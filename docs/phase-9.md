# Phase 9: leaked session-key limits

The attacker test uses only a throwaway session key and submits directly to local
Anvil accounts. It cannot use the owner key, relayer, or SDK policy pre-check.

Verified: a permitted session transfer works; per-payment and fixed-window budgets
reject excess spending; a direct owner revocation disables later session signatures;
a session-key signature cannot authorize owner Consent; replayed operation nonces and
invalid session signatures reject. The test asserts recorded spend never exceeds its
configured budget in its window.

Session operations have no calldata parameter in the frozen interface, so a non-empty
calldata transfer cannot be constructed. The SDK also rejects calldata/token intents.
The Foundry boundary test documents the fixed window: at its exact reset boundary a
new window begins, permitting nearly two budgets across a boundary.

Validation on 2026-09-19: `npm test` passed 184 tests; `npx tsc --noEmit` passed.
`forge build`, `forge fmt --check`, and `forge test -vv` also passed (43 Solidity tests).
No production contract or frozen interface changed. This remains an unaudited,
local-Anvil-only prototype; revocation, receipt timing, and fixed windows are on-chain
behavior, not a guarantee against all wallet or infrastructure compromise.
