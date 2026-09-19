import {
  concatHex, encodeAbiParameters, keccak256, recoverAddress, stringToHex,
  type Address, type Hex, type LocalAccount,
} from 'viem';
import type { ApplicationDomain, GrantLimits, Mandate, MandateGrant } from './types.js';
import { assertAddress, assertBytes32, assertUint256, validateGrant, validateMandate } from './validation.js';

export const MANDATE_DOMAIN = Object.freeze({ name: 'USLMandate', version: '1' });
export const MANDATE_TYPES = {
  EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }],
  Mandate: [{ name: 'grants', type: 'MandateGrant[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }],
  MandateGrant: [
    { name: 'domain', type: 'EIP712ChainDomain' }, { name: 'sessionKey', type: 'address' },
    { name: 'perTxLimit', type: 'uint256' }, { name: 'budget', type: 'uint256' },
    { name: 'windowSeconds', type: 'uint256' }, { name: 'expiry', type: 'uint256' },
  ],
  EIP712ChainDomain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
} as const;

export const CHAIN_DOMAIN_TYPE = 'EIP712ChainDomain(uint256 chainId,address verifyingContract)';
const GRANT_PRIMARY_TYPE = 'MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)';
export const GRANT_TYPE = GRANT_PRIMARY_TYPE + CHAIN_DOMAIN_TYPE;
// EIP-712 dependencies follow the primary type in alphabetical order.
export const MANDATE_TYPE = 'Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)' + CHAIN_DOMAIN_TYPE + GRANT_PRIMARY_TYPE;
export const DOMAIN_TYPE = 'EIP712Domain(string name,string version)';
export const CHAIN_DOMAIN_TYPEHASH = keccak256(stringToHex(CHAIN_DOMAIN_TYPE));
export const GRANT_TYPEHASH = keccak256(stringToHex(GRANT_TYPE));
export const MANDATE_TYPEHASH = keccak256(stringToHex(MANDATE_TYPE));

export function createMandate(input: {
  sessionKey: Address;
  chains: readonly { chainId: bigint; account: Address }[];
  limits: GrantLimits;
  nonce: bigint;
  deadline: bigint;
  now: bigint;
}): Mandate {
  const mandate: Mandate = {
    grants: input.chains.map(({ chainId, account }) => ({
      domain: { chainId, verifyingContract: account }, sessionKey: input.sessionKey,
      // Copy only limit fields so a structurally wider object cannot replace the
      // selected chain/account or shared session key through object spreading.
      perTxLimit: input.limits.perTxLimit, budget: input.limits.budget,
      windowSeconds: input.limits.windowSeconds, expiry: input.limits.expiry,
    })),
    nonce: input.nonce, deadline: input.deadline,
  };
  assertUint256(input.now, 'now');
  validateMandate(mandate, input.now);
  return mandate;
}

export function mandateTypedData(mandate: Mandate) {
  validateMandate(mandate);
  // Wallets receive every grant field, with no top-level chainId or verifier.
  return {
    domain: { ...MANDATE_DOMAIN }, types: MANDATE_TYPES, primaryType: 'Mandate',
    message: { ...mandate, grants: mandate.grants.map(g => ({
      ...g, sessionKey: g.sessionKey.toLowerCase() as Address,
      domain: { ...g.domain, verifyingContract: g.domain.verifyingContract.toLowerCase() as Address },
    })) },
  } as const;
}

export function chainDomainHash(grant: MandateGrant): Hex {
  validateGrant(grant);
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [CHAIN_DOMAIN_TYPEHASH, grant.domain.chainId, grant.domain.verifyingContract.toLowerCase() as Address],
  ));
}
export function grantStructHash(grant: MandateGrant): Hex {
  validateGrant(grant);
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' },
      { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [GRANT_TYPEHASH, chainDomainHash(grant), grant.sessionKey.toLowerCase() as Address, grant.perTxLimit,
      grant.budget, grant.windowSeconds, grant.expiry],
  ));
}
export function structsArrayHash(hashes: readonly Hex[]): Hex {
  hashes.forEach(assertBytes32);
  // EIP-712 arrays concatenate struct hashes without an ABI offset or length word.
  return keccak256(concatHex(hashes));
}
export function mandateStructHashFromHashes(hashes: readonly Hex[], nonce: bigint, deadline: bigint): Hex {
  assertUint256(nonce, 'nonce');
  assertUint256(deadline, 'deadline');
  if (!hashes.length) throw new Error('A mandate needs at least one grant');
  return keccak256(encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }],
    [MANDATE_TYPEHASH, structsArrayHash(hashes), nonce, deadline],
  ));
}
export function mandateStructHash(mandate: Mandate): Hex {
  validateMandate(mandate);
  return mandateStructHashFromHashes(mandate.grants.map(grantStructHash), mandate.nonce, mandate.deadline);
}

/** Select only header-flagged ERC-5267 fields, in canonical EIP-712 order. */
export function domainSeparator(domain: Partial<ApplicationDomain> = MANDATE_DOMAIN, fields = 0x03): Hex {
  if (!Number.isInteger(fields) || fields < 0 || fields > 0x1f) throw new Error('Unsupported domain fields');
  const declarations: string[] = [];
  const parameters: { type: 'bytes32' | 'uint256' | 'address' }[] = [{ type: 'bytes32' }];
  const values: (Hex | bigint)[] = [];
  for (const [bit, name] of [[1, 'name'], [2, 'version']] as const) {
    if (fields & bit) {
      const value = domain[name];
      if (typeof value !== 'string') throw new Error(`Missing domain ${name}`);
      declarations.push(`string ${name}`);
      parameters.push({ type: 'bytes32' });
      values.push(keccak256(stringToHex(value)));
    }
  }
  if (fields & 4) {
    assertUint256(domain.chainId, 'domain.chainId');
    declarations.push('uint256 chainId'); parameters.push({ type: 'uint256' }); values.push(domain.chainId);
  }
  if (fields & 8) {
    assertAddress(domain.verifyingContract, 'domain.verifyingContract');
    declarations.push('address verifyingContract'); parameters.push({ type: 'address' }); values.push(domain.verifyingContract.toLowerCase() as Address);
  }
  if (fields & 16) {
    assertBytes32(domain.salt);
    declarations.push('bytes32 salt'); parameters.push({ type: 'bytes32' }); values.push(domain.salt);
  }
  const typeHash = keccak256(stringToHex(`EIP712Domain(${declarations.join(',')})`));
  return keccak256(encodeAbiParameters(parameters, [typeHash, ...values]));
}
export function digestFromStructHash(structHash: Hex, domain: Partial<ApplicationDomain> = MANDATE_DOMAIN, fields = 0x03): Hex {
  assertBytes32(structHash);
  return keccak256(concatHex(['0x1901', domainSeparator(domain, fields), structHash]));
}
export function mandateDigest(mandate: Mandate): Hex {
  return digestFromStructHash(mandateStructHash(mandate));
}
export async function signMandate(mandate: Mandate, account: LocalAccount): Promise<Hex> {
  return account.signTypedData(mandateTypedData(mandate));
}
/** This prototype accepts canonical 65-byte EOA signatures only. */
export function assertSignature(signature: Hex): void {
  if (!/^0x[\da-fA-F]{130}$/.test(signature) || !['1b', '1c'].includes(signature.slice(-2).toLowerCase())) {
    throw new Error('Signature must contain 65 bytes with v = 27 or 28');
  }
}
export async function verifyMandateSignature(mandate: Mandate, signature: Hex, owner: Address): Promise<boolean> {
  try {
    assertSignature(signature);
    assertAddress(owner, 'owner');
    return (await recoverAddress({ hash: mandateDigest(mandate), signature })).toLowerCase() === owner.toLowerCase();
  } catch { return false; }
}
