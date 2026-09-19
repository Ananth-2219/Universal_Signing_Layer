# Phase 6: deploying the account contract

A deploy script puts one non-upgradeable `MandateAccount` on a chain, owned by the user's
own wallet (`OWNER_ADDRESS`). Deploy accounts first on every chain: a grant contains that
chain's account address. The script holds no key (local runs use anvil's unlocked accounts;
a testnet run passes `--private-key $DEPLOYER_PRIVATE_KEY` on the command line only).

## Files
- `contracts/script/DeployMandateAccount.s.sol` (new): deploys one account, checks `owner()`,
  and writes `deployments/<chainId>.json` (chain id, account address, owner address).
- `foundry.toml`: `script = "contracts/script"` plus a `./deployments`-only fs permission.
- `.env.example` and `.env`: added the NAMES for anvil A/B, Sepolia, Base Sepolia, Arbitrum
  Sepolia, deployer, owner and relayer. Values stay empty; no secret is written or committed.
- `.gitignore`: ignores `broadcast/`; `test/MandateVector.t.sol` needed whitespace-only fixes.

## Commands run and results (local anvil only)
- `forge build` -> compiles, 0 errors.
- `forge fmt --check` -> passes (it failed before, only on the vector test file).
- `forge test -vv` -> 43 passed, 0 failed, 0 skipped; `npm test` -> 175 passed, tsc clean.
- `anvil --port 8545`, then `forge script ...DeployMandateAccount --unlocked --sender <anvil>
  --broadcast` -> "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL"; `cast call` shows `owner()` = sender
  and `eip712Domain()` = "USLMandate"/"1".
- Secret scan of `deployments/`, `broadcast/`, `contracts/cache/`, tracked files and git
  history -> no key or RPC value found; deployment records contain addresses only.

## Limits and doubts
- No testnet RPC value exists yet, so no testnet deploy was attempted. Arbitrum Sepolia is
  not in the frozen chain list (section 7); its name was added as asked, the list was not.
- `TEST_VECTOR_KEY`, `OWNER_TEST_KEY` and `SESSION_TEST_KEY` stay filled because the Foundry
  and SDK suites read them; they are throwaway keys and must never be funded.
- A deploy only records an address: nothing is verified end to end until Phase 7.