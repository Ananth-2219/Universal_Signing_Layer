# Phase 1 rework: readable array mandates

The SDK now signs the full EIP-712 `Mandate` array following the application schema
in [encoding.md](encoding.md), based on ERC-7964 (draft, checked 2026-09-19).
Each grant binds a chain and account to a session key and limits. One unique nonce
and one submission deadline belong to the entire mandate. Session expiry stays
inside each grant.

## What changed

Added manual ABI hashes cross-checked against viem, array order binding, a strict
ERC-7964 envelope encoder/decoder, and typed verification failure reasons. The
verifier recomputes the local grant, uses the header's ERC-5267 domain field mask,
checks the caller's domain-provider address, and verifies the signed nonce and
deadline. Time is always injected: deadline is inclusive, expiry exclusive.

Kept bigint amount precision, uint256/address validation, the dedicated ignored
TEST_VECTOR_KEY, fixed public fixtures, and a regeneration script (now named
`sdk/scripts/regen-vector.ts`). Added a Solidity parity test with no account
contract, external Solidity libraries, private key, or network transaction.

Removed:

- `@openzeppelin/merkle-tree` and its dependency subtree.
- `grant.ts`, `grantLeaf`, `buildMerkleTree`, and their exports.
- Leaves, roots, proofs, the old root-only typed payload, and dependent tests/docs.
- Old per-grant owner and nonce fields; nonce now belongs to the mandate.
- `regenerate-vectors.ts`, replaced by `regen-vector.ts`.
- The old Solidity fixture helpers, replaced by public array-mandate constants.

Grant order now matters. Duplicate chain/account pairs are rejected; distinct
accounts on the same chain are allowed. Intent types are scoped to EVM addresses
and `eip155` chain IDs for this phase.

## Running checks

From the repository root:

```sh
npm ci
npm test
npx tsc --noEmit
forge test
```

`npm run typecheck` is also available. Dependencies used: viem 2.56.8, TypeScript
5.9.3, Vitest 3.2.7; Solidity parity uses Foundry 1.8.3 and solc 0.8.30. Their
installed APIs were inspected before use. Root `tsconfig.json` makes the requested
`npx tsc --noEmit` work from the repository root. `foundry.toml` selects
`contracts/test`, with build outputs/cache ignored.

In this WSL workspace, npm/npx initially resolve to Windows binaries while Node
is Linux. Use a Linux npm on PATH. Equivalent direct checks after installing
packages are:

```sh
node node_modules/vitest/vitest.mjs run --root sdk
node node_modules/typescript/bin/tsc --noEmit
$HOME/.foundry/bin/forge test
```

The Solidity suite has four tests: grant hashes, full digest, owner recovery, and
both envelopes. The Vitest suite covers fixed public outputs, independent viem
parity, every field of both grants, order/chain binding, malformed envelopes,
signature boundaries, all ERC-5267 masks, application matching, uint256 bounds,
address casing, exact time boundaries, and private signing reproduction.

Final validation: **84 Vitest tests passed**, **4 Foundry tests passed**, and
`npx tsc --noEmit` passed. No tests were skipped in the local run. A separate copy
without `.env` passed **83 tests and skipped only private signature reproduction**,
with an explicit missing-TEST_VECTOR_KEY message. Foundry needed no key.

No key is needed for public TypeScript tests or Foundry. When TEST_VECTOR_KEY is
missing, the single private reproduction test reports why it is skipped. Follow
[the regeneration steps](encoding.md#public-vectors-and-regeneration) only when
intentionally updating the public vectors. No transactions are sent.

The Merkle dependency removal reduced the npm audit report to two moderate
Vitest-related advisories. They remain unresolved; tests use offline `vitest run`.

## Assumptions and boundaries

The approved correction is that changing nonce/deadline changes the main struct
hash and digest, not the grants' array hash. They are required verification
arguments because the envelope does not carry them. The on-chain registration
entry point and nonce update ordering are specified in encoding.md.

Application-domain metadata is caller-supplied in the offline SDK; the future
contract must fetch it from the header's application. Expected local chain and
account identity must come from trusted execution context. This phase verifies
EOA signatures, not contract-wallet signatures. The decoder deliberately requires
canonical ABI layout, rejecting extra bytes, gaps, or nonzero padding.

Real wallet display quality is wallet-dependent; this phase supplies structured
fields but does not implement or test a wallet UI. EVM execution, fixed-window budgets,
nonce storage, and fresh consent for over-limit actions remain later work.

## Plain-language explanation

A grant is a permission slip: which chain and account a temporary key may use,
how much it may spend, and when its permission ends. The master key signs the
whole list of permission slips, so a wallet can show their fields before consent.

Each chain receives its own slip, fingerprints of all slips, and the same master
signature. It computes its own slip's fingerprint, checks that it occupies the
right place in the list, and reconstructs the signed message. The nonce labels
this consent; the deadline says when it must be submitted. Expiry separately says
when the temporary key must stop working.

This is one consent signature verified on multiple chains. The session key still
signs each ordinary transaction, and later contracts must enforce spending limits.
