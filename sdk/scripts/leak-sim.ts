import { createWalletClient, encodeFunctionData, http, type Address, type Hex, type LocalAccount } from 'viem';
import { ACCOUNT_ABI } from '../src/adapters/evm/abi.js';
import { operationTypedData } from '../src/adapters/evm/operation.js';

export type LeakAttempt = { attempt: number; result: 'sent' | 'reverted'; reason: string; totalDrained: bigint; remainingBalance: bigint };
/** Records Phase 9B direct-attack outcomes without ever retaining signing material. */
export function appendLeakAttempt(rows: LeakAttempt[], result: LeakAttempt['result'], reason: string, totalDrained: bigint, remainingBalance: bigint) {
  rows.push({ attempt: rows.length + 1, result, reason, totalDrained, remainingBalance });
}
export async function runLeakSimulation(input: { chainId: string; rpcUrl: string; account: Address; attacker: LocalAccount; recipient: Address; perTxLimit: bigint; budget: bigint; deadline: bigint; balance: () => Promise<bigint> }) {
  const wallet = createWalletClient({ account: input.attacker, transport: http(input.rpcUrl) });
  const rows: LeakAttempt[] = []; let drained = 0n;
  const smallAttempts = Number(input.budget / input.perTxLimit + 2n);
  for (const value of [input.perTxLimit + 1n, ...Array(smallAttempts).fill(input.perTxLimit) as bigint[]]) {
    const op = { to: input.recipient, value, nonce: BigInt(rows.length + 1), deadline: input.deadline };
    const signature = await input.attacker.signTypedData(operationTypedData(input.chainId, op, input.account));
    const data = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeWithSessionSig', args: [op, signature] });
    try { await wallet.sendTransaction({ chain: undefined, to: input.account, data }); drained += value; appendLeakAttempt(rows, 'sent', '', drained, await input.balance()); }
    catch { appendLeakAttempt(rows, 'reverted', 'contract rejected', drained, await input.balance()); }
  }
  // Addresses and amounts only: never print keys, signatures, requests, or RPC details.
  console.table(rows.map(r => ({ attempt: r.attempt, result: r.result, reason: r.reason, totalDrained: r.totalDrained.toString(), remainingBalance: r.remainingBalance.toString() })));
  return rows;
}
