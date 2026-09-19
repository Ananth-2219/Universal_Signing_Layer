import type { Address, Hex } from 'viem';

/** A CAIP-2 namespace:reference; runtime validation belongs to chain adapters. */
export type ChainId = `${string}:${string}`;

export interface Intent {
  chainId: ChainId;
  to: string;
  /** Smallest asset unit; never a floating-point quantity. */
  amount: bigint;
  asset: 'native' | string;
  data?: Hex;
}

/** Phase 1's ABI format is EVM-specific. All numeric fields encode as uint256. */
export interface Grant {
  owner: Address;
  chainId: bigint;
  sessionKey: Address;
  perTxLimit: bigint;
  budget: bigint;
  windowSeconds: bigint;
  /** Unix seconds. */
  expiry: bigint;
  nonce: bigint;
}

export interface Mandate {
  owner: Address;
  grants: Grant[];
}
