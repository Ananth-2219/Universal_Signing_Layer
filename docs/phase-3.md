# Phase 3: EVM chain adapters (updated to the frozen interface)

An adapter turns a payment request into the format a chain's account understands.
The registry stores adapters by CAIP-2 ID, such as `eip155:11155111`.
It refuses duplicates and lists known chains when an adapter is missing.
Chain IDs use canonical decimal eip155 references; other namespaces are rejected.

Session operations are native ETH transfers only. Missing data or `0x` is empty.
Any token asset or nonempty calldata throws NeedsConsentError for fresh owner consent.
There is no ERC-20 transfer/approval path and no generated token calldata.
Operation is exactly { to, value, nonce, deadline }; it has no data field.
Its EIP-712 domain is USLMandate version 1, WITH chainId and the account address.
Each operation nonce is a random 32-byte uint256, not a sequential counter.
The deadline uses injected time plus a default TTL of 300 bigint seconds.
The nonce generator is optionally injected through the EvmAdapter constructor.

The browser session key only signs; it never submits transactions or needs ETH.
A permissionless submitter sends the outer transaction and pays gas.
Registration uses the Phase 1 mandate and envelope for the selected chain/account.
The two ABI fragments in evm/abi.ts match the frozen Phase 5 registration/execution calls.
Deploy each non-upgradeable account first, then request the user's mandate signature.

ViemSubmitter uses a wallet client's configured account and chain; no keys are created.
The public client waits for a receipt and reports success/reverted and block number.
Limits, active sessions, replay prevention, and fixed-window budgets are enforced on-chain.
The Phase 4 pre-check is advisory; it does not replace those contract checks.

Run `npm test` and `npx tsc --noEmit` from the repository root.
Tests mock clients, reject token/calldata paths, verify signatures, and decode both calls.
No integration tests or network transactions run before the account contract exists.
