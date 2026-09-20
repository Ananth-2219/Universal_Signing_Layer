import { expect, it, vi } from 'vitest';
import { WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from 'viem';
import { registrationReceipt } from '../../demo/src/lib/registrationReceipt';

const hash: Hex = `0x${'ab'.repeat(32)}`;
it('permits checking the same hash after a timeout and preserves the receipt status', async () => {
  const receipt = { status: 'success' };
  const waitForTransactionReceipt = vi.fn().mockRejectedValueOnce(new WaitForTransactionReceiptTimeoutError({ hash }))
    .mockResolvedValueOnce(receipt);
  const client = { waitForTransactionReceipt } as unknown as PublicClient;
  expect(await registrationReceipt(client, hash)).toBeUndefined();
  expect(await registrationReceipt(client, hash)).toBe(receipt);
  expect(waitForTransactionReceipt.mock.calls).toEqual([[{ hash }], [{ hash }]]);
});
it('does not conceal other errors or change reverted receipts to success', async () => {
  const error = new Error('RPC unavailable');
  const waitForTransactionReceipt = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ status: 'reverted' });
  const client = { waitForTransactionReceipt } as unknown as PublicClient;
  await expect(registrationReceipt(client, hash)).rejects.toBe(error);
  expect(await registrationReceipt(client, hash)).toEqual({ status: 'reverted' });
});
