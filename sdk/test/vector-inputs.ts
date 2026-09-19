import type { Address } from 'viem';
import { createMandate } from '../src/core/index.js';

export const VECTOR_NOW = 1900000000n;
export const VECTOR_APPLICATION: Address = '0x4444444444444444444444444444444444444444';
export function vectorMandate() {
  return createMandate({
    sessionKey: '0x3333333333333333333333333333333333333333',
    chains: [
      { chainId: 31337n, account: '0x1111111111111111111111111111111111111111' },
      { chainId: 31338n, account: '0x2222222222222222222222222222222222222222' },
    ],
    limits: { perTxLimit: 10000000000000001n, budget: 100000000000000000n, windowSeconds: 3600n, expiry: 2000000001n },
    nonce: 42n, deadline: 2000000000n, now: VECTOR_NOW,
  });
}
