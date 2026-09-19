# Phase 3: EVM chain adapters (updated to the frozen interface)

An adapter turns a payment request into the format a chain's account understands.
The registry stores adapters by CAIP-2 ID, such as `eip155:11155111`.
It refuses duplicates and lists known chains when an adapter is missing.
Chain IDs use canonical decimal eip155 references; other namespaces are rejected.

Session operations are native ETH transfers only. Absent data or `0x` means empty calldata.
Any intent with nonempty calldata, or with an asset other than `native`, throws
NeedsConsentError instead of building an operation; no ERC-20 transfer/approval path and
no generated token calldata exist any more (both were removed in this revision).
Operation is exactly { to, value, nonce, deadline }; it has no data or token field.
Its EIP-712 type is Operation(address to,uint256 value,uint256 nonce,uint256 deadline)
with domain USLMandate version 1, this chainId, and the account as verifyingContract.
That type string and its keccak256 typehash are identical to the MandateAccount constant.
Each operation nonce is a random 32-byte uint256, not a sequential counter.
The deadline uses injected time plus a default TTL of 300 bigint seconds.
The nonce generator is optionally injected through the EvmAdapter constructor.

The browser session key only signs; it never submits transactions or needs ETH.
A permissionless submitter sends the outer transaction and pays gas.
Registration uses the Phase 1 mandate and envelope for the selected chain/account.
The ABI fragments live in sdk/src/adapters/evm/abi.ts, NOT sdk/src/abi/mandateAccount.ts;
the file name/location differs from the prompt, so it is recorded here. Its two fragments,
executeWithSessionSig((address to,uint256 value,uint256 nonce,uint256 deadline) op, bytes signature)
and registerMandate(((uint256 chainId,address verifyingContract) domain,address sessionKey,
uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry) grant,uint256 nonce,
uint256 deadline, bytes envelope), were compared with `forge inspect MandateAccount abi`
after Phase 5 and match the frozen section 6 interface exactly in name, order and types.
Deploy each non-upgradeable account first, then request the user's mandate signature.

ViemSubmitter uses a wallet client's configured account and chain; no keys are created.
The public client waits for a receipt and reports success/reverted and block number.
Limits, active sessions, replay prevention, and fixed-window budgets are enforced on-chain.
The Phase 4 pre-check is advisory; it does not replace those contract checks.

Run `npm test` and `npx tsc --noEmit` from the repository root.
Tests mock clients, reject every token/calldata path, verify signatures, and decode both calls.
The account contract now exists (Phase 5); end-to-end anvil integration tests are Phase 7.
