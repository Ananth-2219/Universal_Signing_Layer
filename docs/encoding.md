# USL array mandate encoding, version 1

Reference checked **2026-09-19**: [ERC-7964 — Crosschain EIP-712 Signatures](https://eips.ethereum.org/EIPS/eip-7964).
It is a **DRAFT**, not a finalized standard. This document specifies the USL
application schema requested for this prototype. Scope: EVM chains only.
[ERC-5267](https://eips.ethereum.org/EIPS/eip-5267) defines the domain field mask.

## Types and exact type strings

All numeric fields are `uint256` on the wire and `bigint` in TypeScript. Addresses
are 20 bytes. Address casing is tolerated and normalized for viem encoding.
JSON fixtures store integers as decimal strings to avoid precision loss.

```text
EIP712Domain:
  name: string
  version: string

Mandate:
  grants: MandateGrant[]
  nonce: uint256
  deadline: uint256

MandateGrant:
  domain: EIP712ChainDomain
  sessionKey: address
  perTxLimit: uint256
  budget: uint256
  windowSeconds: uint256
  expiry: uint256

EIP712ChainDomain:
  chainId: uint256
  verifyingContract: address
```

`primaryType` is `Mandate`. The signing domain is exactly
`{ name: 'USLMandate', version: '1' }`: no `chainId`, `verifyingContract`, or `salt`
keys, including no zero-valued placeholders. Every grant exposes its target under
exactly `domain.chainId`. `domain.verifyingContract` is the user's MandateAccount
on that chain. `sessionKey` is an EVM signing address. The owner is recovered from
the signature and compared to the account's owner; it is not a grant field.

These exact UTF-8 type strings have no spaces after commas. Nested dependencies
are appended alphabetically after the primary type:

```text
Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)EIP712ChainDomain(uint256 chainId,address verifyingContract)MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)

MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)EIP712ChainDomain(uint256 chainId,address verifyingContract)

EIP712ChainDomain(uint256 chainId,address verifyingContract)

EIP712Domain(string name,string version)
```

Tests compare the manual hashes against viem's `hashStruct`, `hashDomain`, and
`hashTypedData`, whose installed implementation sorts dependent type names.

## Manual hash construction

`keccak256` always consumes raw bytes, not hexadecimal text. `abi.encode` pads
addresses on the left and encodes unsigned integers as 32-byte big-endian words.
Each TYPEHASH below is the keccak256 hash of the corresponding type string above.
The implementation uses viem's ABI encoder and keccak256; it implements no crypto
primitive itself.

```solidity
chainDomainHash = keccak256(abi.encode(
    CHAIN_DOMAIN_TYPEHASH, grant.domain.chainId, grant.domain.verifyingContract
));
grantStructHash = keccak256(abi.encode(
    GRANT_TYPEHASH, chainDomainHash, grant.sessionKey,
    grant.perTxLimit, grant.budget, grant.windowSeconds, grant.expiry
));
arrayHash = keccak256(abi.encodePacked(structsArray));
mandateStructHash = keccak256(abi.encode(
    MANDATE_TYPEHASH, arrayHash, nonce, deadline
));
domainSeparator = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version)"),
    keccak256("USLMandate"), keccak256("1")
));
digest = keccak256(abi.encodePacked(hex"1901", domainSeparator, mandateStructHash));
```

`structsArray` contains every grant struct hash in the original array order. Its
hash preimage is `32 * grants.length` bytes with no count or offset prefix.
Swapping grants changes the signed digest. Changing nonce or deadline changes the
mandate struct hash and digest, **but leaves the grant and array hashes unchanged**.
This corrects the original test wording, as approved by the user.

`signMandate(mandate, account)` passes the full typed data to a viem LocalAccount's
`signTypedData`. The fixture uses deterministic secp256k1 signing. Signatures in
this prototype are 65-byte `r || s || v`, with `v` equal to 27 or 28. EOA recovery
is supported; ERC-1271 and compact 64-byte signatures are outside this phase.

## Construction and validation

`createMandate({ sessionKey, chains, limits, nonce, deadline, now })` accepts one
shared session key, `chains: [{ chainId, account }]`, and shared limits
`{ perTxLimit, budget, windowSeconds, expiry }`. It creates one grant per entry
and validates times against the supplied `now`. Callers may also construct a
Mandate directly with different per-chain limits.

The codec requires at least one grant, valid addresses, uint256 bigints, and no
duplicate `(chainId, verifyingContract)` pair. Different accounts on the same
chain are allowed. `validateMandate(mandate, now)` checks all grants' times;
`validateGrant(grant, now)` checks an individual session. Encoding and hashing
validate structure but deliberately have no wall-clock dependency, so historical
fixtures remain reproducible. Use explicit time validation before requesting a
signature. Zero amounts/windows can be encoded; meaningful spending-policy
validation is a later contract concern.

## Envelope bytes

The envelope is canonical Solidity ABI encoding:

```solidity
abi.encode(bytes32 header, bytes32[] structsArray, bytes signature)
```

| Header byte offset | Length | Value |
| --- | --- | --- |
| 0 | 9 | Magic `0x796479647964796479` |
| 9 | 1 | ERC-5267 fields mask; issuance uses `0x03` |
| 10 | 2 | `structIndex`, uint16 big-endian |
| 12 | 20 | `application`, ERC-5267 domain provider address |

`encodeEnvelope` finds the unique grant matching `(chainId, verifyingContract)`.
Indices must fit uint16. The header is packed; the enclosing tuple uses normal
ABI encoding. The three head words are header, array offset, and signature offset.
The array offset is 96. The array tail is its length followed by hashes. The
signature offset is `128 + 32 * structsArray.length`, followed by signature length,
bytes, and zero padding to a 32-byte boundary.

`decodeEnvelope` requires this canonical layout: valid hex and magic, bounded
lengths/offsets, nonempty array, in-range index, no overlaps/gaps, no truncated data,
no nonzero padding, and no trailing data. It bounds arithmetic before invoking
viem's decoder. This is deliberately stricter than accepting arbitrary decodable
ABI offsets. Reserved field-mask bits above bit 4 are rejected. Signature byte
length and `v` are validated by the verifier; a complete ABI `bytes` value can
parse successfully but still contain an invalid EOA signature.

The envelope **does not contain nonce or deadline**. They must accompany it as
separate arguments. The array hashes also do not disclose other grants' raw
fields; the signing wallet receives the full array before signing.

## Verification and ERC-5267 domain handling

```typescript
verifyEnvelope({
  envelope, expectedGrant, owner, nonce, deadline, now, application,
  domain: { name, version, chainId, verifyingContract, salt },
})
```

`domain` holds values obtained from the application's `eip712Domain()`. The
function is offline: the caller must fetch trustworthy metadata from that
contract. Its `application` argument must match the header's application address.
The function cannot independently prove where caller-supplied metadata came from.

The **header**, not a caller-provided mask, determines which domain fields enter
the separator. Supported ERC-5267 bits, in canonical order:

| Bit | Mask | Field |
| --- | --- | --- |
| 0 | `0x01` | name |
| 1 | `0x02` | version |
| 2 | `0x04` | chainId |
| 3 | `0x08` | verifyingContract |
| 4 | `0x10` | salt |

With `0x03`, only name and version are hashed. Supplied chainId, verifyingContract,
and salt values are ignored, including for validation. Other supported masks
change both the domain type string and its selected encoded values; modifying a
fixture's mask invalidates its signature. The signing API always uses `0x03`.
Domain helpers support all five standard fields to mirror the metadata flow.

Verification checks local inputs and application identity, validates time,
recomputes the selected grant hash from `expectedGrant`'s **own fields**, and
compares it with `structsArray[structIndex]`. It rebuilds the full mandate hash
using the received hashes plus the supplied nonce and deadline, then recovers
and compares the owner. It returns `{ valid: true, digest, signer }` or
`{ valid: false, reason, message }`. A wrong nonce/deadline that passes time
validation produces `SIGNER_MISMATCH`; the signature cannot identify which
supplied field was wrong. Invalid time produces its specific reason first.

`application` supplies domain metadata; it is distinct from the grant's execution
account. Its address is not directly signed when the top-level domain omits
verifyingContract. Another provider with identical selected metadata yields the
same separator. The signed per-grant verifyingContract still binds execution.

## Time and nonce semantics for the future contract

Both timestamps are Unix seconds. **deadline** is the last time the signature may
be submitted; **expiry** is when that grant's session stops working. They are
independent:

```text
submission is timely:  now <= deadline
a session is active:   expectedGrant.expiry > now
```

Thus deadline equal to now passes; expiry equal to now fails. `verifyEnvelope`
requires an injected uint256 bigint `now` and never reads the system clock.
The future on-chain entry point is:

```solidity
registerMandate(MandateGrant grant, uint256 nonce, uint256 deadline, bytes envelope)
```

It will use `block.timestamp` as now, bind the local grant to `block.chainid` and
its own account address, and compare the recovered signer with its stored owner.
The supplied nonce is a **unique mandate ID**, not a counter. The contract must
check it is unused, verify that exact value through the signed digest, and only
mark it used **after verification succeeds**. It must not increment or re-read a
changed counter while reconstructing the signature. All state changes must be
atomic and precede any external execution. Each account tracks its own used IDs.

The execution design was frozen during Phase 4: sessions transfer native ETH only,
with no calldata, and enforce a fixed-window budget. A window starts at its first
spend and resets when `now >= windowStart + windowSeconds`. This permits a burst
near twice the budget across a boundary. Tokens and calldata need fresh owner
consent; the grant has no asset field, so token amounts cannot share its native budget.
The off-chain pre-check is advisory; on-chain enforcement and used-ID storage
remain Phase 5 work. Test fixtures use local chains 31337 and 31338 only.

## Frozen execution messages (Phase 4 update)

Deploy the non-upgradeable accounts before requesting the user's wallet signature.
Operation, Consent, and RevokeSession use name `USLMandate`, version `1`, WITH
the current chainId and verifyingContract (the account) in their EIP-712 domain.
These domains differ from the chain-agnostic mandate domain above.

```text
Operation(address to,uint256 value,uint256 nonce,uint256 deadline)
Consent(address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)
RevokeSession(address sessionKey,uint256 nonce,uint256 deadline)
```

`executeWithSessionSig(Operation op, bytes signature)` is permissionless. The
Operation has no data field: native transfers have empty calldata by construction.
The contract requires an active recovered session, `now <= op.deadline`,
`expiry > now`, `value <= perTxLimit`, and `spent + value <= budget` after resetting
the fixed window if due. Its unordered operation nonces are tracked per session
key. `executeWithConsent(address to,uint256 value,bytes data,uint256 nonce,
uint256 deadline,bytes ownerSignature)` is the future owner-consent route; its
dataHash binds the calldata and its nonces are also unordered. This update does
not implement the consent or revocation entry points.

## Public vectors and regeneration

`sdk/test/vectors/mandate.json` fixes two grants, nonce, deadline, every intermediate
hash, recovered owner, signature, and both envelopes. `docs/vectors/Phase1Vector.sol`
contains their public Solidity constants. `contracts/test/MandateVector.t.sol`
recomputes hashes from raw fields, checks both envelopes, and recovers the owner
without a private key or account contract.

The dedicated `TEST_VECTOR_KEY` stays in the ignored root `.env`. Never print,
commit, fund, or deploy with it. Normal tests compare fixed values and do not
regenerate them. Only exact signing reproduction needs the key; if missing, that
test explicitly reports a skip while all public verification tests still run.

After a deliberate encoding change:

1. Update this specification, SDK encoding, and independent Solidity parity code.
2. Run `npm run vectors:regenerate` from the repository root. This runs
   `sdk/scripts/regen-vector.ts`, replaces only TEST_VECTOR_KEY with a fresh key,
   preserves other environment entries, restricts `.env` permissions, and rewrites
   the JSON/Solidity public fixtures. Raw errors and secrets are never logged.
3. Run `npm test`, `npx tsc --noEmit`, and `forge test`. Review the public fixture
   differences together with the encoding changes before committing them.

Regeneration rotates the public signer and signature even if the message is
unchanged. It must not be used merely to conceal a failing encoding regression.
