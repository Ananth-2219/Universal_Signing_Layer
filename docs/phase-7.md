# Phase 7: two-chain SDK integration

The SDK integration test starts two temporary local Anvil chains: chain 31337 on
port 8545 and chain 31338 on port 8546. It deploys one `MandateAccount` on each,
then creates and signs one ERC-7964 mandate containing one grant per account.
The same random in-memory session key is registered independently on both chains.

The test sends a native ETH payment through the SDK on each chain and checks both
the account decrease and recipient increase. It also checks rejected per-payment
and budget-limit payments, replayed nonces, expired sessions, unknown session keys,
invalid signatures, calldata/token intents, and wrong-chain and wrong-account grants.
Anvil is started and stopped by `sdk/test/phase7.integration.test.ts`; no RPC URL,
private key, or deployment record is needed for this test.

Validation on 2026-09-19:
- `forge build` passed (existing Foundry lint warnings only).
- `forge fmt --check` passed.
- `forge test -vv` passed: 43 tests, 0 failures, 0 skipped.
- `npm test` passed: 182 tests, 0 failures; this includes 7 Phase 7 integration tests.
- `npx tsc --noEmit` passed.

Limits: this is Anvil-only and native-ETH session operations remain empty-calldata
only. The fixed-window budget boundary weakness documented in Phase 5 still applies.
