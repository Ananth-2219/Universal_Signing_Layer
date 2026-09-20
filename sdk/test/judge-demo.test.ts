import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPublicClient, createTestClient, createWalletClient, custom, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { signMandateWithWallet, verifyMandateSignature } from '../src/core/index.js';
import { createSessionKey } from '../src/keys/index.js';
import { SpendTracker } from '../src/policy/index.js';
import { ACCOUNT_VIEW_ABI } from '../src/adapters/index.js';
import { buildChainMandate, budgetProbeValue, checkReadiness, effectiveRemaining, probeSignedOperation, registrationComplete } from '../../demo/src/lib/judge.js';
import { planRegistration, planSessionTransfer, walletChainFor, readChainStatus, type DemoChain } from '../../demo/src/lib/usl.js';
import { submitDirect } from '../../demo/src/lib/submission.js';

describe('judge flow on three isolated Anvil nodes using the testnet chain IDs', () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const key = createSessionKey({ expiry: 2n ** 100n });
  const children: ChildProcess[] = [];
  const nodes: Awaited<ReturnType<typeof startNode>>[] = [];
  let activeChain = 11155111;
  let refusedChain: number | undefined = 84532;
  let signatureRequests = 0;

  async function startNode(chainId: number, port: number) {
    const child = spawn('anvil', ['--chain-id', String(chainId), '--port', String(port), '--silent'], { stdio: 'ignore' });
    children.push(child);
    const chain: DemoChain = { chainId, caip2: `eip155:${chainId}`, label: String(chainId), rpcUrl: `http://127.0.0.1:${port}` };
    const publicClient = createPublicClient({ chain: walletChainFor(chain), transport: http(chain.rpcUrl), pollingInterval: 20 });
    for (let attempt = 0; ; attempt++) {
      try { await publicClient.getChainId(); break; } catch {
        if (attempt > 100) throw new Error('Isolated node did not start');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const testClient = createTestClient({ chain: walletChainFor(chain), mode: 'anvil', transport: http(chain.rpcUrl) });
    await testClient.setBalance({ address: owner.address, value: parseEther('10') });
    const localWallet = createWalletClient({ account: owner, chain: walletChainFor(chain), transport: http(chain.rpcUrl) });
    const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/MandateAccount.sol/MandateAccount.json', import.meta.url), 'utf8'));
    const hash = await localWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
    const account = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
    await testClient.setBalance({ address: account, value: parseEther('1') });
    return { chain, publicClient, testClient, localWallet, account };
  }

  const wallet = createWalletClient({ account: owner.address, transport: custom({ async request({ method, params }) {
    if (method === 'eth_signTypedData_v4') {
      signatureRequests++;
      const [signer, encoded] = params as [Address, string];
      expect(signer).toBe(owner.address);
      const data = JSON.parse(encoded);
      expect(data.domain).toEqual({ name: 'USLMandate', version: '1' });
      expect(data.message.grants).toHaveLength(3);
      return owner.signTypedData(data);
    }
    if (method === 'wallet_switchEthereumChain') {
      const requested = Number((params as [{ chainId: string }])[0].chainId);
      if (requested === refusedChain) throw { code: 4001, message: 'User rejected the request' };
      activeChain = requested;
      return null;
    }
    if (method === 'eth_chainId') return `0x${activeChain.toString(16)}`;
    const node = nodes.find(item => item.chain.chainId === activeChain)!;
    if (method === 'eth_sendTransaction') {
      const transaction = (params as [{ to: Address; data: Hex; value: Hex }])[0];
      expect(transaction.to.toLowerCase()).toBe(node.account.toLowerCase());
      expect(BigInt(transaction.value)).toBe(0n);
      return node.localWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
    }
    return node.publicClient.request({ method, params } as never);
  } }) });

  beforeAll(async () => {
    for (const [index, id] of [11155111, 84532, 421614].entries()) nodes.push(await startNode(id, 8570 + index));
  }, 30000);
  afterAll(() => { key.destroy(); for (const child of children) child.kill('SIGTERM'); });

  it('registers one per-chain mandate with partial failure/retry, then enforces every security case on all three', async () => {
    const now = (await nodes[0]!.publicClient.getBlock()).timestamp;
    const mandate = buildChainMandate({ sessionKey: key.address, now, targets: nodes.map((node, index) => ({
      chain: node.chain, account: node.account,
      limits: { perTxLimit: BigInt(index + 10), budget: BigInt(index + 10), windowSeconds: 3600n, expiry: now + BigInt(300 + index) },
    })) });
    const signature = await signMandateWithWallet(wallet, mandate);
    expect(signatureRequests).toBe(1);
    expect(await verifyMandateSignature(mandate, signature, owner.address)).toBe(true);
    for (const node of nodes) {
      const readiness = await checkReadiness({ chain: node.chain, client: node.publicClient, account: node.account, owner: owner.address, sessionKey: key.address });
      expect(readiness.ready).toBe(true);
      const plan = await planRegistration({ chain: node.chain, account: node.account, owner: owner.address, mandate, signature, now });
      const send = () => submitDirect({ body: plan.body, chain: node.chain, wallet, publicClient: node.publicClient });
      if (node.chain.chainId === refusedChain) await expect(send()).rejects.toBeDefined();
      else expect((await node.publicClient.waitForTransactionReceipt({ hash: await send() })).status).toBe('success');
    }
    refusedChain = undefined;
    for (const node of nodes) {
      if (await registrationComplete(node.publicClient, node.account, mandate.nonce)) continue;
      const plan = await planRegistration({ chain: node.chain, account: node.account, owner: owner.address, mandate, signature, now });
      await node.publicClient.waitForTransactionReceipt({ hash: await submitDirect({ body: plan.body, chain: node.chain, wallet, publicClient: node.publicClient }) });
    }
    expect(signatureRequests).toBe(1);
    for (const node of nodes) {
      const grant = mandate.grants.find(item => item.domain.chainId === BigInt(node.chain.chainId))!;
      const status = () => readChainStatus({ publicClient: node.publicClient, account: node.account, sessionKey: key.address, mandateNonce: mandate.nonce });
      expect((await status()).mandateUsed).toBe(true);
      const plan = (amount: bigint) => planSessionTransfer({ chain: node.chain, account: node.account, sessionKey: key,
        grant, tracker: new SpendTracker({ chainId: node.chain.caip2, sessionKey: key.address, windowSeconds: grant.windowSeconds }),
        publicClient: node.publicClient, recipient: owner.address, amount, now });
      const probe = async (amount: bigint) => probeSignedOperation({ chain: node.chain, client: node.publicClient, payer: owner.address, body: (await plan(amount)).body });
      expect(await probe(grant.perTxLimit + 1n)).toEqual({ rejected: true, reason: 'PerTxLimitExceeded' });
      const valid = await plan(grant.perTxLimit);
      const before = await node.publicClient.getBalance({ address: owner.address });
      const receipt = await node.publicClient.waitForTransactionReceipt({ hash: await submitDirect({ body: valid.body, chain: node.chain, wallet, publicClient: node.publicClient }) });
      expect(receipt.status).toBe('success');
      expect(await node.publicClient.getBalance({ address: owner.address })).toBe(before + grant.perTxLimit - receipt.gasUsed * receipt.effectiveGasPrice);
      expect((await status()).session.spent).toBe(grant.perTxLimit);
      expect(await probeSignedOperation({ chain: node.chain, client: node.publicClient, payer: owner.address, body: valid.body })).toEqual({ rejected: true, reason: 'OperationNonceUsed' });
      const current = await status();
      expect(await probe(budgetProbeValue(current.session, current.now))).toEqual({ rejected: true, reason: 'BudgetExceeded' });
      const revoked = await node.localWallet.writeContract({ address: node.account, abi: ACCOUNT_VIEW_ABI, functionName: 'revokeSession', args: [key.address] });
      await node.publicClient.waitForTransactionReceipt({ hash: revoked });
      expect((await status()).session.active).toBe(false);
      expect(await probe(1n)).toEqual({ rejected: true, reason: 'SessionNotActive' });
    }
  }, 30000);

  it('diagnostics reject missing deployment, wrong owner and unfunded accounts', async () => {
    const node = nodes[0]!;
    const input = { chain: node.chain, client: node.publicClient, owner: owner.address };
    expect((await checkReadiness(input)).ready).toBe(false);
    expect((await checkReadiness({ ...input, account: owner.address })).ready).toBe(false);
    await node.testClient.setBalance({ address: node.account, value: 0n });
    const result = await checkReadiness({ ...input, account: node.account });
    expect(result.ready).toBe(false); expect(result.message).toContain('Fund the account');
  });

  it('budget probes distinguish the budget rule from the per-transfer cap and elapsed windows', () => {
    const session = { perTxLimit: 10n, budget: 20n, spent: 20n, windowSeconds: 10n, windowStart: 100n, expiry: 1000n, active: true };
    expect(effectiveRemaining(session, 109n)).toBe(0n);
    expect(budgetProbeValue(session, 109n)).toBe(1n);
    expect(effectiveRemaining(session, 110n)).toBe(20n);
    expect(() => budgetProbeValue(session, 110n)).toThrow('Spend until');
  });
});
