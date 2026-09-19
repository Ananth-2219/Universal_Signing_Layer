import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { inspect } from 'node:util';
import { getAddress, isAddress, recoverAddress, verifyTypedData, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { afterEach, expect, it, vi } from 'vitest';
import { createMandate } from '../src/core/index.js';
import { createSessionKey, MemoryStore, sessionKeyAddressForGrants } from '../src/keys/index.js';

vi.mock('viem/accounts', async importOriginal => {
  const actual = await importOriginal<typeof import('viem/accounts')>();
  return { ...actual, generatePrivateKey: vi.fn(actual.generatePrivateKey) };
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

const expiry = 2000000000n;
const now = expiry - 1n;
const hash: Hex = `0x${'ab'.repeat(32)}`;
const typedData = {
  domain: { name: 'USLSessionTest', version: '1', chainId: 31337 },
  types: { Action: [{ name: 'amount', type: 'uint256' }] },
  primaryType: 'Action', message: { amount: 1n },
} as const;

it('creates distinct keys with checksummed addresses', () => {
  const a = createSessionKey({ expiry }), b = createSessionKey({ expiry });
  expect(a.address).not.toBe(b.address);
  for (const key of [a, b]) {
    expect(isAddress(key.address)).toBe(true);
    expect(key.address).toBe(getAddress(key.address));
  }
});
it('signs a raw digest with a recoverable 65-byte signature', async () => {
  const key = createSessionKey({ expiry });
  const signature = await key.signHash(hash, now);
  expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
  expect(await recoverAddress({ hash, signature })).toBe(key.address);
});
it('signs standard EIP-712 typed data', async () => {
  const key = createSessionKey({ expiry });
  const signature = await key.signTypedData(typedData, now);
  expect(await verifyTypedData({ ...typedData, signature, address: key.address })).toBe(true);
});
it('is usable before expiry and rejects both signing paths at expiry', async () => {
  const key = createSessionKey({ expiry });
  expect(key.isUsable(now)).toBe(true);
  expect(key.isUsable(expiry)).toBe(false);
  expect(key.isUsable(expiry + 1n)).toBe(false);
  await expect(key.signHash(hash, expiry)).rejects.toThrow('Session key expired');
  await expect(key.signTypedData(typedData, expiry)).rejects.toThrow('Session key expired');
});
it('destroys idempotently and rejects both signing paths afterwards', async () => {
  const key = createSessionKey({ expiry });
  key.destroy(); key.destroy();
  expect(key.isUsable(now)).toBe(false);
  await expect(key.signHash(hash, now)).rejects.toThrow('Session key destroyed');
  await expect(key.signTypedData(typedData, now)).rejects.toThrow('Session key destroyed');
});
it('shows only the address when serialized, converted, inspected, or logged', () => {
  const key = createSessionKey({ expiry });
  const secret = vi.mocked(generatePrivateKey).mock.results.at(-1)!.value as Hex;
  let logged = '';
  new Console(new Writable({ write(chunk, _encoding, done) { logged += chunk; done(); } })).log(key);
  const outputs = [JSON.stringify(key), String(key), inspect(key), logged,
    JSON.stringify(Object.keys(key)), JSON.stringify(Object.getOwnPropertyNames(key))];
  // Assert a boolean so even a failed test never includes secret bytes in diagnostics.
  for (const output of outputs) expect(output.includes(secret)).toBe(false);
  expect(JSON.stringify(key)).toBe(JSON.stringify(key.address));
  expect(String(key)).toBe(key.address);
  expect(inspect(key)).toBe(key.address);
  expect(logged.trim()).toBe(key.address);
  expect(Object.hasOwn(key, 'privateKey')).toBe(false);
});
it('stores, retrieves, and clears a key, invalidating retained handles', () => {
  const store = new MemoryStore(() => now), key = createSessionKey({ expiry });
  expect(store.get()).toBeUndefined();
  store.set(key);
  expect(store.get()).toBe(key);
  store.clear(); store.clear();
  expect(store.get()).toBeUndefined();
  expect(key.isUsable(now)).toBe(false);
});
it('drops expired keys at the boundary and does not revive them if time moves back', () => {
  let time = now;
  const store = new MemoryStore(() => time), key = createSessionKey({ expiry });
  store.set(key);
  expect(store.get()).toBe(key);
  time = expiry;
  expect(store.get()).toBeUndefined();
  time = now;
  expect(store.get()).toBeUndefined();
  expect(key.isUsable(now)).toBe(false);
});
it('uses Unix seconds by default and drops already destroyed keys', () => {
  vi.useFakeTimers(); vi.setSystemTime(Number(now) * 1000);
  const store = new MemoryStore(), key = createSessionKey({ expiry });
  store.set(key);
  expect(store.get()).toBe(key);
  vi.advanceTimersByTime(1000);
  expect(store.get()).toBeUndefined();
  const other = createSessionKey({ expiry: expiry + 10n });
  store.set(other); other.destroy();
  expect(store.get()).toBeUndefined();
});
it('destroys replaced keys but preserves a key set twice', () => {
  const store = new MemoryStore(() => now);
  const a = createSessionKey({ expiry }), b = createSessionKey({ expiry });
  store.set(a); store.set(a);
  expect(a.isUsable(now)).toBe(true);
  store.set(b);
  expect(a.isUsable(now)).toBe(false);
  expect(store.get()).toBe(b);
});
it('supplies the same session address to every EVM grant and rejects an empty store', () => {
  const store = new MemoryStore(() => now), key = createSessionKey({ expiry });
  expect(() => sessionKeyAddressForGrants(store)).toThrow('No usable session key');
  store.set(key);
  const mandate = createMandate({ sessionKey: sessionKeyAddressForGrants(store),
    chains: [31337n, 31338n].map(chainId => ({ chainId, account: key.address })),
    limits: { perTxLimit: 1n, budget: 10n, windowSeconds: 60n, expiry }, nonce: 1n, deadline: now, now });
  expect(mandate.grants.map(g => g.sessionKey)).toEqual([key.address, key.address]);
});
it('rejects invalid time values and non-32-byte digests', async () => {
  expect(() => createSessionKey({ expiry: -1n })).toThrow('uint256');
  const key = createSessionKey({ expiry });
  expect(() => key.isUsable(-1n)).toThrow('uint256');
  await expect(key.signHash('0x1234', now)).rejects.toThrow('bytes32');
});
