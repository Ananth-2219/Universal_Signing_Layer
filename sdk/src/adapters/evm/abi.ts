import { decodeErrorResult, parseAbi, type Hex } from 'viem';

// Must match contracts in Phase 5. These are the only account ABI definitions.
export const ACCOUNT_ABI = parseAbi([
  'function executeWithSessionSig((address to,uint256 value,uint256 nonce,uint256 deadline) op, bytes signature)',
  'function registerMandate(((uint256 chainId,address verifyingContract) domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry) grant,uint256 nonce,uint256 deadline,bytes envelope)',
]);

/**
 * Read-only and owner-only fragments used by the Phase 10 demo. Kept apart from
 * ACCOUNT_ABI, whose two encoding fragments are frozen by the Phase 3 test.
 */
export const ACCOUNT_VIEW_ABI = parseAbi([
  'function owner() view returns (address)',
  'function sessions(address sessionKey) view returns ((uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry,uint256 windowStart,uint256 spent,bool active))',
  'function mandateIdUsed(uint256 mandateId) view returns (bool)',
  'function revokeSession(address sessionKey)',
]);

/** MandateAccount custom errors, so revert data can be shown as a readable reason. */
export const ACCOUNT_ERROR_ABI = parseAbi([
  'error InvalidOwner()',
  'error InvalidSessionKey()',
  'error InvalidWindow()',
  'error NotOwner()',
  'error WrongChain()',
  'error WrongAccount()',
  'error DeadlinePassed()',
  'error SessionExpired()',
  'error MandateNonceUsed()',
  'error OperationNonceUsed()',
  'error ConsentNonceUsed()',
  'error RevokeNonceUsed()',
  'error SessionAlreadyActive()',
  'error SessionNotActive()',
  'error InvalidEnvelope()',
  'error WrongMagic()',
  'error WrongFields()',
  'error InvalidStructIndex()',
  'error WrongApplication()',
  'error GrantHashMismatch()',
  'error InvalidSignature()',
  'error WrongSigner()',
  'error PerTxLimitExceeded()',
  'error BudgetExceeded()',
  'error InvalidWindowTime()',
  'error InsufficientBalance()',
  'error CallFailed()',
]);

/** Name of the custom error in revert data, or undefined when it is not one of ours. */
export function decodeAccountError(data: unknown): string | undefined {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(data)) return undefined;
  try {
    return decodeErrorResult({ abi: ACCOUNT_ERROR_ABI, data: data as Hex }).errorName;
  } catch {
    return undefined;
  }
}
