import { BlockNotFoundError, type Hash, type PublicClient } from 'viem';

/** A receipt can arrive before the RPC can serve its block. Never resubmit here. */
export async function recordConfirmedSpend(
  client: Pick<PublicClient, 'getBlock'>,
  blockHash: Hash,
  record: (timestamp: bigint) => void,
): Promise<{ synced: true } | { synced: false; error: unknown }> {
  try {
    for (let attempt = 0; ; attempt++) {
      let timestamp: bigint;
      try {
        timestamp = (await client.getBlock({ blockHash })).timestamp;
      } catch (error) {
        if (!(error instanceof BlockNotFoundError) || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      record(timestamp);
      return { synced: true };
    }
  } catch (error) {
    // Bookkeeping failure cannot undo a successful receipt.
    return { synced: false, error };
  }
}
