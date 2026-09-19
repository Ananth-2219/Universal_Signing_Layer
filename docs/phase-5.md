# Phase 5: the account that enforces the rules

`contracts/src/MandateAccount.sol` holds ETH and checks permission before sending it.
The owner's wallet signs a mandate once; each listed chain verifies that same
signature and remembers its own session limits. Routine payments use the browser's
session key. Anyone can submit a signed request and pay its gas, but cannot change it.
The contract has an immutable owner, no upgrades, and no ERC-4337 machinery.

Session payments have empty calldata and enforce expiry, a per-payment cap, and
a fixed-window budget. Owner-signed Consent permits a specific payment or contract
call beyond those limits. Direct or signed revocation disables a session.
Used nonces block replay. State updates happen before external calls; reentrancy
is blocked across all entry points, and a failed payment rolls back its nonce and spend.
Malformed envelopes and invalid/high-s signatures are rejected with custom errors.

## Run locally

From the repository root, with Node and Foundry installed:

```sh
git submodule update --init --recursive
node contracts/test/prepare-keys.mjs
forge test
npm test
npx tsc --noEmit
```

The setup script creates only missing throwaway OWNER_TEST_KEY and SESSION_TEST_KEY
entries in ignored `.env`, without printing them. Never fund or deploy with these keys.
Use normal test verbosity: verbose traces/debuggers can expose `vm.sign` arguments.
Dependencies are pinned: OpenZeppelin Contracts v5.7.0, forge-std v1.16.2, solc 0.8.30.
Tests run locally; no deployment, RPC, or real funds are involved.

Validation: 42 Foundry tests (including two fuzz tests at 512 runs each),
172 SDK tests, and TypeScript checking passed. Tests cover signature/domain binding,
registration, replay, boundaries, drip spending, revocation, consent, and call rollback.
The public Phase 1 signature registers both grants without its private key. Its old
envelopes name a different application: tests change only that unsigned header address
to the corresponding account and also verify that the original header is rejected.

## Assumptions and limits

Consent, revocation, and mandate IDs have separate nonce spaces. Operation nonces
are per session address and remain used after revocation and re-registration.
Revocation does not cancel unused signed mandates; avoid reusing a compromised key.
An expired session must still be revoked before registering that same key again.
Fixed windows permit nearly two budgets across a boundary. A zero-second window
resets every payment, matching Phase 4; choose a positive duration for a useful budget.
Empty-calldata ETH transfers can still trigger a recipient contract's receive function.
Only EOA signatures are supported; this is an unaudited, testnet-only prototype.
