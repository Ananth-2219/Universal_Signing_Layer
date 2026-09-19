import type { Address } from 'viem';
import type { Grant } from '../src/core/index.js';

/** Public inputs only. Sepolia, Base Sepolia, and local Anvil. */
export function vectorGrants(owner: Address): Grant[] {
  return [
    { owner, chainId: 11155111n, sessionKey: '0x1111111111111111111111111111111111111111',
      perTxLimit: 10000000000000000n, budget: 100000000000000000n,
      windowSeconds: 3600n, expiry: 2000000000n, nonce: 7n },
    { owner, chainId: 84532n, sessionKey: '0x2222222222222222222222222222222222222222',
      perTxLimit: 20000000000000000n, budget: 200000000000000000n,
      windowSeconds: 86400n, expiry: 2000000100n, nonce: 8n },
    { owner, chainId: 31337n, sessionKey: '0x3333333333333333333333333333333333333333',
      perTxLimit: 30000000000000000n, budget: 300000000000000000n,
      windowSeconds: 600n, expiry: 2000000200n, nonce: 9n },
  ];
}
