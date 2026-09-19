// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MandateAccountBase, MandateAccount} from "./MandateAccountBase.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CallTarget {
    bool public rejecting;
    uint256 public number;

    function reject(bool value) external {
        rejecting = value;
    }

    function setNumber(uint256 value) external payable {
        require(!rejecting);
        number = value;
    }

    receive() external payable {
        require(!rejecting);
    }
}

contract ReenterTarget {
    MandateAccount public account;
    bytes public payload;
    address public signer;
    bool public nestedSuccess;
    bytes public nestedResult;
    bool public nonceSeen;
    uint256 public spentSeen;

    constructor(MandateAccount account_, address signer_) {
        account = account_;
        signer = signer_;
    }

    function arm(bytes memory payload_) external {
        payload = payload_;
    }

    receive() external payable {
        nonceSeen = account.operationNonceUsed(signer, 1);
        spentSeen = account.sessions(signer).spent;
        (nestedSuccess, nestedResult) = address(account).call(payload);
    }
}

contract MandateSecurityTest is MandateAccountBase {
    function testOwnerOnlyRevocationAndRevokedSessionCannotSpend() public {
        _register();
        vm.expectRevert(MandateAccount.NotOwner.selector);
        account.revokeSession(sessionAddress);
        vm.expectEmit(false, false, false, true, address(account));
        emit MandateAccount.SessionRevoked(sessionAddress);
        vm.prank(ownerAddress);
        account.revokeSession(sessionAddress);
        assertFalse(account.sessions(sessionAddress).active);
        MandateAccount.Operation memory op = _op(1, 1);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.executeWithSessionSig(op, sig);
        vm.prank(ownerAddress);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.revokeSession(sessionAddress);
    }

    function testPermissionlessSignedRevocationAndReplay() public {
        _register();
        bytes memory sig = _revokeSig(7, 100);
        vm.prank(RECEIVER);
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
        assertFalse(account.sessions(sessionAddress).active);
        vm.expectRevert(MandateAccount.RevokeNonceUsed.selector);
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
    }

    function testSignedRevocationBindsFieldsAndDomainAndChecksDeadline() public {
        _register();
        bytes memory sig = _revokeSig(7, 100);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.revokeSessionWithSig(sessionAddress, 8, 100, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.revokeSessionWithSig(sessionAddress, 7, 101, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.revokeSessionWithSig(RECEIVER, 7, 100, sig);
        vm.chainId(31338);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
        vm.chainId(31337);
        vm.warp(101);
        vm.expectRevert(MandateAccount.DeadlinePassed.selector);
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
        sig = _revokeSig(7, 101);
        account.revokeSessionWithSig(sessionAddress, 7, 101, sig);
    }

    function testRejectedInactiveRevocationDoesNotBurnNonce() public {
        bytes memory sig = _revokeSig(7, 100);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
        _register();
        account.revokeSessionWithSig(sessionAddress, 7, 100, sig);
    }

    function testConsentExecutesCalldataAndExceedsSessionLimitsWithoutSpendingBudget() public {
        _register();
        CallTarget target = new CallTarget();
        bytes memory data = abi.encodeCall(CallTarget.setNumber, (42));
        bytes memory sig = _consentSig(address(target), 100, data, 1, 100);
        vm.expectEmit(false, false, false, true, address(account));
        emit MandateAccount.ConsentExecuted(address(target), 100, 1);
        vm.prank(RECEIVER);
        account.executeWithConsent(address(target), 100, data, 1, 100, sig);
        assertEq(target.number(), 42);
        assertEq(address(target).balance, 100);
        assertEq(account.sessions(sessionAddress).spent, 0);
        vm.expectRevert(MandateAccount.ConsentNonceUsed.selector);
        account.executeWithConsent(address(target), 100, data, 1, 100, sig);
        // The frozen typed actions have independent nonce spaces.
        account.revokeSessionWithSig(sessionAddress, 1, 100, _revokeSig(1, 100));
    }

    function testConsentBindsAllArgumentsAndDomain() public {
        bytes memory sig = _consentSig(RECEIVER, 1, "", 1, 100);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(ownerAddress, 1, "", 1, 100, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 2, "", 1, 100, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 1, hex"01", 1, 100, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 1, "", 2, 100, sig);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 101, sig);
        vm.chainId(31338);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        vm.chainId(31337);
        MandateAccount other = new MandateAccount(ownerAddress);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        other.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        vm.warp(101);
        vm.expectRevert(MandateAccount.DeadlinePassed.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        sig = _consentSig(RECEIVER, 1, "", 1, 101);
        account.executeWithConsent(RECEIVER, 1, "", 1, 101, sig);
    }

    function testSessionSignatureCannotAuthorizeConsentOrRevocation() public {
        _register();
        bytes memory sig = _sign(
            sessionKey,
            _boundDigest(
                keccak256(abi.encode(CONSENT_TYPE, RECEIVER, 1, keccak256(""), 1, 100)), address(account), block.chainid
            )
        );
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        sig = _sign(
            sessionKey,
            _boundDigest(keccak256(abi.encode(REVOKE_TYPE, sessionAddress, 1, 100)), address(account), block.chainid)
        );
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.revokeSessionWithSig(sessionAddress, 1, 100, sig);
    }

    function testRejectsMalformedZeroAndMalleableSignatures() public {
        MandateAccount.MandateGrant memory g = _grant();
        (bytes32 header, bytes32[] memory hashes, bytes memory sig) =
            abi.decode(_envelope(g, 1, DEADLINE, ownerKey), (bytes32, bytes32[], bytes));
        bytes[] memory invalid = new bytes[](4);
        invalid[0] = hex"01";
        invalid[1] = new bytes(65);
        invalid[2] = bytes.concat(sig);
        invalid[2][64] = hex"00";
        invalid[3] = _malleate(sig);
        for (uint256 i; i < invalid.length; i++) {
            bytes memory envelope = abi.encode(header, hashes, invalid[i]);
            vm.expectRevert(MandateAccount.InvalidSignature.selector);
            account.registerMandate(g, 1, DEADLINE, envelope);
        }
        _register();
        MandateAccount.Operation memory op = _op(1, 1);
        sig = _malleate(_opSig(op, sessionKey, address(account), block.chainid));
        vm.expectRevert(MandateAccount.InvalidSignature.selector);
        account.executeWithSessionSig(op, sig);
        sig = _malleate(_consentSig(RECEIVER, 1, "", 1, 100));
        vm.expectRevert(MandateAccount.InvalidSignature.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        sig = _malleate(_revokeSig(1, 100));
        vm.expectRevert(MandateAccount.InvalidSignature.selector);
        account.revokeSessionWithSig(sessionAddress, 1, 100, sig);
    }

    function testRejectedSessionCallRollsBackWindowSpendAndNonce() public {
        _register();
        CallTarget target = new CallTarget();
        target.reject(true);
        MandateAccount.Operation memory op = _op(10, 1);
        op.to = address(target);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.CallFailed.selector);
        account.executeWithSessionSig(op, sig);
        assertFalse(account.operationNonceUsed(sessionAddress, 1));
        assertEq(account.sessions(sessionAddress).windowStart, 0);
        assertEq(account.sessions(sessionAddress).spent, 0);
        target.reject(false);
        account.executeWithSessionSig(op, sig);
        assertEq(address(target).balance, 10);
    }

    function testInsufficientFundsCanRetrySameOperationAndConsent() public {
        _register();
        vm.deal(address(account), 0);
        MandateAccount.Operation memory op = _op(1, 1);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.InsufficientBalance.selector);
        account.executeWithSessionSig(op, sig);
        vm.deal(address(account), 1);
        account.executeWithSessionSig(op, sig);
        sig = _consentSig(RECEIVER, 1, "", 1, 100);
        vm.expectRevert(MandateAccount.InsufficientBalance.selector);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
        vm.deal(address(account), 1);
        account.executeWithConsent(RECEIVER, 1, "", 1, 100, sig);
    }

    function testRejectedConsentCallDoesNotBurnNonce() public {
        CallTarget target = new CallTarget();
        target.reject(true);
        bytes memory data = abi.encodeCall(CallTarget.setNumber, (42));
        bytes memory sig = _consentSig(address(target), 1, data, 1, 100);
        vm.expectRevert(MandateAccount.CallFailed.selector);
        account.executeWithConsent(address(target), 1, data, 1, 100, sig);
        target.reject(false);
        account.executeWithConsent(address(target), 1, data, 1, 100, sig);
        assertEq(target.number(), 42);
    }

    function testReentrantOperationAndRevocationBlockedAfterEffects() public {
        _register();
        ReenterTarget target = new ReenterTarget(account, sessionAddress);
        MandateAccount.Operation memory nested = _op(1, 2);
        target.arm(
            abi.encodeCall(
                MandateAccount.executeWithSessionSig,
                (nested, _opSig(nested, sessionKey, address(account), block.chainid))
            )
        );
        MandateAccount.Operation memory op = _op(1, 1);
        op.to = address(target);
        account.executeWithSessionSig(op, _opSig(op, sessionKey, address(account), block.chainid));
        assertFalse(target.nestedSuccess());
        assertEq(bytes4(target.nestedResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertTrue(target.nonceSeen());
        assertEq(target.spentSeen(), 1);
        assertFalse(account.operationNonceUsed(sessionAddress, 2));
        target.arm(abi.encodeCall(MandateAccount.revokeSessionWithSig, (sessionAddress, 1, 100, _revokeSig(1, 100))));
        op.nonce = 3;
        account.executeWithSessionSig(op, _opSig(op, sessionKey, address(account), block.chainid));
        assertFalse(target.nestedSuccess());
        assertTrue(account.sessions(sessionAddress).active);
        assertEq(account.sessions(sessionAddress).spent, 2);
    }

    function _malleate(bytes memory signature) private pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        assembly ("memory-safe") {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
        }
        // Public secp256k1 group order; mutate a signature to exercise OZ's low-s rejection.
        uint256 order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        return abi.encodePacked(r, bytes32(order - uint256(s)), uint8(signature[64]) == 27 ? uint8(28) : uint8(27));
    }
}
