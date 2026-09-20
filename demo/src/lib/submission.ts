import { encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { ACCOUNT_ABI } from '@usl/sdk/adapters';
import { ensureWalletChain, walletChainFor, type DemoChain, type RelayBody } from './usl';

export type SubmissionMode = 'direct' | 'relayer';

export function parseSubmissionMode(value?: string): SubmissionMode {
  if (!value?.trim() || value === 'direct') return 'direct';
  if (value === 'relayer') return 'relayer';
  throw new Error('NEXT_PUBLIC_SUBMISSION_MODE must be direct or relayer');
}

export async function assertDeployment(publicClient: PublicClient, chain: DemoChain, account: Address): Promise<void> {
  if (await publicClient.getChainId() !== chain.chainId) throw new Error(`${chain.label}: RPC chain mismatch`);
  const code = await publicClient.getCode({ address: account });
  if (!code || code === '0x') {
    throw new Error(`${chain.label}: no account contract at ${account}. The deployment record is stale or belongs to another node. Deploy and fund the account on the current node, update deployments/${chain.chainId}.json, then refresh.`);
  }
}

/** Only the two signed account entry points can be submitted through this path. */
export async function submitDirect(input: {
  body: RelayBody; chain: DemoChain; wallet: WalletClient; publicClient: PublicClient;
}): Promise<Hex> {
  const { body, chain, wallet, publicClient } = input;
  if (!wallet.account) throw new Error('Connect MetaMask first');
  if (![31337, 31338, 31339, 11155111, 84532, 421614].includes(chain.chainId) || body.chainId !== chain.chainId) {
    throw new Error('Submission chain does not match a supported test chain');
  }
  let data: Hex;
  if (body.kind === 'register') {
    const { grant, nonce, deadline, envelope } = body.args;
    if (BigInt(grant.domain.chainId) !== BigInt(chain.chainId)
      || grant.domain.verifyingContract.toLowerCase() !== body.account.toLowerCase()) {
      throw new Error('Grant does not match the target account and chain');
    }
    data = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'registerMandate', args: [{
      domain: { chainId: BigInt(grant.domain.chainId), verifyingContract: grant.domain.verifyingContract },
      sessionKey: grant.sessionKey, perTxLimit: BigInt(grant.perTxLimit), budget: BigInt(grant.budget),
      windowSeconds: BigInt(grant.windowSeconds), expiry: BigInt(grant.expiry),
    }, BigInt(nonce), BigInt(deadline), envelope] });
  } else if (body.kind === 'execute') {
    const { to, value, nonce, deadline, signature } = body.args;
    data = encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeWithSessionSig', args: [{
      to, value: BigInt(value), nonce: BigInt(nonce), deadline: BigInt(deadline),
    }, signature] });
  } else {
    throw new Error('Unsupported submission kind');
  }
  await assertDeployment(publicClient, chain, body.account);
  await ensureWalletChain(wallet, chain);
  // Simulate the exact signed call, then send zero outer value: funds come from the account.
  const request = { account: wallet.account, to: body.account, data, value: 0n };
  await publicClient.call(request);
  return wallet.sendTransaction({ ...request, chain: walletChainFor(chain) });
}
