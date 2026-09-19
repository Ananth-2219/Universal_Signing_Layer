# Phase 9A: basic session-key leak simulation

`sdk/scripts/leak-sim.ts` models an attacker who has only a temporary session key and
submits signed native-transfer operations directly to the account. It bypasses the SDK
policy layer and relayer, so the contract is the only protection being measured.

The simulation tries one payment above the per-transaction limit, then repeated
limit-sized payments. It prints a compact table with attempt, result, safe reason,
total drained, and remaining account balance. It does not print keys, signatures,
requests, or RPC URLs.

The intended invariant is total drained <= the configured fixed-window budget; an
existing fixed-window boundary can allow nearly two budgets across a boundary and is
documented rather than changed here. Revocation, consent impersonation, calldata,
replay, and the remaining Phase 9 suite are intentionally not implemented.
