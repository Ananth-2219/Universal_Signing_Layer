// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MandateAccount} from "../src/MandateAccount.sol";

abstract contract MandateAccountBase is Test {
    MandateAccount internal account;
    uint256 internal ownerKey;
    uint256 internal sessionKey;
    address internal ownerAddress;
    address internal sessionAddress;
    address internal constant RECEIVER = address(0xBEEF);
    uint256 internal constant DEADLINE = 5000;
    bytes32 internal constant CHAIN_TYPE = keccak256("EIP712ChainDomain(uint256 chainId,address verifyingContract)");
    bytes32 internal constant GRANT_TYPE = keccak256(
        "MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)EIP712ChainDomain(uint256 chainId,address verifyingContract)"
    );
    bytes32 internal constant MANDATE_TYPE = keccak256(
        "Mandate(MandateGrant[] grants,uint256 nonce,uint256 deadline)EIP712ChainDomain(uint256 chainId,address verifyingContract)MandateGrant(EIP712ChainDomain domain,address sessionKey,uint256 perTxLimit,uint256 budget,uint256 windowSeconds,uint256 expiry)"
    );
    bytes32 internal constant OP_TYPE = keccak256("Operation(address to,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant CONSENT_TYPE =
        keccak256("Consent(address to,uint256 value,bytes32 dataHash,uint256 nonce,uint256 deadline)");
    bytes32 internal constant REVOKE_TYPE =
        keccak256("RevokeSession(address sessionKey,uint256 nonce,uint256 deadline)");

    function setUp() public virtual {
        vm.chainId(31337);
        vm.warp(100);
        // Dedicated local test secrets only. Never use makeAddrAndKey or literal keys.
        ownerKey = vm.envUint("OWNER_TEST_KEY");
        sessionKey = vm.envUint("SESSION_TEST_KEY");
        ownerAddress = vm.addr(ownerKey);
        sessionAddress = vm.addr(sessionKey);
        require(ownerAddress != sessionAddress, "Test keys must be distinct");
        account = new MandateAccount(ownerAddress);
        vm.deal(address(account), 1 ether);
    }

    function _grant() internal view returns (MandateAccount.MandateGrant memory) {
        return MandateAccount.MandateGrant(
            MandateAccount.EIP712ChainDomain(block.chainid, address(account)), sessionAddress, 10, 20, 10, 10000
        );
    }

    function _grantHash(MandateAccount.MandateGrant memory g) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                GRANT_TYPE,
                keccak256(abi.encode(CHAIN_TYPE, g.domain.chainId, g.domain.verifyingContract)),
                g.sessionKey,
                g.perTxLimit,
                g.budget,
                g.windowSeconds,
                g.expiry
            )
        );
    }

    function _mandateDigest(bytes32[] memory hashes, uint256 nonce, uint256 deadline) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(keccak256("EIP712Domain(string name,string version)"), keccak256("USLMandate"), keccak256("1"))
        );
        bytes32 message = keccak256(abi.encode(MANDATE_TYPE, keccak256(abi.encodePacked(hashes)), nonce, deadline));
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function _boundDigest(bytes32 message, address target, uint256 chain) internal pure returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USLMandate"),
                keccak256("1"),
                chain,
                target
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domain, message));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _pack(bytes32[] memory hashes, uint16 index, address application, bytes memory signature)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            bytes32(abi.encodePacked(bytes9(0x796479647964796479), bytes1(0x03), index, application)), hashes, signature
        );
    }

    function _envelope(MandateAccount.MandateGrant memory g, uint256 nonce, uint256 deadline, uint256 key)
        internal
        pure
        returns (bytes memory)
    {
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = _grantHash(g);
        return _pack(hashes, 0, g.domain.verifyingContract, _sign(key, _mandateDigest(hashes, nonce, deadline)));
    }

    function _register() internal {
        MandateAccount.MandateGrant memory g = _grant();
        account.registerMandate(g, 1, DEADLINE, _envelope(g, 1, DEADLINE, ownerKey));
    }

    function _op(uint256 value, uint256 nonce) internal pure returns (MandateAccount.Operation memory) {
        return MandateAccount.Operation(RECEIVER, value, nonce, 10000);
    }

    function _opSig(MandateAccount.Operation memory op, uint256 key, address target, uint256 chain)
        internal
        pure
        returns (bytes memory)
    {
        return _sign(
            key, _boundDigest(keccak256(abi.encode(OP_TYPE, op.to, op.value, op.nonce, op.deadline)), target, chain)
        );
    }

    function _execute(uint256 value, uint256 nonce) internal {
        MandateAccount.Operation memory op = _op(value, nonce);
        account.executeWithSessionSig(op, _opSig(op, sessionKey, address(account), block.chainid));
    }

    function _consentSig(address to, uint256 value, bytes memory data, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _sign(
            ownerKey,
            _boundDigest(
                keccak256(abi.encode(CONSENT_TYPE, to, value, keccak256(data), nonce, deadline)),
                address(account),
                block.chainid
            )
        );
    }

    function _revokeSig(uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        return _sign(
            ownerKey,
            _boundDigest(
                keccak256(abi.encode(REVOKE_TYPE, sessionAddress, nonce, deadline)), address(account), block.chainid
            )
        );
    }
}
