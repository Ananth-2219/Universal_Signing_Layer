# USL: standing rules for Codex
Project: EVM-only signing layer. One ERC-7964 mandate signature is verified on-chain per
chain; a browser-held secp256k1 session key signs limited native transfers; a keyless
relayer submits. Full context and the FROZEN account interface: docs/PROJECT_CONTEXT.md
(read only sections 5 and 6 when a task needs them).
Rules:
- Testnets and local anvil only. Never hardcode, print or commit private keys, seeds or
  RPC URLs; use .env and keep .env.example names-only.
- No hand-written crypto primitives. Use viem, @noble/*, OpenZeppelin.
- Check installed package versions and real APIs; never guess function names.
- Every feature has tests. Run them; fix failures before finishing.
- KEEP CHANGES SMALL. Do not refactor unrelated code, add dependencies not requested,
  or re-research decisions marked DECIDED. If unsure, state the assumption in one line
  and continue.
- Finish each phase with docs/phase-N.md (max 30 lines, plain language, for a beginner)
  and a report of test counts and doubts in under 10 lines.