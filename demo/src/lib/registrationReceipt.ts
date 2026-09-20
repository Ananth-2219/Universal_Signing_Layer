import { WaitForTransactionReceiptTimeoutError, type Hex, type PublicClient } from 'viem';

/** A timeout leaves the existing hash available for another confirmation check. */
export async function registrationReceipt(client: Pick<PublicClient, 'waitForTransactionReceipt'>, hash: Hex) {
  try {
    return await client.waitForTransactionReceipt({ hash });
  } catch (error) {
    if (error instanceof WaitForTransactionReceiptTimeoutError) return undefined;
    throw error;
  }
}
