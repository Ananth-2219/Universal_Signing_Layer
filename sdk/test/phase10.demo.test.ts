/**
 * Phase 10: the demo's framework-free logic, driven against two real local anvil chains and
 * the real Phase 8 relayer HTTP server. Nothing here needs an RPC URL, key or deployment
 * record from .env: the nodes, accounts and keys are created inside the test and are never
 * printed. Every assertion uses an address, amount, boolean or contract error name.
 *
 * The React UI is not rendered here (that needs a browser and MetaMask); this suite covers
 * each non-UI step the page performs: limit parsing, mandate building, the one-signature
 * wallet path, SDK envelope verification, relayer submission, budget accounting, the
 * over-limit refusal, direct (leak) submissions and owner revocation.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256, parseEther, stringToHex,
  type Address, type Chain, type Hex, type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mandateTypedData, signMandate, signMandateWithWallet, type Mandate } from '../src/core/index.js';
import { createSessionKey, type SessionKey } from '../src/keys/index.js';
import { ACCOUNT_VIEW_ABI, decodeAccountError } from '../src/adapters/index.js';
import { SpendTracker } from '../src/policy/index.js';
import { createRelayer } from '../../relayer/src/server.js';
import {
  buildDemoMandate, createDemoAttacker, describeError, parseLimits, planRegistration,
  planSessionTransfer, postRelay, readBalance, readChainStatus, relayerIsUp, remainingBudget,
  runLeakAttempts, walletChainFor, type DemoChain, type FetchLike, type MandateFormValues,
} from '../../demo/src/lib/usl.js';

const CHAINS = [
  // Deliberately not 8545/8546: sdk/test/phase7.integration.test.ts owns those ports and
  // vitest runs test files in parallel, so sharing them would attach to the wrong node.
  { chainId: 31337, port: 8555, label: 'Anvil A' },
  { chainId: 31338, port: 8556, label: 'Anvil B' },
] as const;
const RELAYER_PORT = 8791;
const FORM: MandateFormValues = {
  perTxLimitEth: '0.001',
  budgetEth: '0.005',
  windowSeconds: '3600',
  expiryMinutes: '60',
};
const SMALL = parseEther('0.0001');
/** Same shape the browser passes: fetch behind a structural type, so the lib needs no DOM. */
const fetchImpl: FetchLike = (input, init) => globalThis.fetch(input, init);

interface Node {
  chain: DemoChain;
  walletChain: Chain;
  id: 31337 | 31338;
  url: string;
  publicClient: PublicClient;
  testClient: ReturnType<typeof createTestClient>;
  wallet: ReturnType<typeof createWalletClient>;
  ownerWallet: ReturnType<typeof createWalletClient>;
  account: Address;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Phase 10: demo logic against two anvil chains and the real relayer', () => {
  const children: ChildProcess[] = [];
  const nodes: Node[] = [];
  const servers: { close(callback: () => void): void }[] = [];
  const owner = privateKeyToAccount(generatePrivateKey());
  const relayerKey = generatePrivateKey();
  const relayerAccount = privateKeyToAccount(relayerKey);
  const relayerUrl = `http://127.0.0.1:${RELAYER_PORT}`;
  let session: SessionKey;
  let mandate: Mandate;
  let signature: Hex;
  let limits: ReturnType<typeof parseLimits>;
  /** One advisory SDK tracker per chain, as the page keeps them per browser session. */
  const trackers = new Map<string, SpendTracker>();

  function startAnvil(chainId: number, port: number): ChildProcess {
    // stdio 'ignore' keeps anvil's banner (which lists dev keys) out of the test log.
    return spawn('anvil', ['--chain-id', String(chainId), '--port', String(port), '--silent'], { stdio: 'ignore' });
  }

  async function waitReady(url: string, chainId: number): Promise<void> {
    const client = createPublicClient({ transport: http(url) });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        if (BigInt(await client.request({ method: 'eth_chainId' })) === BigInt(chainId)) return;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`Anvil for chain ${chainId} did not become ready`);
      await sleep(250);
    }
  }

  const statusOf = (node: Node) => readChainStatus({
    publicClient: node.publicClient, account: node.account, sessionKey: session.address, mandateNonce: mandate.nonce,
  });
  const grantFor = (node: Node) => mandate.grants
    .find(grant => grant.domain.chainId === BigInt(node.id))!;
  const trackerFor = (node: Node) => {
    const existing = trackers.get(node.chain.caip2);
    if (existing) return existing;
    const created = new SpendTracker({
      chainId: node.chain.caip2, sessionKey: session.address, windowSeconds: limits.windowSeconds,
    });
    trackers.set(node.chain.caip2, created);
    return created;
  };

  beforeAll(async () => {
    const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/MandateAccount.sol/MandateAccount.json', import.meta.url), 'utf8')) as {
      abi: Parameters<ReturnType<typeof createWalletClient>['deployContract']>[0]['abi'];
      bytecode: { object: Hex };
    };
    for (const config of CHAINS) {
      const url = `http://127.0.0.1:${config.port}`;
      children.push(startAnvil(config.chainId, config.port));
      await waitReady(url, config.chainId);
      const chain = defineChain({
        id: config.chainId,
        name: `USL ${config.label}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      });
      const transport = http(url);
      const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 });
      const testClient = createTestClient({ chain, mode: 'anvil', transport });
      const funder = privateKeyToAccount(generatePrivateKey());
      await testClient.setBalance({ address: funder.address, value: parseEther('1000') });
      // The relayer pays gas, so its account must be funded on every chain (simulation included).
      await testClient.setBalance({ address: relayerAccount.address, value: parseEther('100') });
      const wallet = createWalletClient({ account: funder, chain, transport });
      // The owner pays for its own revoke transaction, exactly as MetaMask would in the page.
      await testClient.setBalance({ address: owner.address, value: parseEther('10') });
      const ownerWallet = createWalletClient({ account: owner, chain, transport });
      const deployed = await wallet.deployContract({
        abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: deployed });
      expect(receipt.status).toBe('success');
      const account = receipt.contractAddress!;
      const funding = await wallet.sendTransaction({ to: account, value: parseEther('1'), gas: 50_000n });
      expect((await publicClient.waitForTransactionReceipt({ hash: funding })).status).toBe('success');
      nodes.push({
        chain: { chainId: config.chainId, caip2: `eip155:${config.chainId}`, label: config.label, rpcUrl: url },
        walletChain: chain,
        id: config.chainId, url, publicClient, testClient, wallet, ownerWallet, account,
      });
    }

    const now = (await Promise.all(nodes.map(node => node.publicClient.getBlock())))
      .map(block => block.timestamp).reduce((left, right) => (right > left ? right : left));
    limits = parseLimits(FORM, now);
    session = createSessionKey({ expiry: limits.expiry });
    mandate = buildDemoMandate({
      sessionKey: session.address,
      chains: nodes.map(node => ({ chainId: node.id, account: node.account })),
      limits,
      now,
    });
    signature = await signMandateWithWallet(owner, mandate);

    const relayer = createRelayer({
      privateKey: relayerKey,
      rateLimit: 100,
      chains: nodes.map(node => ({
        chainId: node.id, rpcUrl: node.url, accounts: [node.account], gasPriceCap: 100_000_000_000n,
      })),
    });
    await new Promise<void>(resolve => relayer.server.listen(RELAYER_PORT, resolve));
    servers.push(relayer.server);
  }, 240_000);

  afterAll(async () => {
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    for (const child of children) child.kill('SIGTERM');
    await sleep(300);
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  });

  it('turns the form into limits and refuses unsafe input', () => {
    expect(limits.perTxLimit).toBe(parseEther('0.001'));
    expect(limits.budget).toBe(parseEther('0.005'));
    expect(limits.windowSeconds).toBe(3600n);
    expect(limits.expiry).toBeGreaterThan(0n);
    expect(() => parseLimits({ ...FORM, perTxLimitEth: 'abc' }, 1n)).toThrow('positive decimal');
    expect(() => parseLimits({ ...FORM, windowSeconds: '0' }, 1n)).toThrow('greater than zero');
    expect(() => parseLimits({ ...FORM, budgetEth: '0.0005' }, 1n)).toThrow('at least the per-transaction limit');
    expect(() => parseLimits({ ...FORM, expiryMinutes: 'x' }, 1n)).toThrow('whole number');
  });

  it('allows the local demo origin to read health and preflight relay requests', async () => {
    const origin = 'http://localhost:3000';
    const health = await fetch(`${relayerUrl}/health`, { headers: { origin } });
    expect(health.status).toBe(200);
    expect(health.headers.get('access-control-allow-origin')).toBe(origin);
    const preflight = await fetch(`${relayerUrl}/relay`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('names contract errors for the user and ignores foreign revert data', () => {
    const selector = keccak256(stringToHex('BudgetExceeded()')).slice(0, 10);
    expect(decodeAccountError(selector)).toBe('BudgetExceeded');
    expect(decodeAccountError('0xdeadbeef')).toBeUndefined();
    expect(decodeAccountError('not-hex')).toBeUndefined();
    expect(describeError(new Error('boom'))).toContain('boom');
  });

  it('builds one mandate with one grant per chain and a chain-agnostic wallet domain', () => {
    expect(mandate.grants).toHaveLength(nodes.length);
    for (const node of nodes) {
      const grant = grantFor(node);
      expect(grant.sessionKey).toBe(session.address);
      expect(grant.domain.verifyingContract).toBe(node.account);
      expect(grant.perTxLimit).toBe(limits.perTxLimit);
      expect(grant.budget).toBe(limits.budget);
    }
    const typedData = mandateTypedData(mandate);
    expect(Object.keys(typedData.domain).sort()).toEqual(['name', 'version']);
    expect(typedData.primaryType).toBe('Mandate');
    expect(Object.keys(typedData.types)).toContain('EIP712ChainDomain');
    // A session key can never serialise key material: its JSON form is its public address.
    expect(JSON.stringify(session)).toBe(JSON.stringify(session.address));
  });

  it('signs identical bytes through a wallet and through a local key', async () => {
    expect(await signMandate(mandate, owner)).toBe(signature);
  });

  it('registers the one mandate on both chains through the relayer and leaks no secret', async () => {
    expect(await relayerIsUp(relayerUrl, fetchImpl)).toBe(true);
    for (const node of nodes) {
      const block = await node.publicClient.getBlock();
      const plan = await planRegistration({
        mandate, signature, chain: node.chain, account: node.account, owner: owner.address, now: block.timestamp,
      });
      if (!plan.verification.valid) throw new Error(plan.verification.message);
      expect(plan.verification.digest).toMatch(/^0x[0-9a-f]{64}$/);
      const args = plan.body.args;
      expect(typeof args.nonce).toBe('string');
      expect(typeof args.grant.perTxLimit).toBe('string');
      expect(args.grant.windowSeconds).toBe('3600');
      expect(args.envelope.startsWith('0x')).toBe(true);
      // Every 32-byte blob in the request sits inside the envelope: no private key travels.
      const blobs = JSON.stringify(plan.body).match(/0x[0-9a-fA-F]{64}/g) ?? [];
      expect(blobs.every(blob => args.envelope.toLowerCase().includes(blob.toLowerCase()))).toBe(true);
      const hash = await postRelay({ relayerUrl, fetchImpl, body: plan.body });
      expect((await node.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
      const state = await statusOf(node);
      expect(state.mandateUsed).toBe(true);
      expect(state.session.active).toBe(true);
      expect(state.session.perTxLimit).toBe(limits.perTxLimit);
      expect(state.session.budget).toBe(limits.budget);
      expect(state.session.spent).toBe(0n);
      expect(state.owner.toLowerCase()).toBe(owner.address.toLowerCase());
      expect(remainingBudget(state.session)).toBe(limits.budget);
    }
  }, 30_000);

  it('sends a permitted session transfer through the relayer and counts the spend', async () => {
    const node = nodes[0]!;
    const tracker = trackerFor(node);
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const before = await node.publicClient.getBalance({ address: recipient });
    const block = await node.publicClient.getBlock();
    const plan = await planSessionTransfer({
      chain: node.chain, account: node.account, sessionKey: session, grant: grantFor(node), tracker,
      publicClient: node.publicClient, recipient, amount: SMALL, now: block.timestamp,
    });
    expect(plan.policy.decision).toBe('allow');
    // Every number on the wire is a decimal string, exactly as the relayer's parser requires.
    expect(Object.values(plan.body.args).every(value => typeof value === 'string')).toBe(true);
    const hash = await postRelay({ relayerUrl, fetchImpl, body: plan.body });
    const receipt = await node.publicClient.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const confirmed = await node.publicClient.getBlock({ blockNumber: receipt.blockNumber });
    tracker.record(SMALL, confirmed.timestamp);
    expect(tracker.snapshot(confirmed.timestamp).spent).toBe(SMALL);
    expect(await node.publicClient.getBalance({ address: recipient })).toBe(before + SMALL);
    const state = await statusOf(node);
    expect(state.session.spent).toBe(SMALL);
    expect(state.session.windowStart).toBe(confirmed.timestamp);
    expect(remainingBudget(state.session)).toBe(limits.budget - SMALL);
  }, 30_000);

  it('refuses an over-limit transfer with the contract error and leaves the budget untouched', async () => {
    const node = nodes[1]!;
    const grant = grantFor(node);
    const block = await node.publicClient.getBlock();
    const plan = await planSessionTransfer({
      chain: node.chain, account: node.account, sessionKey: session, grant: grantFor(node), tracker: trackerFor(node),
      publicClient: node.publicClient, recipient: privateKeyToAccount(generatePrivateKey()).address,
      amount: grant.perTxLimit + 1n, now: block.timestamp,
    });
    // The advisory pre-check flags it; the contract is the part that actually refuses it.
    expect(plan.policy.decision).toBe('needs_consent');
    // The Phase 8 relayer simulates first and deliberately reports only a generic refusal
    // (the exact contract error name is proven in the direct-submission test below).
    await expect(postRelay({ relayerUrl, fetchImpl, body: plan.body })).rejects.toThrow('the contract refused it');
    const state = await statusOf(node);
    expect(state.session.spent).toBe(0n);
    expect(state.session.active).toBe(true);
  }, 30_000);

  it('describes a chain for the wallet without inventing an RPC URL', () => {
    const node = nodes[0]!;
    expect(walletChainFor(node.chain).id).toBe(node.id);
    expect(walletChainFor(node.chain).rpcUrls.default.http).toEqual([node.url]);
    // An unconfigured chain must not carry a hard-coded endpoint.
    expect(walletChainFor({ chainId: 31337, caip2: 'eip155:31337', label: 'none', rpcUrl: '' })
      .rpcUrls.default.http).toEqual([]);
  });

  it('lets a leaked key submit directly, and the contract still refuses the over-limit attempt', async () => {
    const node = nodes[0]!;
    const before = await statusOf(node);
    const attacker = createDemoAttacker();
    await node.testClient.setBalance({ address: attacker.address, value: parseEther('1') });
    const block = await node.publicClient.getBlock();
    const rows = await runLeakAttempts({
      chain: node.chain, account: node.account, sessionKey: session, attacker,
      publicClient: node.publicClient, session: before.session, now: block.timestamp,
    });
    // 0.005 budget over a 0.001 per-transaction limit: the first attempt is refused outright,
    // and no single permitted value could ever exceed the remaining budget.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.result).toBe('rejected');
    expect(rows[0]!.reason).toContain('per-transaction limit');
    expect(rows[1]!.result).toBe('skipped');
    expect(rows[1]!.reason).toContain('within the per-transaction limit');
    expect(rows.every(row => row.drainedWei === 0n)).toBe(true);
    const after = await statusOf(node);
    expect(after.session.spent).toBe(before.session.spent);
    expect(after.balance).toBe(before.balance);
  }, 30_000);

  it('also stops a leaked key at the budget, on a mandate whose budget equals one transfer', async () => {
    const node = nodes[1]!;
    const start = await node.publicClient.getBlock();
    const tight = {
      perTxLimit: parseEther('0.001'), budget: parseEther('0.001'),
      windowSeconds: 3600n, expiry: start.timestamp + 3600n,
    };
    const secondKey = createSessionKey({ expiry: tight.expiry });
    const secondMandate = buildDemoMandate({
      sessionKey: secondKey.address, chains: [{ chainId: node.id, account: node.account }], limits: tight, now: start.timestamp,
    });
    const secondSignature = await signMandate(secondMandate, owner);
    const registration = await planRegistration({
      mandate: secondMandate, signature: secondSignature, chain: node.chain, account: node.account,
      owner: owner.address, now: start.timestamp,
    });
    if (!registration.verification.valid) throw new Error(registration.verification.message);
    const registered = await postRelay({ relayerUrl, fetchImpl, body: registration.body });
    expect((await node.publicClient.waitForTransactionReceipt({ hash: registered })).status).toBe('success');

    const secondTracker = new SpendTracker({
      chainId: node.chain.caip2, sessionKey: secondKey.address, windowSeconds: tight.windowSeconds,
    });
    const spend = parseEther('0.0006');
    const transfer = await planSessionTransfer({
      chain: node.chain, account: node.account, sessionKey: secondKey, grant: secondMandate.grants[0]!,
      tracker: secondTracker, publicClient: node.publicClient,
      recipient: privateKeyToAccount(generatePrivateKey()).address, amount: spend,
      now: (await node.publicClient.getBlock()).timestamp,
    });
    expect(transfer.policy.decision).toBe('allow');
    const transferHash = await postRelay({ relayerUrl, fetchImpl, body: transfer.body });
    expect((await node.publicClient.waitForTransactionReceipt({ hash: transferHash })).status).toBe('success');

    const read = () => readChainStatus({
      publicClient: node.publicClient, account: node.account,
      sessionKey: secondKey.address, mandateNonce: secondMandate.nonce,
    });
    const spent = await read();
    expect(remainingBudget(spent.session)).toBe(tight.budget - spend);

    const attacker = createDemoAttacker();
    await node.testClient.setBalance({ address: attacker.address, value: parseEther('1') });
    const rows = await runLeakAttempts({
      chain: node.chain, account: node.account, sessionKey: secondKey, attacker,
      publicClient: node.publicClient, session: spent.session, now: (await node.publicClient.getBlock()).timestamp,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.result).toBe('rejected');
    expect(rows[0]!.reason).toContain('per-transaction limit');
    // 0.0004 ETH left, so a value inside the 0.001 limit is still above the budget: refused.
    expect(rows[1]!.result).toBe('rejected');
    expect(rows[1]!.reason).toContain('budget');
    expect(rows.every(row => row.drainedWei === 0n)).toBe(true);
    expect((await read()).session.spent).toBe(spend);
  }, 30_000);

  it('revokes with one owner transaction and the contract then refuses the key', async () => {
    const node = nodes[0]!;
    const hash = await node.ownerWallet.writeContract({
      chain: node.walletChain,
      account: owner,
      address: node.account,
      abi: ACCOUNT_VIEW_ABI,
      functionName: 'revokeSession',
      args: [session.address],
    });
    expect((await node.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
    expect((await statusOf(node)).session.active).toBe(false);

    const plan = await planSessionTransfer({
      chain: node.chain, account: node.account, sessionKey: session, grant: grantFor(node), tracker: trackerFor(node),
      publicClient: node.publicClient, recipient: privateKeyToAccount(generatePrivateKey()).address,
      amount: SMALL, now: (await node.publicClient.getBlock()).timestamp,
    });
    // The advisory layer cannot see a revocation; only the contract can refuse it.
    expect(plan.policy.decision).toBe('allow');
    await expect(postRelay({ relayerUrl, fetchImpl, body: plan.body })).rejects.toThrow('the contract refused it');
  }, 30_000);
});
