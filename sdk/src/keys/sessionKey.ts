import type { Address, Hex, TypedData, TypedDataDefinition } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { assertBytes32, assertUint256 } from '../core/index.js';

export interface SessionKey {
  readonly address: Address;
  readonly expiry: bigint;
  isUsable(now: bigint): boolean;
  signHash(hash: Hex, now: bigint): Promise<Hex>;
  signTypedData<const T extends TypedData | Record<string, unknown>, P extends keyof T | 'EIP712Domain' = keyof T>(
    typedData: TypedDataDefinition<T, P>, now: bigint,
  ): Promise<Hex>;
  destroy(): void;
  toJSON(): Address;
  toString(): string;
}

export function createSessionKey({ expiry }: { expiry: bigint }): SessionKey {
  assertUint256(expiry, 'expiry');
  // Only the closure holds the signing account; no key or account escapes it.
  let account: PrivateKeyAccount | undefined = privateKeyToAccount(generatePrivateKey());
  const address = account.address;
  function usableAccount(now: bigint): PrivateKeyAccount {
    assertUint256(now, 'now');
    if (!account) throw new Error('Session key destroyed');
    if (expiry <= now) throw new Error('Session key expired');
    return account;
  }
  return Object.freeze({
    address,
    expiry,
    isUsable(now: bigint) {
      assertUint256(now, 'now');
      return account !== undefined && expiry > now;
    },
    async signHash(hash: Hex, now: bigint) {
      const signer = usableAccount(now);
      assertBytes32(hash);
      return signer.sign({ hash });
    },
    async signTypedData<const T extends TypedData | Record<string, unknown>, P extends keyof T | 'EIP712Domain' = keyof T>(
      typedData: TypedDataDefinition<T, P>, now: bigint,
    ) {
      return usableAccount(now).signTypedData(typedData);
    },
    destroy() {
      // Drop the reference; JavaScript cannot guarantee physical memory erasure.
      account = undefined;
    },
    toJSON: () => address,
    toString: () => address,
    // Symbol.for keeps the browser module free of Node imports.
    [Symbol.for('nodejs.util.inspect.custom')]: () => address,
  });
}
