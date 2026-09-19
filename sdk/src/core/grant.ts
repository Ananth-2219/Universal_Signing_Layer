import { StandardMerkleTree } from '@openzeppelin/merkle-tree';
import { encodeAbiParameters, isAddress, keccak256, maxUint256, type Hex } from 'viem';
import type { Grant } from './types.js';

export const GRANT_ABI = [
  { name: 'owner', type: 'address' },
  { name: 'chainId', type: 'uint256' },
  { name: 'sessionKey', type: 'address' },
  { name: 'perTxLimit', type: 'uint256' },
  { name: 'budget', type: 'uint256' },
  { name: 'windowSeconds', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
] as const;

export function grantValues(grant: Grant) {
  for (const field of ['owner', 'sessionKey'] as const) {
    if (!isAddress(grant[field], { strict: false })) throw new Error(`Invalid ${field} address`);
  }
  for (const field of ['chainId', 'perTxLimit', 'budget', 'windowSeconds', 'expiry', 'nonce'] as const) {
    const value = grant[field];
    if (typeof value !== 'bigint' || value < 0n || value > maxUint256) {
      throw new Error(`${field} must be a uint256 bigint`);
    }
  }
  return [grant.owner, grant.chainId, grant.sessionKey, grant.perTxLimit,
    grant.budget, grant.windowSeconds, grant.expiry, grant.nonce] as const;
}

export function grantLeaf(grant: Grant): Hex {
  // Double hashing separates leaf preimages from 64-byte internal-node preimages.
  return keccak256(keccak256(encodeAbiParameters(GRANT_ABI, grantValues(grant))));
}

export function buildMerkleTree(grants: readonly Grant[]) {
  if (grants.length === 0) throw new Error('A mandate needs at least one grant');
  const owner = grants[0]!.owner.toLowerCase();
  const chains = new Set<bigint>();
  const values = grants.map(grant => {
    const value = grantValues(grant);
    // A mandate has one owner and one unambiguous policy per chain.
    if (grant.owner.toLowerCase() !== owner) throw new Error('Grants must share one owner');
    if (chains.has(grant.chainId)) throw new Error('Duplicate chainId');
    chains.add(grant.chainId);
    return [...value];
  });
  const tree = StandardMerkleTree.of(values, GRANT_ABI.map(field => field.type), { sortLeaves: true });
  return {
    root: tree.root as Hex,
    getProof(grant: Grant): Hex[] {
      // Lookup uses encoded values, so copies and address casing are equivalent.
      return tree.getProof([...grantValues(grant)]) as Hex[];
    },
  };
}
