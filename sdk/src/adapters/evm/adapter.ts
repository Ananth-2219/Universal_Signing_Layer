import { encodeFunctionData, type Address, type Hex, type PublicClient, type WalletClient } from 'viem';
import { assertSignature, assertUint256, encodeEnvelope } from '../../core/index.js';
import type { SessionKey } from '../../keys/index.js';
import { parseCaip2 } from '../registry.js';
import type { ChainAdapter, Intent, Operation, OperationContext, RegistrationRequest, SubmitRequest, Submitter } from '../types.js';
import { ACCOUNT_ABI } from './abi.js';
import { address, assertData, buildOperation, operationTypedData, randomNonce, validateOperation } from './operation.js';

export class EvmAdapter implements ChainAdapter {
  readonly chainId: string;
  private readonly publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>;
  private readonly nonceGenerator: () => bigint;
  constructor(input: { chainId: string; publicClient: Pick<PublicClient, 'waitForTransactionReceipt'>; nonceGenerator?: () => bigint }) {
    parseCaip2(input.chainId);
    this.chainId = input.chainId; this.publicClient = input.publicClient;
    this.nonceGenerator = input.nonceGenerator ?? randomNonce;
  }
  buildOperation(intent: Intent, context: OperationContext): Operation {
    return buildOperation(this.chainId, intent, context, this.nonceGenerator);
  }
  operationTypedData(op: Operation, account: Address) { return operationTypedData(this.chainId, op, account); }
  signOperation(op: Operation, account: Address, sessionKey: SessionKey, now: bigint): Promise<Hex> {
    return sessionKey.signTypedData(this.operationTypedData(op, account), now);
  }
  buildExecuteRequest(op: Operation, account: Address, signature: Hex): SubmitRequest {
    validateOperation(op); assertSignature(signature);
    return { chainId: this.chainId, to: address(account), value: 0n,
      data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'executeWithSessionSig', args: [{ ...op, to: address(op.to) }, signature] }) };
  }
  buildRegistrationRequest({ mandate, signature, account, application }: RegistrationRequest): SubmitRequest {
    const numeric = parseCaip2(this.chainId).numericChainId;
    const target = address(account);
    const grant = mandate.grants.find(g => g.domain.chainId === numeric && g.domain.verifyingContract.toLowerCase() === target);
    if (!grant) throw new Error(`No mandate grant for ${this.chainId} and account ${target}`);
    const envelope = encodeEnvelope({ mandate, signature, chainId: numeric, verifyingContract: target, application });
    const normalized = { ...grant, sessionKey: address(grant.sessionKey), domain: { ...grant.domain, verifyingContract: target } };
    return { chainId: this.chainId, to: target, value: 0n,
      data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'registerMandate', args: [normalized, mandate.nonce, mandate.deadline, envelope] }) };
  }
  submit(req: SubmitRequest, submitter: Submitter): Promise<Hex> {
    if (req.chainId !== this.chainId) throw new Error('Request chain does not match adapter');
    return submitter.submit(req);
  }
  async waitForReceipt(hash: Hex) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return { status: receipt.status, blockNumber: receipt.blockNumber };
  }
}

/** The configured wallet sends the outer transaction and funds its gas. */
export class ViemSubmitter implements Submitter {
  constructor(private readonly walletClient: WalletClient) {}
  async submit(req: SubmitRequest): Promise<Hex> {
    const { account, chain } = this.walletClient;
    if (!account || !chain) throw new Error('Submitter wallet requires a configured account and chain');
    if (BigInt(chain.id) !== parseCaip2(req.chainId).numericChainId) throw new Error('Submitter wallet chain mismatch');
    assertData(req.data); assertUint256(req.value ?? 0n, 'value');
    return this.walletClient.sendTransaction({ account, chain, to: address(req.to), data: req.data, value: req.value ?? 0n });
  }
}
