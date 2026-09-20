# Judge demo runbook

## What this demonstrates

One ERC-7964-style explicit-array mandate signature authorizes a random browser session
key on three independent account contracts. The key authorizes routine native ETH
transfers. In Direct Wallet Mode, MetaMask confirms every outer transaction and the
user pays gas; this does not mean one wallet interaction for every future transaction.
The owner key stays in MetaMask and the session key stays in memory. No new server
custody or signing service is introduced. Contract interfaces and signed schemas are unchanged.

## Public testnet setup

Use Node 24, npm, Foundry, and a dedicated MetaMask test wallet. From the repository root:

```sh
npm ci
git submodule update --init --recursive
forge build
test -f demo/.env.local || cp demo/.env.example demo/.env.local
```

Fill these entries in `demo/.env.local` locally (never commit RPC values):
- `NEXT_PUBLIC_SEPOLIA_RPC_URL` for Ethereum Sepolia, chain 11155111.
- `NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL` for Base Sepolia, chain 84532.
- `NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL` for Arbitrum Sepolia, chain 421614.
- `NEXT_PUBLIC_SUBMISSION_MODE`: `direct` (also the default).
- Leave `NEXT_PUBLIC_NETWORK_MODE` empty for the three public testnets.

Browser RPC configuration is public to the browser: use provider credentials restricted
to your demo's origin. Fund the connected MetaMask owner with test ETH on every chain.
Each account contract also needs test ETH: wallet gas funds and account spending funds
are separate balances.

Deploy accounts BEFORE signing. Set root `.env` variables `OWNER_ADDRESS` to the
MetaMask public address and `SEPOLIA_RPC_URL`, `BASE_SEPOLIA_RPC_URL`,
`ARBITRUM_SEPOLIA_RPC_URL` to their matching endpoints. Use a locally configured,
funded Foundry keystore named `testnet-deployer`; it need not be the account owner.
The owner/master private key must not be exported from MetaMask.

```sh
set -a
. ./.env
set +a
forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount --account testnet-deployer --rpc-url "$SEPOLIA_RPC_URL" --broadcast
forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount --account testnet-deployer --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast
forge script contracts/script/DeployMandateAccount.s.sol:DeployMandateAccount --account testnet-deployer --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL" --broadcast
npm run demo
```

The existing deploy script writes address-only records to `deployments/11155111.json`,
`deployments/84532.json`, and `deployments/421614.json`. Send test ETH to each recorded
account from MetaMask. Do not reuse stale local Anvil records. Then open the port
reported by Next.js and run the pre-demo check. Restart Next.js after changing RPCs.

Production preview: `npm run demo:build`, then `npm --workspace demo run start`.

## Exact judge sequence

1. Connect MetaMask. Explain the displayed owner address versus the later session address.
2. Run Pre-Demo Check. All three cards must pass RPC, deployment bytecode, owner, funds,
   and session reads. Gas reserve is a current-price estimate, not a guarantee.
3. Select all three chains. Set each cap and budget to **0.0001 ETH**, window to
   **3600 seconds**, and expiry to **60 minutes**. Values may differ per chain.
4. Generate the session key. Review each chain, account, limit and expiry in the preview.
5. Sign the mandate once in MetaMask. Keep its chainless domain unchanged.
6. Register the three grants. Approve network switches and gas-paying transactions.
   To demonstrate partial failure, reject one prompt, let the others finish, then click
   Register / retry remaining chains. Confirmed mandate IDs are skipped; a known pending
   hash is checked again instead of sending another transaction.
7. Choose a chain and set the recipient to your owner address and amount to **0.0001 ETH**.
   In Security Demo, run the valid small action: this really transfers test ETH and
   consumes the budget. Explain that a compromised session signer can also do this.
8. Probe oversized action: expect **PerTxLimitExceeded**.
9. Probe budget violation: expect **BudgetExceeded**. If using other limits, spend until
   the remaining budget is below the per-transfer cap first.
10. Replay exact operation: expect **OperationNonceUsed**. The original signed bytes and
    nonce are retained only in memory. Replay before its five-minute deadline expires.
11. Revoke the selected session, wait for its receipt, then probe after revocation:
    expect **SessionNotActive**. Repeat transfers/revocation on the other two chains.
12. Show receipt-backed activity hashes and explorer links, plus refreshed on-chain values.

Rejection probes execute the signed call through `eth_call` against the real contract;
they do not broadcast failing transactions or spend gas. A missing RPC or an unexpected
acceptance is not shown as a successful defense. This simulates compromised access to
the same in-memory signer without exporting its private key.

Reload loses the session key. Destroying it does not revoke on-chain authority. Revocation
is per chain. Budgets use fixed windows, so a boundary burst can approach two budgets.

## Local verification and optional relayer

The integration suite starts isolated Anvil nodes, including three nodes with the exact
public-testnet chain IDs, and shuts down only those child processes. It deploys and funds
real contracts and uses an EIP-1193 test wallet. It does not operate a real MetaMask extension.

```sh
forge test
npm test
npm run typecheck
npm --workspace demo run lint
npm run demo:typecheck
npm run demo:build
```

For a manual local demo, set `NEXT_PUBLIC_NETWORK_MODE=local`, configure
`NEXT_PUBLIC_ANVIL_RPC_A/B/C` separately, and start three terminals:
`anvil --silent --chain-id 31337 --port 8546`,
`anvil --silent --chain-id 31338 --port 8547`, and
`anvil --silent --chain-id 31339 --port 8548`.
Deploy/fund an account on each using the existing Phase 6 script and a local test-only
sender. The silent flag avoids printing Anvil's development keys.

Relayer files and tests are preserved. The existing `npm run relayer` launcher remains
configured for the original two local chains; the public-testnet judge route is Direct
Wallet Mode. Select Relayer Mode only when its configured server supports your chains.

## Verified scope and remaining setup

The public RPC entries and public deployment records were absent during implementation.
All three-chain execution claims refer to isolated Anvil tests, not public testnet receipts.
Actual MetaMask prompts, public deployments, faucet funding, and explorer confirmations
remain manual setup and verification. No public-network success or browser clicks are fabricated.
