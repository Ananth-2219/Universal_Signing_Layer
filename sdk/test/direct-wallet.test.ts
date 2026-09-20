import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createPublicClient, createTestClient, createWalletClient, custom, http, parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signMandateWithWallet } from '../src/core/index.js';
import { createSessionKey } from '../src/keys/index.js';
import { ACCOUNT_VIEW_ABI } from '../src/adapters/index.js';
import { SpendTracker } from '../src/policy/index.js';
import { buildDemoMandate, planRegistration, planSessionTransfer, walletChainFor, describeError, type DemoChain, type RelayBody } from '../../demo/src/lib/usl.js';
import { parseSubmissionMode, submitDirect } from '../../demo/src/lib/submission.js';

describe('Direct Wallet Mode without a relayer', () => {
  const children: ChildProcess[] = [];
  const owner = privateKeyToAccount(generatePrivateKey());
  const session = createSessionKey({ expiry: 2n ** 100n });
  const nodes: Awaited<ReturnType<typeof startNode>>[] = [];
  let currentChain = 31337;
  let rejectSwitch = false;
  let rejectSend = false;
  let walletSubmissions = 0;

  async function startNode(chainId: number, port: number) {
    const child = spawn('anvil', ['--chain-id', String(chainId), '--port', String(port), '--silent'], { stdio: 'ignore' });
    children.push(child);
    const url = `http://127.0.0.1:${port}`;
    const chain: DemoChain = { chainId, caip2: `eip155:${chainId}`, label: String(chainId), rpcUrl: url };
    const chainDefinition = walletChainFor(chain);
    const publicClient = createPublicClient({ chain: chainDefinition, transport: http(url), pollingInterval: 20 });
    for (let attempt = 0; ; attempt++) {
      try { await publicClient.getChainId(); break; } catch {
        if (attempt === 100) throw new Error('Isolated test node did not start');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    const testClient = createTestClient({ chain: chainDefinition, mode: 'anvil', transport: http(url) });
    await testClient.setBalance({ address: owner.address, value: parseEther('10') });
    const ownerWallet = createWalletClient({ account: owner, chain: chainDefinition, transport: http(url) });
    const artifact = JSON.parse(readFileSync('contracts/out/MandateAccount.sol/MandateAccount.json', 'utf8'));
    const deployed = await ownerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
    const account = (await publicClient.waitForTransactionReceipt({ hash: deployed })).contractAddress!;
    await testClient.setBalance({ address: account, value: parseEther('1') });
    return { chain, publicClient, testClient, ownerWallet, account };
  }

  // EIP-1193 wallet boundary, backed by test-only local signing; no relayer is created.
  const wallet = createWalletClient({ account: owner.address, transport: custom({
    async request({ method, params }) {
      if (method === 'wallet_switchEthereumChain') {
        if (rejectSwitch) throw { code: 4001 };
        currentChain = Number((params as [{ chainId: string }])[0].chainId);
        return null;
      }
      if (method === 'eth_chainId') return `0x${currentChain.toString(16)}`;
      const node = nodes.find(candidate => candidate.chain.chainId === currentChain)!;
      if (method === 'eth_sendTransaction') {
        if (rejectSend) throw { code: 4001 };
        const transaction = (params as [{ to: Address; data: Hex; value: Hex }])[0];
        expect(transaction.to.toLowerCase()).toBe(node.account.toLowerCase());
        expect(BigInt(transaction.value)).toBe(0n);
        walletSubmissions++;
        return node.ownerWallet.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n });
      }
      return node.publicClient.request({ method, params } as never);
    },
  }) });

  beforeAll(async () => {
    nodes.push(await startNode(31337, 8565), await startNode(31338, 8566));
  }, 30_000);
  afterAll(() => { session.destroy(); for (const child of children) child.kill('SIGTERM'); });

  it('defaults to relayer, while retaining an explicit manual direct fallback', () => {
    expect(parseSubmissionMode()).toBe('relayer');
    expect(parseSubmissionMode('direct')).toBe('direct');
    expect(parseSubmissionMode('relayer')).toBe('relayer');
    expect(() => parseSubmissionMode('other')).toThrow();
  });

  for (const chainId of [31337, 31338]) {
    it(`registers, enforces signed limits, and revokes on ${chainId}`, async () => {
      const node = nodes.find(candidate => candidate.chain.chainId === chainId)!;
      const now = (await node.publicClient.getBlock()).timestamp;
      const limits = { perTxLimit: 10n, budget: 20n, windowSeconds: 3600n, expiry: now + 300n };
      const mandate = buildDemoMandate({ sessionKey: session.address,
        chains: nodes.map(item => ({ chainId: item.chain.chainId, account: item.account })), limits, now });
      const signature = await signMandateWithWallet(owner, mandate);
      // The same signature is verified on both chains, once for this test's fresh session.
      const key = chainId === 31337 ? session : createSessionKey({ expiry: limits.expiry });
      if (chainId !== 31337) {
        for (const grant of mandate.grants) grant.sessionKey = key.address;
      }
      const signed = chainId === 31337 ? signature : await signMandateWithWallet(owner, mandate);
      for (const target of nodes) {
        const plan = await planRegistration({ mandate, signature: signed, chain: target.chain, account: target.account, owner: owner.address, now });
        expect(plan.verification.valid).toBe(true);
        const altered = { ...plan.body, args: { ...plan.body.args, nonce: String(mandate.nonce + 1n) } };
        await expect(submitDirect({ body: altered, chain: target.chain, wallet, publicClient: target.publicClient })
          .catch(error => { throw new Error(describeError(error)); })).rejects.toThrow('owner');
        const hash = await submitDirect({ body: plan.body, chain: target.chain, wallet, publicClient: target.publicClient });
        expect((await target.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
      }
      const grant = mandate.grants.find(item => item.domain.chainId === BigInt(chainId))!;
      const tracker = new SpendTracker({ chainId: node.chain.caip2, sessionKey: key.address, windowSeconds: limits.windowSeconds });
      const plan = async (amount: bigint) => planSessionTransfer({ chain: node.chain, account: node.account,
        sessionKey: key, grant, tracker, publicClient: node.publicClient, recipient: owner.address, amount, now });
      const submit = (body: RelayBody) => submitDirect({ body, chain: node.chain, wallet, publicClient: node.publicClient });
      const rejected = async (body: RelayBody, message: string) => {
        const before = walletSubmissions;
        await expect(submit(body).catch(error => { throw new Error(describeError(error)); })).rejects.toThrow(message);
        expect(walletSubmissions).toBe(before);
      };
      await rejected((await plan(11n)).body, 'per-transaction');
      const payment = (await plan(10n)).body;
      rejectSend = true;
      const submissionsBeforeRejection = walletSubmissions;
      await expect(submit(payment)).rejects.toBeDefined();
      expect(walletSubmissions).toBe(submissionsBeforeRejection);
      rejectSend = false;
      const ownerBefore = await node.publicClient.getBalance({ address: owner.address });
      const receipt = await node.publicClient.waitForTransactionReceipt({ hash: await submit(payment) });
      expect(receipt.status).toBe('success');
      expect(await node.publicClient.getBalance({ address: owner.address })).toBe(ownerBefore + 10n - receipt.gasUsed * receipt.effectiveGasPrice);
      await rejected(payment, 'nonce');
      await node.publicClient.waitForTransactionReceipt({ hash: await submit((await plan(10n)).body) });
      await rejected((await plan(1n)).body, 'budget');
      const tampered = (await plan(1n)).body;
      tampered.args.signature = `0x${'00'.repeat(65)}`;
      await rejected(tampered, 'signature');
      const hash = await node.ownerWallet.writeContract({ address: node.account, abi: ACCOUNT_VIEW_ABI, functionName: 'revokeSession', args: [key.address] });
      await node.publicClient.waitForTransactionReceipt({ hash });
      await rejected((await plan(1n)).body, 'not active');
      // The other chain's grant stays active and enforces expiry independently.
      const other = nodes.find(item => item !== node)!;
      await other.testClient.setNextBlockTimestamp({ timestamp: limits.expiry }); await other.testClient.mine({ blocks: 1 });
      const otherPlan = await planSessionTransfer({ chain: other.chain, account: other.account, sessionKey: key,
        grant: mandate.grants.find(item => item.domain.chainId === BigInt(other.chain.chainId)),
        tracker: new SpendTracker({ chainId: other.chain.caip2, sessionKey: key.address, windowSeconds: limits.windowSeconds }),
        publicClient: other.publicClient, recipient: owner.address, amount: 1n, now, ttlSeconds: 600n });
      await expect(submitDirect({ body: otherPlan.body, chain: other.chain, wallet, publicClient: other.publicClient })
        .catch(error => { throw new Error(describeError(error)); })).rejects.toThrow('expiry');
      if (key !== session) key.destroy();
    });
  }

  it('stops on wallet refusal and rejects mismatched chains', async () => {
    const node = nodes[0]!;
    const body: RelayBody = { chainId: 31337, account: node.account, kind: 'execute', args: {
      to: owner.address, value: '0', nonce: '1', deadline: '9999999999', signature: `0x${'00'.repeat(65)}`,
    } };
    rejectSwitch = true;
    await expect(submitDirect({ body, chain: node.chain, wallet, publicClient: node.publicClient })).rejects.toBeDefined();
    rejectSwitch = false;
    await expect(submitDirect({ body: { ...body, chainId: 31338 }, chain: node.chain, wallet, publicClient: node.publicClient })).rejects.toThrow('chain');
    expect(rejectSend).toBe(false);
  });
});
