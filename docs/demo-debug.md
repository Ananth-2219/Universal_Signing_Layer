# Demo investigation: 2026-09-19

The current browser configuration reaches chain 31337 on port 8546 and chain 31338
on port 8547. Both deployment records name the same public account address,
`0x5FbDB2315678afecb367f032d93F642f64180aa3`. Neither running node has code there;
both account balances are zero. The running demo returns those records unchanged.

The signing action reads `owner()` before asking MetaMask to sign. On both nodes,
the reproduced error is: `The contract function "owner" returned no data ("0x").`
There is no contract revert or provider error code: this is empty return data.
Direct session submission also stops before sending because the account has no code.
The records therefore do not describe deployed contracts on these current nodes.

Signing and submission now check deployment existence and chain ID explicitly.
Errors display the action, full messages, nested provider codes, and any recognized
contract revert. URLs and long hex values are redacted before entering the activity log.
This does not deploy accounts or repair records: deploy/fund on the current nodes,
write their correct address-only records, and refresh before testing the full UI flow.

The unchanged mandate domain is USLMandate/1 without chainId/verifyingContract.
Grants bind each chain/account; session Operation signatures use the chain-bound domain.
Anvil's existing v4 signing provider accepted the nested array and its signature verified.
New tests inspect the browser-wallet v4 request, owner address and integer serialization.
Existing integration tests verify both chains with real deployed contracts and no relayer.
Those isolated-node tests do not prove MetaMask extension behavior on the user's browser.
No MetaMask error has been captured here; the user will supply the actual browser errors.

Validation commands: `npm test`, `forge test`, `npm run typecheck`,
`npm run demo:typecheck`, `npm run demo:build`.
