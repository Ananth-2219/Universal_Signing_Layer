import { afterEach, expect, it, vi } from 'vitest';
import nextConfig from '../../demo/next.config';
import { relayerIsUp, postRelay, type RelayBody } from '../../demo/src/lib/usl';

afterEach(() => vi.unstubAllEnvs());

it('proxies only health and submission to the configured relayer', async () => {
  vi.stubEnv('NEXT_PUBLIC_RELAYER_URL', '');
  expect(await nextConfig.rewrites!()).toEqual([
    { source: '/api/relayer/health', destination: 'http://127.0.0.1:8787/health' },
    { source: '/api/relayer/relay', destination: 'http://127.0.0.1:8787/relay' },
  ]);
});

it('accepts an HTTP success without depending on JSON, and fails closed on errors', async () => {
  const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw Error('unused'); } }));
  expect(await relayerIsUp('/api/relayer', fetcher)).toBe(true);
  expect(fetcher).toHaveBeenCalledWith('/api/relayer/health', { method: 'GET', headers: {} });
  expect(await relayerIsUp('/api/relayer', async () => ({ ok: false, status: 502, json: async () => ({}) }))).toBe(false);
  expect(await relayerIsUp('/api/relayer', async () => { throw Error('network'); })).toBe(false);
});

it('sends the unchanged signed payload through the same-origin submission endpoint', async () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const fetcher = vi.fn(async function (this: unknown) {
    // Browser fetch throws Illegal invocation if called as an options-object method.
    expect(this).toBeUndefined();
    return { ok: true, status: 200, json: async () => ({ hash }) };
  });
  const body = { chainId: 11155111, kind: 'execute', account: `0x${'12'.repeat(20)}`, args: {
    to: `0x${'34'.repeat(20)}`, value: '1', nonce: '2', deadline: '3', signature: '0xab',
  } } as RelayBody;
  expect(await postRelay({ relayerUrl: '/api/relayer', fetchImpl: fetcher, body })).toBe(hash);
  expect(fetcher).toHaveBeenCalledWith('/api/relayer/relay', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
});
