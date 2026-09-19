import { hashTypedData, verifyTypedData, type Address, type Hex, type LocalAccount } from 'viem';

// Omitting chainId AND verifyingContract is intentional: consent spans chains.
export const MANDATE_DOMAIN = Object.freeze({ name: 'USLMandate', version: '1' });
export function mandateTypedData(root: Hex) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) throw new Error('Root must be bytes32');
  return {
    domain: { ...MANDATE_DOMAIN },
    types: { Mandate: [{ name: 'root', type: 'bytes32' }] },
    primaryType: 'Mandate',
    message: { root },
  } as const;
}

export function mandateDigest(root: Hex): Hex {
  return hashTypedData(mandateTypedData(root));
}

export async function signMandate(root: Hex, account: LocalAccount): Promise<Hex> {
  return account.signTypedData(mandateTypedData(root));
}

/** EOA signature verification only; this does not validate execution policy. */
export async function verifyMandateSignature(root: Hex, signature: Hex, owner: Address): Promise<boolean> {
  const typedData = mandateTypedData(root);
  try {
    return await verifyTypedData({ ...typedData, signature, address: owner });
  } catch {
    return false;
  }
}
