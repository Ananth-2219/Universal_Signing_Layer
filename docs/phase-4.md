# Phase 4: off-chain policy pre-check

Source of truth: the user-supplied sections 3 and 6 and Phase 4 rules.
PROJECT_CONTEXT.md was never saved; no claim is made to have read that file.
The evaluator returns allow, needs_consent, or deny, with a plain-language reason.
Missing/wrong-chain grants and expiry <= now deny; a new mandate is needed.
Tokens, nonempty calldata, amounts above perTxLimit, or excess budget need consent.
The adapter additionally throws NeedsConsentError for token/calldata session requests.
Native limits are bigint wei, not USD, and empty calldata means absent or `0x`.

Create SpendTracker({ chainId, sessionKey, windowSeconds }) for each pair in an account.
The first record(value, now) starts a fixed window; later spends do not extend it.
At now >= windowStart + windowSeconds, the next recorded spend starts a new window.
Evaluation reads snapshot(now) without starting windows or recording a spend.
Call record only for confirmed successful spends, using their on-chain timestamp.
Times must not precede the last recorded spend. Separate trackers isolate chain/key pairs.
save() returns JSON; SpendTracker.load(json) restores identity, timing, and exact bigints.
JSON stores decimal strings and public addresses, never signing keys; corrupt state fails.

Fixed windows permit a burst: spend 1 at t=100, 99 at t=109, then 100 at t=110
with a 100 budget and 10-second window: 199 is allowed within one second.
No positive-duration constraint was specified: a zero window resets on every spend.
PriceProvider/MockPriceProvider return a native token's USD price at a chosen scale.
toNativeLimit(usd, price) takes bigint inputs at the SAME USD scale and floors to wei.
For example, 10_000000 / 2000_000000 USD units authorizes 5_000000000000000 wei.
Conversion happens at mandate creation; future price changes do not rewrite limits.

Run `npm test` and `npx tsc --noEmit`. Tests cover boundaries, bursts, drip spending,
JSON restoration, scope isolation, and precision beyond JavaScript's safe integer range.
This cache cannot prove activation, revocation, or current chain state; the contract decides.
