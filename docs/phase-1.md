# Phase 1: core types and mandate format

Built `sdk/src/core` with TypeScript intent, grant, and mandate types;
OpenZeppelin-compatible grant leaves and Merkle proofs; and viem EIP-712 digest,
signing, and EOA verification helpers. Added fixed public vectors in JSON and a
copyable Solidity fixture, plus a dedicated test-key regeneration script.
See [encoding.md](encoding.md) for the exact wire format and unresolved policy
decisions that Phase 5 must address.

## Running the checks

From the repository root, using a Linux Node/npm installation when inside WSL:

```sh
npm ci
npm test
npm run typecheck
```

The SDK pins viem 2.56.8, @openzeppelin/merkle-tree 1.0.8, TypeScript 5.9.3,
and Vitest 3.2.7. Implementation checked their installed source APIs, including
OpenZeppelin's leaf/node hashes and viem account signing. Tests were run on
Node 18.19.1. Node must support `--import` for the optional regeneration script.

This workspace initially resolved `npm` to Windows while `node` resolved to
Linux. Until the shell uses a Linux npm, these direct commands work after
dependencies have been installed:

```sh
node node_modules/vitest/vitest.mjs run --root sdk
node node_modules/typescript/bin/tsc --noEmit -p sdk/tsconfig.json
node --import tsx sdk/scripts/regenerate-vectors.ts
```

Public verification needs no `.env` or RPC. The exact signing test additionally
reads `TEST_VECTOR_KEY` from root `.env`; it is skipped if that key is absent.
The local test run includes that test. Regeneration creates a new dedicated
test-only key and updates the fixtures; follow the deliberate regeneration
process in [encoding.md](encoding.md#fixed-vectors-and-regeneration).
No deployments, network transactions, or funds are involved. Foundry execution
is deferred to the contract phase; no Foundry toolchain is installed here.

Tests cover fixed leaves/root/proofs/digest/signature, independent OpenZeppelin
encoding, the explicit Solidity digest formula, all three-grant permutations,
single-leaf trees, equivalent address casing, mutation and proof tampering,
all uint256 boundaries, malformed addresses and roots, duplicate chain IDs,
mixed owners, changed domains, and incorrect signatures.

Dependency installation reports six moderate advisories in the Merkle tree's
transitive dependencies and Vitest. The initial critical Vitest advisory was
removed by updating to 3.2.7. This prototype uses offline `vitest run`, with no
Vitest UI server. The dependency advisories remain unresolved and should be
reviewed when updating the toolchain.

## Plain-language explanation

A grant is a permission slip for one chain: who owns the account, which temporary
key may act, how much it may spend, and when permission ends. A Merkle tree puts
several permission slips into one bundle with a short fingerprint called its
root. A proof lets a chain check that its permission slip belongs to that bundle
without receiving every other slip.

The master key signs this root with a named, versioned message format. We leave
the chain and verifier address out of that message's domain so the exact same
consent signature can be checked on multiple chains. Each permission slip still
contains its own chain ID. This is one consent signature verified on multiple
chains; session keys separately sign ordinary transactions.

This phase only builds and checks the permission bundle. Later contracts must
track spending, enforce expiry, reject reused or revoked permissions, and require
new master consent when an action exceeds the limits. The current grant format
uses EVM addresses; Solana's representation still needs an explicit design.
