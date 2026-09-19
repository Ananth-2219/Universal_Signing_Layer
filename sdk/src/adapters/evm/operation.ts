import { bytesToBigInt, type Address, type Hex } from 'viem';
import { assertAddress, assertUint256 } from '../../core/index.js';
import { parseCaip2 } from '../registry.js';
import type { Intent, Operation, OperationContext } from '../types.js';
import { NeedsConsentError } from '../types.js';

export const OPERATION_TYPES = { Operation: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
export function address(value: Address): Address {
  assertAddress(value, 'address');
  return value.toLowerCase() as Address;
}
export function assertData(data: Hex): void {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('Data must be byte-aligned hex');
}
export function validateOperation(op: Operation): void {
  // Fail closed for legacy objects rather than silently discard a requested call.
  if ('data' in op || 'asset' in op) throw new NeedsConsentError('Session Operations cannot contain calldata or asset fields');
  address(op.to);
  for (const field of ['value', 'nonce', 'deadline'] as const) assertUint256(op[field], field);
}
export function randomNonce(): bigint {
  // Browser CSPRNG; this is an operation ID, unrelated to any signing key.
  return bytesToBigInt(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}
export function buildOperation(chainId: string, intent: Intent, context: OperationContext, nonceGenerator = randomNonce): Operation {
  if (intent.chainId !== chainId) throw new Error('Intent chain does not match adapter');
  // Native-value accounting cannot constrain token transfers or approvals.
  if (intent.asset !== 'native' || (intent.data !== undefined && intent.data !== '0x')) {
    throw new NeedsConsentError('Tokens and calldata require fresh owner consent');
  }
  address(context.account); address(intent.to);
  assertUint256(intent.amount, 'amount'); assertUint256(context.now, 'now');
  const ttl = context.ttlSeconds ?? 300n;
  assertUint256(ttl, 'ttlSeconds');
  const op: Operation = {
    to: address(intent.to), value: intent.amount,
    nonce: nonceGenerator(), deadline: context.now + ttl,
  };
  validateOperation(op);
  return op;
}
export function operationTypedData(chainId: string, op: Operation, account: Address) {
  validateOperation(op);
  return {
    domain: { name: 'USLMandate', version: '1', chainId: parseCaip2(chainId).numericChainId, verifyingContract: address(account) },
    types: OPERATION_TYPES, primaryType: 'Operation',
    message: { to: address(op.to), value: op.value, nonce: op.nonce, deadline: op.deadline },
  } as const;
}
