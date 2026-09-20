# Phase 10: browser demo
The demo signs one mandate for both chains and creates a memory-only session key.
The contract still checks signatures, per-transfer caps, fixed-window budgets, expiry and revocation.

## Start (local Anvil only)

1. Start `anvil --chain-id 31337 --port 8545` and `anvil --chain-id 31338 --port 8546`.
2. Deploy and fund one `MandateAccount` on each chain with the Phase 6 deploy script.
   This writes address-only `deployments/<chainId>.json` files.
3. Direct Wallet Mode needs no relayer. MetaMask submits each signed contract call; you pay gas.
4. Copy `demo/.env.example` to `demo/.env.local`; it needs `NEXT_PUBLIC_ANVIL_RPC_A`,
   `NEXT_PUBLIC_ANVIL_RPC_B`, and optionally `NEXT_PUBLIC_RELAYER_URL`. Names only: never commit values.
5. Run `npm run demo`; use a test-only Anvil owner with gas funds in MetaMask on both chains.

## Manual check

Click Generate session key, Sign mandate, Register, small transfer, over-limit attempt, and Revoke.
Direct mode simulates the same signed calls, sends zero outer value, and never converts a refusal
into unrestricted owner consent. Real MetaMask prompts and nested grant display need a manual check.

## Limits and checks

Direct mode is the default. Set NEXT_PUBLIC_SUBMISSION_MODE to `direct` or `relayer` and restart,
or switch modes in the UI (resets on reload). Relayer Mode still uses `npm run relayer`.
No automatic fallback retries uncertain submissions. Reloading loses the browser session key.

Run `npm run typecheck`, `npm run demo:typecheck`, `npm test`, `npm run demo:build`, and `forge test`.
Direct-mode tests use an EIP-1193 test wallet and two real Anvil nodes without a relayer.
They verify consent, gas payment, signatures, limits, replay, expiry, rejection and revocation.
Existing relayer tests remain. See [current deployment diagnosis](demo-debug.md); fixed windows permit a near-2x burst.
