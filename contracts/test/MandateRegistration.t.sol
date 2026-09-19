// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MandateAccountBase, MandateAccount} from "./MandateAccountBase.sol";
import {Test} from "forge-std/Test.sol";
import {Phase1Vector as V} from "../../docs/vectors/Phase1Vector.sol";

contract MandateRegistrationTest is MandateAccountBase {
    function testDomainOwnerAndReceive() public {
        assertEq(account.owner(), ownerAddress);
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chain,
            address verifier,
            bytes32 salt,
            uint256[] memory extensions
        ) = account.eip712Domain();
        assertEq(fields, hex"0f");
        assertEq(name, "USLMandate");
        assertEq(version, "1");
        assertEq(chain, block.chainid);
        assertEq(verifier, address(account));
        assertEq(salt, 0);
        assertEq(extensions.length, 0);
        vm.deal(address(this), 1);
        (bool ok,) = address(account).call{value: 1}("");
        assertTrue(ok);
        assertEq(address(account).balance, 1 ether + 1);
        vm.expectRevert(MandateAccount.InvalidOwner.selector);
        new MandateAccount(address(0));
    }

    function testPermissionlessRegistrationStoresSessionAndEmitsEvent() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectEmit(false, false, false, true, address(account));
        emit MandateAccount.MandateRegistered(sessionAddress, 1, g.expiry);
        vm.prank(RECEIVER);
        account.registerMandate(g, 1, DEADLINE, envelope);
        MandateAccount.Session memory s = account.sessions(sessionAddress);
        assertTrue(s.active);
        assertTrue(account.mandateIdUsed(1));
        assertEq(s.perTxLimit, 10);
        assertEq(s.budget, 20);
        assertEq(s.windowSeconds, 10);
        assertEq(s.expiry, g.expiry);
        assertEq(s.windowStart, 0);
        assertEq(s.spent, 0);
    }

    function testWrongSignerDoesNotConsumeMandateId() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory envelope = _envelope(g, 1, DEADLINE, sessionKey);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
        assertFalse(account.mandateIdUsed(1));
        _register();
    }

    function testWrongChainAndAccountRejectedEvenIfOwnerSignedThem() public {
        MandateAccount.MandateGrant memory g = _grant();
        g.domain.chainId++;
        bytes memory envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.WrongChain.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
        g = _grant();
        g.domain.verifyingContract = RECEIVER;
        envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.WrongAccount.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
    }

    function testTamperedGrantAndWrongSelectedGrantFail() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory envelope = _envelope(g, 1, DEADLINE, ownerKey);
        g.budget++;
        vm.expectRevert(MandateAccount.GrantHashMismatch.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
        g = _grant();
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = _grantHash(g);
        hashes[1] = bytes32(uint256(1));
        envelope = _pack(hashes, 1, address(account), _sign(ownerKey, _mandateDigest(hashes, 1, DEADLINE)));
        vm.expectRevert(MandateAccount.GrantHashMismatch.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
    }

    function testWrongNonceDeadlineAndOtherGrantHashInvalidateSignature() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.registerMandate(g, 2, DEADLINE, envelope);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.registerMandate(g, 1, DEADLINE + 1, envelope);
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = _grantHash(g);
        hashes[1] = bytes32(uint256(1));
        bytes memory signature = _sign(ownerKey, _mandateDigest(hashes, 1, DEADLINE));
        hashes[1] = bytes32(uint256(2));
        envelope = _pack(hashes, 0, address(account), signature);
        vm.expectRevert(MandateAccount.WrongSigner.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
        assertFalse(account.mandateIdUsed(1));
        assertFalse(account.mandateIdUsed(2));
    }

    function testHeaderMagicFieldsIndexAndApplication() public {
        MandateAccount.MandateGrant memory g = _grant();
        (bytes32 header, bytes32[] memory hashes, bytes memory sig) =
            abi.decode(_envelope(g, 1, DEADLINE, ownerKey), (bytes32, bytes32[], bytes));
        bytes32[4] memory bad = [
            header ^ bytes32(uint256(1) << 248),
            header ^ bytes32(uint256(1) << 176),
            header | bytes32(uint256(1) << 160),
            header ^ bytes32(uint256(1))
        ];
        bytes4[4] memory errors = [
            MandateAccount.WrongMagic.selector,
            MandateAccount.WrongFields.selector,
            MandateAccount.InvalidStructIndex.selector,
            MandateAccount.WrongApplication.selector
        ];
        for (uint256 i; i < bad.length; i++) {
            bytes memory envelope = abi.encode(bad[i], hashes, sig);
            vm.expectRevert(errors[i]);
            account.registerMandate(g, 1, DEADLINE, envelope);
        }
    }

    function testTruncationOffsetsLengthsAndPaddingHaveCustomErrors() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory good = _envelope(g, 1, DEADLINE, ownerKey);
        for (uint256 length; length < good.length; length++) {
            bytes memory truncated = new bytes(length);
            for (uint256 j; j < length; j++) {
                truncated[j] = good[j];
            }
            vm.expectRevert(MandateAccount.InvalidEnvelope.selector);
            account.registerMandate(g, 1, DEADLINE, truncated);
        }
        uint256[4] memory offsets = [uint256(32), 64, 96, 160];
        for (uint256 i; i < offsets.length; i++) {
            bytes memory bad = bytes.concat(good);
            uint256 offset = offsets[i];
            assembly ("memory-safe") { mstore(add(add(bad, 32), offset), not(0)) }
            vm.expectRevert(MandateAccount.InvalidEnvelope.selector);
            account.registerMandate(g, 1, DEADLINE, bad);
        }
        good[good.length - 1] = hex"01";
        vm.expectRevert(MandateAccount.InvalidEnvelope.selector);
        account.registerMandate(g, 1, DEADLINE, good);
    }

    function testMandateReplayAndActiveSessionCannotBeOverwritten() public {
        _register();
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory repeated = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.MandateNonceUsed.selector);
        account.registerMandate(g, 1, DEADLINE, repeated);
        bytes memory fresh = _envelope(g, 2, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.SessionAlreadyActive.selector);
        account.registerMandate(g, 2, DEADLINE, fresh);
        assertFalse(account.mandateIdUsed(2));
    }

    function testRegistrationDeadlineEqualityAndOneSecondLate() public {
        MandateAccount.MandateGrant memory g = _grant();
        bytes memory signature = _envelope(g, 1, 100, ownerKey);
        account.registerMandate(g, 1, 100, signature);
        MandateAccount other = new MandateAccount(ownerAddress);
        g.domain.verifyingContract = address(other);
        signature = _envelope(g, 1, 100, ownerKey);
        vm.warp(101);
        vm.expectRevert(MandateAccount.DeadlinePassed.selector);
        other.registerMandate(g, 1, 100, signature);
    }

    function testExpiryEqualityAndZeroSessionKeyRejected() public {
        MandateAccount.MandateGrant memory g = _grant();
        g.expiry = block.timestamp;
        bytes memory envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.SessionExpired.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
        g = _grant();
        g.sessionKey = address(0);
        envelope = _envelope(g, 1, DEADLINE, ownerKey);
        vm.expectRevert(MandateAccount.InvalidSessionKey.selector);
        account.registerMandate(g, 1, DEADLINE, envelope);
    }

    function testSameSignatureRegistersTwoAccountsOnTwoChains() public {
        MandateAccount other = new MandateAccount(ownerAddress);
        MandateAccount.MandateGrant memory a = _grant();
        MandateAccount.MandateGrant memory b = _grant();
        b.domain = MandateAccount.EIP712ChainDomain(31338, address(other));
        bytes32[] memory hashes = new bytes32[](2);
        hashes[0] = _grantHash(a);
        hashes[1] = _grantHash(b);
        bytes memory signature = _sign(ownerKey, _mandateDigest(hashes, 1, DEADLINE));
        account.registerMandate(a, 1, DEADLINE, _pack(hashes, 0, address(account), signature));
        vm.chainId(31338);
        other.registerMandate(b, 1, DEADLINE, _pack(hashes, 1, address(other), signature));
        assertTrue(account.sessions(sessionAddress).active);
        assertTrue(other.sessions(sessionAddress).active);
        (,,, uint256 domainChain,,,) = other.eip712Domain();
        assertEq(domainChain, 31338);
    }

    function testFuzzMalformedEnvelopeNeverPanics(bytes memory input) public {
        MandateAccount.MandateGrant memory g = _grant();
        (bool ok, bytes memory reason) =
            address(account).call(abi.encodeCall(MandateAccount.registerMandate, (g, 1, DEADLINE, input)));
        assertFalse(ok);
        assertGe(reason.length, 4);
        assertTrue(bytes4(reason) != bytes4(0x4e487b71)); // Solidity panic.
        assertTrue(bytes4(reason) != bytes4(0x08c379a0)); // String revert.
    }
}

/// Public-vector registration is independent of .env and vm.sign.
contract MandatePublicVectorTest is Test {
    function testFixedPhase1SignatureRegistersBothGrants() public {
        vm.warp(1900000000);
        MandateAccount template = new MandateAccount(V.OWNER);
        vm.etch(V.G0_VERIFYING_CONTRACT, address(template).code);
        vm.etch(V.G1_VERIFYING_CONTRACT, address(template).code);
        for (uint256 i; i < 2; i++) {
            MandateAccount.MandateGrant memory g = MandateAccount.MandateGrant(
                MandateAccount.EIP712ChainDomain(
                    i == 0 ? V.G0_CHAIN_ID : V.G1_CHAIN_ID, i == 0 ? V.G0_VERIFYING_CONTRACT : V.G1_VERIFYING_CONTRACT
                ),
                i == 0 ? V.G0_SESSION_KEY : V.G1_SESSION_KEY,
                i == 0 ? V.G0_PER_TX_LIMIT : V.G1_PER_TX_LIMIT,
                i == 0 ? V.G0_BUDGET : V.G1_BUDGET,
                i == 0 ? V.G0_WINDOW_SECONDS : V.G1_WINDOW_SECONDS,
                i == 0 ? V.G0_EXPIRY : V.G1_EXPIRY
            );
            vm.chainId(g.domain.chainId);
            MandateAccount target = MandateAccount(payable(g.domain.verifyingContract));
            bytes memory original = i == 0 ? V.ENVELOPE_0 : V.ENVELOPE_1;
            vm.expectRevert(MandateAccount.WrongApplication.selector);
            target.registerMandate(g, V.NONCE, V.DEADLINE, original);
            (bytes32 header, bytes32[] memory hashes, bytes memory signature) =
                abi.decode(original, (bytes32, bytes32[], bytes));
            // Only the unsigned application field changes; all signed bytes stay fixed.
            header = bytes32((uint256(header) & ~uint256(type(uint160).max)) | uint256(uint160(address(target))));
            target.registerMandate(g, V.NONCE, V.DEADLINE, abi.encode(header, hashes, signature));
            assertEq(signature, V.SIGNATURE);
            assertEq(target.owner(), V.OWNER);
            assertTrue(target.sessions(g.sessionKey).active);
            assertTrue(target.mandateIdUsed(V.NONCE));
        }
    }
}
