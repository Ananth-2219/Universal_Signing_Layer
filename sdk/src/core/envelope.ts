import { decodeAbiParameters, encodeAbiParameters, concatHex, recoverAddress, toHex, type Address, type Hex } from 'viem';
import type { ApplicationDomain, Mandate, MandateGrant } from './types.js';
import { assertAddress, assertUint256, validateGrant, validateMandate } from './validation.js';
import { assertSignature, digestFromStructHash, grantStructHash, mandateStructHashFromHashes } from './mandate.js';

export const ENVELOPE_MAGIC = '0x796479647964796479';
export const ENVELOPE_ABI = [{ type: 'bytes32' }, { type: 'bytes32[]' }, { type: 'bytes' }] as const;

export function encodeEnvelope(input: {
  mandate: Mandate; signature: Hex; chainId: bigint; verifyingContract: Address; application: Address;
}): Hex {
  validateMandate(input.mandate);
  assertSignature(input.signature);
  assertUint256(input.chainId, 'chainId');
  assertAddress(input.verifyingContract, 'verifyingContract');
  assertAddress(input.application, 'application');
  const index = input.mandate.grants.findIndex(g => g.domain.chainId === input.chainId
    && g.domain.verifyingContract.toLowerCase() === input.verifyingContract.toLowerCase());
  if (index < 0 || index > 65535) throw new Error('Grant index missing or outside uint16');
  const header = concatHex([ENVELOPE_MAGIC, '0x03', toHex(index, { size: 2 }), input.application]);
  return encodeAbiParameters(ENVELOPE_ABI, [header, input.mandate.grants.map(grantStructHash), input.signature]);
}

export function decodeEnvelope(envelope: Hex) {
  if (!/^0x(?:[\da-fA-F]{2})*$/.test(envelope)) throw new Error('Envelope must be byte-aligned hex');
  const size = BigInt((envelope.length - 2) / 2);
  if (size < 160n || size % 32n !== 0n) throw new Error('Envelope too short or truncated');
  if (envelope.slice(0, 20).toLowerCase() !== ENVELOPE_MAGIC) throw new Error('Wrong envelope magic');
  const word = (offset: bigint) => {
    if (offset < 0n || offset + 32n > size) throw new Error('Envelope word out of bounds');
    const start = 2 + Number(offset) * 2;
    return BigInt(`0x${envelope.slice(start, start + 64)}`);
  };
  // Bound lengths with bigint before decoding: attacker-controlled offsets must not
  // allocate arrays or lose precision. Require the canonical ABI layout we emit.
  if (word(32n) !== 96n) throw new Error('Bad array offset');
  const count = word(96n);
  const signatureOffset = 128n + count * 32n;
  if (count === 0n || signatureOffset + 32n > size) throw new Error('Bad array length');
  if (word(64n) !== signatureOffset) throw new Error('Bad signature offset');
  const signatureLength = word(signatureOffset);
  if (signatureOffset + 32n + ((signatureLength + 31n) / 32n) * 32n !== size) {
    throw new Error('Bad signature length or truncated signature');
  }
  const fields = Number.parseInt(envelope.slice(20, 22), 16);
  if (fields > 0x1f) throw new Error('Unsupported domain fields');
  const structIndex = Number.parseInt(envelope.slice(22, 26), 16);
  if (BigInt(structIndex) >= count) throw new Error('Struct index out of bounds');
  const [header, structsArray, signature] = decodeAbiParameters(ENVELOPE_ABI, envelope);
  // Re-encoding also rejects nonzero padding and extra trailing data.
  if (encodeAbiParameters(ENVELOPE_ABI, [header, structsArray, signature]).toLowerCase() !== envelope.toLowerCase()) {
    throw new Error('Noncanonical ABI encoding');
  }
  return { fields, structIndex, application: `0x${header.slice(26)}` as Address, structsArray, signature };
}

export type EnvelopeFailure = 'MALFORMED_ENVELOPE' | 'INVALID_INPUT' | 'APPLICATION_MISMATCH'
  | 'GRANT_MISMATCH' | 'DEADLINE_PASSED' | 'SESSION_EXPIRED' | 'INVALID_SIGNATURE' | 'SIGNER_MISMATCH';
export type EnvelopeVerification =
  | { valid: true; digest: Hex; signer: Address }
  | { valid: false; reason: EnvelopeFailure; message: string };

export async function verifyEnvelope(input: {
  envelope: Hex; expectedGrant: MandateGrant; owner: Address; nonce: bigint; deadline: bigint;
  now: bigint; application: Address; domain: ApplicationDomain;
}): Promise<EnvelopeVerification> {
  const fail = (reason: EnvelopeFailure, message: string): EnvelopeVerification => ({ valid: false, reason, message });
  let decoded;
  try { decoded = decodeEnvelope(input.envelope); }
  catch { return fail('MALFORMED_ENVELOPE', 'Envelope header, offsets, lengths, or padding are invalid'); }
  try {
    assertUint256(input.nonce, 'nonce'); assertUint256(input.deadline, 'deadline'); assertUint256(input.now, 'now');
    assertAddress(input.owner, 'owner'); assertAddress(input.application, 'application');
    validateGrant(input.expectedGrant);
  } catch { return fail('INVALID_INPUT', 'Expected grant, owner, application, nonce, deadline, or now is invalid'); }
  if (input.application.toLowerCase() !== decoded.application.toLowerCase()) {
    return fail('APPLICATION_MISMATCH', 'Domain provider does not match the envelope application');
  }
  if (input.now > input.deadline) return fail('DEADLINE_PASSED', 'Submission deadline passed');
  if (input.expectedGrant.expiry <= input.now) return fail('SESSION_EXPIRED', 'Session expired');
  // Never trust the selected hash alone: bind the actual local operation first.
  if (grantStructHash(input.expectedGrant).toLowerCase() !== decoded.structsArray[decoded.structIndex]!.toLowerCase()) {
    return fail('GRANT_MISMATCH', 'Expected grant does not match the selected operation');
  }
  let digest: Hex;
  try {
    digest = digestFromStructHash(
      mandateStructHashFromHashes(decoded.structsArray, input.nonce, input.deadline), input.domain, decoded.fields,
    );
  } catch { return fail('INVALID_INPUT', 'A header-selected domain field is invalid or missing'); }
  try {
    assertSignature(decoded.signature);
    const signer = await recoverAddress({ hash: digest, signature: decoded.signature });
    if (signer.toLowerCase() !== input.owner.toLowerCase()) {
      return fail('SIGNER_MISMATCH', 'Signature does not match owner with the supplied nonce, deadline, domain, and grant hashes');
    }
    return { valid: true, digest, signer };
  } catch { return fail('INVALID_SIGNATURE', 'Invalid EOA signature; expected 65 bytes and v = 27 or 28'); }
}
