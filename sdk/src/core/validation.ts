import { isAddress, maxUint256, type Address, type Hex } from 'viem';
import type { Mandate, MandateGrant } from './types.js';

export function assertUint256(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maxUint256) {
    throw new Error(`${field} must be a uint256 bigint`);
  }
}
export function assertAddress(value: unknown, field: string): asserts value is Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new Error(`Invalid ${field} address`);
}
export function assertBytes32(value: unknown): asserts value is Hex {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value)) throw new Error('Expected bytes32');
}
export function validateGrant(grant: MandateGrant, now?: bigint): void {
  assertAddress(grant.domain.verifyingContract, 'verifyingContract');
  assertAddress(grant.sessionKey, 'sessionKey');
  assertUint256(grant.domain.chainId, 'chainId');
  for (const field of ['perTxLimit', 'budget', 'windowSeconds', 'expiry'] as const) assertUint256(grant[field], field);
  // The account contract rejects a zero window (InvalidWindow): a zero window would
  // reset the budget on every spend and silently remove the budget limit.
  if (grant.windowSeconds === 0n) throw new Error('windowSeconds must be greater than zero');
  if (now !== undefined) {
    assertUint256(now, 'now');
    if (grant.expiry <= now) throw new Error('Session expired');
  }
}
export function validateMandate(mandate: Mandate, now?: bigint): void {
  assertUint256(mandate.nonce, 'nonce');
  assertUint256(mandate.deadline, 'deadline');
  if (mandate.grants.length === 0) throw new Error('A mandate needs at least one grant');
  const seen = new Set<string>();
  for (const grant of mandate.grants) {
    validateGrant(grant, now);
    const pair = `${grant.domain.chainId}:${grant.domain.verifyingContract.toLowerCase()}`;
    if (seen.has(pair)) throw new Error('Duplicate chainId/verifyingContract');
    seen.add(pair);
  }
  if (now !== undefined && now > mandate.deadline) throw new Error('Submission deadline passed');
}
