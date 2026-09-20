import { expect, it, vi } from 'vitest';
import type { PublicClient } from 'viem';
import { relayFees } from '../../relayer/src/fees';

function client(baseFeePerGas: bigint | null, tip = 3n) {
  return { getBlock: vi.fn(async () => ({ baseFeePerGas })),
    estimateMaxPriorityFeePerGas: vi.fn(async () => tip) } as unknown as PublicClient;
}
it('allows a doubling of base fee while retaining the suggested priority fee', async () => {
  expect(await relayFees(client(100n), 300n)).toEqual({ maxFeePerGas: 203n, maxPriorityFeePerGas: 3n });
});
it('retains the configured ceiling and refuses unsupported fee data', async () => {
  await expect(relayFees(client(100n), 202n)).rejects.toThrow('gas price exceeds cap');
  await expect(relayFees(client(null), 300n)).rejects.toThrow('EIP-1559 fees unavailable');
});
it('supports a replacement priority-fee floor without bypassing the cap', async () => {
  expect(await relayFees(client(100n), 400n, 125n)).toEqual({ maxFeePerGas: 325n, maxPriorityFeePerGas: 125n });
  await expect(relayFees(client(100n), 300n, 125n)).rejects.toThrow('gas price exceeds cap');
});
