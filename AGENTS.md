# Project: Universal Signing Layer (hackathon prototype, ~30 hours)

Goal: a chain-agnostic signing layer. The user signs ONE mandate with a secp256k1
master key. Chains verify it on-chain. Session keys then sign routine transactions
natively (secp256k1 on EVM, ed25519 on Solana) within limits: per-transaction cap,
rolling budget, expiry. Over-limit actions need fresh master-key consent.
Honest claim: one consent signature verified on multiple chains. NOT one signature
that signs every transaction.

Repo layout: contracts/ (Foundry, Solidity), sdk/ (TypeScript, viem, @noble/curves),
demo/ (Next.js), docs/.

Rules:
- Testnets only (Sepolia, Base Sepolia, Solana devnet, local anvil). Never real funds.
- Never hardcode, print, or commit private keys, seed phrases, or RPC URLs. Read them
  from .env. Keep .env.example updated with variable names only.
- Do not implement crypto primitives. Use viem, @noble/curves, @noble/hashes,
  @scure/bip39, @scure/bip32, @openzeppelin/merkle-tree, OpenZeppelin contracts.
- Check the installed package versions and their real APIs before using them. Do not
  guess function names.
- Every feature needs tests. Run them and fix failures before you finish.
- Keep code small and readable. Comment the WHY of security-relevant lines.
- After each phase, write docs/phase-N.md: what was built, how to run the tests, and a
  plain-language explanation for someone new to blockchain.
- State assumptions and uncertainties instead of silently guessing.