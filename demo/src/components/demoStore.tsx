'use client';

/**
 * One place for the demo's shared state and actions. Every action here is thin: it checks
 * inputs, calls @usl/sdk or the relayer through demo/src/lib/usl.ts, and logs what happened.
 * No cryptography, no encoding and no policy logic lives in this file or in any component.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { isAddress, parseEther, type Address, type Hex, type PublicClient } from 'viem';
import { signMandateWithWallet, type GrantLimits, type Mandate } from '@usl/sdk/core';
import { MemoryStore, createSessionKey, type SessionKey } from '@usl/sdk/keys';
import { ACCOUNT_VIEW_ABI } from '@usl/sdk/adapters';
import { SpendTracker } from '@usl/sdk/policy';
import { useAccount, useConnect, useDisconnect, useWalletClient } from 'wagmi';
import { DEMO_CHAINS, RELAYER_URL, UNCONFIGURED_CHAINS, chainById } from '../lib/chains';
import { clockTime, eth, shortHex } from '../lib/format';
import { assertDeployment, parseSubmissionMode, submitDirect, type SubmissionMode } from '../lib/submission';
import { describeActionError, redactErrorText } from '../lib/actionError';
import { recordConfirmedSpend } from '../lib/confirmedSpend';
import { registrationReceipt } from '../lib/registrationReceipt';
import { buildChainMandate, budgetProbeValue, checkReadiness, probeSignedOperation, registrationComplete, type Readiness } from '../lib/judge';
import {
  createDemoAttacker, describeError, ensureWalletChain, parseLimits,
  planRegistration, planSessionTransfer, postRelay, publicClientFor, readBalance, readChainStatus,
  relayerIsUp, runLeakAttempts, walletChainFor,
  type ChainStatus, type DemoChain, type LeakAttemptRow, type RelayBody, type RelayExecuteBody, type MandateFormValues,
} from '../lib/usl';

export interface Deployment { chainId: number; mandateAccount: Address; owner: Address }
export interface ChainView { chain: DemoChain; deployment?: Deployment; status?: ChainStatus; error?: string }
export interface LogEntry { id: number; at: string; level: 'info' | 'ok' | 'warn' | 'error'; message: string; hash?: Hex; chainId?: number }
export interface DemoForm {
  perTxLimitEth: string;
  budgetEth: string;
  windowSeconds: string;
  expiryMinutes: string;
  recipient: string;
  amountEth: string;
  transferChainId: number;
  leakChainId: number;
}

const DEFAULT_FORM: DemoForm = {
  perTxLimitEth: '0.001',
  budgetEth: '0.005',
  windowSeconds: '3600',
  expiryMinutes: '60',
  recipient: '',
  amountEth: '0.0001',
  transferChainId: DEMO_CHAINS[0]!.chainId,
  leakChainId: DEMO_CHAINS[0]!.chainId,
};

export interface DemoContextValue {
  chainForms: Record<number, MandateFormValues>;
  updateChain(chainId: number, field: keyof MandateFormValues, value: string): void;
  limitsByChain: Record<number, GrantLimits>;
  readiness: Readiness[];
  diagnose(): Promise<void>;
  registrations: Record<number, string>;
  security(kind: 'budget' | 'over' | 'replay' | 'post-revoke'): Promise<void>;
  address?: Address;
  walletChainId?: number;
  connecting: boolean;
  isConnected: boolean;
  busy?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  switchWalletChain(chain: DemoChain): Promise<void>;
  chains: readonly DemoChain[];
  unconfigured: readonly DemoChain[];
  selected: number[];
  toggleChain(chainId: number): void;
  deployments: Deployment[];
  deploymentsError?: string;
  refreshDeployments(): Promise<void>;
  views: ChainView[];
  refreshViews(): Promise<void>;
  sessionKey?: SessionKey;
  generateSessionKey(): Promise<void>;
  clearSessionKey(): void;
  limits?: GrantLimits;
  mandate?: Mandate;
  signature?: Hex;
  sign(): Promise<void>;
  register(): Promise<void>;
  form: DemoForm;
  update(field: keyof DemoForm, value: string | number): void;
  send(overLimit: boolean): Promise<void>;
  revoke(chainId: number): Promise<void>;
  simulateLeak(chainId: number): Promise<void>;
  leakRows: LeakAttemptRow[];
  relayerUp: boolean;
  submissionMode: SubmissionMode;
  setSubmissionMode(mode: SubmissionMode): void;
  entries: LogEntry[];
  clearLog(): void;
  describeError: typeof describeError;
}

const DemoContext = createContext<DemoContextValue | undefined>(undefined);

export function useDemo(): DemoContextValue {
  const value = useContext(DemoContext);
  if (!value) throw new Error('useDemo must be used inside DemoProvider');
  return value;
}

export function DemoProvider({ children }: { children: ReactNode }) {
  const { address, chainId: walletChainId, isConnected } = useAccount();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { data: walletClient } = useWalletClient();

  const [keyStore] = useState(() => new MemoryStore());
  const clients = useRef<Map<number, PublicClient> | null>(null);
  const trackers = useRef<Map<string, SpendTracker> | null>(null);
  if (!clients.current) clients.current = new Map();
  if (!trackers.current) trackers.current = new Map();

  const [form, setForm] = useState<DemoForm>(DEFAULT_FORM);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<string>();
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [deploymentsError, setDeploymentsError] = useState<string>();
  const [selected, setSelected] = useState<number[]>(DEMO_CHAINS.map(chain => chain.chainId));
  const [chainForms, setChainForms] = useState<Record<number, MandateFormValues>>(() => Object.fromEntries(DEMO_CHAINS.map(chain => [chain.chainId, {
    perTxLimitEth: '0.0001', budgetEth: '0.0001', windowSeconds: '3600', expiryMinutes: '60',
  }])));
  const [limitsByChain, setLimitsByChain] = useState<Record<number, GrantLimits>>({});
  const [readiness, setReadiness] = useState<Readiness[]>([]);
  const [registrations, setRegistrations] = useState<Record<number, string>>({});
  const lastOperations = useRef(new Map<number, RelayExecuteBody>());
  const pendingRegistrations = useRef(new Map<number, Hex>());
  const actionLock = useRef(false);
  const [views, setViews] = useState<ChainView[]>([]);
  const [sessionKey, setSessionKeyState] = useState<SessionKey>();
  const [limits, setLimits] = useState<GrantLimits>();
  const [mandate, setMandate] = useState<Mandate>();
  const [signature, setSignature] = useState<Hex>();
  const [leakRows, setLeakRows] = useState<LeakAttemptRow[]>([]);
  const [relayerUp, setRelayerUp] = useState(false);
  const [submissionMode, setSubmissionMode] = useState(() => parseSubmissionMode(process.env.NEXT_PUBLIC_SUBMISSION_MODE));
  const previousOwner = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (previousOwner.current && previousOwner.current !== address?.toLowerCase()) {
      keyStore.clear(); setSessionKeyState(undefined); setMandate(undefined); setSignature(undefined);
      setLimits(undefined); setLimitsByChain({}); setRegistrations({}); setReadiness([]);
      pendingRegistrations.current.clear(); lastOperations.current.clear();
    }
    previousOwner.current = address?.toLowerCase();
  }, [address, keyStore]);

  const log = useCallback((level: LogEntry['level'], message: string, transaction?: { hash: Hex; chainId: number }) => {
    setEntries(previous => {
      const id = (previous.at(-1)?.id ?? 0) + 1;
      return [...previous.slice(-199), { id, at: clockTime(new Date()), level, message: redactErrorText(message), ...transaction }];
    });
  }, []);

  const run = useCallback(async (label: string, action: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(label);
    try {
      await action();
    } catch (error) {
      const operation = label === 'sign' ? 'signing' : label === 'register' ? 'registration'
        : label.startsWith('send-') ? 'session transfer' : label;
      log('error', describeActionError(operation, error));
    } finally {
      actionLock.current = false;
      setBusy(undefined);
    }
  }, [log]);

  const getClient = useCallback((chain: DemoChain): PublicClient => {
    const cache = clients.current!;
    const cached = cache.get(chain.chainId);
    if (cached) return cached;
    const client = publicClientFor(chain);
    cache.set(chain.chainId, client);
    return client;
  }, []);

  const setKey = useCallback((key?: SessionKey) => {
    if (key) keyStore.set(key);
    else keyStore.clear();
    setSessionKeyState(keyStore.get());
  }, [keyStore]);


  const selectedChains = useMemo(
    () => DEMO_CHAINS.filter(chain => selected.includes(chain.chainId)),
    [selected],
  );
  const deploymentFor = useCallback(
    (chainId: number) => deployments.find(record => record.chainId === chainId),
    [deployments],
  );
  /** Newest timestamp of the selected chains; only used to build deadlines and expiry. */
  const newestChainTime = useCallback(async (chains: readonly DemoChain[]) => {
    const stamps = await Promise.all(chains.filter(chain => chain.rpcUrl)
      .map(async chain => (await getClient(chain).getBlock()).timestamp));
    if (!stamps.length) throw new Error('No RPC URL is configured for the selected chains in demo/.env.local');
    return stamps.reduce((left, right) => (right > left ? right : left));
  }, [getClient]);

  const refreshDeployments = useCallback(async () => {
    try {
      const response = await fetch('/api/deployments');
      const payload = await response.json() as { deployments?: Deployment[]; error?: string };
      setDeployments(payload.deployments ?? []);
      setDeploymentsError(payload.error);
      if (!payload.deployments?.length) {
        log('warn', payload.error ?? 'No deployments/<chainId>.json record found; deploy an account first.');
      } else {
        log('info', `Read ${payload.deployments.length} address-only deployment record(s) from deployments/`);
      }
      if (submissionMode === 'relayer') setRelayerUp(await relayerIsUp(RELAYER_URL, fetch));
    } catch (error) {
      setDeploymentsError(describeError(error));
      log('error', `Could not read deployments: ${describeError(error)}`);
    }
  }, [log, submissionMode]);

  const refreshViews = useCallback(async () => {
    const stored = keyStore.get();
    setSessionKeyState(stored);
    const nonce = mandate?.nonce ?? 0n;
    const results: ChainView[] = [];
    for (const chain of DEMO_CHAINS) {
      const deployment = deploymentFor(chain.chainId);
      if (!deployment || !stored || !chain.rpcUrl) {
        results.push({ chain, deployment });
        continue;
      }
      try {
        results.push({
          chain,
          deployment,
          status: await readChainStatus({
            publicClient: getClient(chain),
            account: deployment.mandateAccount,
            sessionKey: stored.address,
            mandateNonce: nonce,
          }),
        });
      } catch (error) {
        results.push({ chain, deployment, error: describeError(error) });
      }
    }
    setViews(results);
  }, [deploymentFor, getClient, keyStore, mandate?.nonce, selectedChains]);

  useEffect(() => { void refreshDeployments(); }, [refreshDeployments]);
  useEffect(() => { void refreshViews(); }, [refreshViews]);
  useEffect(() => { const timer = setInterval(() => { if (!actionLock.current) void refreshViews(); }, 12000); return () => clearInterval(timer); }, [refreshViews]);

  const diagnose = useCallback(async () => {
    await run('diagnostics', async () => {
      const results = await Promise.all(DEMO_CHAINS.map(async chain => {
        if (!chain.rpcUrl) return { chainId: chain.chainId, ready: false, message: 'RPC not configured' };
        return checkReadiness({ chain, client: getClient(chain), account: deploymentFor(chain.chainId)?.mandateAccount,
          owner: address, sessionKey: sessionKey?.address });
      }));
      setReadiness(results);
      log(results.every(result => result.ready) ? 'ok' : 'warn', `Pre-demo check: ${results.filter(result => result.ready).length}/${results.length} chains ready`);
    });
  }, [address, deploymentFor, getClient, log, run, sessionKey?.address]);

  const updateChain = useCallback((chainId: number, field: keyof MandateFormValues, value: string) => {
    setChainForms(previous => ({ ...previous, [chainId]: { ...previous[chainId]!, [field]: value } }));
  }, []);

  const connect = useCallback(async () => {
    await run('connect', async () => {
      const connector = connectors[0];
      if (!connector) throw new Error('MetaMask was not found in this browser');
      await connectAsync({ connector });
      log('ok', 'Wallet connected');
    });
  }, [connectAsync, connectors, log, run]);

  const disconnect = useCallback(async () => {
    await disconnectAsync();
    setKey(undefined);
    setMandate(undefined);
    setSignature(undefined);
    setLimits(undefined);
    setLeakRows([]);
    log('info', 'Wallet disconnected; the in-memory session key was destroyed');
  }, [disconnectAsync, log, setKey]);

  const switchWalletChain = useCallback(async (chain: DemoChain) => {
    await run(`switch:${chain.chainId}`, async () => {
      if (!walletClient) throw new Error('Connect MetaMask first');
      await ensureWalletChain(walletClient, chain);
      log('ok', `Wallet is on ${chain.label} (chain id ${chain.chainId})`);
    });
  }, [log, run, walletClient]);

  const toggleChain = useCallback((chainId: number) => {
    setSelected(previous => (previous.includes(chainId)
      ? previous.filter(id => id !== chainId)
      : [...previous, chainId].sort((left, right) => left - right)));
    // A different chain set is a different mandate, so the signature is dropped.
    setMandate(undefined);
    setSignature(undefined);
  }, []);

  const generateSessionKey = useCallback(async () => {
    await run('session-key', async () => {
      const chains = selectedChains;
      if (!chains.length) throw new Error('Select at least one chain');
      // Key generation and its readable preview are entirely local.  Do not make the
      // first demo action look broken merely because a public RPC/deployment has not
      // been configured yet; signing still reads each chain clock before it proceeds.
      const now = BigInt(Math.floor(Date.now() / 1_000));
      const parsedByChain = Object.fromEntries(chains.map(chain => [chain.chainId, parseLimits(chainForms[chain.chainId]!, now)]));
      const parsed = parsedByChain[chains[0]!.chainId]!;
      const expiry = Object.values(parsedByChain).reduce((latest, item) => item.expiry > latest ? item.expiry : latest, 0n);
      const key = createSessionKey({ expiry });
      setLimitsByChain(parsedByChain);
      setRegistrations({}); pendingRegistrations.current.clear(); lastOperations.current.clear();
      setKey(key);
      setLimits(parsed);
      setMandate(undefined);
      setSignature(undefined);
      setLeakRows([]);
      log('ok', `Session key created in memory only: ${key.address}`);
      log('info', `Permissions fixed for ${chains.length} independent chain grants. Review each cap, budget and expiry before signing.`);
    });
  }, [chainForms, log, run, selectedChains, setKey]);

  const clearSessionKey = useCallback(() => {
    setKey(undefined);
    setMandate(undefined);
    setSignature(undefined);
    log('info', 'Session key destroyed; sign a new mandate to continue');
  }, [log, setKey]);

  const sign = useCallback(async () => {
    await run('sign', async () => {
      const key = keyStore.get();
      if (!key) throw new Error('Generate a session key first');
      if (!walletClient || !address) throw new Error('Connect MetaMask first');
      if (!limits) throw new Error('Generate a session key first: the limits are fixed at that step');
      const targets: { chain: DemoChain; account: Address; limits: GrantLimits }[] = [];
      for (const chain of selectedChains) {
        const deployment = deploymentFor(chain.chainId);
        if (!deployment) throw new Error(`No deployed account for ${chain.label}; run the Phase 6 deploy script and refresh`);
        if (!chain.rpcUrl) throw new Error(`${chain.label} has no RPC URL in demo/.env.local`);
        await assertDeployment(getClient(chain), chain, deployment.mandateAccount);
        const owner = await getClient(chain).readContract({
          address: deployment.mandateAccount, abi: ACCOUNT_VIEW_ABI, functionName: 'owner',
        });
        if (owner.toLowerCase() !== address.toLowerCase()) {
          throw new Error(`The connected wallet is not the owner of the ${chain.label} account (${deployment.mandateAccount})`);
        }
        const chainLimits = limitsByChain[chain.chainId];
        if (!chainLimits) throw new Error('Generate a new session key after changing the selected chains');
        targets.push({ chain, account: deployment.mandateAccount, limits: chainLimits });
      }
      if (!targets.length) throw new Error('Select at least one chain');
      const now = await newestChainTime(targets.map(target => target.chain));
      const built = buildChainMandate({ sessionKey: key.address, targets, now });
      log('info', `Requesting ONE signature for ${built.grants.length} grant(s): the wallet shows every chain, session key and limit (domain USLMandate/1, no chainId, no verifyingContract)`);
      const signed = await signMandateWithWallet(walletClient, built);
      setMandate(built);
      setSignature(signed);
      setRegistrations({}); pendingRegistrations.current.clear();
      log('ok', `Mandate ${built.nonce} signed once; the same signature registers on ${built.grants.length} chain(s)`);
      await refreshViews();
    });
  }, [address, deploymentFor, getClient, keyStore, limits, limitsByChain, log, newestChainTime, refreshViews, run, selectedChains, walletClient]);

  const submit = useCallback(async (body: RelayBody, chain: DemoChain) => {
    if (submissionMode === 'relayer') return postRelay({ relayerUrl: RELAYER_URL, fetchImpl: fetch, body });
    if (!walletClient) throw new Error('Connect MetaMask first');
    log('info', `${chain.label}: Direct Wallet Mode — confirm in MetaMask; you pay gas`);
    return submitDirect({ body, chain, wallet: walletClient, publicClient: getClient(chain) });
  }, [submissionMode, walletClient, getClient, log]);

  const register = useCallback(async () => {
    await run('register', async () => {
      const key = keyStore.get();
      if (!key) throw new Error('Generate a session key first');
      if (!mandate || !signature) throw new Error('Sign the mandate first');
      if (!address) throw new Error('Connect MetaMask first');
      if (submissionMode === 'relayer') {
        const online = await relayerIsUp(RELAYER_URL, fetch);
        setRelayerUp(online);
        if (!online) {
          throw new Error('Relayer health check failed through /api/relayer/health. Check the demo server terminal and the relayer health endpoint. Restart the demo after changing NEXT_PUBLIC_RELAYER_URL. Registration in Relayer Mode does not prompt MetaMask.');
        }
      }
      for (const chain of selectedChains) {
        try {
          const deployment = deploymentFor(chain.chainId);
          if (!deployment) throw new Error(`No deployed account record for ${chain.label}`);
          if (await registrationComplete(getClient(chain), deployment.mandateAccount, mandate.nonce)) {
            setRegistrations(previous => ({ ...previous, [chain.chainId]: 'confirmed' }));
            continue;
          }
          setRegistrations(previous => ({ ...previous, [chain.chainId]: 'awaiting wallet / receipt' }));
          let hash = pendingRegistrations.current.get(chain.chainId);
          if (!hash) {
            const now = (await getClient(chain).getBlock()).timestamp;
            const plan = await planRegistration({
              mandate, signature, chain, account: deployment.mandateAccount, owner: address, now,
            });
            if (!plan.verification.valid) throw new Error(`the SDK rejected the envelope: ${plan.verification.message}`);
            log('info', `${chain.label}: the SDK verified the envelope before anything was sent`);
            hash = await submit(plan.body, chain);
            pendingRegistrations.current.set(chain.chainId, hash);
          }
          log('info', `${chain.label}: registration submitted, waiting for receipt`, { hash, chainId: chain.chainId });
          const receipt = await registrationReceipt(getClient(chain), hash);
          if (!receipt) {
            setRegistrations(previous => ({ ...previous, [chain.chainId]: 'still pending / check again' }));
            log('warn', `${chain.label}: confirmation timed out; registration may still be pending. Retry checks the existing transaction without submitting again.`, { hash, chainId: chain.chainId });
            continue;
          }
          pendingRegistrations.current.delete(chain.chainId);
          if (receipt.status !== 'success') throw new Error('Registration reverted');
          setRegistrations(previous => ({ ...previous, [chain.chainId]: 'confirmed' }));
          log('ok', `${chain.label}: registration confirmed`, { hash, chainId: chain.chainId });
        } catch (error) {
          // A failure on one chain must not hide the result on the others.
          log('error', describeActionError(`registration (${chain.label})`, error));
          setRegistrations(previous => ({ ...previous, [chain.chainId]: 'failed / retry available' }));
        }
      }
      await refreshViews();
    });
  }, [address, deploymentFor, getClient, keyStore, log, mandate, refreshViews, run, selectedChains, signature, submissionMode, submit]);

  const update = useCallback((field: keyof DemoForm, value: string | number) => {
    setForm(previous => ({ ...previous, [field]: value }));
  }, []);

  const send = useCallback(async (overLimit: boolean) => {
    await run(overLimit ? 'send-over' : 'send-small', async () => {
      const key = keyStore.get();
      if (!key) throw new Error('Generate a session key first');
      if (!mandate) throw new Error('Sign and register a mandate first');
      const chain = chainById(form.transferChainId);
      const deployment = deploymentFor(chain.chainId);
      if (!deployment) throw new Error(`No deployed account for ${chain.label}`);
      if (!isAddress(form.recipient)) throw new Error('Enter the recipient address (0x…)');
      const grant = mandate.grants.find(candidate => candidate.domain.chainId === BigInt(chain.chainId));
      if (!grant) throw new Error(`The mandate has no grant for ${chain.label}`);
      const client = getClient(chain);
      const block = await client.getBlock();
      // This is the same address that signs the operation below.  Read its actual
      // storage before the submission preflight so a SessionNotActive revert is
      // explained as a mandate-lifecycle issue rather than a generic eth_call error.
      const onChain = await readChainStatus({
        publicClient: client,
        account: deployment.mandateAccount,
        sessionKey: key.address,
        mandateNonce: mandate.nonce,
      });
      log('info', `${chain.label}: transfer preflight — account ${deployment.mandateAccount}, session ${key.address}, mandate ${mandate.nonce} used=${onChain.mandateUsed}, active=${onChain.session.active}`);
      if (!onChain.mandateUsed) {
        throw new Error(`This mandate is not registered on ${chain.label}. Use “Register / retry remaining chains” and wait for its confirmed receipt before sending. Relayer Mode submits without a MetaMask transaction prompt.`);
      }
      if (!onChain.session.active) {
        throw new Error(`The current browser session key (${key.address}) is inactive on ${chain.label}. It was revoked, or this browser key is not the key in the registered mandate. Generate a new key, sign a new mandate, and register it on this chain.`);
      }
      if (onChain.session.expiry <= block.timestamp) {
        throw new Error(`The registered session expired on ${chain.label}. Generate, sign, and register a new mandate.`);
      }
      let amount: bigint;
      if (overLimit) {
        amount = grant.perTxLimit + parseEther('0.001');
      } else {
        try {
          amount = parseEther(form.amountEth.trim());
        } catch {
          throw new Error('Enter the transfer amount in ETH, for example 0.0001');
        }
      }
      const trackerKey = `${chain.chainId}:${key.address}:${grant.windowSeconds}`;
      let tracker = trackers.current!.get(trackerKey);
      if (!tracker) {
        tracker = new SpendTracker({ chainId: chain.caip2, sessionKey: key.address, windowSeconds: grant.windowSeconds });
        trackers.current!.set(trackerKey, tracker);
      }
      const plan = await planSessionTransfer({
        chain, account: deployment.mandateAccount, sessionKey: key, grant, tracker, publicClient: client,
        recipient: form.recipient, amount, now: block.timestamp,
      });
      log('info', `SDK policy pre-check on ${chain.label}: ${plan.policy.decision} — ${plan.policy.reason}`);
      const hash = await submit(plan.body, chain);
      log('info', `${chain.label}: session transfer submitted, waiting for receipt`, { hash, chainId: chain.chainId });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Transfer reverted; no spend was recorded');
      lastOperations.current.set(chain.chainId, plan.body);
      log('ok', `${chain.label}: confirmed ${eth(amount)} ETH transfer, authorized by the session key`, { hash, chainId: chain.chainId });
      const sync = await recordConfirmedSpend(client, receipt.blockHash, timestamp => tracker.record(amount, timestamp));
      if (!sync.synced) {
        log('warn', `${chain.label}: transfer confirmed; local spending tracker could not update. Do not resend this payment. On-chain spending limits still apply.\n${describeActionError('spending tracker update', sync.error)}`, { hash, chainId: chain.chainId });
      }
      await refreshViews();
    });
  }, [deploymentFor, form, getClient, keyStore, log, mandate, refreshViews, run, submit]);

  const revoke = useCallback(async (chainId: number) => {
    await run(`revoke:${chainId}`, async () => {
      const key = keyStore.get();
      if (!key) throw new Error('There is no session key to revoke');
      if (!walletClient || !address) throw new Error('Connect MetaMask first');
      const chain = chainById(chainId);
      const deployment = deploymentFor(chainId);
      if (!deployment) throw new Error(`No deployed account record for ${chain.label}`);
      await ensureWalletChain(walletClient, chain);
      const hash = await walletClient.writeContract({
        account: address,
        chain: walletChainFor(chain),
        address: deployment.mandateAccount,
        abi: ACCOUNT_VIEW_ABI,
        functionName: 'revokeSession',
        args: [key.address],
      });
      const receipt = await getClient(chain).waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Revocation reverted; the session may still be active');
      log('ok', `${chain.label}: session revocation confirmed`, { hash, chainId: chain.chainId });
      await refreshViews();
    });
  }, [address, deploymentFor, getClient, keyStore, log, refreshViews, run, walletClient]);

  const security = useCallback(async (kind: 'budget' | 'over' | 'replay' | 'post-revoke') => {
    await run(`security:${kind}`, async () => {
      const key = keyStore.get();
      if (!key || !address || !mandate) throw new Error('Connect wallet, generate a key and register the mandate first');
      const chain = chainById(form.transferChainId);
      const account = deploymentFor(chain.chainId)?.mandateAccount;
      if (!account) throw new Error('Deployment missing');
      const client = getClient(chain);
      const status = await readChainStatus({ publicClient: client, account, sessionKey: key.address, mandateNonce: mandate.nonce });
      let body = lastOperations.current.get(chain.chainId);
      if (kind === 'replay' && !body) throw new Error('Confirm a valid session transfer on this chain before replaying it');
      if (kind !== 'replay') {
        const amount = kind === 'over' ? status.session.perTxLimit + 1n : kind === 'budget' ? budgetProbeValue(status.session, status.now) : 1n;
        const plan = await planSessionTransfer({ chain, account, sessionKey: key,
          grant: mandate.grants.find(grant => grant.domain.chainId === BigInt(chain.chainId)),
          tracker: new SpendTracker({ chainId: chain.caip2, sessionKey: key.address, windowSeconds: status.session.windowSeconds }),
          publicClient: client, recipient: address, amount, now: status.now });
        body = plan.body;
      }
      const result = await probeSignedOperation({ chain, client, body: body!, payer: address });
      const expected = { over: 'PerTxLimitExceeded', budget: 'BudgetExceeded', replay: 'OperationNonceUsed', 'post-revoke': 'SessionNotActive' }[kind];
      log(result.rejected && result.reason === expected ? 'ok' : 'warn', `${chain.label}: ${kind} — ${result.reason}. Real contract simulation; no transaction or gas charge.`);
      await refreshViews();
    });
  }, [address, deploymentFor, form.transferChainId, getClient, keyStore, log, mandate, refreshViews, run]);

  const simulateLeak = useCallback(async (chainId: number) => {
    await run(`leak:${chainId}`, async () => {
      const key = keyStore.get();
      if (!key) throw new Error('Generate a session key first');
      if (!walletClient || !address) throw new Error('Connect MetaMask first (it funds the throwaway attacker account)');
      const chain = chainById(chainId);
      const deployment = deploymentFor(chainId);
      if (!deployment) throw new Error(`No deployed account record for ${chain.label}`);
      const client = getClient(chain);
      const attacker = createDemoAttacker();
      await ensureWalletChain(walletClient, chain);
      const balance = await readBalance(client, attacker.address);
      if (balance < parseEther('0.02')) {
        const funding = await walletClient.sendTransaction({
          account: address, chain: walletChainFor(chain), to: attacker.address, value: parseEther('0.1'),
        });
        await client.waitForTransactionReceipt({ hash: funding });
        log('info', `${chain.label}: funded a throwaway attacker account so it pays its own gas (${shortHex(attacker.address)})`);
      }
      const block = await client.getBlock();
      const status = await readChainStatus({
        publicClient: client, account: deployment.mandateAccount,
        sessionKey: key.address, mandateNonce: mandate?.nonce ?? 0n,
      });
      if (!status.session.active) log('warn', `${chain.label}: this session is not active, so the leaked key has no power at all`);
      log('info', `Playing the attacker on ${chain.label}: direct submissions to the account contract, no relayer and no SDK pre-check`);
      const rows = await runLeakAttempts({
        chain, account: deployment.mandateAccount, sessionKey: key, attacker,
        publicClient: client, session: status.session, now: block.timestamp,
      });
      setLeakRows(rows);
      const drained = rows.reduce((total, row) => total + row.drainedWei, 0n);
      log(drained === 0n ? 'ok' : 'warn', `${chain.label}: over-limit attempts drained ${eth(drained)} ETH; the contract rejected every one of them`);
      await refreshViews();
    });
  }, [address, deploymentFor, getClient, keyStore, log, mandate?.nonce, refreshViews, run, walletClient]);

  const value = useMemo<DemoContextValue>(() => ({
    chainForms, updateChain, limitsByChain, readiness, diagnose, registrations, security,
    address,
    walletChainId,
    connecting,
    isConnected,
    busy,
    connect,
    disconnect,
    switchWalletChain,
    chains: DEMO_CHAINS,
    unconfigured: UNCONFIGURED_CHAINS,
    selected,
    toggleChain,
    deployments,
    deploymentsError,
    refreshDeployments,
    views,
    refreshViews,
    sessionKey,
    generateSessionKey,
    clearSessionKey,
    limits,
    mandate,
    signature,
    sign,
    register,
    form,
    update,
    send,
    revoke,
    simulateLeak,
    leakRows,
    relayerUp,
    submissionMode,
    setSubmissionMode,
    entries,
    clearLog: () => setEntries([]),
    describeError,
  }), [
    address, walletChainId, connecting, isConnected, busy, connect, disconnect, switchWalletChain, selected,
    toggleChain, deployments, deploymentsError, refreshDeployments, views, refreshViews, sessionKey,
    generateSessionKey, clearSessionKey, limits, mandate, signature, sign, register, form, update, send,
    revoke, simulateLeak, leakRows, relayerUp, entries, submissionMode,
    chainForms, updateChain, limitsByChain, readiness, diagnose, registrations, security,
  ]);

  return <DemoContext.Provider value={value}>{children}</DemoContext.Provider>;
}
