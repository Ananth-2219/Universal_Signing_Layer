import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ACCOUNT_ABI } from '../../sdk/src/adapters/evm/abi.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { relayFees } from './fees.js';

type Kind = 'register' | 'execute' | 'revoke';
type Request = { chainId: number; account: Address; kind: Kind; args: unknown };
export type RelayerChain = { chainId: number; rpcUrl: string; accounts: readonly Address[]; gasPriceCap: bigint };
export type RelayerOptions = { chains: readonly RelayerChain[]; privateKey: Hex; rateLimit?: number };
const MAX_BODY = 32_768;
const RELAYER_ABI = parseAbi(['function revokeSessionWithSig(address sessionKey,uint256 nonce,uint256 deadline,bytes ownerSignature)']);
const LOCAL_DEMO_ORIGINS = new Set(['http://localhost:3000', 'http://127.0.0.1:3000']);

function fail(message: string): never { throw new Error(message); }
function uint(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) fail(`invalid ${name}`);
  const parsed = BigInt(value); if (parsed > 2n ** 256n - 1n) fail(`invalid ${name}`); return parsed;
}
function address(value: unknown, name: string): Address { if (typeof value !== 'string' || !isAddress(value)) fail(`invalid ${name}`); return value as Address; }
function hex(value: unknown, name: string): Hex { if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value) || value.length % 2) fail(`invalid ${name}`); return value as Hex; }
function argsFor(kind: Kind, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid args');
  const a = raw as Record<string, unknown>;
  if (kind === 'execute') return [{ to: address(a.to, 'to'), value: uint(a.value, 'value'), nonce: uint(a.nonce, 'nonce'), deadline: uint(a.deadline, 'deadline') }, hex(a.signature, 'signature')];
  if (kind === 'revoke') return [address(a.sessionKey, 'sessionKey'), uint(a.nonce, 'nonce'), uint(a.deadline, 'deadline'), hex(a.ownerSignature, 'ownerSignature')];
  const g = a.grant as Record<string, unknown> | undefined; const d = g?.domain as Record<string, unknown> | undefined;
  if (!g || !d) fail('invalid grant');
  return [{ domain: { chainId: uint(d.chainId, 'grant.domain.chainId'), verifyingContract: address(d.verifyingContract, 'grant.domain.verifyingContract') }, sessionKey: address(g.sessionKey, 'grant.sessionKey'), perTxLimit: uint(g.perTxLimit, 'grant.perTxLimit'), budget: uint(g.budget, 'grant.budget'), windowSeconds: uint(g.windowSeconds, 'grant.windowSeconds'), expiry: uint(g.expiry, 'grant.expiry') }, uint(a.nonce, 'nonce'), uint(a.deadline, 'deadline'), hex(a.envelope, 'envelope')];
}
function callFor(kind: Kind, args: readonly unknown[]): Hex {
  if (kind === 'revoke') return encodeFunctionData({ abi: RELAYER_ABI, functionName: 'revokeSessionWithSig', args: args as never });
  return encodeFunctionData({ abi: ACCOUNT_ABI, functionName: kind === 'register' ? 'registerMandate' : 'executeWithSessionSig', args: args as never });
}
function safeReason(error: unknown): string { const data = (error as { data?: unknown })?.data; return typeof data === 'string' ? `simulation reverted (${data.slice(0, 10)})` : 'simulation reverted'; }
function setLocalDemoCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin || !LOCAL_DEMO_ORIGINS.has(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Vary', 'Origin');
}

export function createRelayer(options: RelayerOptions) {
  const account = privateKeyToAccount(options.privateKey);
  const counts = new Map<string, { n: number; reset: number }>();
  const chains = new Map(options.chains.map(c => [c.chainId, c]));
  async function relay(input: unknown, ip: string) {
    const now = Date.now(); const bucket = counts.get(ip);
    if (bucket && bucket.reset > now && bucket.n >= (options.rateLimit ?? 10)) fail('rate limit exceeded');
    counts.set(ip, { n: bucket && bucket.reset > now ? bucket.n + 1 : 1, reset: now + 60_000 });
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid request');
    const r = input as Record<string, unknown>; if (!Number.isInteger(r.chainId) || typeof r.account !== 'string' || !['register', 'execute', 'revoke'].includes(String(r.kind))) fail('invalid request');
    const req: Request = { chainId: r.chainId as number, account: address(r.account, 'account'), kind: r.kind as Kind, args: r.args };
    const chain = chains.get(req.chainId); if (!chain) fail('unsupported chain');
    if (!chain.accounts.some(a => a.toLowerCase() === req.account.toLowerCase())) fail('unknown account');
    const args = argsFor(req.kind, req.args); const data = callFor(req.kind, args);
    const publicClient = createPublicClient({ transport: http(chain.rpcUrl) });
    try { await publicClient.call({ to: req.account, data, account: account.address }); } catch (error) { fail(safeReason(error)); }
    const fees = await relayFees(publicClient, chain.gasPriceCap);
    const wallet = createWalletClient({ account, transport: http(chain.rpcUrl) });
    return wallet.sendTransaction({ chain: undefined, to: req.account, data, ...fees });
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    setLocalDemoCors(req, res);
    if (req.method === 'OPTIONS' && req.url === '/relay') { res.statusCode = 204; return void res.end(); }
    if (req.method === 'GET' && req.url === '/health') return void res.end(JSON.stringify({ ok: true }));
    if (req.method !== 'POST' || req.url !== '/relay') { res.statusCode = 404; return void res.end(JSON.stringify({ error: 'not found' })); }
    let body = ''; req.on('data', c => { body += c; if (body.length > MAX_BODY) req.destroy(); });
    req.on('end', async () => { try { const hash = await relay(JSON.parse(body), req.socket.remoteAddress ?? 'unknown'); res.end(JSON.stringify({ hash })); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: (e as Error).message })); } });
  });
  return { server, relay };
}
