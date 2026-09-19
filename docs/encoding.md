# USL mandate encoding, version 1

This document is the byte-level contract between the SDK and Phase 5 Solidity.
The SDK is in `sdk/src/core`. Public fixed vectors are in
`sdk/test/vectors/mandate.json`; `docs/vectors/Phase1Vector.sol` contains the same
inputs, hashes, proofs, and signature as a copyable Solidity library.
Neither file contains a private key. JSON integers are decimal strings to avoid
JavaScript number precision loss; TypeScript uses `bigint`.

## Types and scope

`Intent` contains a CAIP-2 `chainId` (for example `eip155:11155111`), a chain-native
destination string, an `amount` in the smallest asset unit, an `asset` string
(`native` or a chain-native token address), and optional hex `data`.
The template-literal chain ID type requires a colon, but is not a full runtime
CAIP-2 validator. Intents are not included in this mandate's signed payload.

`Grant` uses the ABI below. `Mandate` is `{ owner, grants: Grant[] }`.
Its top-level owner is convenience metadata: each leaf commits its own owner.
`buildMerkleTree` requires a nonempty list, the same owner for every grant, and
unique numeric chain IDs. It rejects invalid addresses, non-bigint integers,
negative integers, and integers larger than `2**256 - 1`.

Phase 1 implements the requested EVM grant format. Its numeric chain IDs and
20-byte session-key addresses do **not** yet describe Solana's CAIP-2 reference or
32-byte ed25519 keys. A later phase must explicitly define that representation
and its on-chain verification; no implicit Solana encoding is assumed here.

## Grant leaf: exact field order

| Position | Name | Solidity ABI type | Meaning |
| --- | --- | --- | --- |
| 0 | owner | address | Master key's Ethereum address |
| 1 | chainId | uint256 | EVM chain ID, not a CAIP-2 string |
| 2 | sessionKey | address | EVM session signer |
| 3 | perTxLimit | uint256 | Maximum amount per transaction, smallest unit |
| 4 | budget | uint256 | Amount budget over the policy window, smallest unit |
| 5 | windowSeconds | uint256 | Window duration in seconds |
| 6 | expiry | uint256 | Unix timestamp in seconds |
| 7 | nonce | uint256 | Policy replay/revocation nonce |

Encode eight standard ABI words: 256 bytes total. Addresses are 20-byte values
left-padded to 32 bytes; unsigned integers use 32-byte big-endian encoding.
Do not use packed encoding, serialize CAIP-2 strings, narrow timestamp fields to
`uint64`, or include a grant type hash.

```solidity
bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(
    grant.owner,
    grant.chainId,
    grant.sessionKey,
    grant.perTxLimit,
    grant.budget,
    grant.windowSeconds,
    grant.expiry,
    grant.nonce
))));
```

The outer hash consumes the raw 32-byte inner hash, not its hexadecimal text.
This is OpenZeppelin's double-hashed standard leaf format, which distinguishes
leaf preimages from internal-node preimages.
[OpenZeppelin Merkle tree documentation](https://github.com/OpenZeppelin/merkle-tree#standard-merkle-trees).

## Tree and proofs

`StandardMerkleTree.of(values, encoding, { sortLeaves: true })` defines the tree.
Leaves are sorted by hash before OpenZeppelin constructs its complete binary
tree. Every internal node is `keccak256(concat(min(a,b), max(a,b)))`, sorting
32-byte child hashes lexicographically. Do not substitute a tree that duplicates
odd leaves or promotes nodes using a different layout.

Input grant order does not affect the root. Proofs contain sibling hashes in
leaf-to-root order and can be passed directly to OpenZeppelin `MerkleProof.verify`.
A one-grant tree has its leaf as its root and an empty proof. `getProof(grant)`
uses encoded values rather than object identity, accepts equivalent address
casing, and throws when the grant is absent.

## EIP-712: exact domain and message

```typescript
{
  domain: { name: 'USLMandate', version: '1' },
  types: { Mandate: [{ name: 'root', type: 'bytes32' }] },
  primaryType: 'Mandate',
  message: { root }
}
```

The domain contains **only** `name` and `version`. `chainId`,
`verifyingContract`, and `salt` are absent, not zero-valued.
The typed struct is `Mandate(bytes32 root)`, not the TypeScript `Mandate`
container. Each root must be exactly 32 bytes.

```solidity
bytes32 domainSeparator = keccak256(abi.encode(
    keccak256("EIP712Domain(string name,string version)"),
    keccak256("USLMandate"),
    keccak256("1")
));
bytes32 structHash = keccak256(abi.encode(
    keccak256("Mandate(bytes32 root)"),
    root
));
bytes32 digest = keccak256(abi.encodePacked(
    hex"1901", domainSeparator, structHash
));
```

The final preimage is 66 bytes: two prefix bytes and two 32-byte hashes.
Do not apply the personal-message / `eth_sign` prefix.
OpenZeppelin's default EIP712 domain includes chain and contract information,
so Phase 5 must deliberately reproduce the domain above rather than use its
default domain separator unchanged.

`mandateDigest(root)` uses viem `hashTypedData`. `signMandate(root, account)`
accepts a viem `LocalAccount` and calls its `signTypedData` method.
The fixture uses a private-key account and a deterministic 65-byte secp256k1
signature serialized as `r || s || v`, with low `s` and `v` of 27 or 28.
`verifyMandateSignature(root, signature, owner)` verifies the expected EOA
signer offline via viem `verifyTypedData`. It returns false for invalid signatures
or an incorrect signer; a malformed root throws. Contract-wallet / ERC-1271
verification and RPC-backed wallet clients are outside this API's current scope.
[Viem signing](https://viem.sh/docs/actions/wallet/signTypedData) and
[EOA verification](https://viem.sh/docs/utilities/verifyTypedData).

## What this signature authorizes

One consent signature can be verified on several chains because the signed root
and domain are identical everywhere. Each grant separately binds its owner,
chain, session key, limits, expiry, and nonce. Routine transactions must still
be signed natively by the session key. Over-limit actions require fresh
master-key consent in a later execution flow.

Signature verification alone does not authorize a transaction. Phase 5 must
verify the grant proof, recovered owner, destination chain, authorized session
key, nonce, expiry, and spending limits. `signMandate` receives an opaque root
and cannot inspect which owners are inside it; callers must construct and review
the intended mandate before signing.

The omitted verifying contract also means the signature does not distinguish
two verifiers on the same chain. Canonical verifier selection and shared or
otherwise constrained nonce/budget state remain protocol decisions for Phase 5.
The grant has no asset, destination, or calldata restriction. Define which asset
the amount limits refer to before executing token transfers; arbitrary assets
cannot safely share a budget by merely comparing their raw integer amounts.
The exact rolling-window accounting, expiry boundary, nonce invalidation, and
zero-value policy semantics are not specified by this encoding phase. Zero
integers encode successfully; execution policy must validate meaningful limits.

## Fixed vectors and regeneration

The committed fixture has three grants: Sepolia (11155111), Base Sepolia (84532),
and local Anvil (31337). It includes every input, leaf, proof, root, digest, owner,
and signature. Tests compare against these literal values; they do not regenerate
expected outputs during a normal run. The Solidity fixture needs no private key
and no network. For a future Foundry test, import its library and verify:

```solidity
// With OpenZeppelin ECDSA and MerkleProof imported in your Foundry test:
assertEq(ECDSA.recover(Phase1Vector.DIGEST, Phase1Vector.SIGNATURE), Phase1Vector.OWNER);
Phase1Vector.Grant[] memory grants = Phase1Vector.grants();
bytes32[] memory leaves = Phase1Vector.leaves();
for (uint256 i; i < grants.length; ++i) {
    Phase1Vector.Grant memory g = grants[i];
    bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(
        g.owner, g.chainId, g.sessionKey, g.perTxLimit,
        g.budget, g.windowSeconds, g.expiry, g.nonce
    ))));
    assertEq(leaf, leaves[i]);
    assertTrue(MerkleProof.verify(Phase1Vector.proof(i), Phase1Vector.ROOT, leaf));
}
// Also compute the domain/struct digest above with Phase1Vector.ROOT
// and assert equality to Phase1Vector.DIGEST.
```

The dedicated `TEST_VECTOR_KEY` is stored only in root `.env`, ignored by Git.
Never fund it, deploy with it, print it, or place it in a Foundry fixture.
On this machine, the signing test reads that key and reproduces the exact
signature. Without the key, public verification tests still run and only the
private signing test is skipped. An existing but mismatched key fails the signing
test instead of silently updating the expected signature.

After an intentional encoding change:

1. Update the encoding code, this specification, and any independently specified
   test reference encoding. Review the protocol compatibility implications.
2. From the repository root, run `npm run vectors:regenerate`. The script uses
   viem's key generator to rotate **only** `TEST_VECTOR_KEY` in `.env`, preserves
   other environment entries, restricts `.env` permissions, then reads the key
   back to sign. It writes the JSON and Solidity fixtures. It never logs the key
   or raw exception objects.
3. Run `npm test` and `npm run typecheck`. Review changes to the public vectors
   and commit those files together with the encoding change. Do not regenerate
   vectors merely to hide a failing regression test.

Regeneration changes the public owner and therefore every leaf, root, digest,
and signature, even when the encoding is unchanged. Contributors who only need
verification do not need to regenerate anything or obtain the key.
