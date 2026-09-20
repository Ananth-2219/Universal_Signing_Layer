import { afterEach, expect, it, vi } from 'vitest';
import { BlockNotFoundError, type Hash, type PublicClient } from 'viem';
import { recordConfirmedSpend } from '../../demo/src/lib/confirmedSpend';

const blockHash: Hash = `0x${'ab'.repeat(32)}`;
afterEach(() => vi.useRealTimers());

it('records exactly once when the receipt block becomes readable after RPC lag', async () => {
  vi.useFakeTimers();
  const getBlock = vi.fn()
    .mockRejectedValueOnce(new BlockNotFoundError({ blockHash }))
    .mockResolvedValue({ timestamp: 123n });
  const record = vi.fn();
  const result = recordConfirmedSpend({ getBlock } as unknown as PublicClient, blockHash, record);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ synced: true });
  expect(getBlock).toHaveBeenCalledTimes(2);
  expect(getBlock).toHaveBeenLastCalledWith({ blockHash });
  expect(record).toHaveBeenCalledExactlyOnceWith(123n);
});

it('reports an unsynced tracker without throwing a transfer failure after bounded retries', async () => {
  vi.useFakeTimers();
  const error = new BlockNotFoundError({ blockHash });
  const getBlock = vi.fn().mockRejectedValue(error);
  const record = vi.fn();
  const result = recordConfirmedSpend({ getBlock } as unknown as PublicClient, blockHash, record);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ synced: false, error });
  expect(getBlock).toHaveBeenCalledTimes(4);
  expect(record).not.toHaveBeenCalled();
});

it('does not retry other provider errors or invent a spending timestamp', async () => {
  const error = new Error('RPC unavailable');
  const getBlock = vi.fn().mockRejectedValue(error);
  const record = vi.fn();
  expect(await recordConfirmedSpend({ getBlock } as unknown as PublicClient, blockHash, record))
    .toEqual({ synced: false, error });
  expect(getBlock).toHaveBeenCalledTimes(1);
  expect(record).not.toHaveBeenCalled();
});

it('preserves confirmed status if local recording itself fails', async () => {
  const error = new Error('Time precedes last recorded spend');
  const getBlock = vi.fn().mockResolvedValue({ timestamp: 123n });
  const record = vi.fn(() => { throw error; });
  expect(await recordConfirmedSpend({ getBlock } as unknown as PublicClient, blockHash, record))
    .toEqual({ synced: false, error });
  expect(record).toHaveBeenCalledTimes(1);
});
