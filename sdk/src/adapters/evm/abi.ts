import { parseAbi } from 'viem';

// Must match contracts in Phase 5. These are the only account ABI definitions.
export const ACCOUNT_ABI = parseAbi([
  'function executeWithSessionSig((address to,uint256 value,uint256 nonce,uint256 deadline) op, bytes signature)',
  'function registerMandate(((uint256 chainId,address verifyingContract) domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry) grant,uint256 nonce,uint256 deadline,bytes envelope)',
]);
