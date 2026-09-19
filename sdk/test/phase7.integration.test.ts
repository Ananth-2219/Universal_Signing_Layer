import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http, keccak256,
  encodeFunctionData as encodeFunctionData_, parseAbi, parseAbiItem, parseEther, stringToHex,
  type Address, type Hex, type LocalAccount,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  MANDATE_DOMAIN, createMandate, encodeEnvelope, mandateTypedData, signMandate,
  verifyEnvelope, type Mandate,
} from '../src/core/index.js';
import { createSessionKey, type SessionKey } from '../src/keys/index.js';
import { EvmAdapter, NeedsConsentError, ViemSubmitter, ACCOUNT_ABI } from '../src/adapters/index.js';
import { createRelayer } from '../../relayer/src/server.js';

/**
 * Phase 7: one owner, ONE owner-signed mandate, two local anvil chains (31337 on 8545,
 * 31338 on 8546), and real on-chain enforcement of session limits. The suite starts and
 * stops its own anvil nodes, so `npm test` runs the whole flow offline. Keys (owner,
 * relayer, session) are generated in memory and are never printed, written, or sent
 * anywhere; every printed or asserted value is an address, amount, or boolean.
 */

const registerAbi = parseAbi([
  'function registerMandate(((uint256 chainId,address verifyingContract) domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry) grant, uint256 nonce, uint256 deadline, bytes envelope)',
]);
const viewAbi = parseAbi([
  'function owner() view returns (address)',
  'function sessions(address sessionKey) view returns ((uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry,uint256 windowStart,uint256 spent,bool active))',
  'function mandateIdUsed(uint256 mandateId) view returns (bool)',
  'function operationNonceUsed(address sessionKey, uint256 nonce) view returns (bool)',
]);
const consentAbi = parseAbi([
  'function executeWithConsent(address to,uint256 value,bytes data,uint256 nonce,uint256 deadline,bytes ownerSignature)',
  'function revokeSession(address sessionKey)',
]);
const mandateRegisteredEvent = parseAbiItem('event MandateRegistered(address sessionKey, uint256 mandateId, uint256 expiry)');
const executedEvent = parseAbiItem('event Executed(address sessionKey, address to, uint256 value)');

/** Four-byte Solidity error selector: keccak256 of the canonical error signature. */
const selector = (signature: string) => keccak256(stringToHex(signature)).slice(0, 10).toLowerCase();
const ERRORS = {
  SessionExpired: selector('SessionExpired()'),
  InvalidSignature: selector('InvalidSignature()'),
  OperationNonceUsed: selector('OperationNonceUsed()'),
  SessionNotActive: selector('SessionNotActive()'),
  PerTxLimitExceeded: selector('PerTxLimitExceeded()'),
  BudgetExceeded: selector('BudgetExceeded()'),
  WrongSigner: selector('WrongSigner()'),
  WrongChain: selector('WrongChain()'),
  WrongAccount: selector('WrongAccount()'),
} as const;

const CHAINS = [
  { chainId: 31337, port: 8545, caip2: 'eip155:31337', label: 'A' },
  { chainId: 31338, port: 8546, caip2: 'eip155:31338', label: 'B' },
] as const;
const LIMITS = { perTxLimit: 1_000_000_000_000_000n, budget: 1_100_000_000_000_000n, windowSeconds: 3600n };
const SMALL = 100_000_000_000_000n; // 0.0001 ETH: the first permitted transfer.
const MANDATE_NONCE = 20260919001n; // Arbitrary unique mandate ID (unordered used-mapping).
const FUNDING = parseEther('1'); // ETH the account contract can spend.

interface Node {
  label: string;
  chainId: 31337 | 31338;
  caip2: 'eip155:31337' | 'eip155:31338';
  chain: ReturnType<typeof defineChain>;
  publicClient: ReturnType<typeof createPublicClient>;
  testClient: ReturnType<typeof createTestClient>;
  relayerWallet: ReturnType<typeof createWalletClient>;
  relayer: LocalAccount;
  account: Address; // deployed MandateAccount on this chain
  adapter: EvmAdapter;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Raw revert data of a simulated call, or undefined when the call succeeds. */
async function revertData(publicClient: Node['publicClient'], to: Address, data: Hex): Promise<string | undefined> {
  try {
    await publicClient.transport.request({ method: 'eth_call', params: [{ to, data }, 'latest'] });
    return undefined;
  } catch (error) {
    const err = error as { data?: unknown; info?: { error?: { data?: unknown } }; cause?: unknown };
    const candidates: unknown[] = [err.data, err.info?.error?.data];
    if (err.cause && typeof err.cause === 'object') candidates.push((err.cause as { data?: unknown }).data);
    const raw = candidates.find(c => typeof c === 'string') as string | undefined;
    if (!raw) throw new Error(`eth_call failed without revert data: ${String(error)}`);
    return raw.toLowerCase();
  }
}

describe('Phase 7: one mandate, two anvil chains, enforced session limits', () => {
  const children: ChildProcess[] = [];
  const nodes: Node[] = [];
  const owner = privateKeyToAccount(generatePrivateKey());
  const session = createSessionKey({ expiry: 2n ** 100n });
  let mandate: Mandate;
  let mandateSignature: Hex;
  let chainNow = 0n;
  let executedOnA: { op: { to: Address; value: bigint; nonce: bigint; deadline: bigint }; signature: Hex };

  function startAnvil(chainId: number, port: number): ChildProcess {
    // stdio 'ignore' keeps anvil's own banner (which lists dev keys) out of our logs.
    return spawn('anvil', ['--chain-id', String(chainId), '--port', String(port), '--silent'], { stdio: 'ignore' });
  }

  async function waitReady(url: string, chainId: number): Promise<void> {
    const client = createPublicClient({ transport: http(url) });
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        if (BigInt(await client.request({ method: 'eth_chainId' })) === BigInt(chainId)) return;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error(`Anvil for chain ${chainId} at ${url} did not become ready`);
      await sleep(250);
    }
  }

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
        id: config.chainId as 31337 | 31338,
        name: `USL Anvil ${config.label}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [url] } },
      });
      const transport = http(url);
      const publicClient = createPublicClient({ chain, transport, pollingInterval: 100 });
      const testClient = createTestClient({ chain, mode: 'anvil', transport });
      const relayer = privateKeyToAccount(generatePrivateKey());
      const relayerWallet = createWalletClient({ account: relayer, chain, transport });
      await testClient.setBalance({ address: relayer.address, value: parseEther('1000') });

      const deployed = await relayerWallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [owner.address] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: deployed });
      expect(receipt.status).toBe('success');
      const account = receipt.contractAddress!;
      const funded = await relayerWallet.sendTransaction({ to: account, value: FUNDING, gas: 50_000n });
      expect((await publicClient.waitForTransactionReceipt({ hash: funded })).status).toBe('success');
      nodes.push({
        label: config.label, chainId: config.chainId, caip2: config.caip2, chain, publicClient, testClient,
        relayerWallet, relayer, account, adapter: new EvmAdapter({ chainId: config.caip2, publicClient }),
      });
    }

    chainNow = (await Promise.all(nodes.map(n => n.publicClient.getBlock()))).map(b => b.timestamp).reduce((a, b) => (b > a ? b : a));
    mandate = createMandate({
      sessionKey: session.address,
      chains: nodes.map(node => ({ chainId: BigInt(node.chainId), account: node.account })),
      limits: { ...LIMITS, expiry: chainNow + 86_400n },
      nonce: MANDATE_NONCE, deadline: chainNow + 3_600n, now: chainNow,
    });
    mandateSignature = await signMandate(mandate, owner); // ONE chainless-domain signature for both chains.

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const grant = mandate.grants[i]!;
      const envelope = encodeEnvelope({
        mandate, signature: mandateSignature, chainId: BigInt(node.chainId),
        verifyingContract: node.account, application: node.account,
      });
      // Independent SDK verification of exactly what this chain will receive.
      const verification = await verifyEnvelope({
        envelope, expectedGrant: grant, owner: owner.address, nonce: mandate.nonce, deadline: mandate.deadline,
        now: chainNow, application: node.account,
        domain: { ...MANDATE_DOMAIN, chainId: BigInt(node.chainId), verifyingContract: node.account, salt: `0x${'00'.repeat(32)}` },
      });
      expect(verification.valid).toBe(true);
      const request = node.adapter.buildRegistrationRequest({ mandate, signature: mandateSignature, account: node.account, application: node.account });
      const hash = await node.adapter.submit(request, new ViemSubmitter(node.relayerWallet));
      expect((await node.adapter.waitForReceipt(hash)).status).toBe('success');
    }
  }, 240_000);

  afterAll(async () => {
    for (const child of children) child.kill('SIGTERM');
    await sleep(500);
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  });

  it('deploys and registers the ONE mandate on both chains', async () => {
    expect(mandate.grants).toHaveLength(2);
    for (const node of nodes) {
      expect(await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'owner' })).toBe(owner.address);
      expect(await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'mandateIdUsed', args: [mandate.nonce] })).toBe(true);
      const registered = await node.publicClient.getLogs({
        address: node.account, event: mandateRegisteredEvent, args: { sessionKey: session.address }, fromBlock: 1n,
      });
      expect(registered).toHaveLength(1);
      const grant = mandate.grants[nodes.indexOf(node)]!;
      expect(grant.domain.chainId).toBe(BigInt(node.chainId));
      expect(grant.domain.verifyingContract.toLowerCase()).toBe(node.account.toLowerCase());
      const active = await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'sessions', args: [session.address] });
      expect(active.active).toBe(true);
    }
  });

  it('executes a valid native transfer through the SDK on both chains', async () => {
    for (const node of nodes) {
      const recipient = privateKeyToAccount(generatePrivateKey()).address;
      const op = node.adapter.buildOperation(
        { chainId: node.caip2, to: recipient, amount: SMALL, asset: 'native' },
        { account: node.account, now: chainNow },
      );
      const signature = await node.adapter.signOperation(op, node.account, session, chainNow);
      const request = node.adapter.buildExecuteRequest(op, node.account, signature);
      const accountBalanceBefore = await node.publicClient.getBalance({ address: node.account });
      const hash = await node.adapter.submit(request, new ViemSubmitter(node.relayerWallet));
      expect((await node.adapter.waitForReceipt(hash)).status).toBe('success');
      expect(await node.publicClient.getBalance({ address: recipient })).toBe(SMALL);
      expect(await node.publicClient.getBalance({ address: node.account })).toBe(accountBalanceBefore - SMALL);

      const executed = await node.publicClient.getLogs({ address: node.account, event: executedEvent, fromBlock: 1n });
      expect(executed.some(log => log.args.value === SMALL)).toBe(true);
      const spent = await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'sessions', args: [session.address] });
      expect(spent.spent).toBe(SMALL);
      expect(await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'operationNonceUsed', args: [session.address, op.nonce] })).toBe(true);
      if (node.label === 'A') executedOnA = { op, signature };
    }
  }, 15_000);

  it('rejects a transfer above the per-transaction limit', async () => {
    const node = nodes[0]!;
    const op = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: LIMITS.perTxLimit + 1n, asset: 'native' },
      { account: node.account, now: chainNow },
    );
    const data = encodeFunctionData(op, await node.adapter.signOperation(op, node.account, session, chainNow));
    expect(await revertData(node.publicClient, node.account, data)).toBe(ERRORS.PerTxLimitExceeded);
    const spent = await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'sessions', args: [session.address] });
    expect(spent.spent).toBe(SMALL); // rejected operation leaves state untouched
  });

  it('relays only simulated allowlisted operations and rate-limits callers', async () => {
    const node = nodes[0]!; const key = generatePrivateKey();
    const relayer = createRelayer({ privateKey: key, rateLimit: 2, chains: [{ chainId: node.chainId, rpcUrl: `http://127.0.0.1:8545`, accounts: [node.account], gasPriceCap: 100_000_000_000n }] });
    await node.testClient.setBalance({ address: privateKeyToAccount(key).address, value: parseEther('1') });
    const op = node.adapter.buildOperation({ chainId: node.caip2, to: node.relayer.address, amount: 1n, asset: 'native' }, { account: node.account, now: chainNow });
    const signature = await node.adapter.signOperation(op, node.account, session, chainNow);
    const hash = await relayer.relay({ chainId: node.chainId, account: node.account, kind: 'execute', args: { ...op, value: op.value.toString(), nonce: op.nonce.toString(), deadline: op.deadline.toString(), signature } }, 'test');
    expect((await node.publicClient.waitForTransactionReceipt({ hash })).status).toBe('success');
    await expect(relayer.relay({ chainId: node.chainId, account: node.account, kind: 'execute', args: { ...op, value: (LIMITS.perTxLimit + 1n).toString(), nonce: '99', deadline: op.deadline.toString(), signature } }, 'bad')).rejects.toThrow('simulation reverted');
    await expect(relayer.relay({ chainId: node.chainId, account: node.relayer.address, kind: 'execute', args: {} }, 'other')).rejects.toThrow('unknown account');
    await expect(relayer.relay({ chainId: node.chainId, account: node.account, kind: 'consent', args: {} }, 'other2')).rejects.toThrow('invalid request');
    await expect(relayer.relay({ chainId: node.chainId, account: node.account, kind: 'execute', args: {} }, 'limit')).rejects.toThrow('invalid to');
    await expect(relayer.relay({ chainId: node.chainId, account: node.account, kind: 'execute', args: {} }, 'limit')).rejects.toThrow('invalid to');
    await expect(relayer.relay({ chainId: node.chainId, account: node.account, kind: 'execute', args: {} }, 'limit')).rejects.toThrow('rate limit exceeded');
  }, 15_000);

  it('rejects a transfer above the remaining budget', async () => {
    const node = nodes[1]!;
    // Fill the remaining budget with one per-transaction-limit-sized transfer.
    const filler = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: LIMITS.budget - SMALL, asset: 'native' },
      { account: node.account, now: chainNow },
    );
    const fillerHash = await node.adapter.submit(
      node.adapter.buildExecuteRequest(filler, node.account, await node.adapter.signOperation(filler, node.account, session, chainNow)),
      new ViemSubmitter(node.relayerWallet),
    );
    expect((await node.adapter.waitForReceipt(fillerHash)).status).toBe('success');

    const over = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: SMALL, asset: 'native' },
      { account: node.account, now: chainNow },
    );
    const data = encodeFunctionData(over, await node.adapter.signOperation(over, node.account, session, chainNow));
    expect(await revertData(node.publicClient, node.account, data)).toBe(ERRORS.BudgetExceeded);
  });

  it('rejects a replayed operation nonce', async () => {
    const node = nodes[0]!;
    expect(await revertData(node.publicClient, node.account, encodeFunctionData(executedOnA.op, executedOnA.signature)))
      .toBe(ERRORS.OperationNonceUsed);
  });

  it('rejects invalid session keys, invalid signatures, calldata intents, and wrong chain/account grants', async () => {
    const node = nodes[0]!;
    const stranger = createSessionKey({ expiry: 2n ** 100n });

    // Unregistered key: the recovered signer has no active session.
    const rogue = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: SMALL, asset: 'native' },
      { account: node.account, now: chainNow },
    );
    const rogueData = encodeFunctionData(rogue, await node.adapter.signOperation(rogue, node.account, stranger, chainNow));
    expect(await revertData(node.publicClient, node.account, rogueData)).toBe(ERRORS.SessionNotActive);

    // An invalid recovery-id byte is rejected before session lookup.
    const op = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: SMALL, asset: 'native' },
      { account: node.account, now: chainNow },
    );
    const bad = await node.adapter.signOperation(op, node.account, session, chainNow);
    const malformed = `${bad.slice(0, -2)}00` as Hex;
    expect(await revertData(node.publicClient, node.account, encodeFunctionData(op, malformed))).toBe(ERRORS.InvalidSignature);

    // Session ops are native-only with empty calldata: the SDK throws NeedsConsentError.
    expect(() => node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: SMALL, asset: node.account, data: '0xdeadbeef' },
      { account: node.account, now: chainNow },
    )).toThrow(NeedsConsentError);

    const other = nodes[1]!;
    const wrongChain = encodeFunctionData_({
      abi: registerAbi, functionName: 'registerMandate',
      args: [mandate.grants[1]!, mandate.nonce, mandate.deadline, '0x'],
    });
    expect(await revertData(node.publicClient, node.account, wrongChain)).toBe(ERRORS.WrongChain);

    const wrongAccountGrant = {
      ...mandate.grants[0]!,
      domain: { ...mandate.grants[0]!.domain, verifyingContract: other.account },
    };
    const wrongAccount = encodeFunctionData_({
      abi: registerAbi, functionName: 'registerMandate',
      args: [wrongAccountGrant, mandate.nonce, mandate.deadline, '0x'],
    });
    expect(await revertData(node.publicClient, node.account, wrongAccount)).toBe(ERRORS.WrongAccount);
  });

  it('rejects an expired-session operation', async () => {
    const node = nodes[0]!;
    const op = node.adapter.buildOperation(
      { chainId: node.caip2, to: node.relayer.address, amount: SMALL, asset: 'native' },
      { account: node.account, now: chainNow, ttlSeconds: 100_000n },
    );
    const signature = await node.adapter.signOperation(op, node.account, session, chainNow);
    const data = encodeFunctionData(op, signature);

    // Warp past the registered session's expiry and mine it onto the local chain.
    await node.testClient.setNextBlockTimestamp({ timestamp: chainNow + 90_000n });
    await node.testClient.mine({ blocks: 1 });
    expect(await revertData(node.publicClient, node.account, data)).toBe(ERRORS.SessionExpired);
  });

  it('Phase 9B: leaked session key cannot impersonate owner and stops after revocation', async () => {
    const node = nodes[1]!;
    // A session-key signature over the owner-consent typed data recovers the wrong signer.
    const consent = { to: node.relayer.address, value: 0n, data: '0x' as Hex, nonce: 700n, deadline: chainNow + 300n };
    const ownerSignature = await session.signTypedData({
      domain: { name: 'USLMandate', version: '1', chainId: BigInt(node.chainId), verifyingContract: node.account },
      types: { Consent: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'dataHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      primaryType: 'Consent', message: { to: consent.to, value: consent.value, dataHash: keccak256(consent.data), nonce: consent.nonce, deadline: consent.deadline },
    }, chainNow);
    const consentData = encodeFunctionData_({ abi: consentAbi, functionName: 'executeWithConsent', args: [consent.to, consent.value, consent.data, consent.nonce, consent.deadline, ownerSignature] });
    expect(await revertData(node.publicClient, node.account, consentData)).toBe(ERRORS.WrongSigner);

    const attackerOp = node.adapter.buildOperation({ chainId: node.caip2, to: node.relayer.address, amount: 1n, asset: 'native' }, { account: node.account, now: chainNow });
    const attackerSignature = await node.adapter.signOperation(attackerOp, node.account, session, chainNow);
    const before = await node.publicClient.readContract({ address: node.account, abi: viewAbi, functionName: 'sessions', args: [session.address] });
    expect(before.spent).toBeLessThanOrEqual(LIMITS.budget);
    await node.testClient.setBalance({ address: owner.address, value: parseEther('1') });
    const ownerWallet = createWalletClient({ account: owner, chain: node.chain, transport: http('http://127.0.0.1:8546') });
    const revoke = await ownerWallet.writeContract({ chain: undefined, address: node.account, abi: consentAbi, functionName: 'revokeSession', args: [session.address] });
    expect((await node.publicClient.waitForTransactionReceipt({ hash: revoke })).status).toBe('success');
    expect(await revertData(node.publicClient, node.account, encodeFunctionData(attackerOp, attackerSignature))).toBe(ERRORS.SessionNotActive);
  }, 15_000);
});

/** SDK-built calldata for executeWithSessionSig, using the frozen ABI. */
function encodeFunctionData(
  op: { to: Address; value: bigint; nonce: bigint; deadline: bigint }, signature: Hex,
): Hex {
  return encodeFunctionData_({ abi: ACCOUNT_ABI, functionName: 'executeWithSessionSig', args: [op, signature] });
}
