import { type Address, type Hex, type PublicClient } from 'viem';
import { createMandate, validateMandate, type GrantLimits, type Mandate } from '@usl/sdk/core';
import { ACCOUNT_VIEW_ABI, EvmAdapter, decodeAccountError, randomNonce } from '@usl/sdk/adapters';
import { assertDeployment } from './submission';
import { describeActionError } from './actionError';
import { readChainStatus, revertDataOf, type ChainStatus, type DemoChain, type RelayExecuteBody, type SessionState } from './usl';

export function buildChainMandate(input: {
  sessionKey: Address; now: bigint;
  targets: { chain: DemoChain; account: Address; limits: GrantLimits }[];
}): Mandate {
  const nonce = randomNonce();
  const deadline = input.now + 3600n;
  const grants = input.targets.flatMap(target => createMandate({ sessionKey: input.sessionKey,
    chains: [{ chainId: BigInt(target.chain.chainId), account: target.account }],
    limits: target.limits, nonce, deadline, now: input.now }).grants);
  const mandate = { grants, nonce, deadline };
  validateMandate(mandate, input.now);
  return mandate;
}

export interface Readiness {
  chainId: number; ready: boolean; message: string; status?: ChainStatus;
  walletBalance?: bigint; estimatedGasReserve?: bigint;
}
export async function checkReadiness(input: {
  chain: DemoChain; client: PublicClient; account?: Address; owner?: Address; sessionKey?: Address;
}): Promise<Readiness> {
  const { chain, client, account, owner, sessionKey } = input;
  try {
    if (!chain.rpcUrl) throw new Error('RPC not configured');
    if (await client.getChainId() !== chain.chainId) throw new Error('RPC chain mismatch');
    if (!account) throw new Error('Deployment record missing');
    await assertDeployment(client, chain, account);
    if (!owner) throw new Error('Connect MetaMask to check owner and gas balance');
    const status = await readChainStatus({ publicClient: client, account, sessionKey: sessionKey ?? owner, mandateNonce: 0n });
    const [walletBalance, gasPrice] = await Promise.all([client.getBalance({ address: owner }), client.getGasPrice()]);
    const estimatedGasReserve = gasPrice * 400_000n;
    const problems = [status.owner.toLowerCase() !== owner.toLowerCase() && 'Connected wallet is not the contract owner',
      status.balance === 0n && 'Fund the account contract with test ETH',
      walletBalance < estimatedGasReserve && 'Wallet gas balance below estimated reserve'].filter(Boolean);
    return { chainId: chain.chainId, ready: problems.length === 0, status, walletBalance, estimatedGasReserve,
      message: problems.join('; ') || 'RPC, bytecode, owner, funding and session reads passed. Gas reserve is an estimate.' };
  } catch (error) {
    return { chainId: chain.chainId, ready: false, message: describeActionError('pre-demo check', error) };
  }
}

export function effectiveRemaining(session: SessionState, now: bigint): bigint {
  if (session.windowStart === 0n || now >= session.windowStart + session.windowSeconds) return session.budget;
  return session.spent >= session.budget ? 0n : session.budget - session.spent;
}

export function budgetProbeValue(session: SessionState, now: bigint): bigint {
  const remaining = effectiveRemaining(session, now);
  if (remaining >= session.perTxLimit) throw new Error('Spend until remaining budget is below the per-transfer cap, then retry the budget probe. Use equal cap and budget for a short demo.');
  return remaining + 1n;
}

/** A real eth_call of the signed operation. A provider failure is never labeled a contract rejection. */
export async function probeSignedOperation(input: {
  chain: DemoChain; client: PublicClient; body: RelayExecuteBody; payer: Address;
}): Promise<{ rejected: boolean; reason: string }> {
  const { chain, client, body, payer } = input;
  await assertDeployment(client, chain, body.account);
  const adapter = new EvmAdapter({ chainId: chain.caip2, publicClient: client });
  const request = adapter.buildExecuteRequest({ to: body.args.to, value: BigInt(body.args.value),
    nonce: BigInt(body.args.nonce), deadline: BigInt(body.args.deadline) }, body.account, body.args.signature);
  try {
    await client.call({ account: payer, to: request.to, data: request.data, value: 0n });
    return { rejected: false, reason: 'Contract accepted simulation. No transaction was submitted.' };
  } catch (error) {
    const reason = decodeAccountError(revertDataOf(error));
    if (!reason) throw error;
    return { rejected: true, reason };
  }
}

export function transactionLink(chain: DemoChain, hash: Hex): string | undefined {
  return chain.explorer ? `${chain.explorer}/tx/${hash}` : undefined;
}

export async function registrationComplete(client: PublicClient, account: Address, nonce: bigint): Promise<boolean> {
  return client.readContract({ address: account, abi: ACCOUNT_VIEW_ABI, functionName: 'mandateIdUsed', args: [nonce] });
}
