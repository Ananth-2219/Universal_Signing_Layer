import { describe, expect, it } from 'vitest';
import { maxUint256, type Address } from 'viem';
import { MockPriceProvider, toNativeLimit } from '../src/policy/price.js';
import { SpendTracker } from '../src/policy/tracker.js';
import { evaluate } from '../src/policy/evaluate.js';
import type { MandateGrant } from '../src/core/index.js';
import type { Intent } from '../src/adapters/types.js';

const chainId = 'eip155:31337';
const sessionKey: Address = '0x3333333333333333333333333333333333333333';
const grant: MandateGrant = {
  domain: { chainId: 31337n, verifyingContract: '0x1111111111111111111111111111111111111111' },
  sessionKey, perTxLimit: 10n, budget: 20n, windowSeconds: 10n, expiry: 1000n,
};
const intent: Intent = { chainId, to: '0x2222222222222222222222222222222222222222', amount: 10n, asset: 'native' };
const fresh = (scope = {}) => new SpendTracker({ chainId, sessionKey, windowSeconds: grant.windowSeconds, ...scope });

describe('native-only policy decisions', () => {
  it.each([
    ['per-tx equality', intent, grant, 100n, 'allow'],
    ['per-tx excess', { ...intent, amount: 11n }, grant, 100n, 'needs_consent'],
    ['expiry equality', intent, grant, 1000n, 'deny'],
    ['before expiry', intent, grant, 999n, 'allow'],
    ['missing grant', intent, undefined, 100n, 'deny'],
    ['wrong chain grant', { ...intent, chainId: 'eip155:31338' }, grant, 100n, 'deny'],
    ['empty calldata', { ...intent, data: '0x' }, grant, 100n, 'allow'],
    ['nonempty calldata', { ...intent, data: '0x00' }, grant, 100n, 'needs_consent'],
    ['token without calldata', { ...intent, asset: intent.to }, grant, 100n, 'needs_consent'],
    ['approval call', { ...intent, data: '0x095ea7b3' }, grant, 100n, 'needs_consent'],
    ['expired token grant', { ...intent, asset: intent.to }, grant, 1000n, 'deny'],
    ['negative amount', { ...intent, amount: -1n }, grant, 100n, 'deny'],
  ] as const)('%s', (_name, request, permission, now, expected) => {
    expect(evaluate(request as Intent, permission, fresh(), now).decision).toBe(expected);
  });
  it('returns a reason and does not reserve or spend budget when checking', () => {
    const tracker = fresh();
    const before = tracker.save();
    expect(evaluate(intent, grant, tracker, 100n)).toEqual({ decision: 'allow', reason: 'Within native-transfer limits' });
    expect(tracker.save()).toBe(before);
  });
  it.each([
    { chainId: 'eip155:31338' }, { sessionKey: intent.to }, { windowSeconds: 11n },
  ])('rejects mismatched tracker scope %#', scope => {
    expect(evaluate(intent, grant, fresh(scope), 100n).decision).toBe('deny');
  });
  it('accounts independently per chain and session', () => {
    const a = fresh(), b = fresh({ sessionKey: intent.to }), c = fresh({ chainId: 'eip155:31338' });
    a.record(20n, 100n);
    expect(evaluate(intent, grant, a, 101n).decision).toBe('needs_consent');
    expect(evaluate(intent, { ...grant, sessionKey: intent.to }, b, 101n).decision).toBe('allow');
    expect(evaluate({ ...intent, chainId: c.chainId }, { ...grant, domain: { ...grant.domain, chainId: 31338n } }, c, 101n).decision).toBe('allow');
  });
});

describe('fixed-window spending', () => {
  it.each([[109n, 'needs_consent'], [110n, 'allow'], [10000n, 'allow']] as const)(
    'checks the fixed-window boundary at %s', (now, expected) => {
      const tracker = fresh(); tracker.record(20n, 100n);
      expect(evaluate(intent, { ...grant, expiry: 20000n }, tracker, now).decision).toBe(expected);
    },
  );
  it('anchors each window at its first recorded spend, not an earlier pre-check', () => {
    const tracker = fresh();
    tracker.snapshot(0n); tracker.record(10n, 100n); tracker.record(10n, 105n);
    expect(tracker.snapshot(109n)).toEqual({ windowStart: 100n, spent: 20n });
    expect(tracker.snapshot(110n)).toEqual({ windowStart: undefined, spent: 0n });
    tracker.record(1n, 115n);
    expect(tracker.snapshot(115n)).toEqual({ windowStart: 115n, spent: 1n });
  });
  it('allows exact budget equality and blocks the next small spend (drip attack)', () => {
    const tracker = fresh(), small = { ...intent, amount: 1n };
    for (let i = 0; i < 20; i++) {
      expect(evaluate(small, grant, tracker, 100n).decision).toBe('allow');
      tracker.record(1n, 100n);
    }
    expect(tracker.snapshot(100n).spent).toBe(20n);
    expect(evaluate(small, grant, tracker, 100n).decision).toBe('needs_consent');
  });
  it('documents the near-2x boundary burst permitted by fixed windows', () => {
    const tracker = fresh(), permission = { ...grant, perTxLimit: 100n, budget: 100n };
    tracker.record(1n, 100n); // Starts the window; leaves 99 for the last second.
    let burst = 0n;
    for (const [amount, now] of [[99n, 109n], [100n, 110n]] as const) {
      expect(evaluate({ ...intent, amount }, permission, tracker, now).decision).toBe('allow');
      tracker.record(amount, now);
      burst += amount;
    }
    expect(burst).toBe(199n); // Almost 2 * budget within one second.
    expect(evaluate({ ...intent, amount: 1n }, permission, tracker, 110n).decision).toBe('needs_consent');
  });
  it('keeps spending and limits exact beyond Number.MAX_SAFE_INTEGER', () => {
    const amount = 9007199254740993n, tracker = fresh();
    const permission = { ...grant, perTxLimit: amount, budget: 2n * amount };
    tracker.record(amount, 0n);
    expect(evaluate({ ...intent, amount }, permission, tracker, 1n).decision).toBe('allow');
    tracker.record(amount, 1n);
    expect(tracker.snapshot(1n).spent).toBe(18014398509481986n);
    expect(evaluate({ ...intent, amount: 1n }, permission, tracker, 1n).decision).toBe('needs_consent');
  });
  it('follows the specified reset expression even for a zero-duration window', () => {
    const tracker = fresh({ windowSeconds: 0n }); tracker.record(20n, 100n);
    expect(evaluate(intent, { ...grant, windowSeconds: 0n }, tracker, 100n).decision).toBe('allow');
  });
});

describe('tracker persistence', () => {
  it('round-trips empty and populated state with bigint precision and scope', () => {
    const tracker = fresh();
    expect(SpendTracker.load(tracker.save()).save()).toBe(tracker.save());
    tracker.record(9007199254740993n, 0n); tracker.record(1n, 1n);
    const restored = SpendTracker.load(tracker.save());
    expect(restored.save()).toBe(tracker.save());
    expect(restored.snapshot(9n)).toEqual({ windowStart: 0n, spent: 9007199254740994n });
    expect(restored.snapshot(10n).spent).toBe(0n);
  });
  it.each([
    { spent: 1 }, { spent: '-1' }, { spent: '1' }, { version: 2 },
    { windowStart: '2', lastRecordedAt: '1' }, { windowStart: '0', lastRecordedAt: '10' },
    { sessionKey: '0x1234' }, { chainId: 'solana:devnet' },
  ])('rejects corrupt or inconsistent JSON state %#', patch => {
    expect(() => SpendTracker.load(JSON.stringify({ ...JSON.parse(fresh().save()), ...patch }))).toThrow();
  });
  it('rejects backwards time and invalid or overflowing spends without modifying state', () => {
    const tracker = fresh(); tracker.record(maxUint256, 100n);
    const before = tracker.save();
    expect(() => tracker.record(1n, 100n)).toThrow('spent');
    expect(() => tracker.record(-1n, 100n)).toThrow('uint256');
    expect(() => tracker.snapshot(99n)).toThrow('Time');
    expect(evaluate(intent, grant, tracker, 99n).decision).toBe('deny');
    expect(tracker.save()).toBe(before);
  });
});

describe('mandate-creation price conversion', () => {
  it.each([
    [10_000000n, 2000_000000n, 5_000000000000000n],
    [1n, 3n, 333333333333333333n],
    [0n, 1n, 0n],
    [9007199254740993n, 10n ** 18n, 9007199254740993n],
  ])('converts USD %s at price %s to %s wei exactly', (usd, price, expected) => {
    expect(toNativeLimit(usd, price)).toBe(expected);
  });
  it('rejects invalid prices, amounts, and uint256 overflow', () => {
    for (const [usd, price] of [[1n, 0n], [1n, -1n], [-1n, 1n], [maxUint256, 1n]]) {
      expect(() => toNativeLimit(usd!, price!)).toThrow();
    }
    expect(() => toNativeLimit(1.5 as unknown as bigint, 1n)).toThrow('bigint');
  });
  it('provides deterministic mock prices and reports missing or invalid prices', async () => {
    const prices = { 'eip155:31337': 2000_000000n };
    const provider = new MockPriceProvider(prices);
    prices['eip155:31337'] = 1n;
    expect(await provider.getNativeUsdPrice('eip155:31337')).toBe(2000_000000n);
    await expect(provider.getNativeUsdPrice('eip155:31338')).rejects.toThrow('No native USD price');
    await expect(new MockPriceProvider({ 'eip155:31337': 0n }).getNativeUsdPrice('eip155:31337')).rejects.toThrow('positive');
  });
});
