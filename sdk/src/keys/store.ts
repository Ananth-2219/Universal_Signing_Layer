import type { Address } from 'viem';
import type { SessionKey } from './sessionKey.js';

export interface SessionKeyStore {
  get(): SessionKey | undefined;
  set(key: SessionKey): void;
  clear(): void;
}

/** Owns its key: clearing or replacing it destroys the previous key. */
export class MemoryStore implements SessionKeyStore {
  #key: SessionKey | undefined;
  constructor(private readonly now: () => bigint = () => BigInt(Math.floor(Date.now() / 1000))) {}

  get(): SessionKey | undefined {
    if (this.#key && !this.#key.isUsable(this.now())) this.clear();
    return this.#key;
  }
  set(key: SessionKey): void {
    if (key === this.#key) return;
    this.clear();
    this.#key = key;
  }
  clear(): void {
    // Invalidate retained handles too, rather than merely hiding the stored key.
    this.#key?.destroy();
    this.#key = undefined;
  }
}

export function sessionKeyAddressForGrants(store: SessionKeyStore): Address {
  const key = store.get();
  if (!key) throw new Error('No usable session key in store');
  return key.address;
}
