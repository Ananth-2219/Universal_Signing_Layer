import type { Address, Hex, TypedDataDefinition } from 'viem';
import type { Mandate } from '../core/index.js';
import type { SessionKey } from '../keys/index.js';

export interface Intent { chainId: string; to: Address; amount: bigint; asset: 'native' | Address; data?: Hex }
export interface Operation { to: Address; value: bigint; nonce: bigint; deadline: bigint }
export class NeedsConsentError extends Error {
  override name = 'NeedsConsentError';
}
export interface SubmitRequest { chainId: string; to: Address; data: Hex; value?: bigint }
export interface Submitter { submit(req: SubmitRequest): Promise<Hex> }
export interface OperationContext { account: Address; now: bigint; ttlSeconds?: bigint }
export interface RegistrationRequest { mandate: Mandate; signature: Hex; account: Address; application: Address }
export interface ChainAdapter {
  readonly chainId: string;
  buildOperation(intent: Intent, context: OperationContext): Operation;
  operationTypedData(op: Operation, account: Address): TypedDataDefinition;
  signOperation(op: Operation, account: Address, sessionKey: SessionKey, now: bigint): Promise<Hex>;
  buildExecuteRequest(op: Operation, account: Address, signature: Hex): SubmitRequest;
  buildRegistrationRequest(input: RegistrationRequest): SubmitRequest;
  submit(req: SubmitRequest, submitter: Submitter): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }>;
}
