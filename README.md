# Universal Signing Layer (USL)

The current judge UI defaults to Relayer Mode on Ethereum Sepolia, Base Sepolia, and
Arbitrum Sepolia. The browser session key signs routine transfers; the relayer submits them
and pays gas. Direct Wallet Mode remains an explicit manual fallback and therefore opens
MetaMask for each outer transaction. See [the judge-demo runbook](docs/judge-demo.md) for setup,
verification scope, and the exact presentation sequence.

> A lightweight, EVM-only signing abstraction that combines ERC-7964-style cross-chain mandates with bounded client-side session keys.

Universal Signing Layer (USL) enables applications to obtain user authorization once and execute limited routine transactions across supported EVM chains without requiring the user to approve every individual transaction.

USL is a prototype focused on **bounded delegation, on-chain enforcement, and permissionless transaction submission**.

---

## Table of Contents

- [Problem](#problem)
- [Solution](#solution)
- [Core Idea](#core-idea)
- [Architecture](#architecture)
- [How It Works](#how-it-works)
- [ERC-7964 Methodology](#erc-7964-methodology)
- [Why We Moved Away from Merkle Tree Roots](#why-we-moved-away-from-merkle-tree-roots)
- [Security Model](#security-model)
- [Current Scope and Limitations](#current-scope-and-limitations)
- [Repository Structure](#repository-structure)
- [Technology Stack](#technology-stack)
- [Local Setup](#local-setup)
- [Testing](#testing)
- [Development Phases](#development-phases)
- [Important Disclaimer](#important-disclaimer)

---

## Problem

Blockchain applications commonly require users to approve transactions repeatedly through their wallet.

This creates several problems:

- Poor user experience for repeated operations.
- Repeated wallet interactions.
- Application developers must handle chain-specific signing logic.
- Delegated keys can become dangerous if permissions are not enforced on-chain.
- Relayers may submit transactions, but their authority and security assumptions must be clearly defined.

USL explores a signing layer where an application can request a bounded authorization policy while keeping the user's main wallet separate from routine session operations.

---

## Solution

USL separates **initial user consent** from **routine transaction execution**.

1. The user's wallet signs a mandate describing the session permissions.
2. A random secp256k1 session key is generated in the browser.
3. The mandate specifies limits for the session key on each EVM chain.
4. The account contract verifies and stores the mandate.
5. The session key signs permitted routine operations.
6. A permissionless relayer can submit the operation and pay gas.
7. The account contract independently verifies the signature and enforces the limits.

The relayer does not receive authority over the user's account. It only provides transaction submission and liveness.

> **Important:** One mandate signature does not sign every future transaction. It authorizes a bounded session policy, while each routine operation is separately signed by the session key.

---

## Core Idea

USL combines:

- ERC-7964 draft-style cross-chain mandate structure.
- A single session key address used across supported EVM chains.
- On-chain spending and expiry enforcement.
- Permissionless relaying.
- Native ETH-only routine session operations.
- Fresh owner consent for operations outside session permissions.

The project does not attempt to replace the user's wallet or custody private keys on a server.

---

## Architecture

### Main Components

| Component | Responsibility |
|---|---|
| Browser SDK | Creates session keys, builds mandates, signs operations, and performs policy checks |
| User Wallet | Signs the initial mandate and exceptional consent requests |
| Session Key | Signs permitted routine operations |
| MandateAccount | Verifies signatures and enforces session restrictions on-chain |
| Relayer | Simulates and submits signed transactions; has no account authority |
| EVM Network | Executes and verifies the account contract independently |

### High-Level Flow

```text
                    INITIAL AUTHORIZATION

       User Wallet / MetaMask
                |
                | Signs ERC-7964-style mandate
                v
          Browser SDK
                |
                | Creates one envelope per chain
                v
       MandateAccount on each EVM chain
                |
                | Verifies mandate and stores session
                v

                    ROUTINE EXECUTION

       Browser SDK
                |
                | Session key signs operation
                v
           Relayer
                |
                | Simulates and submits
                v
       MandateAccount
                |
                | Verifies signature + limits
                v
         Native ETH transfer
```

---

## How It Works

### 1. Account Setup

A MandateAccount is deployed for the user on each supported EVM chain.

Each account is controlled by the owner's wallet address.

The accounts are non-upgradeable because changing the account's EIP-712 domain or verification behavior could invalidate existing signatures.

### 2. Session Key Generation

The browser generates a random secp256k1 keypair.

- The key is not derived from the owner's wallet.
- The private key is held in browser memory by default.
- The key is not logged or sent to a server.
- The same session key address can be used in grants for multiple EVM chains.

The session key is limited by the mandate and cannot independently change its own permissions.

### 3. Mandate Registration

The owner signs a mandate containing:

- One or more chain-specific grants.
- Session key address.
- Per-transaction limit.
- Total budget.
- Fixed budget-window duration.
- Session expiry.
- Mandate nonce.
- Signature submission deadline.

A separate envelope is constructed for each chain. The account contract verifies the grant relevant to its own chain and account address.

Registration is permissionless: anyone can submit the signed mandate to the relevant account.

### 4. Routine Session Transaction

Routine session operations use a chain-bound EIP-712 operation signature.

The account verifies:

- The recovered session key.
- Whether the session is active.
- Operation deadline.
- Session expiry.
- Per-transaction limit.
- Budget-window limit.
- Operation nonce.
- Empty calldata requirement.

Only permitted native ETH transfers are executed through the session operation path.

### 5. Exceptional Operations

Operations involving calldata, such as token transfers, approvals, or contract calls, require fresh owner consent.

This prevents a session-key operation from bypassing the native-transfer restrictions through arbitrary contract calls.

### 6. Revocation

The owner can revoke a session directly.

A signed revocation can also be submitted through a permissionless transaction path.

Revocation must be handled independently on each chain.

---

## ERC-7964 Methodology

USL implements a mandate structure based on the ERC-7964 draft methodology.

**ERC-7964 is a draft standard and is not claimed as an invention of this project.** USL builds a bounded-delegation system on top of its cross-chain mandate approach.

### Cross-Chain Mandate Structure

A mandate contains an array of grants.

Each grant includes:

```text
EIP712ChainDomain
    chainId
    verifyingContract

MandateGrant
    domain
    sessionKey
    perTxLimit
    budget
    windowSeconds
    expiry

Mandate
    grants[]
    nonce
    deadline
```

The chain domain identifies:

- The target EVM chain.
- The account contract that must verify the grant.

The same mandate can describe grants for multiple EVM chains, while each account validates its own grant.

### Domain Separation

The mandate domain uses:

```text
EIP712Domain(
    name,
    version
)
```

USL uses:

```text
name:    USLMandate
version: 1
```

The mandate domain intentionally does not include chainId or verifyingContract. Chain-specific information is represented in each grant.

The account contract must use the matching name and version in its own ERC-5267 EIP-712 domain configuration.

### Verification Process

The account contract:

1. Rebuilds the grant hash from the supplied grant and current account context.
2. Uses the current chain ID and account address rather than trusting a sender-provided hash.
3. Validates the envelope header and application address.
4. Rebuilds the mandate digest.
5. Recovers the signer using ECDSA.
6. Confirms that the signer is the account owner.
7. Checks the deadline and grant expiry.
8. Marks the mandate nonce as used only after successful verification.

The envelope contains the encoded header, grant struct hashes, and signature. The mandate nonce and deadline are supplied separately to the registration function.

---

## Why We Moved Away from Merkle Tree Roots

### Earlier Design

The initial design used a Merkle tree root to represent multiple chain-specific grants.

The owner would sign a root, while individual grants would be proven using Merkle proofs.

Although this can reduce the amount of data committed to a root, it introduced a major usability issue for wallet authorization.

### Problem with Blind Root Signing

A Merkle root is a cryptographic commitment. It does not directly show the complete grant information to the user.

During wallet approval, the user may only see a root or an opaque structured value instead of clearly understanding:

- Which chains are authorized.
- Which account contracts are targeted.
- Which session key is authorized.
- What the spending limits are.
- When the session expires.

This creates a blind-signing concern, especially for a security-sensitive authorization flow.

### Current Design: Explicit Grant Arrays

USL moved to an ERC-7964-style mandate containing explicit grant entries.

Instead of signing only a Merkle root, the wallet-facing mandate includes the chain-specific grant data.

The grant structure explicitly identifies:

- Chain ID.
- Account contract address.
- Session key.
- Per-transaction limit.
- Total budget.
- Window duration.
- Expiry.

### Trade-Off

| Merkle Root Design | Explicit Grant Array |
|---|---|
| Compact commitment | More explicit authorization data |
| Requires Merkle proofs | Uses grant struct hashes and array encoding |
| Grant details are not represented directly by the root | Grant details are included in the signed mandate |
| More complex proof and verification flow | More straightforward grant verification |
| Potentially better for large grant sets | Better transparency for the current prototype |

The design change prioritizes **authorization clarity and implementation simplicity** over minimizing mandate size.

This does not mean Merkle trees are inherently insecure. The change was made because the current project prioritizes transparent wallet authorization and a manageable verification process.

---

## Security Model

### Bounded Session Permissions

The session key cannot spend beyond the limits stored by the account contract.

The account enforces:

- Per-transaction value limit.
- Total budget.
- Fixed budget window.
- Session expiry.
- Operation deadline.
- Operation nonce uniqueness.
- Active session status.

### Relayer Security

The relayer is permissionless and does not control the account.

It can:

- Simulate a transaction.
- Submit a signed transaction.
- Pay transaction gas.

It cannot:

- Change the session limits.
- Create owner authorization.
- Bypass contract verification.
- Execute arbitrary session calldata.

Anyone, including the user, can submit valid signed operations directly.

### Native-Transfer Restriction

Session operations are restricted to native ETH transfers with empty calldata.

Operations involving arbitrary calldata require fresh owner consent.

This prevents a session key from using token approvals or arbitrary contract calls to bypass the native ETH spending policy.

### Nonces

Mandate, operation, and revocation nonces use unordered used mappings rather than requiring sequential counters.

This allows independent submissions while preventing replay of previously accepted signatures.

---

## Current Scope and Limitations

USL is a prototype and has not undergone a professional security audit.

Current scope:

- EVM-compatible chains only.
- Native ETH session transfers only.
- Non-upgradeable account contracts.
- Permissionless relayer architecture.
- ERC-7964 draft-style mandate methodology.
- Client-side secp256k1 session keys.
- Fixed budget windows.

Known limitations:

1. ERC-7964 is a draft and may change.
2. Fixed budget windows can allow a burst near a window boundary of approximately two times the configured budget.
3. Native-transfer restrictions do not support arbitrary routine token or contract operations.
4. Relayer availability and RPC providers remain external dependencies.
5. Client-side session-key storage and browser security require careful handling.
6. Multi-chain registration and revocation are independently processed on each chain.
7. The implementation has not been professionally audited.

---

## Repository Structure

```text
USL_PROJ/
├── AGENTS.md
├── README.md
├── contracts/
│   ├── src/
│   ├── test/
│   ├── foundry.toml
│   └── ...
├── sdk/
│   ├── src/
│   ├── test/
│   └── ...
├── demo/
├── relayer/
├── docs/
│   ├── PROJECT_CONTEXT.md
│   ├── phase-1.md
│   ├── phase-2.md
│   └── ...
└── deployments/
    └── <chainId>.json
```

The project context and phase documents provide implementation decisions, development history, and detailed technical notes.

---

## Technology Stack

- Solidity
- Foundry
- OpenZeppelin Contracts
- TypeScript
- viem
- @noble cryptography libraries
- Vitest
- Next.js
- EVM-compatible testnets
- Anvil for local testing

No production private keys or RPC secrets should be committed to the repository.

---

## Local Setup

The default demo uses Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia in
Relayer Mode. Use test ETH only. The current website is a **single-owner demo**:
it reads one `deployments/<chainId>.json` record per chain, rather than creating
an account automatically for each visitor.

### 1. Install prerequisites and dependencies

Install Node.js 24, npm, Foundry, Git, and MetaMask with testnets enabled. In a
Linux or WSL2 terminal, clone the repository and install its exact dependencies:

```bash
git clone https://github.com/Ananth-2219/Universal_Signing_Layer
cd USL_PROJ
git submodule update --init --recursive
npm ci
forge build
```

### 2. Configure local environment files

Never commit `.env` or `demo/.env.local`. Copy the example files:

```bash
cp .env.example .env
cp demo/.env.example demo/.env.local
```

In root `.env`, set these locally:

```env
# Server-side RPC endpoints used by deployment and the relayer.
SEPOLIA_RPC_URL=
BASE_SEPOLIA_RPC_URL=
ARBITRUM_SEPOLIA_RPC_URL=

# Public address of the MetaMask wallet that will own every deployed account.
OWNER_ADDRESS=

# Throwaway testnet-only relayer key. Fund its derived address on every selected chain.
RELAYER_PRIVATE_KEY=

# Optional: only needed when deploying through a Foundry private-key workflow.
DEPLOYER_PRIVATE_KEY=

# Leave empty or set to testnet for the three public testnets.
RELAYER_NETWORK_MODE=testnet
```

In `demo/.env.local`, set matching browser-readable RPC endpoints:

```env
NEXT_PUBLIC_SEPOLIA_RPC_URL=
NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL=
NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL=

# Leave empty for public testnets.
NEXT_PUBLIC_NETWORK_MODE=
NEXT_PUBLIC_SUBMISSION_MODE=relayer
```

The browser RPC values are visible to browser users. Use provider credentials
restricted to your local/demo origin. Root `.env` stays server-side; do not place
`RELAYER_PRIVATE_KEY` in the demo environment file.

### 3. Prepare the three required testnet balances

For each selected chain, fund three different addresses with test ETH:

| Address | Why it needs ETH |
|---|---|
| MetaMask owner wallet | Deployment gas and Direct Wallet Mode gas |
| Relayer address derived from `RELAYER_PRIVATE_KEY` | Gas for Relayer Mode registration and transfers |
| Deployed `MandateAccount` | ETH that session-key transfers actually send to recipients |

The relayer does not hold transfer funds. The account contract does not pay the
relayer's outer transaction gas.

### 4. Deploy one account contract per chain

The deploy script creates an account whose immutable `owner` is `OWNER_ADDRESS`.
It writes the resulting contract address and owner address to
`deployments/<chainId>.json`, which the website and relayer both read.

Configure a funded Foundry keystore account named `testnet-deployer`, then run:

```bash
set -a
. ./.env
set +a

forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount \
  --account testnet-deployer --rpc-url "$SEPOLIA_RPC_URL" --broadcast

forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount \
  --account testnet-deployer --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast

forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount \
  --account testnet-deployer --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" --broadcast
```

> Running this script again on a chain deploys another account and replaces that
> chain's local deployment record. The previous contract remains on-chain, but
> the demo will point to the newest recorded contract.

After deployment, send test ETH to every newly recorded `mandateAccount` address
in `deployments/11155111.json`, `deployments/84532.json`, and
`deployments/421614.json`.

### 5. Start the relayer and website

Use two terminals from the repository root:

```bash
# Terminal 1
npm run relayer
```

```bash
# Terminal 2
npm run dev
```

Open the localhost URL printed by Next.js. If you change an RPC URL or a
`NEXT_PUBLIC_*` value, restart the demo server. If you change root relayer
configuration, restart the relayer.

### 6. Use the website in this order

1. Connect the MetaMask account matching `OWNER_ADDRESS`.
2. Run **Pre-Demo Check**. It must find deployed bytecode, the expected owner,
   configured RPCs, and sufficient test balances.
3. Select chains and set per-transfer limit, total budget, window, and expiry.
4. Generate a browser session key.
5. Sign the mandate once with MetaMask.
6. Select **Relayer Mode** and register or retry every selected chain.
7. Wait for every registration receipt to confirm.
8. Enter a recipient and a small amount within the signed limit, then send a
   session transfer.
9. Revoke the session from the owner wallet when the demonstration is complete.

Reloading the page destroys the in-memory session private key. It does not revoke
the on-chain session; revoke it explicitly first if the session should stop early.

### Local Anvil mode

For local testing, set `NEXT_PUBLIC_NETWORK_MODE=local`, configure
`NEXT_PUBLIC_ANVIL_RPC_A/B/C`, and use `RELAYER_NETWORK_MODE=local`. Start three
test-only nodes without printing their development keys:

```bash
anvil --silent --chain-id 31337 --port 8546
anvil --silent --chain-id 31338 --port 8547
anvil --silent --chain-id 31339 --port 8548
```

Deploy and fund an account on each local chain before signing. The full public-testnet
presentation flow is also available in [docs/judge-demo.md](docs/judge-demo.md).

---

## Testing

### Smart Contracts

```bash
cd contracts

forge build
forge fmt --check
forge test -vv
```

### SDK

```bash
cd sdk

npm install
npx vitest run
```

### Recommended End-to-End Validation

The complete demonstration should verify:

1. Account deployment.
2. Mandate creation and signing.
3. Mandate registration on the target chain.
4. Session-key operation signing.
5. Relayer simulation and submission.
6. Successful permitted transfer.
7. Rejection of an over-limit operation.
8. Rejection of expired or replayed signatures.

Only report test results that have actually been executed.

---

## Development Phases

The project is developed in small phases to keep the implementation testable.

| Phase | Focus |
|---|---|
| 1 | Mandate format and ERC-7964 methodology |
| 2 | Session-key module |
| 3 | Chain adapters and registry |
| 4 | Policy engine |
| 5 | MandateAccount contract |
| 6 | Deployment scripts |
| 7 | End-to-end SDK and Anvil integration |
| 8 | Permissionless relayer |
| 9 | Key-leak simulation |
| 10 | Demo UI |
| 11 | Extensibility and documentation |
| 12 | Security review |

The phase documents in `docs/` contain the implementation details and test reports for individual phases.

---

## Design Decisions

The following decisions are intentional:

- EVM-only scope.
- No Solana or ed25519 signing path.
- No ERC-4337 bundler dependency.
- No server-side custody of session keys.
- No Merkle-root mandate design.
- No upgradeable account contracts.
- Native ETH-only session operations.
- Fresh owner consent for arbitrary calldata.
- Permissionless relayer submission.
- Fixed budget window rather than a true sliding window.

These decisions reduce the prototype's scope and make the authorization and enforcement model easier to inspect.

---

## Important Disclaimer

USL is an experimental prototype for hackathon and research purposes.

It is not audited and should not be used to protect real funds.

ERC-7964 is a draft standard. The implementation should be reviewed against the relevant draft version and the exact deployed contract and library versions.

Use local Anvil networks or dedicated testnet wallets with test funds only.

---

## License

MIT
