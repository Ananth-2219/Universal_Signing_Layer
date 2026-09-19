import type { Address } from 'viem';
import { assertAddress, assertUint256 } from '../core/index.js';
import { parseCaip2 } from '../adapters/registry.js';

export interface TrackerScope { chainId: string; sessionKey: Address; windowSeconds: bigint }
export interface SpendWindow { windowStart: bigint | undefined; spent: bigint }

/** One in-memory tracker per (chainId, sessionKey), scoped by the caller. */
export class SpendTracker {
  readonly chainId: string;
  readonly sessionKey: Address;
  readonly windowSeconds: bigint;
  #windowStart: bigint | undefined;
  #spent = 0n;
  #lastRecordedAt: bigint | undefined;

  constructor(scope: TrackerScope) {
    parseCaip2(scope.chainId); assertAddress(scope.sessionKey, 'sessionKey');
    assertUint256(scope.windowSeconds, 'windowSeconds');
    this.chainId = scope.chainId;
    this.sessionKey = scope.sessionKey.toLowerCase() as Address;
    this.windowSeconds = scope.windowSeconds;
  }
  snapshot(now: bigint): SpendWindow {
    assertUint256(now, 'now');
    if (this.#lastRecordedAt !== undefined && now < this.#lastRecordedAt) throw new Error('Time precedes last recorded spend');
    // A pre-check must not start a window; only a recorded spend starts it.
    if (this.#windowStart === undefined || now >= this.#windowStart + this.windowSeconds) {
      return { windowStart: undefined, spent: 0n };
    }
    return { windowStart: this.#windowStart, spent: this.#spent };
  }
  record(value: bigint, now: bigint): void {
    assertUint256(value, 'value');
    const current = this.snapshot(now);
    const spent = current.spent + value;
    assertUint256(spent, 'spent');
    this.#windowStart = current.windowStart ?? now;
    this.#spent = spent;
    this.#lastRecordedAt = now;
  }
  save(): string {
    return JSON.stringify({ version: 1, chainId: this.chainId, sessionKey: this.sessionKey,
      windowSeconds: String(this.windowSeconds), windowStart: this.#windowStart?.toString() ?? null,
      spent: String(this.#spent), lastRecordedAt: this.#lastRecordedAt?.toString() ?? null });
  }
  static load(json: string): SpendTracker {
    const data = JSON.parse(json);
    if (!data || data.version !== 1 || typeof data.chainId !== 'string') throw new Error('Invalid tracker JSON');
    const uint = (value: unknown): bigint => {
      if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid tracker integer');
      const parsed = BigInt(value); assertUint256(parsed, 'tracker integer'); return parsed;
    };
    const tracker = new SpendTracker({ chainId: data.chainId, sessionKey: data.sessionKey, windowSeconds: uint(data.windowSeconds) });
    const start = data.windowStart === null ? undefined : uint(data.windowStart);
    const last = data.lastRecordedAt === null ? undefined : uint(data.lastRecordedAt);
    const spent = uint(data.spent);
    if ((start === undefined) !== (last === undefined) || (start === undefined && spent !== 0n)
      || (start !== undefined && last !== undefined && (last < start
        || (tracker.windowSeconds > 0n ? last >= start + tracker.windowSeconds : last !== start)))) {
      throw new Error('Inconsistent tracker state');
    }
    tracker.#windowStart = start; tracker.#spent = spent; tracker.#lastRecordedAt = last;
    return tracker;
  }
}
