import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import {
  concatHex, encodeAbiParameters, hashTypedData, keccak256, maxUint256,
  recoverAddress, stringToHex, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  buildMerkleTree, grantLeaf, mandateDigest, mandateTypedData,
  signMandate, verifyMandateSignature, type Grant, type Intent, type Mandate,
} from '../src/core/index.js';
import vector from './vectors/mandate.json';

const owner = vector.owner as Address;
const root = vector.root as Hex;
const signature = vector.signature as Hex;
const grants: Grant[] = vector.grants.map(g => ({
  owner: g.owner as Address, chainId: BigInt(g.chainId), sessionKey: g.sessionKey as Address,
  perTxLimit: BigInt(g.perTxLimit), budget: BigInt(g.budget),
  windowSeconds: BigInt(g.windowSeconds), expiry: BigInt(g.expiry), nonce: BigInt(g.nonce),
}));
const first = grants[0]!;
// Independent of the production ABI constant: field-order regressions must fail.
const encoding = ['address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'];
const tuples = grants.map(g => [g.owner, g.chainId, g.sessionKey, g.perTxLimit,
  g.budget, g.windowSeconds, g.expiry, g.nonce]);

describe('public fixed vectors', () => {
  it('matches every double-hashed leaf, the root, and each proof', () => {
    const tree = buildMerkleTree(grants);
    expect(grants.map(grantLeaf)).toEqual(vector.leaves);
    expect(tree.root).toBe(root);
    expect(grants.map(g => tree.getProof(g))).toEqual(vector.proofs);
    for (let i = 0; i < grants.length; i++) {
      expect(StandardMerkleTree.verify(root, encoding, tuples[i]!, vector.proofs[i]!)).toBe(true);
    }
  });

  it('agrees with OpenZeppelin using independently specified ABI field order', () => {
    const reference = StandardMerkleTree.of(tuples, encoding);
    expect(reference.root).toBe(root);
    expect(reference.getProof(0)).toEqual(vector.proofs[0]);
  });

  it('matches the fixed EIP-712 digest and recovers the known public signer', async () => {
    expect(mandateDigest(root)).toBe(vector.digest);
    expect(await recoverAddress({ hash: vector.digest as Hex, signature })).toBe(owner);
    expect(await verifyMandateSignature(root, signature, owner)).toBe(true);
  });

  it('matches the explicit Solidity EIP-712 formula without a chain or contract', () => {
    const domainSeparator = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(stringToHex('EIP712Domain(string name,string version)')),
        keccak256(stringToHex('USLMandate')), keccak256(stringToHex('1'))],
    ));
    const structHash = keccak256(encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }],
      [keccak256(stringToHex('Mandate(bytes32 root)')), root],
    ));
    expect(keccak256(concatHex(['0x1901', domainSeparator, structHash]))).toBe(vector.digest);
    expect(mandateTypedData(root).domain).toEqual({ name: 'USLMandate', version: '1' });
  });
});

describe('Merkle membership and grant validation', () => {
  it('is order independent for all permutations of three grants', () => {
    for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      const tree = buildMerkleTree(order.map(i => grants[i]!));
      expect(tree.root).toBe(root);
      expect(tree.getProof({ ...first })).toEqual(vector.proofs[0]);
    }
  });

  it('uses the leaf as a single-grant root and returns an empty proof', () => {
    const tree = buildMerkleTree([first]);
    expect(tree.root).toBe(vector.leaves[0]);
    expect(tree.getProof(first)).toEqual([]);
  });

  it('looks up equivalent address casing and snapshots input values', () => {
    const copy = grants.map(g => ({ ...g }));
    const tree = buildMerkleTree(copy);
    copy[0]!.nonce++;
    const lower = { ...first, owner: first.owner.toLowerCase() as Address };
    expect(tree.getProof(lower)).toEqual(vector.proofs[0]);
    expect(tree.root).toBe(root);
    expect(() => tree.getProof(copy[0]!)).toThrow();
  });

  it.each(['owner', 'chainId', 'sessionKey', 'perTxLimit', 'budget', 'windowSeconds', 'expiry', 'nonce'] as const)(
    'binds the %s field', field => {
      const changed = { ...first };
      if (field === 'owner' || field === 'sessionKey') changed[field] = '0x4444444444444444444444444444444444444444';
      else changed[field]++;
      expect(grantLeaf(changed)).not.toBe(vector.leaves[0]);
      expect(() => buildMerkleTree(grants).getProof(changed)).toThrow();
    },
  );

  it('rejects empty, duplicate-chain, and mixed-owner mandates', () => {
    expect(() => buildMerkleTree([])).toThrow('at least one');
    expect(() => buildMerkleTree([first, { ...first, nonce: 99n }])).toThrow('Duplicate chainId');
    expect(() => buildMerkleTree([first, { ...grants[1]!, owner: first.sessionKey }])).toThrow('one owner');
  });

  it.each(['chainId', 'perTxLimit', 'budget', 'windowSeconds', 'expiry', 'nonce'] as const)(
    'validates uint256 bounds and bigint type for %s', field => {
      for (const invalid of [-1n, maxUint256 + 1n, 1, '1']) {
        expect(() => grantLeaf({ ...first, [field]: invalid } as Grant)).toThrow('uint256 bigint');
      }
      expect(() => grantLeaf({ ...first, [field]: 0n })).not.toThrow();
      expect(() => grantLeaf({ ...first, [field]: maxUint256 })).not.toThrow();
    },
  );

  it.each(['owner', 'sessionKey'] as const)('rejects malformed %s addresses', field => {
    expect(() => grantLeaf({ ...first, [field]: '0x1234' })).toThrow('address');
  });

  it('rejects a tampered proof', () => {
    const proof = [...vector.proofs[0]!];
    proof[0] = `0x${'00'.repeat(32)}`;
    expect(StandardMerkleTree.verify(root, encoding, tuples[0]!, proof)).toBe(false);
  });
});

describe('signature boundaries', () => {
  it('rejects the wrong signer, changed root, and malformed signatures', async () => {
    expect(await verifyMandateSignature(root, signature, first.sessionKey)).toBe(false);
    expect(await verifyMandateSignature(vector.leaves[0] as Hex, signature, owner)).toBe(false);
    expect(await verifyMandateSignature(root, '0x1234', owner)).toBe(false);
  });

  it('changes the digest when forbidden domain fields or a different version are added', () => {
    const data = mandateTypedData(root);
    for (const extra of [{ chainId: 11155111 }, { verifyingContract: first.sessionKey }, { version: '2' }]) {
      expect(hashTypedData({ ...data, domain: { ...data.domain, ...extra } })).not.toBe(vector.digest);
    }
  });

  it.each(['0x', '0x12', `0x${'00'.repeat(33)}`, `0x${'zz'.repeat(32)}`])('rejects malformed root %s', badRoot => {
    expect(() => mandateDigest(badRoot as Hex)).toThrow('bytes32');
  });
});

function readTestKey(): Hex | undefined {
  try {
    return parse(readFileSync(new URL('../../.env', import.meta.url))).TEST_VECTOR_KEY as Hex | undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('Could not read the local test environment');
  }
}
const testKey = readTestKey();
it.skipIf(!testKey)('reproduces the fixed signature using only the dedicated key in .env', async () => {
  let account;
  try {
    account = privateKeyToAccount(testKey!);
  } catch {
    throw new Error('TEST_VECTOR_KEY must be a valid test-only secp256k1 key');
  }
  expect(account.address).toBe(owner);
  expect(await signMandate(root, account)).toBe(signature);
});

it('represents chain-agnostic intents and EVM mandates without losing amount precision', () => {
  const intent: Intent = { chainId: 'eip155:11155111', to: first.sessionKey,
    amount: 10000000000000001n, asset: 'native', data: '0x' };
  const mandate: Mandate = { owner, grants };
  expect(intent.amount).toBe(10000000000000001n);
  expect(buildMerkleTree(mandate.grants).root).toBe(root);
});
