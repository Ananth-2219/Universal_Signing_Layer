import { webcrypto } from 'node:crypto';
import { decodeFunctionData, getAddress, maxUint256, verifyTypedData, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeEnvelope } from '../src/core/index.js';
import { createSessionKey } from '../src/keys/index.js';
import { ACCOUNT_ABI, AdapterRegistry, EvmAdapter, NeedsConsentError, ViemSubmitter, parseCaip2, randomNonce, type Intent } from '../src/adapters/index.js';
import vector from './vectors/mandate.json';
import { vectorMandate } from './vector-inputs.js';

afterEach(() => vi.unstubAllGlobals());
const chainId = 'eip155:31337';
const account: Address = '0x1111111111111111111111111111111111111111';
const otherAccount: Address = '0x2222222222222222222222222222222222222222';
const recipient: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const token: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const hash: Hex = `0x${'ab'.repeat(32)}`;
const now = 1900000000n;
const context = { account, now };
const intent: Intent = { chainId, to: recipient, amount: 11n, asset: 'native' };
const wait = vi.fn(async () => ({ status: 'success' as const, blockNumber: 7n }));
const publicClient = { waitForTransactionReceipt: wait } as unknown as PublicClient;
const adapter = new EvmAdapter({ chainId, publicClient, nonceGenerator: () => 42n });
const operation = () => adapter.buildOperation(intent, context);

it('registers, retrieves, rejects duplicates, and lists known chains on lookup failure', () => {
  const registry = new AdapterRegistry();
  expect(() => registry.get(chainId)).toThrow('(none)');
  registry.register(adapter);
  expect(registry.get(chainId)).toBe(adapter);
  expect(() => registry.register(adapter)).toThrow('already registered');
  expect(() => registry.get('eip155:84532')).toThrow('known chains: eip155:31337');
});
it('parses decimal eip155 CAIP-2 IDs', () => {
  expect(parseCaip2('eip155:11155111')).toEqual({ namespace: 'eip155', reference: '11155111', numericChainId: 11155111n });
});
it.each(['eip155', 'eip155:', 'eip155:-1', 'eip155:1.5', 'eip155:01', 'eip155:0x1', 'eip155:1:2'])(
  'rejects invalid CAIP-2 %s', value => expect(() => parseCaip2(value)).toThrow('Invalid'),
);
it('rejects unsupported namespaces and numeric overflow', () => {
  expect(() => parseCaip2('solana:devnet')).toThrow('eip155 namespace');
  expect(() => parseCaip2(`eip155:${maxUint256 + 1n}`)).toThrow('uint256');
});
it('builds exactly the frozen native Operation with injected time and uint256 nonce', () => {
  expect(operation()).toEqual({ to: recipient, value: 11n, nonce: 42n, deadline: now + 300n });
  expect(Object.keys(operation())).toEqual(['to', 'value', 'nonce', 'deadline']);
  expect(adapter.buildOperation({ ...intent, data: '0x' }, { ...context, ttlSeconds: 12n })).toMatchObject({ deadline: now + 12n });
});
it.each([
  { asset: token }, { asset: token, data: '0xa9059cbb' }, { data: '0x00' }, { data: '0xa9059cbb' }, { data: '0x095ea7b3' },
])('requires fresh consent for token or calldata intent %#', change => {
  expect(() => adapter.buildOperation({ ...intent, ...change } as Intent, context)).toThrow(NeedsConsentError);
});
it('rejects legacy Operations carrying calldata or an asset field instead of silently dropping them', () => {
  const extras = [{ data: '0x1234' as Hex }, { asset: token }, { data: '0x1234' as Hex, asset: token }];
  for (const extra of extras) {
    const legacy = { ...operation(), ...extra };
    expect(() => adapter.operationTypedData(legacy, account)).toThrow(NeedsConsentError);
    expect(() => adapter.buildExecuteRequest(legacy, account, vector.signature as Hex)).toThrow(NeedsConsentError);
  }
});
it('exposes exactly the two frozen account ABI fragments with frozen tuple shapes', () => {
  expect(ACCOUNT_ABI.map(item => [item.type, item.name])).toEqual([
    ['function', 'executeWithSessionSig'], ['function', 'registerMandate'],
  ]);
  const execute = ACCOUNT_ABI.find(f => f.name === 'executeWithSessionSig')!;
  expect(execute.inputs.map(input => input.type)).toEqual(['tuple', 'bytes']);
  expect(execute.inputs[0].components.map(field => `${field.name}:${field.type}`))
    .toEqual(['to:address', 'value:uint256', 'nonce:uint256', 'deadline:uint256']);
  const register = ACCOUNT_ABI.find(f => f.name === 'registerMandate')!;
  expect(register.inputs.map(input => input.type)).toEqual(['tuple', 'uint256', 'uint256', 'bytes']);
  expect(register.inputs[0].components.map(field => `${field.name}:${field.type}`)).toEqual([
    'domain:tuple', 'sessionKey:address', 'perTxLimit:uint256', 'budget:uint256', 'windowSeconds:uint256', 'expiry:uint256',
  ]);
  expect(register.inputs[0].components[0].components.map(field => `${field.name}:${field.type}`))
    .toEqual(['chainId:uint256', 'verifyingContract:address']);
});
it.each([
  { chainId: 'eip155:31338' }, { amount: -1n }, { amount: maxUint256 + 1n },
  { to: '0x1234' }, { asset: '0x1234' }, { data: 'hello' }, { data: '0x123' },
])('rejects invalid intent case %#', change => {
  expect(() => adapter.buildOperation({ ...intent, ...change } as Intent, context)).toThrow();
});
it('validates account, injected times, nonce bounds, and deadline overflow', () => {
  expect(() => adapter.buildOperation(intent, { ...context, account: '0x1234' })).toThrow('address');
  expect(() => adapter.buildOperation(intent, { ...context, now: -1n })).toThrow('uint256');
  expect(() => adapter.buildOperation(intent, { ...context, ttlSeconds: -1n })).toThrow('uint256');
  expect(() => adapter.buildOperation(intent, { ...context, now: maxUint256 })).toThrow('uint256');
  const bad = new EvmAdapter({ chainId, publicClient, nonceGenerator: () => -1n });
  expect(() => bad.buildOperation(intent, context)).toThrow('nonce');
});
it('uses 32 bytes of browser cryptographic randomness for default nonces', () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => webcrypto.getRandomValues(bytes));
  vi.stubGlobal('crypto', { getRandomValues });
  const live = new EvmAdapter({ chainId, publicClient });
  const a = live.buildOperation(intent, context).nonce, b = randomNonce();
  expect(a).not.toBe(b); expect(a >= 0n && a <= maxUint256).toBe(true);
  expect(getRandomValues.mock.calls[0]![0]).toHaveLength(32);
});
it('signs Operations and binds them to both chain and account', async () => {
  const key = createSessionKey({ expiry: now + 100n });
  const data = adapter.operationTypedData(operation(), account);
  const signature = await adapter.signOperation(operation(), account, key, now);
  expect(data.domain).toEqual({ name: 'USLMandate', version: '1', chainId: 31337n, verifyingContract: account });
  expect(data.types.Operation).toEqual([
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ]);
  expect(await verifyTypedData({ ...data, signature, address: key.address })).toBe(true);
  for (const change of [{ chainId: 31338n }, { verifyingContract: otherAccount }]) {
    expect(await verifyTypedData({ ...data, domain: { ...data.domain, ...change }, signature, address: key.address })).toBe(false);
  }
});
it('rejects signing with an expired session key', async () => {
  const key = createSessionKey({ expiry: now });
  await expect(adapter.signOperation(operation(), account, key, now)).rejects.toThrow('expired');
});
it('round-trips the operation and signature through execute calldata', async () => {
  const key = createSessionKey({ expiry: now + 100n }), op = operation();
  const signature = await adapter.signOperation(op, account, key, now);
  const req = adapter.buildExecuteRequest(op, account, signature);
  expect(req).toMatchObject({ chainId, to: account, value: 0n });
  const execute = ACCOUNT_ABI.find(f => f.name === 'executeWithSessionSig')!;
  expect(execute.inputs[0].components.map(field => field.type)).toEqual(['address', 'uint256', 'uint256', 'uint256']);
  const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: req.data });
  expect(decoded).toEqual({ functionName: 'executeWithSessionSig', args: [{ ...op, to: getAddress(op.to) }, signature] });
  // The frozen Operation has exactly four fields: no data, no asset, no token fields.
  expect(Object.keys(decoded.args[0])).toEqual(['to', 'value', 'nonce', 'deadline']);
});
it.each([0, 1])('registers the correct grant and envelope index %i', index => {
  const mandate = vectorMandate(), grant = mandate.grants[index]!;
  const local = new EvmAdapter({ chainId: `eip155:${grant.domain.chainId}`, publicClient });
  const req = local.buildRegistrationRequest({ mandate, signature: vector.signature as Hex,
    account: grant.domain.verifyingContract, application: vector.application as Address });
  expect(req).toMatchObject({ chainId: local.chainId, to: grant.domain.verifyingContract, value: 0n });
  const decoded = decodeFunctionData({ abi: ACCOUNT_ABI, data: req.data });
  expect(decoded.functionName).toBe('registerMandate');
  if (decoded.functionName !== 'registerMandate') throw new Error('Wrong function');
  expect(decoded.args.slice(0, 3)).toEqual([grant, mandate.nonce, mandate.deadline]);
  expect(decoded.args[3]).toBe(vector.envelopes[index]);
  expect(decodeEnvelope(decoded.args[3]).structIndex).toBe(index);
});
it('clearly rejects a mandate missing this chain/account pair', () => {
  const req = { mandate: vectorMandate(), signature: vector.signature as Hex, account: recipient, application: account };
  expect(() => adapter.buildRegistrationRequest(req)).toThrow('No mandate grant');
  const other = new EvmAdapter({ chainId: 'eip155:84532', publicClient });
  expect(() => other.buildRegistrationRequest({ ...req, account })).toThrow('No mandate grant');
});
it('delegates submission without exposing the session key and prevents wrong-chain routing', async () => {
  const submitter = { submit: vi.fn(async () => hash) };
  const req = { chainId, to: account, data: '0x' as Hex, value: 0n };
  expect(await adapter.submit(req, submitter)).toBe(hash);
  expect(submitter.submit).toHaveBeenCalledExactlyOnceWith(req);
  expect(() => adapter.submit({ ...req, chainId: 'eip155:31338' }, submitter)).toThrow('chain');
});
it.each(['success', 'reverted'] as const)('returns a %s receipt from the injected public client', async status => {
  const receipt = vi.fn(async () => ({ status, blockNumber: 99n }));
  const local = new EvmAdapter({ chainId, publicClient: { waitForTransactionReceipt: receipt } as unknown as PublicClient });
  expect(await local.waitForReceipt(hash)).toEqual({ status, blockNumber: 99n });
  expect(receipt).toHaveBeenCalledWith({ hash });
});
it('submits through the funded wallet and checks its account and chain configuration', async () => {
  const sendTransaction = vi.fn(async () => hash);
  const wallet = { account: { address: account, type: 'json-rpc' }, chain: { id: 31337 }, sendTransaction };
  const submitter = new ViemSubmitter(wallet as unknown as WalletClient);
  const req = { chainId, to: recipient, data: '0x' as Hex };
  expect(await submitter.submit(req)).toBe(hash);
  expect(sendTransaction).toHaveBeenCalledExactlyOnceWith({ account: wallet.account, chain: wallet.chain, to: recipient, data: '0x', value: 0n });
  await expect(submitter.submit({ ...req, chainId: 'eip155:31338' })).rejects.toThrow('chain mismatch');
  const missing = new ViemSubmitter({ ...wallet, account: undefined } as unknown as WalletClient);
  await expect(missing.submit(req)).rejects.toThrow('configured account and chain');
});
