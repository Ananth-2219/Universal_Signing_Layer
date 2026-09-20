# Phase 11: judge-facing three-chain demo

The existing SDK, account contract and MetaMask flow now have a three-chain interface:
Ethereum Sepolia, Base Sepolia and Arbitrum Sepolia. Local mode supports three Anvil nodes.
One browser-generated session key signs routine native transfers. The owner signs one
explicit grant-array mandate with separate limits and expiry for each selected chain.

Relayer Mode is the default: the session key authorizes and signs routine transfers; the
relayer submits the signed call and pays gas. Direct Wallet Mode remains a manual fallback
that opens MetaMask for each outer transaction. The preview shows what each grant allows. Registration reports each chain independently,
skips already-used mandate IDs on retry, and retains pending transaction hashes in memory.
Successful transfers and revocation wait for receipts and refresh contract state.

The UI includes readiness cards, live values, explorer-linked activity, and Security Demo.
Real contract calls test caps, budget, replay and revocation. The valid compromised-key
action really transfers the configured test amount; rejected probes use gas-free eth_call.
Provider failures are never reported as successful contract rejections.

The diagnostics distinguish wallet gas funds from account spending funds. Missing records,
RPCs, bytecode, ownership and funding are visible. Keys/signatures are not logged.
Changing the wallet account clears the in-memory session and mandate to avoid stale consent.
Relayer source and tests remain; its existing launcher targets the original two local chains.

Run `forge test`, `npm test`, `npm run typecheck`, `npm --workspace demo run lint`,
`npm run demo:typecheck`, and `npm run demo:build` from the repository root.
Three-node integration tests cover one wallet signature, partial registration/retry,
gas payment, receipt-confirmed transfers, all security probes, and diagnostics.

Public testnet RPCs and deployments were not configured, so public execution remains unverified.
Actual MetaMask clicks still require a browser check. See [judge-demo.md](judge-demo.md)
for exact setup commands, the judge sequence, and limits including fixed-window bursts.
