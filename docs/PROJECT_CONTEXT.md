# USL (Universal Signing Layer): complete project context
Paste this into any LLM. State: Phase 1 rework and Phase 2 prompts were issued; results not yet reported to this chat.

## 1. Task and constraints
- Hackathon Web3 track "Universal Signing Layer": a network-agnostic signing abstraction so apps request signatures without implementing each chain's signing; one signature valid across chains; extensible to more chains and standards.
- 30 hours to build from scratch. Round 1 = submit problem statement + idea (deadline was 1 pm; outcome unknown here). A 4-slide template (Problem / Solution / How it works / Business model) was drafted around an EARLIER design and must be updated: remove Solana and Merkle, add ERC-7964 and the client-side session key.
- The user is an undergraduate student NEW to blockchain. Explain every blockchain term in plain words, keep answers concise, and state honest limits and uncertainty.
- Environment: Windows + WSL2 Ubuntu; repo ~/USL_PROJ on the Linux filesystem; VS Code; Codex (GPT-6 Astra, Medium effort for most phases) generates code; Foundry; MetaMask (Sepolia enabled); Alchemy RPC; Base Sepolia planned.

## 2. Honest claim (never overclaim)
One consent signature (an ERC-7964 cross-chain EIP-712 signature) is verified on-chain by the user's account contract on each EVM chain. Routine transactions are then signed by a limited session key. NOT "one signature signs every transaction". Multi-chain signing is a draft ERC (7964), not our invention; our contribution is the bounded-delegation mandate, client-side session key, on-chain limits, and relayer on top of it.

## 3. Decisions and why
- EVM chains only (Solana, ed25519, SLIP-10 dropped).
- No server or layer holds any key. Session key = random secp256k1 keypair generated in the user's browser, not derived from any master key, never serialized or logged. One session key (same address) serves every EVM chain. Memory storage by default; IndexedDB persistence with short expiry only in the UI phase.
- Master key = the user's own wallet (MetaMask). We never create or touch it. Scripts use a throwaway OWNER_TEST_KEY.
- Protection comes from ON-CHAIN enforcement, so a leaked session key can lose only what the mandate allows, until expiry or revocation.
- Merkle-root mandate DROPPED: signing a root is blind signing in wallets. ERC-7964 arrays show every chain and limit in the wallet.
- Deploy accounts FIRST on each chain, then sign (grants need each account address).
- No ERC-4337 bundler. A simple permissionless relayer submits signed operations and pays gas. Relayer authority = none (liveness only). Anyone, including the user, can submit directly.
- Session ops = native ETH transfers ONLY (empty calldata). Any call with calldata (tokens, approvals, contracts) requires fresh owner consent. This closes the ERC-20 bypass of native limits.
- Budget is a FIXED window (resets when now >= windowStart + windowSeconds; windowStart set at first spend), not a true sliding window. Known weakness: a burst across a window boundary can spend up to ~2x budget. Document it.
- Accounts are NOT upgradeable (a domain change would invalidate signatures).
- Also rejected: MPC, ZK, chain-abstraction networks, P-256/passkey session keys (documented as the hardening roadmap; needs a P-256 verifier and a relayer path, and the encoding changes).

## 4. Architecture and flows
Roles: Browser SDK (creates session key, builds mandate and envelopes, signs operations) | MetaMask (signs the mandate once) | Relayer (submits and pays gas, no authority) | Account contract per chain (verifies, stores session, enforces limits).
1. Setup: deploy MandateAccount(owner) on each chain -> SDK creates session key -> SDK builds Mandate (one grant per chain, same session key address) -> owner signs ONCE (wallet displays the array) -> SDK builds one ERC-7964 envelope per chain from the same signature -> anyone submits registerMandate on each chain -> account verifies and stores the session.
2. Routine tx (no envelope): policy pre-check -> session key signs an Operation (chain-bound EIP-712) -> relayer simulates, then calls executeWithSessionSig -> chain re-checks everything and executes.
3. Over limit or calldata: owner signs a one-time Consent -> executeWithConsent.
4. Revoke: owner calls revokeSession, or signs RevokeSession (submit to EVERY chain at once).
5. Partial failure is normal (registration may succeed on one chain and fail on another): each chain is independent and idempotent; UI shows per-chain status.

## 5. Mandate spec as implemented (ERC-7964 draft, https://eips.ethereum.org/EIPS/eip-7964)
- Domain: EIP712Domain(name,version) = ("USLMandate","1"). NO chainId, NO verifyingContract. The account contract MUST use the same name/version in its own EIP-712 domain (ERC-5267), or verification fails.
- Types: Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline); MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry); EIP712ChainDomain(uint256 chainId,address verifyingContract). verifyingContract = the account on that chain.
- nonce = unique mandate ID (unordered "used" mapping, not a counter). deadline = last time the signature may be SUBMITTED (now <= deadline). expiry = session end (expiry > now; expiry == now is expired).
- Hashes: grantStructHash per grant; structsArrayHash = keccak256(abi.encodePacked(grantStructHashes)); mandateStructHash = keccak256(abi.encode(MANDATE_TYPEHASH, structsArrayHash, nonce, deadline)); digest = keccak256(0x1901 || domainSeparator || mandateStructHash).
- Envelope = abi.encode(bytes32 header, bytes32[] structsArray, bytes signature); header = magic 0x796479647964796479 (9 bytes) || fields 0x03 (name+version, ERC-5267 bitmap) || structIndex (uint16) || application (20 bytes). The envelope does NOT carry nonce or deadline; they are passed as separate arguments.
- On-chain verification: rebuild the grant hash from calldata + block.chainid + address(this) (never trust a hash from the sender); require it equals structsArray[structIndex]; require header application == address(this) and fields == 0x03; rebuild digest; ECDSA-recover; require signer == owner; require now <= deadline and grant.expiry > now; mark the nonce used only AFTER verification succeeds.
- The spec's example contracts look broken as written (out-of-scope variables, nonce consumed before being read back, library function name mismatch): use them as illustration only. Needs a recent OpenZeppelin; verify helper availability.

## 6. FROZEN account interface (Solidity)
struct EIP712ChainDomain { uint256 chainId; address verifyingContract; }
struct MandateGrant { EIP712ChainDomain domain; address sessionKey; uint256 perTxLimit; uint256 budget; uint256 windowSeconds; uint256 expiry; }
struct Session { uint256 perTxLimit; uint256 budget; uint256 windowSeconds; uint256 expiry; uint256 windowStart; uint256 spent; bool active; }
struct Operation { address to; uint256 value; uint256 nonce; uint256 deadline; }
owner() view returns (address)
registerMandate(MandateGrant grant, uint256 nonce, uint256 deadline, bytes envelope)   // permissionless
executeWithSessionSig(Operation op, bytes signature)                                    // permissionless
executeWithConsent(address to, uint256 value, bytes data, uint256 nonce, uint256 deadline, bytes ownerSignature)
revokeSession(address sessionKey)                                                       // owner only
revokeSessionWithSig(address sessionKey, uint256 nonce, uint256 deadline, bytes ownerSignature)
sessions(address) view returns (Session); mandateIdUsed(uint256) view; operationNonceUsed(address sessionKey, uint256 nonce) view; eip712Domain() (ERC-5267); receive() payable
Events: MandateRegistered(sessionKey, mandateId, expiry), SessionRevoked(sessionKey), Executed(sessionKey, to, value), ConsentExecuted(to, value, nonce)
Typed data for Operation / Consent / Revoke uses the account's own domain ("USLMandate","1", WITH chainId and verifyingContract):
Operation(address to,uint256 value,uint256 nonce,uint256 deadline); Consent(address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline); RevokeSession(address sessionKey,uint256 nonce,uint256 deadline)
Operation and consent nonces are unordered (used-mapping; operations keyed per session key).
Session-op rules: caller is anyone; signer recovered from the signature must be an active session; now <= op.deadline; expiry > now; value <= perTxLimit; window reset then spent + value <= budget; empty calldata by construction. Registering an already-active session key reverts (revoke first).

## 7. Repo layout, stack, environment
- ~/USL_PROJ: contracts/ (Foundry, Solidity, OpenZeppelin), sdk/ (TypeScript npm workspace @usl/sdk: viem, @noble/*, vitest), demo/ (Next.js), docs/, deployments/<chainId>.json (addresses only).
- Chains: local anvil A (31337, :8545), anvil B (31338, :8546), Sepolia (11155111), Base Sepolia (84532). CAIP-2 ids eip155:<n>.
- .env (git-ignored; .env.example lists NAMES only): SEPOLIA_RPC_URL, BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY (throwaway from `cast wallet new`), OWNER_ADDRESS, OWNER_TEST_KEY, TEST_VECTOR_KEY (test-vector signing only, never funded), RELAYER_PRIVATE_KEY, ANVIL_RPC, ANVIL_RPC_B.
- Never commit or print any private key. Testnets only. MetaMask account for the project is separate from any real-money account.

## 8. Phase plan and status
1 Mandate format (ERC-7964 array; Merkle version done with 33 tests, rework prompt issued; verifyEnvelope gets required nonce, deadline, now, application, domain arguments) | 2 Session key module (prompt issued) | 3 Adapter interface + registry + EVM adapter | 4 Policy engine | 5 MandateAccount contract | 6 Deploy scripts | 7 End-to-end SDK + anvil integration tests | 8 Relayer | 9 Key-leak simulation | 10 Demo UI | 11 Extensibility + docs + README | 12 Security review.
Phases 3, 4, 5 can run in parallel because of the frozen interface.

## 9. Working agreements
- One Codex prompt per phase in a FRESH task, Medium effort (High only for Phase 5 and 12). Prompts say "KEEP SMALL, decided, don't research". Read the diff, run tests, commit per phase.
- Every phase writes a short docs/phase-N.md with a plain-language explanation.
- Known gotchas already hit: WSL was using the WINDOWS npm (fixed by installing Node via nvm inside WSL; reinstall node_modules from Linux); `sudo apt install snap` installed an unrelated program with a `forge` binary (removed; Foundry PATH is ~/.foundry/bin); MetaMask's new UI hides the network selector under the tokens list, and testnets must be enabled in settings.

## 10. Risks and open items
ERC-7964 is a DRAFT and may change (pin the version, note the date). MetaMask must be tested for displaying nested typed data whose domain has no chainId. OZ helper availability depends on the installed version. Fixed-window burst weakness. Native-only session limits. Relayer liveness and RPC providers are centralized dependencies. Not audited: prototype only. Stretch goals: ERC-1271 owner support, multi-chain ERC-7964 revoke, CREATE2 same-address accounts, P-256 session keys.