// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Phase1Vector as V} from "../../docs/vectors/Phase1Vector.sol";

/// Independent encoding parity only. No account contract or signing key required.
contract MandateVectorTest {
    bytes32 constant CHAIN_TYPEHASH = keccak256("EIP712ChainDomain(uint256 chainId,address verifyingContract)");
    bytes32 constant GRANT_TYPEHASH = keccak256("MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)EIP712ChainDomain(uint256 chainId,address verifyingContract)");
    bytes32 constant MANDATE_TYPEHASH = keccak256("Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)EIP712ChainDomain(uint256 chainId,address verifyingContract)MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)");

    function grantHashes() internal pure returns (bytes32 a, bytes32 b) {
        bytes32 domainA = keccak256(abi.encode(CHAIN_TYPEHASH, V.G0_CHAIN_ID, V.G0_VERIFYING_CONTRACT));
        bytes32 domainB = keccak256(abi.encode(CHAIN_TYPEHASH, V.G1_CHAIN_ID, V.G1_VERIFYING_CONTRACT));
        require(domainA == V.G0_DOMAIN_HASH, "domain A");
        require(domainB == V.G1_DOMAIN_HASH, "domain B");
        a = keccak256(abi.encode(GRANT_TYPEHASH, domainA, V.G0_SESSION_KEY,
            V.G0_PER_TX_LIMIT, V.G0_BUDGET, V.G0_WINDOW_SECONDS, V.G0_EXPIRY));
        b = keccak256(abi.encode(GRANT_TYPEHASH, domainB, V.G1_SESSION_KEY,
            V.G1_PER_TX_LIMIT, V.G1_BUDGET, V.G1_WINDOW_SECONDS, V.G1_EXPIRY));
    }

    function reconstructedDigest() internal pure returns (bytes32) {
        (bytes32 a, bytes32 b) = grantHashes();
        // Two static bytes32 ABI words have no offset/length prefix.
        bytes32 arrayHash = keccak256(abi.encode(a, b));
        require(arrayHash == V.ARRAY_HASH, "array hash");
        bytes32 structHash = keccak256(abi.encode(MANDATE_TYPEHASH, arrayHash, V.NONCE, V.DEADLINE));
        require(structHash == V.MANDATE_STRUCT_HASH, "mandate struct");
        bytes32 separator = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version)"), keccak256("USLMandate"), keccak256("1")
        ));
        require(separator == V.DOMAIN_SEPARATOR, "domain separator");
        return keccak256(abi.encodePacked(hex"1901", separator, structHash));
    }

    function testGrantHashes() public pure {
        (bytes32 a, bytes32 b) = grantHashes();
        require(a == V.G0_STRUCT_HASH && b == V.G1_STRUCT_HASH, "grant hashes");
    }

    function testMandateDigest() public pure {
        require(reconstructedDigest() == V.DIGEST, "digest");
    }

    function testRecoverOwner() public pure {
        bytes memory signature = V.SIGNATURE;
        require(signature.length == 65, "signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        // Read the public r || s || v fixture; no signing occurs in Solidity.
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        require(v == 27 || v == 28, "signature v");
        require(ecrecover(reconstructedDigest(), v, r, s) == V.OWNER, "owner");
    }

    function testBothEnvelopes() public pure {
        (bytes32 a, bytes32 b) = grantHashes();
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = a;
        hashes[1] = b;
        bytes32 header0 = bytes32(abi.encodePacked(bytes9(0x796479647964796479), bytes1(0x03), uint16(0), V.APPLICATION));
        bytes32 header1 = bytes32(abi.encodePacked(bytes9(0x796479647964796479), bytes1(0x03), uint16(1), V.APPLICATION));
        require(keccak256(abi.encode(header0, hashes, V.SIGNATURE)) == keccak256(V.ENVELOPE_0), "envelope 0");
        require(keccak256(abi.encode(header1, hashes, V.SIGNATURE)) == keccak256(V.ENVELOPE_1), "envelope 1");
    }
}
