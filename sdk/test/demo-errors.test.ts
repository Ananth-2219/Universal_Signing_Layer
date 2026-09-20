import { describe, expect, it, vi } from 'vitest';
import { createWalletClient, custom, keccak256, stringToHex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describeActionError } from '../../demo/src/lib/actionError.js';
import { assertDeployment } from '../../demo/src/lib/submission.js';
import { createMandate, mandateTypedData, signMandateWithWallet, verifyMandateSignature } from '../src/core/index.js';

describe('demo failure diagnostics and wallet wire encoding', () => {
  it('retains multiline provider messages and nested codes/reverts, with redaction', () => {
    const privateText = generatePrivateKey();
    const signatureText = `${privateText}${'aa'.repeat(33)}`;
    const rpcText = ['https:', '', 'example.invalid', 'credential'].join('/');
    const diagnostic = describeActionError('session transfer', {
      message: `Provider failed\nSecond line preserved\n${rpcText}\n${privateText}\n${signatureText}`,
      code: -32603,
      data: { originalError: { code: 3, message: 'execution reverted',
        data: keccak256(stringToHex('BudgetExceeded()')).slice(0, 10) } },
    });
    expect(diagnostic.includes(privateText)).toBe(false);
    expect(diagnostic.includes(signatureText)).toBe(false);
    expect(diagnostic.includes(rpcText)).toBe(false);
    expect(diagnostic).toContain('Operation: session transfer');
    expect(diagnostic).toContain('Error code: -32603, 3');
    expect(diagnostic).toContain('Contract revert: BudgetExceeded');
    expect(diagnostic).toContain('Second line preserved');
    expect(diagnostic).toContain('execution reverted');
  });

  it('reports wallet rejection without inventing a contract revert', () => {
    expect(describeActionError('signing', { code: 4001, message: 'User rejected the request.' }))
      .toContain('Error code: 4001\nContract revert: not provided\nUser rejected the request.');
    expect(describeActionError('registration', undefined)).toContain('No error message was provided');
  });

  it('detects stale deployment records and wrong RPC chains before wallet signing', async () => {
    const account = privateKeyToAccount(generatePrivateKey()).address;
    const client = { getChainId: vi.fn().mockResolvedValue(31337), getCode: vi.fn().mockResolvedValue('0x') };
    const chain = { chainId: 31337, caip2: 'eip155:31337' as const, label: 'Anvil A', rpcUrl: '' };
    await expect(assertDeployment(client as unknown as PublicClient, chain, account)).rejects.toThrow('deployment record is stale');
    client.getChainId.mockResolvedValue(31338);
    await expect(assertDeployment(client as unknown as PublicClient, chain, account)).rejects.toThrow('RPC chain mismatch');
    client.getChainId.mockResolvedValue(31337); client.getCode.mockResolvedValue('0x1234');
    await expect(assertDeployment(client as unknown as PublicClient, chain, account)).resolves.toBeUndefined();
  });

  it('sends one chainless nested-array v4 request for the owner, with lossless integers', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    const session = privateKeyToAccount(generatePrivateKey());
    const mandate = createMandate({ sessionKey: session.address,
      chains: [31337n, 31338n].map(chainId => ({ chainId, account: owner.address })),
      limits: { perTxLimit: 10n, budget: 20n, windowSeconds: 100n, expiry: 999n },
      nonce: 2n ** 250n, deadline: 998n, now: 1n });
    let requests = 0;
    const wallet = createWalletClient({ account: owner.address, transport: custom({ async request({ method, params }) {
      requests++;
      expect(method).toBe('eth_signTypedData_v4');
      const [signer, encoded] = params as [string, string];
      expect(signer.toLowerCase()).toBe(owner.address.toLowerCase());
      const data = JSON.parse(encoded);
      expect(data.domain).toEqual({ name: 'USLMandate', version: '1' });
      expect(data.types).toEqual(mandateTypedData(mandate).types);
      expect(data.message.grants).toHaveLength(2);
      expect(BigInt(data.message.nonce)).toBe(mandate.nonce);
      expect(data.message.grants.map((grant: { domain: { chainId: string } }) => BigInt(grant.domain.chainId))).toEqual([31337n, 31338n]);
      return owner.signTypedData(data);
    } }) });
    const signature = await signMandateWithWallet(wallet, mandate);
    expect(requests).toBe(1);
    expect(await verifyMandateSignature(mandate, signature, owner.address)).toBe(true);
  });
});
