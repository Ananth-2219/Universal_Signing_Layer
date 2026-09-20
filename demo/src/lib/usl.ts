/**
 * Phase 10 demo logic. This module is deliberately free of React, DOM and env access so
 * the same code runs in the browser and in `sdk/test/phase10.demo.test.ts` against real
 * local anvil nodes. All signing, encoding and validation is delegated to @usl/sdk; this
 * module only adapts the SDK to the relayer's JSON format and to the demo UI.
 *
 * The session key never leaves its SessionKey object: nothing here can read, print or
 * serialise a private key.
 */
import {
  createPublicClient, createWalletClient, defineChain, http, maxUint256, parseEther,
  type Address, type Chain, type Hex, type PublicClient, type WalletClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  MANDATE_DOMAIN, createMandate, encodeEnvelope, verifyEnvelope,
  type EnvelopeVerification, type GrantLimits, type Mandate, type MandateGrant,
} from '@usl/sdk/core';
import type { SessionKey } from '@usl/sdk/keys';
import {
  ACCOUNT_VIEW_ABI, EvmAdapter, decodeAccountError, randomNonce,
  type Operation, type OperationContext,
} from '@usl/sdk/adapters';
import { SpendTracker, evaluate, type PolicyResult } from '@usl/sdk/policy';

/** One supported local chain. rpcUrl is empty when demo/.env.local is not configured. */
export interface DemoChain {
  explorer?: string;
  chainId: number;
  caip2: `eip155:${number}`;
  label: string;
  rpcUrl: string;
}

export interface MandateFormValues {
  perTxLimitEth: string;
  budgetEth: string;
  windowSeconds: string;
  expiryMinutes: string;
}

export interface SessionState {
  perTxLimit: bigint;
  budget: bigint;
  windowSeconds: bigint;
  expiry: bigint;
  windowStart: bigint;
  spent: bigint;
  active: boolean;
}

export interface ChainStatus {
  owner: Address;
  balance: bigint;
  /** The chain's own clock; every deadline and window is compared against it. */
  now: bigint;
  mandateUsed: boolean;
  session: SessionState;
}

export function publicClientFor(chain: DemoChain): PublicClient {
  if (!chain.rpcUrl) throw new Error(`${chain.label} has no RPC URL configured`);
  return createPublicClient({ transport: http(chain.rpcUrl) });
}

/** Human-readable reason for a rejected transaction or request. */
const ACCOUNT_ERROR_TEXT: Readonly<Record<string, string>> = {
  PerTxLimitExceeded: 'The contract rejected it: value is above the per-transaction limit',
  BudgetExceeded: 'The contract rejected it: the fixed-window budget is exhausted',
  SessionNotActive: 'The contract rejected it: this session key is not active (never registered or revoked)',
  SessionExpired: 'The contract rejected it: the session expiry has passed',
  OperationNonceUsed: 'The contract rejected it: this operation nonce was already used',
  MandateNonceUsed: 'The contract rejected it: this mandate id was already registered',
  SessionAlreadyActive: 'The contract rejected it: this session key is already active, revoke it first',
  WrongSigner: 'The contract rejected it: the signature was not made by the account owner',
  WrongChain: 'The contract rejected it: the grant chain id is not this chain',
  WrongAccount: 'The contract rejected it: the grant names a different account contract',
  InsufficientBalance: 'The contract rejected it: the account contract has not enough ETH',
  InvalidSignature: 'The contract rejected it: the signature is not a valid 65-byte EOA signature',
  DeadlinePassed: 'The contract rejected it: the deadline passed',
  GrantHashMismatch: 'The contract rejected it: the envelope does not contain this grant',
  WrongApplication: 'The contract rejected it: the envelope was built for another application',
  NotOwner: 'The contract rejected it: only the owner can revoke',
};

export type FetchLike = (
  input: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Exactly the Phase 8 relayer wire format: every number travels as a decimal string. */
export interface RelayExecuteArgs {
  to: Address; value: string; nonce: string; deadline: string; signature: Hex;
}
export interface RelayRegisterArgs {
  grant: {
    domain: { chainId: string; verifyingContract: Address };
    sessionKey: Address; perTxLimit: string; budget: string; windowSeconds: string; expiry: string;
  };
  nonce: string; deadline: string; envelope: Hex;
}
export type RelayRegisterBody = { chainId: number; account: Address; kind: 'register'; args: RelayRegisterArgs };
export type RelayExecuteBody = { chainId: number; account: Address; kind: 'execute'; args: RelayExecuteArgs };
export type RelayBody = RelayRegisterBody | RelayExecuteBody;

function etherInput(value: string, field: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`Enter ${field} as a positive decimal number of ETH`);
  try { return parseEther(trimmed); } catch { throw new Error(`${field} has too many decimal places (max 18)`); }
}

function wholeNumber(value: string, field: string, max: bigint): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) throw new Error(`Enter ${field} as a whole number`);
  const parsed = BigInt(trimmed);
  if (parsed <= 0n) throw new Error(`${field} must be greater than zero`);
  if (parsed > max) throw new Error(`${field} is unrealistically large for this demo`);
  return parsed;
}

/** Turn the form into the grant limits the mandate is signed with. */
export function parseLimits(values: MandateFormValues, now: bigint): GrantLimits {
  const perTxLimit = etherInput(values.perTxLimitEth, 'the per-transaction limit');
  const budget = etherInput(values.budgetEth, 'the budget');
  const windowSeconds = wholeNumber(values.windowSeconds, 'the budget window in seconds', 604_800n);
  const expiryMinutes = wholeNumber(values.expiryMinutes, 'the session expiry in minutes', 525_600n);
  if (perTxLimit === 0n) throw new Error('The per-transaction limit must be greater than zero');
  // A demo-level rule only: it keeps the two limit inputs meaningful on screen.
  if (budget < perTxLimit) throw new Error('The budget must be at least the per-transaction limit');
  return { perTxLimit, budget, windowSeconds, expiry: now + expiryMinutes * 60n };
}

export function newMandateNonce(): bigint {
  // An unordered mandate ID, not a counter (the contract keys a used-mapping by it).
  return randomNonce();
}

/** Build the single ERC-7964 mandate: one grant per selected chain, same session key. */
export function buildDemoMandate(input: {
  sessionKey: Address;
  chains: readonly { chainId: number; account: Address }[];
  limits: GrantLimits;
  now: bigint;
  nonce?: bigint;
  submissionWindowSeconds?: bigint;
}): Mandate {
  return createMandate({
    sessionKey: input.sessionKey,
    chains: input.chains.map(chain => ({ chainId: BigInt(chain.chainId), account: chain.account })),
    limits: input.limits,
    nonce: input.nonce ?? newMandateNonce(),
    deadline: input.now + (input.submissionWindowSeconds ?? 3_600n),
    now: input.now,
  });
}

export interface RegistrationPlan {
  grant: MandateGrant;
  envelope: Hex;
  verification: EnvelopeVerification;
  body: RelayRegisterBody;
}

/** One chain's registration: SDK envelope + SDK verification + relayer wire body. */
export async function planRegistration(input: {
  mandate: Mandate; signature: Hex; chain: DemoChain; account: Address; owner: Address; now: bigint;
}): Promise<RegistrationPlan> {
  const { mandate, signature, chain, account, owner, now } = input;
  const grant = mandate.grants.find(candidate => candidate.domain.chainId === BigInt(chain.chainId)
    && candidate.domain.verifyingContract.toLowerCase() === account.toLowerCase());
  if (!grant) throw new Error(`The mandate has no grant for ${chain.label} and account ${account}`);
  // The application is the account contract itself, as in Phase 6/7.
  const envelope = encodeEnvelope({
    mandate, signature, chainId: BigInt(chain.chainId), verifyingContract: account, application: account,
  });
  const verification = await verifyEnvelope({
    envelope, expectedGrant: grant, owner, nonce: mandate.nonce, deadline: mandate.deadline, now,
    application: account,
    // The mandate envelope selects only name+version, so the chain fields are ignored here.
    domain: { ...MANDATE_DOMAIN, chainId: BigInt(chain.chainId), verifyingContract: account, salt: `0x${'00'.repeat(32)}` },
  });
  return {
    grant,
    envelope,
    verification,
    body: {
      chainId: chain.chainId,
      account,
      kind: 'register',
      args: {
        grant: {
          domain: { chainId: String(grant.domain.chainId), verifyingContract: grant.domain.verifyingContract },
          sessionKey: grant.sessionKey,
          perTxLimit: String(grant.perTxLimit),
          budget: String(grant.budget),
          windowSeconds: String(grant.windowSeconds),
          expiry: String(grant.expiry),
        },
        nonce: String(mandate.nonce),
        deadline: String(mandate.deadline),
        envelope,
      },
    },
  };
}

const RELAYER_SELECTOR = /0x[0-9a-fA-F]{8}\b/;

function relayerMessage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const selector = raw.match(RELAYER_SELECTOR)?.[0];
  const name = selector ? decodeAccountError(selector) : undefined;
  if (name) return ACCOUNT_ERROR_TEXT[name] ?? `The contract rejected it: ${name}`;
  if (/simulation reverted/i.test(raw)) {
    // The Phase 8 relayer deliberately returns only a generic message for a failed simulation.
    return 'The relayer simulated the call, the contract refused it, and nothing was sent (the relayer does not report which rule failed)';
  }
  return `relayer: ${raw}`;
}

/** POST one request to the Phase 8 relayer; it simulates the exact call before sending. */
export async function postRelay(input: { relayerUrl: string; fetchImpl: FetchLike; body: RelayBody }): Promise<Hex> {
  // Calling input.fetchImpl(...) sets `this` to input. Native browser fetch
  // rejects that receiver; invoke it as a standalone function instead.
  const { fetchImpl } = input;
  const response = await fetchImpl(`${input.relayerUrl.replace(/\/+$/, '')}/relay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input.body),
  });
  const payload = await response.json().catch(() => undefined) as { hash?: unknown; error?: unknown } | undefined;
  if (!response.ok) throw new Error(relayerMessage(payload?.error) ?? `relayer returned HTTP ${response.status}`);
  if (typeof payload?.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(payload.hash)) {
    throw new Error('relayer answered without a transaction hash');
  }
  return payload.hash as Hex;
}

/** True when the relayer answers GET /health; used to explain a failed request. */
export async function relayerIsUp(relayerUrl: string, fetchImpl: FetchLike): Promise<boolean> {
  try {
    const response = await fetchImpl(`${relayerUrl.replace(/\/+$/, '')}/health`, { method: 'GET', headers: {} });
    return response.ok;
  } catch {
    return false;
  }
}

/** One human-readable sentence for any wallet, relayer or contract failure. */
export function describeError(error: unknown): string {
  const revert = revertDataOf(error);
  const name = revert ? decodeAccountError(revert) : undefined;
  if (name) return ACCOUNT_ERROR_TEXT[name] ?? `The contract rejected it: ${name}`;
  if (isUserRejection(error)) return 'Rejected in the wallet (code 4001)';
  const candidate = error as { shortMessage?: string; message?: string } | undefined;
  const text = (candidate?.shortMessage ?? candidate?.message ?? String(error)).split('\n')[0] ?? 'Unknown error';
  return text.slice(0, 300);
}

export function isUserRejection(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === 4001 || /user (rejected|denied)/i.test(String((error as Error | undefined)?.message ?? ''));
}

/** Revert data anywhere in a nested viem error, for on-chain error names. */
export function revertDataOf(error: unknown): Hex | undefined {
  const found: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of ['data', 'returnData']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(candidate)) found.push(candidate);
    }
    for (const key of ['cause', 'info', 'error', 'data', 'originalError']) visit(record[key], depth + 1);
  };
  visit(error, 0);
  return found[0] as Hex | undefined;
}

/** Owner, balance, chain clock and the on-chain session record for one chain. */
export async function readChainStatus(input: {
  publicClient: PublicClient; account: Address; sessionKey: Address; mandateNonce: bigint;
}): Promise<ChainStatus> {
  const [owner, session, mandateUsed, block, balance] = await Promise.all([
    input.publicClient.readContract({ address: input.account, abi: ACCOUNT_VIEW_ABI, functionName: 'owner' }),
    input.publicClient.readContract({ address: input.account, abi: ACCOUNT_VIEW_ABI, functionName: 'sessions', args: [input.sessionKey] }),
    input.publicClient.readContract({ address: input.account, abi: ACCOUNT_VIEW_ABI, functionName: 'mandateIdUsed', args: [input.mandateNonce] }),
    input.publicClient.getBlock(),
    input.publicClient.getBalance({ address: input.account }),
  ]);
  return {
    owner,
    balance,
    now: block.timestamp,
    mandateUsed,
    session: {
      perTxLimit: session.perTxLimit, budget: session.budget, windowSeconds: session.windowSeconds,
      expiry: session.expiry, windowStart: session.windowStart, spent: session.spent, active: session.active,
    },
  };
}

/** Budget left in the current fixed window; never negative on screen. */
export function remainingBudget(session: SessionState): bigint {
  return session.spent >= session.budget ? 0n : session.budget - session.spent;
}

/** Seconds until the fixed window resets, or 0 when no window is running. */
export function budgetWindowResetsIn(session: SessionState, now: bigint): bigint {
  if (!session.active || session.windowStart === 0n) return 0n;
  const end = session.windowStart + session.windowSeconds;
  return end > now ? end - now : 0n;
}

export interface TransferPlan { op: Operation; signature: Hex; policy: PolicyResult; body: RelayExecuteBody }

/** Build, pre-check and sign one native-transfer session operation. */
export async function planSessionTransfer(input: {
  chain: DemoChain;
  account: Address;
  sessionKey: SessionKey;
  grant: MandateGrant | undefined;
  tracker: SpendTracker;
  publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>;
  recipient: Address;
  amount: bigint;
  now: bigint;
  ttlSeconds?: bigint;
}): Promise<TransferPlan> {
  const adapter = new EvmAdapter({ chainId: input.chain.caip2, publicClient: input.publicClient });
  const intent = { chainId: input.chain.caip2, to: input.recipient, amount: input.amount, asset: 'native' as const };
  // Advisory only: the decision shown in the UI never replaces the on-chain check.
  const policy = evaluate(intent, input.grant, input.tracker, input.now);
  const context: OperationContext = { account: input.account, now: input.now, ttlSeconds: input.ttlSeconds ?? 300n };
  const op = adapter.buildOperation(intent, context);
  const signature = await adapter.signOperation(op, input.account, input.sessionKey, input.now);
  return {
    op,
    signature,
    policy,
    body: { chainId: input.chain.chainId, account: input.account, kind: 'execute', args: toRelayExecuteArgs(op, signature) },
  };
}

export function toRelayExecuteArgs(op: Operation, signature: Hex): RelayExecuteArgs {
  return { to: op.to, value: String(op.value), nonce: String(op.nonce), deadline: String(op.deadline), signature };
}

export interface LeakAttemptRow {
  attempt: number;
  kind: string;
  valueWei: bigint;
  result: 'rejected' | 'sent' | 'skipped';
  reason: string;
  drainedWei: bigint;
  remainingBudgetWei: bigint;
}

/**
 * A throwaway local account for the leak demo. It is NOT the session key: it only pays
 * gas for submitting directly to the account contract, and it is created fresh in memory
 * for each simulation. It never reaches the relayer or any file.
 */
export function createDemoAttacker(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export async function readBalance(publicClient: PublicClient, address: Address): Promise<bigint> {
  return publicClient.getBalance({ address });
}

/**
 * Phase 9 behaviour, run in the browser: an attacker who holds the session key signs
 * operations and submits them DIRECTLY to the contract, with no SDK policy pre-check and
 * no relayer. Only values the contract must reject are attempted, so the demo cannot
 * drain the mandate: each attempt is simulated first and really sent only if the
 * contract wrongly allows it. Keys, signatures and calldata are never returned.
 */
export async function runLeakAttempts(input: {
  chain: DemoChain;
  account: Address;
  sessionKey: SessionKey;
  attacker: PrivateKeyAccount;
  publicClient: PublicClient;
  session: SessionState;
  now: bigint;
  gas?: bigint;
}): Promise<LeakAttemptRow[]> {
  const adapter = new EvmAdapter({ chainId: input.chain.caip2, publicClient: input.publicClient });
  const wallet = createWalletClient({ account: input.attacker, transport: http(input.chain.rpcUrl) });
  const remaining = remainingBudget(input.session);
  const plans: { kind: string; value: bigint; skip?: string }[] = [];
  if (input.session.perTxLimit < maxUint256) {
    plans.push({ kind: 'above the per-transaction limit', value: input.session.perTxLimit + 1n });
  }
  plans.push(remaining < maxUint256 && remaining + 1n <= input.session.perTxLimit
    ? { kind: 'above the remaining budget', value: remaining + 1n }
    : {
      kind: 'above the remaining budget', value: 0n,
      skip: 'no value can be both within the per-transaction limit and above the remaining budget',
    });
  const rows: LeakAttemptRow[] = [];
  let drained = 0n;
  const left = () => remainingBudget({ ...input.session, spent: input.session.spent + drained });
  for (const plan of plans) {
    if (plan.skip) {
      rows.push({ attempt: rows.length + 1, kind: plan.kind, valueWei: 0n, result: 'skipped', reason: plan.skip, drainedWei: drained, remainingBudgetWei: left() });
      continue;
    }
    const op = adapter.buildOperation(
      { chainId: input.chain.caip2, to: input.attacker.address, amount: plan.value, asset: 'native' },
      { account: input.account, now: input.now, ttlSeconds: 600n },
    );
    const signature = await adapter.signOperation(op, input.account, input.sessionKey, input.now);
    const request = adapter.buildExecuteRequest(op, input.account, signature);
    try {
      await input.publicClient.call({ account: input.attacker.address, to: input.account, data: request.data });
      const hash = await wallet.sendTransaction({
        chain: undefined, to: input.account, data: request.data, gas: input.gas ?? 300_000n,
      });
      const receipt = await input.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === 'success') {
        drained += plan.value;
        rows.push({ attempt: rows.length + 1, kind: plan.kind, valueWei: plan.value, result: 'sent', reason: 'the contract allowed this value', drainedWei: drained, remainingBudgetWei: left() });
      } else {
        rows.push({ attempt: rows.length + 1, kind: plan.kind, valueWei: plan.value, result: 'rejected', reason: 'the transaction reverted on chain', drainedWei: drained, remainingBudgetWei: left() });
      }
    } catch (error) {
      rows.push({ attempt: rows.length + 1, kind: plan.kind, valueWei: plan.value, result: 'rejected', reason: describeError(error), drainedWei: drained, remainingBudgetWei: left() });
    }
  }
  return rows;
}

/** A viem Chain for wagmi/MetaMask. rpcUrls stay empty when the demo is unconfigured. */
export function walletChainFor(chain: DemoChain): Chain {
  return defineChain({
    id: chain.chainId,
    name: `USL ${chain.label}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: chain.rpcUrl ? [chain.rpcUrl] : [] } },
    ...(chain.explorer ? { blockExplorers: { default: { name: `${chain.label} Explorer`, url: chain.explorer } } } : {}),
  });
}

export function isUnknownChainError(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = String((error as Error | undefined)?.message ?? '');
  return code === 4902 || /unrecognized chain|not (been )?added/i.test(message);
}

/** Put the wallet on a demo chain, adding it to the wallet the first time. */
export async function ensureWalletChain(walletClient: WalletClient, chain: DemoChain): Promise<void> {
  if (!chain.rpcUrl) throw new Error(`${chain.label} has no RPC URL configured in demo/.env.local`);
  const target = walletChainFor(chain);
  try {
    await walletClient.switchChain({ id: target.id });
  } catch (error) {
    if (!isUnknownChainError(error)) throw error;
    await walletClient.addChain({ chain: target });
    await walletClient.switchChain({ id: target.id });
  }
}
