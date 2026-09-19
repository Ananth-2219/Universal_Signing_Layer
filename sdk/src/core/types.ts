import type { Address, Hex } from 'viem';

export type ChainId = `eip155:${string}`;
export interface Intent {
  chainId: ChainId;
  to: Address;
  /** Smallest asset unit; never a floating-point quantity. */
  amount: bigint;
  asset: 'native' | Address;
  data?: Hex;
}
export interface EIP712ChainDomain { chainId: bigint; verifyingContract: Address }
export interface GrantLimits {
  perTxLimit: bigint;
  budget: bigint;
  windowSeconds: bigint;
  /** Unix seconds: session valid only while expiry > now. */
  expiry: bigint;
}
export interface MandateGrant extends GrantLimits {
  domain: EIP712ChainDomain;
  sessionKey: Address;
}
export interface Mandate {
  grants: MandateGrant[];
  /** Unique mandate ID, not a sequential counter. */
  nonce: bigint;
  /** Last submission time in Unix seconds, inclusive. */
  deadline: bigint;
}
/** Values returned by the application's ERC-5267 eip712Domain(). */
export interface ApplicationDomain {
  name: string;
  version: string;
  chainId: bigint;
  verifyingContract: Address;
  salt: Hex;
}
