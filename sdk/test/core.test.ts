import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  concatHex, encodeAbiParameters, hashDomain, hashStruct, hashTypedData, maxUint256,
  recoverAddress, toHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_DOMAIN_TYPE, DOMAIN_TYPE, GRANT_TYPE, MANDATE_TYPE, MANDATE_TYPES,
  ENVELOPE_ABI, chainDomainHash, createMandate, decodeEnvelope, digestFromStructHash,
  domainSeparator, encodeEnvelope, grantStructHash, mandateDigest, mandateStructHash,
  mandateTypedData, signMandate, structsArrayHash, validateGrant, validateMandate,
  verifyEnvelope, verifyMandateSignature, type ApplicationDomain, type Intent, type Mandate,
} from '../src/core/index.js';
import vector from './vectors/mandate.json';
import { vectorMandate } from './vector-inputs.js';

const mandate: Mandate = {
  grants: vector.mandate.grants.map(g => ({
    domain: { chainId: BigInt(g.domain.chainId), verifyingContract: g.domain.verifyingContract as Address },
    sessionKey: g.sessionKey as Address, perTxLimit: BigInt(g.perTxLimit), budget: BigInt(g.budget),
    windowSeconds: BigInt(g.windowSeconds), expiry: BigInt(g.expiry),
  })), nonce: BigInt(vector.mandate.nonce), deadline: BigInt(vector.mandate.deadline),
};
const grant = mandate.grants[0]!;
const owner = vector.owner as Address;
const application = vector.application as Address;
const signature = vector.signature as Hex;
const envelope = vector.envelopes[0] as Hex;
const now = BigInt(vector.now);
const domain: ApplicationDomain = {
  name: 'USLMandate', version: '1', chainId: 31337n,
  verifyingContract: application, salt: `0x${'00'.repeat(32)}`,
};
const input = { envelope, expectedGrant: grant, owner, nonce: mandate.nonce, deadline: mandate.deadline, now, application, domain };
const clone = () => structuredClone(mandate);
const replace = (hex: Hex, byte: number, value: Hex): Hex =>
  `${hex.slice(0, 2 + byte * 2)}${value.slice(2)}${hex.slice(2 + byte * 2 + value.length - 2)}` as Hex;
const word = (n: bigint) => toHex(n, { size: 32 });
const decoded = decodeEnvelope(envelope);
const rawEnvelope = (sig: Hex, hashes = decoded.structsArray) => encodeAbiParameters(
  ENVELOPE_ABI, [envelope.slice(0, 66) as Hex, hashes, sig],
);

it('preserves bigint amount precision and matches the documented fixed inputs', () => {
  const intent: Intent = { chainId: 'eip155:31337', to: grant.sessionKey, amount: 10000000000000001n, asset: 'native' };
  expect(intent.amount).toBe(grant.perTxLimit);
  expect(vectorMandate()).toEqual(mandate);
});

describe('fixed public vectors and independent viem parity', () => {
  it('matches all intermediate hashes, digest, and recovered signer without a key', async () => {
    expect(mandate.grants.map(chainDomainHash)).toEqual(vector.chainDomainHashes);
    expect(mandate.grants.map(grantStructHash)).toEqual(vector.grantStructHashes);
    expect(structsArrayHash(mandate.grants.map(grantStructHash))).toBe(vector.arrayHash);
    expect(mandateStructHash(mandate)).toBe(vector.mandateStructHash);
    expect(domainSeparator()).toBe(vector.domainSeparator);
    expect(mandateDigest(mandate)).toBe(vector.digest);
    expect(await recoverAddress({ hash: vector.digest as Hex, signature })).toBe(owner);
    expect(await verifyMandateSignature(mandate, signature, owner)).toBe(true);
  });
  it('uses the exact canonical type strings and matches viem recursive encoding', () => {
    expect(CHAIN_DOMAIN_TYPE).toBe('EIP712ChainDomain(uint256 chainId,address verifyingContract)');
    expect(GRANT_TYPE).toBe('MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)EIP712ChainDomain(uint256 chainId,address verifyingContract)');
    expect(MANDATE_TYPE).toBe('Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)EIP712ChainDomain(uint256 chainId,address verifyingContract)MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)');
    expect(DOMAIN_TYPE).toBe('EIP712Domain(string name,string version)');
    for (const g of mandate.grants) {
      expect(chainDomainHash(g)).toBe(hashStruct({ data: g.domain, primaryType: 'EIP712ChainDomain', types: MANDATE_TYPES }));
      expect(grantStructHash(g)).toBe(hashStruct({ data: g, primaryType: 'MandateGrant', types: MANDATE_TYPES }));
    }
    expect(mandateStructHash(mandate)).toBe(hashStruct({ data: mandate, primaryType: 'Mandate', types: MANDATE_TYPES }));
    expect(domainSeparator()).toBe(hashDomain({ domain: { name: 'USLMandate', version: '1' }, types: MANDATE_TYPES }));
    expect(mandateDigest(mandate)).toBe(hashTypedData(mandateTypedData(mandate)));
  });
  it.each([0, 1])('matches envelope %i and verifies its own operation', async i => {
    const g = mandate.grants[i]!;
    const encoded = encodeEnvelope({ mandate, signature, ...g.domain, application });
    expect(encoded).toBe(vector.envelopes[i]);
    expect(decodeEnvelope(encoded)).toEqual({ fields: 3, structIndex: i, application, structsArray: vector.grantStructHashes, signature });
    expect(await verifyEnvelope({ ...input, envelope: encoded, expectedGrant: g })).toEqual({ valid: true, digest: vector.digest, signer: owner });
  });
  it('exposes readable grants with exact chainId names and no domain chainId or verifier keys', () => {
    const data = mandateTypedData(mandate);
    expect(data.domain).toEqual({ name: 'USLMandate', version: '1' });
    expect(Object.hasOwn(data.domain, 'chainId')).toBe(false);
    expect(Object.hasOwn(data.domain, 'verifyingContract')).toBe(false);
    expect(data.message.grants.map(g => g.domain.chainId)).toEqual([31337n, 31338n]);
    expect(data.types.EIP712ChainDomain[0].name).toBe('chainId');
  });
});

describe('field and order binding', () => {
  for (const index of [0, 1]) {
    it.each(['chainId', 'verifyingContract', 'sessionKey', 'perTxLimit', 'budget', 'windowSeconds', 'expiry'] as const)(
      `binds grant ${index} %s`, field => {
        const changed = clone(); const g = changed.grants[index]!;
        if (field === 'chainId') g.domain.chainId++;
        else if (field === 'verifyingContract') g.domain.verifyingContract = application;
        else if (field === 'sessionKey') g.sessionKey = application;
        else g[field]++;
        expect(grantStructHash(g)).not.toBe(vector.grantStructHashes[index]);
        expect(structsArrayHash(changed.grants.map(grantStructHash))).not.toBe(vector.arrayHash);
        expect(mandateDigest(changed)).not.toBe(vector.digest);
        expect(mandateDigest(changed)).toBe(hashTypedData(mandateTypedData(changed)));
      },
    );
  }
  it.each(['nonce', 'deadline'] as const)('binds %s in the main struct, without changing the array', field => {
    const changed = clone(); changed[field]++;
    expect(structsArrayHash(changed.grants.map(grantStructHash))).toBe(vector.arrayHash);
    expect(mandateStructHash(changed)).not.toBe(vector.mandateStructHash);
    expect(mandateDigest(changed)).not.toBe(vector.digest);
  });
  it('preserves order and follows the selected grant after swapping', async () => {
    const changed = clone(); changed.grants.reverse();
    expect(mandateDigest(changed)).not.toBe(vector.digest);
    const encoded = encodeEnvelope({ mandate: changed, signature, ...grant.domain, application });
    expect(decodeEnvelope(encoded).structIndex).toBe(1);
    expect((await verifyEnvelope({ ...input, envelope: encoded })).valid).toBe(false);
  });
  it('rejects grant B at the index of grant A', async () => {
    expect(await verifyEnvelope({ ...input, expectedGrant: mandate.grants[1]! })).toMatchObject({ valid: false, reason: 'GRANT_MISMATCH' });
  });
  it('rejects a tampered other grant hash', async () => {
    const hashes = [...decoded.structsArray]; hashes[1] = word(0n);
    expect(await verifyEnvelope({ ...input, envelope: rawEnvelope(signature, hashes) })).toMatchObject({ valid: false, reason: 'SIGNER_MISMATCH' });
  });
});

describe('ERC-5267 domain and application binding', () => {
  it('ignores unflagged chainId, verifyingContract and salt', async () => {
    const other = { ...domain, chainId: 31338n, verifyingContract: grant.sessionKey, salt: word(123n) };
    expect(domainSeparator(other, 3)).toBe(vector.domainSeparator);
    expect(digestFromStructHash(vector.mandateStructHash as Hex, other, 3)).toBe(vector.digest);
    expect(await verifyEnvelope({ ...input, domain: other })).toMatchObject({ valid: true });
  });
  it.each([0, 1, 2, 7, 11, 19, 31])('changing the fields mask to %i changes the digest and fails verification', async fields => {
    expect(digestFromStructHash(vector.mandateStructHash as Hex, domain, fields)).not.toBe(vector.digest);
    expect(await verifyEnvelope({ ...input, envelope: replace(envelope, 9, toHex(fields, { size: 1 })) })).toMatchObject({ valid: false, reason: 'SIGNER_MISMATCH' });
  });
  it('rejects a caller-supplied application that differs from the header', async () => {
    expect(await verifyEnvelope({ ...input, application: grant.sessionKey })).toMatchObject({ valid: false, reason: 'APPLICATION_MISMATCH' });
  });
  it.each(['name', 'version'] as const)('binds the selected domain %s', async field => {
    expect(await verifyEnvelope({ ...input, domain: { ...domain, [field]: 'changed' } })).toMatchObject({ valid: false, reason: 'SIGNER_MISMATCH' });
  });
  it.each([{ chainId: 31337n }, { verifyingContract: application }])('adding a top-level domain field changes viem digest', extra => {
    const data = mandateTypedData(mandate);
    // Let viem infer EIP712Domain here so the additional field is actually encoded.
    const { EIP712Domain: _unused, ...types } = data.types;
    expect(hashTypedData({ ...data, types, domain: { ...data.domain, ...extra } })).not.toBe(vector.digest);
  });
  it('matches viem for all 32 supported domain masks', () => {
    const entries = [
      ['name', 'string'], ['version', 'string'], ['chainId', 'uint256'],
      ['verifyingContract', 'address'], ['salt', 'bytes32'],
    ] as const;
    for (let fields = 0; fields < 32; fields++) {
      const selected = entries.filter((_e, i) => fields & (1 << i));
      const selectedDomain = Object.fromEntries(selected.map(([name]) => [name, domain[name]]));
      const domainFields: { name: string; type: 'string' | 'uint256' | 'address' | 'bytes32' }[] = selected.map(([name, type]) => ({ name, type }));
      expect(domainSeparator(domain, fields)).toBe(hashDomain({ domain: selectedDomain,
        types: { EIP712Domain: domainFields } }));
    }
  });
});

describe('strict envelope parser', () => {
  const malformed: [string, Hex][] = [
    ['wrong magic', replace(envelope, 0, '0x00')], ['too short', '0x1234'],
    ['array offset into header', replace(envelope, 32, word(32n))],
    ['huge array offset', replace(envelope, 32, word(maxUint256))],
    ['unaligned array offset', replace(envelope, 32, word(97n))],
    ['array length overflow', replace(envelope, 96, word(maxUint256))],
    ['empty array', replace(envelope, 96, word(0n))],
    ['overlapping signature offset', replace(envelope, 64, word(128n))],
    ['huge signature offset', replace(envelope, 64, word(maxUint256))],
    ['huge signature length', replace(envelope, 192, word(maxUint256))],
    ['truncated signature', envelope.slice(0, -64) as Hex],
    ['truncated byte', envelope.slice(0, -2) as Hex],
    ['out of bounds index', replace(envelope, 10, '0x0002')],
    ['nonzero signature padding', replace(envelope, (envelope.length - 2) / 2 - 1, '0x01')],
    ['trailing word', concatHex([envelope, word(0n)])],
    ['reserved fields', replace(envelope, 9, '0x80')], ['odd hex', '0x123'], ['non-hex', '0xzz'],
  ];
  it.each(malformed)('rejects %s', async (_name, bytes) => {
    expect(() => decodeEnvelope(bytes)).toThrow();
    expect(await verifyEnvelope({ ...input, envelope: bytes })).toMatchObject({ valid: false, reason: 'MALFORMED_ENVELOPE' });
  });
  it('accepts uppercase hex with equivalent bytes', () => {
    expect(decodeEnvelope(`0x${envelope.slice(2).toUpperCase()}`).structIndex).toBe(0);
  });
});

describe('signature and time boundaries', () => {
  it.each(['nonce', 'deadline'] as const)('rejects a wrong signed %s', async field => {
    expect(await verifyEnvelope({ ...input, [field]: input[field] + 1n })).toMatchObject({ valid: false, reason: 'SIGNER_MISMATCH' });
  });
  it('rejects the wrong signer', async () => {
    expect(await verifyEnvelope({ ...input, owner: application })).toMatchObject({ valid: false, reason: 'SIGNER_MISMATCH' });
    expect(await verifyMandateSignature(mandate, signature, application)).toBe(false);
  });
  it.each(['0x', signature.slice(0, -2), `${signature.slice(0, -2)}00`, `${signature.slice(0, -2)}1d`] as Hex[])(
    'rejects malformed signature %s', async sig => {
      expect(await verifyEnvelope({ ...input, envelope: rawEnvelope(sig) })).toMatchObject({ valid: false, reason: 'INVALID_SIGNATURE' });
      expect(await verifyMandateSignature(mandate, sig, owner)).toBe(false);
    },
  );
  it('accepts deadline == now and expiry == now + 1', async () => {
    expect(grant.expiry).toBe(mandate.deadline + 1n);
    expect(await verifyEnvelope({ ...input, now: mandate.deadline })).toMatchObject({ valid: true });
  });
  it('rejects deadline == now - 1', async () => {
    expect(await verifyEnvelope({ ...input, deadline: now - 1n })).toMatchObject({ valid: false, reason: 'DEADLINE_PASSED' });
  });
  it('rejects expiry == now', async () => {
    expect(await verifyEnvelope({ ...input, expectedGrant: { ...grant, expiry: now } })).toMatchObject({ valid: false, reason: 'SESSION_EXPIRED' });
  });
});

describe('validation', () => {
  it('constructs grants from explicit chain/account and session-key inputs even with wider limit objects', () => {
    const built = createMandate({
      sessionKey: application, chains: [{ chainId: 31338n, account: application }],
      limits: grant, nonce: mandate.nonce, deadline: mandate.deadline, now,
    });
    expect(built.grants[0]!.sessionKey).toBe(application);
    expect(built.grants[0]!.domain).toEqual({ chainId: 31338n, verifyingContract: application });
    expect(built.grants[0]!.perTxLimit).toBe(grant.perTxLimit);
  });
  it('rejects empty and duplicate chain/account pairs, but allows two accounts on one chain', () => {
    expect(() => validateMandate({ ...mandate, grants: [] })).toThrow('at least one');
    expect(() => validateMandate({ ...mandate, grants: [grant, structuredClone(grant)] })).toThrow('Duplicate');
    expect(() => validateMandate({ ...mandate, grants: [grant, { ...grant, domain: { ...grant.domain, verifyingContract: application } }] })).not.toThrow();
  });
  it('rejects past deadline and expired session using injected time', () => {
    expect(() => validateMandate({ ...mandate, deadline: now - 1n }, now)).toThrow('deadline');
    expect(() => validateGrant({ ...grant, expiry: now }, now)).toThrow('expired');
    expect(() => validateGrant({ ...grant, expiry: now + 1n }, now)).not.toThrow();
  });
  it('rejects a zero window because the account contract reverts with InvalidWindow', () => {
    expect(() => validateGrant({ ...grant, windowSeconds: 0n })).toThrow('greater than zero');
    expect(() => validateMandate({ ...mandate, grants: [{ ...grant, windowSeconds: 0n }] })).toThrow('greater than zero');
    expect(() => createMandate({
      sessionKey: grant.sessionKey, chains: [{ chainId: grant.domain.chainId, account: grant.domain.verifyingContract }],
      limits: { ...grant, windowSeconds: 0n }, nonce: mandate.nonce, deadline: mandate.deadline, now,
    })).toThrow('greater than zero');
  });
  it.each(['chainId', 'perTxLimit', 'budget', 'windowSeconds', 'expiry', 'nonce', 'deadline'] as const)(
    'validates uint256 bigint %s', field => {
      for (const value of [-1n, maxUint256 + 1n, 1, '1', undefined]) {
        const changed = clone();
        if (field === 'chainId') Object.assign(changed.grants[0]!.domain, { chainId: value });
        else if (field === 'nonce' || field === 'deadline') Object.assign(changed, { [field]: value });
        else Object.assign(changed.grants[0]!, { [field]: value });
        expect(() => mandateDigest(changed)).toThrow('uint256 bigint');
      }
      for (const value of [0n, maxUint256]) {
        const changed = clone();
        if (field === 'chainId') changed.grants[0]!.domain.chainId = value;
        else if (field === 'nonce' || field === 'deadline') changed[field] = value;
        else changed.grants[0]![field] = value;
        // 0 is a valid uint256 but not a valid window: the account rejects it (InvalidWindow).
        if (field === 'windowSeconds' && value === 0n) {
          expect(() => mandateDigest(changed)).toThrow('greater than zero');
          continue;
        }
        expect(() => mandateDigest(changed)).not.toThrow();
      }
    },
  );
  it.each(['nonce', 'deadline', 'now'] as const)('requires a uint256 bigint verification %s', async field => {
    for (const value of [-1n, maxUint256 + 1n, 1, undefined]) {
      expect(await verifyEnvelope({ ...input, [field]: value } as typeof input)).toMatchObject({ valid: false, reason: 'INVALID_INPUT' });
    }
  });
  it('rejects bad addresses and accepts checksum casing differences throughout encoding', () => {
    expect(() => grantStructHash({ ...grant, sessionKey: '0x1234' })).toThrow('address');
    expect(() => chainDomainHash({ ...grant, domain: { ...grant.domain, verifyingContract: '0x1234' } })).toThrow('address');
    const changed = clone();
    changed.grants[0]!.sessionKey = '0xAbCdabcdefabcdefabcdefabcdefabcdefabcdef';
    changed.grants[0]!.domain.verifyingContract = changed.grants[0]!.sessionKey;
    expect(mandateDigest(changed)).toBe(hashTypedData(mandateTypedData(changed)));
    const duplicate = structuredClone(changed.grants[0]!);
    duplicate.domain.verifyingContract = duplicate.domain.verifyingContract.toLowerCase() as Address;
    expect(() => validateMandate({ ...changed, grants: [changed.grants[0]!, duplicate] })).toThrow('Duplicate');
  });
  it('rejects missing selected grants and invalid construction time', () => {
    expect(() => encodeEnvelope({ mandate, signature, chainId: 999n, verifyingContract: application, application })).toThrow('index');
    expect(() => createMandate({ sessionKey: grant.sessionKey, chains: [], limits: grant, nonce: 0n, deadline: 0n, now: -1n })).toThrow('now');
  });
});

function readTestKey(): Hex | undefined {
  try { return parse(readFileSync(new URL('../../.env', import.meta.url))).TEST_VECTOR_KEY as Hex | undefined; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read local test environment');
  }
}
const testKey = readTestKey();
it('reproduces the public signature from TEST_VECTOR_KEY', async context => {
  if (!testKey) context.skip('TEST_VECTOR_KEY missing: public verification still runs; exact private signing reproduction skipped');
  let account;
  try { account = privateKeyToAccount(testKey!); }
  catch { throw new Error('TEST_VECTOR_KEY must be a valid dedicated test key'); }
  expect(account.address).toBe(owner);
  expect(await signMandate(mandate, account)).toBe(signature);
});
