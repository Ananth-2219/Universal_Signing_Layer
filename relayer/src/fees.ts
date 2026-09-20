import type { PublicClient } from 'viem';

/** Leave room for base-fee increases while retaining the configured fee ceiling. */
export async function relayFees(
  client: Pick<PublicClient, 'getBlock' | 'estimateMaxPriorityFeePerGas'>,
  cap: bigint,
  minimumPriorityFee = 0n,
) {
  const [block, estimate] = await Promise.all([
    client.getBlock(), client.estimateMaxPriorityFeePerGas(),
  ]);
  if (block.baseFeePerGas == null) throw new Error('EIP-1559 fees unavailable');
  const maxPriorityFeePerGas = estimate > minimumPriorityFee ? estimate : minimumPriorityFee;
  const maxFeePerGas = block.baseFeePerGas * 2n + maxPriorityFeePerGas;
  if (maxFeePerGas > cap) throw new Error('gas price exceeds cap');
  return { maxFeePerGas, maxPriorityFeePerGas };
}
