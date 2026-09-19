import type { Intent } from '../adapters/types.js';
import { parseCaip2 } from '../adapters/registry.js';
import { assertAddress, assertUint256, validateGrant, type MandateGrant } from '../core/index.js';
import type { SpendTracker } from './tracker.js';

export interface PolicyResult { decision: 'allow' | 'needs_consent' | 'deny'; reason: string }

/** Advisory native-transfer checks. Only the account contract enforces permission. */
export function evaluate(intent: Intent, grant: MandateGrant | undefined, tracker: SpendTracker, now: bigint): PolicyResult {
  const result = (decision: PolicyResult['decision'], reason: string): PolicyResult => ({ decision, reason });
  try {
    const chain = parseCaip2(intent.chainId).numericChainId;
    if (!grant || grant.domain.chainId !== chain) return result('deny', 'No grant for this chain');
    assertUint256(now, 'now'); validateGrant(grant);
    if (grant.expiry <= now) return result('deny', 'Session expired; a new mandate is required');
    if (intent.asset !== 'native' || (intent.data !== undefined && intent.data !== '0x')) {
      return result('needs_consent', 'Tokens and calldata require fresh owner consent');
    }
    assertAddress(intent.to, 'to'); assertUint256(intent.amount, 'amount');
    if (tracker.chainId !== intent.chainId || tracker.sessionKey !== grant.sessionKey.toLowerCase()
      || tracker.windowSeconds !== grant.windowSeconds) return result('deny', 'Tracker does not match grant scope');
    if (intent.amount > grant.perTxLimit) return result('needs_consent', 'Per-transaction limit exceeded');
    const { spent } = tracker.snapshot(now);
    if (spent + intent.amount > grant.budget) return result('needs_consent', 'Fixed-window budget exceeded');
    return result('allow', 'Within native-transfer limits');
  } catch {
    return result('deny', 'Invalid policy input or tracker state');
  }
}
