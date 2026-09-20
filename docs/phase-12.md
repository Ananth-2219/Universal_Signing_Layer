# Phase 12: relayed session submission

Routine session transfers now default to Relayer Mode. The browser generates and keeps the
session private key in memory, signs the operation locally, and sends only the signed request
to the relayer. The relayer simulates the exact account call, submits it with its funded
testnet key, and pays gas.

MetaMask is used once to sign the mandate. Registration is permissionless and can also be
relayed. Owner-only revocation still needs the owner wallet. Direct Wallet Mode is retained as
a manual fallback, but it opens MetaMask because MetaMask submits and pays for each transfer.

The account contract, ERC-7964-style mandate schema, EIP-712 domains, expiry, nonce,
per-transfer cap, fixed-window budget, balance and active-session checks are unchanged.

The root relayer launcher now selects the configured public Sepolia/Base/Arbitrum testnets
when all three public RPC values exist. Set `RELAYER_NETWORK_MODE=local` for its original
two-Anvil setup. Fund `RELAYER_PRIVATE_KEY` with test ETH on every relayed chain.

Validation: SDK suite 206 passed with 1 optional vector test skipped; root and demo
typechecks, demo lint, and production build passed. The integration suite proves a relayed
session transfer does not make another owner-wallet request after mandate activation.
