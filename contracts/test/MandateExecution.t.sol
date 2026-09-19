// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MandateAccountBase, MandateAccount} from "./MandateAccountBase.sol";

contract MandateExecutionTest is MandateAccountBase {
    function testPermissionlessExecutionAndPerTransactionBoundary() public {
        _register();
        MandateAccount.Operation memory op = _op(10, 1);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectEmit(false, false, false, true, address(account));
        emit MandateAccount.Executed(sessionAddress, RECEIVER, 10);
        vm.prank(RECEIVER);
        account.executeWithSessionSig(op, sig);
        assertEq(RECEIVER.balance, 10);
        assertEq(account.sessions(sessionAddress).spent, 10);
        op = _op(11, 2);
        sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.PerTxLimitExceeded.selector);
        account.executeWithSessionSig(op, sig);
        assertFalse(account.operationNonceUsed(sessionAddress, 2));
    }

    function testDripSpendingReachesButCannotExceedBudget() public {
        _register();
        for (uint256 i; i < 20; i++) {
            _execute(1, i);
        }
        MandateAccount.Operation memory op = _op(1, 20);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.BudgetExceeded.selector);
        account.executeWithSessionSig(op, sig);
        assertEq(account.sessions(sessionAddress).spent, 20);
        assertEq(RECEIVER.balance, 20);
    }

    function testWindowStartsAtFirstSpendAndResetsExactlyAtBoundary() public {
        _register();
        vm.warp(105);
        _execute(10, 1);
        _execute(10, 2);
        assertEq(account.sessions(sessionAddress).windowStart, 105);
        vm.warp(114);
        MandateAccount.Operation memory op = _op(1, 3);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.BudgetExceeded.selector);
        account.executeWithSessionSig(op, sig);
        vm.warp(115);
        account.executeWithSessionSig(op, sig);
        assertEq(account.sessions(sessionAddress).windowStart, 115);
        assertEq(account.sessions(sessionAddress).spent, 1);
    }

    function testDocumentedAlmostTwoBudgetsBoundaryBurst() public {
        MandateAccount.MandateGrant memory g = _grant();
        g.perTxLimit = 100;
        g.budget = 100;
        account.registerMandate(g, 1, DEADLINE, _envelope(g, 1, DEADLINE, ownerKey));
        _execute(1, 1);
        vm.warp(109);
        _execute(99, 2);
        uint256 before = RECEIVER.balance - 99;
        vm.warp(110);
        _execute(100, 3);
        assertEq(RECEIVER.balance - before, 199);
        assertEq(account.sessions(sessionAddress).spent, 100);
    }

    function testOperationDeadlineInclusiveAndSessionExpiryExclusive() public {
        _register();
        MandateAccount.Operation memory op = _op(1, 1);
        op.deadline = 100;
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        account.executeWithSessionSig(op, sig);
        op.nonce = 2;
        sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.warp(101);
        vm.expectRevert(MandateAccount.DeadlinePassed.selector);
        account.executeWithSessionSig(op, sig);
        vm.warp(9999);
        _execute(1, 3);
        vm.warp(10000);
        op = _op(1, 4);
        sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.SessionExpired.selector);
        account.executeWithSessionSig(op, sig);
    }

    function testOperationReplayIncludingAfterRevocationAndReregistration() public {
        _register();
        _execute(1, 1);
        MandateAccount.Operation memory op = _op(1, 1);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.OperationNonceUsed.selector);
        account.executeWithSessionSig(op, sig);
        vm.prank(ownerAddress);
        account.revokeSession(sessionAddress);
        MandateAccount.MandateGrant memory g = _grant();
        account.registerMandate(g, 2, DEADLINE, _envelope(g, 2, DEADLINE, ownerKey));
        vm.expectRevert(MandateAccount.OperationNonceUsed.selector);
        account.executeWithSessionSig(op, sig);
        _execute(1, 2);
    }

    function testNonceIsScopedToSessionSigner() public {
        _register();
        _execute(1, 1);
        MandateAccount.MandateGrant memory g = _grant();
        g.sessionKey = ownerAddress;
        account.registerMandate(g, 2, DEADLINE, _envelope(g, 2, DEADLINE, ownerKey));
        MandateAccount.Operation memory op = _op(1, 1);
        account.executeWithSessionSig(op, _opSig(op, ownerKey, address(account), block.chainid));
        assertTrue(account.operationNonceUsed(sessionAddress, 1));
        assertTrue(account.operationNonceUsed(ownerAddress, 1));
    }

    function testOperationsCannotCrossChainOrAccountOrChangeFields() public {
        _register();
        MandateAccount.Operation memory op = _op(1, 1);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid + 1);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.executeWithSessionSig(op, sig);
        sig = _opSig(op, sessionKey, RECEIVER, block.chainid);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.executeWithSessionSig(op, sig);
        sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.chainId(31338);
        vm.expectRevert(MandateAccount.SessionNotActive.selector);
        account.executeWithSessionSig(op, sig);
        vm.chainId(31337);
        for (uint256 i; i < 4; i++) {
            MandateAccount.Operation memory changed = _op(1, 1);
            if (i == 0) changed.to = ownerAddress;
            if (i == 1) changed.value++;
            if (i == 2) changed.nonce++;
            if (i == 3) changed.deadline++;
            vm.expectRevert(MandateAccount.SessionNotActive.selector);
            account.executeWithSessionSig(changed, sig);
        }
    }

    function testZeroDurationResetsEverySpendAsInPolicy() public {
        MandateAccount.MandateGrant memory g = _grant();
        g.windowSeconds = 0;
        account.registerMandate(g, 1, DEADLINE, _envelope(g, 1, DEADLINE, ownerKey));
        for (uint256 i; i < 3; i++) {
            _execute(10, i);
        }
        assertEq(account.sessions(sessionAddress).spent, 10);
        assertEq(RECEIVER.balance, 30);
    }

    function testZeroValueFirstSpendAtTimestampZeroStartsWindow() public {
        vm.warp(0);
        _register();
        _execute(0, 1);
        vm.warp(9);
        _execute(10, 2);
        _execute(10, 3);
        assertEq(account.sessions(sessionAddress).windowStart, 0);
        vm.warp(10);
        _execute(10, 4);
        assertEq(account.sessions(sessionAddress).windowStart, 10);
        assertEq(account.sessions(sessionAddress).spent, 10);
    }

    function testMaxUintBudgetAndDurationDoNotOverflow() public {
        MandateAccount.MandateGrant memory g = _grant();
        g.perTxLimit = type(uint256).max;
        g.budget = type(uint256).max;
        g.windowSeconds = type(uint256).max;
        account.registerMandate(g, 1, DEADLINE, _envelope(g, 1, DEADLINE, ownerKey));
        vm.deal(address(account), type(uint256).max);
        _execute(type(uint256).max, 1);
        MandateAccount.Operation memory op = _op(1, 2);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        vm.expectRevert(MandateAccount.BudgetExceeded.selector);
        account.executeWithSessionSig(op, sig);
    }

    function testFuzzBudgetAccounting(uint96 rawBudget, uint32 rawWindow, uint256 seed, uint64[] memory values) public {
        MandateAccount.MandateGrant memory g = _grant();
        g.budget = bound(rawBudget, 0, 1e12);
        g.perTxLimit = g.budget;
        g.windowSeconds = bound(rawWindow, 1, 1000);
        g.expiry = type(uint256).max;
        account.registerMandate(g, 1, DEADLINE, _envelope(g, 1, DEADLINE, ownerKey));
        uint256 spent;
        uint256 start;
        bool started;
        uint256 length = values.length > 32 ? 32 : values.length;
        for (uint256 i; i < length; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            vm.warp(block.timestamp + seed % (g.windowSeconds + 1));
            uint256 value = uint256(values[i]) % (g.budget + 2);
            bool reset = !started || block.timestamp - start >= g.windowSeconds;
            uint256 available = g.budget - (reset ? 0 : spent);
            MandateAccount.Operation memory op = _op(value, i);
            op.deadline = type(uint256).max;
            bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
            if (value > g.perTxLimit || value > available) {
                vm.expectRevert(
                    value > g.perTxLimit
                        ? MandateAccount.PerTxLimitExceeded.selector
                        : MandateAccount.BudgetExceeded.selector
                );
                account.executeWithSessionSig(op, sig);
                assertFalse(account.operationNonceUsed(sessionAddress, i));
            } else {
                account.executeWithSessionSig(op, sig);
                if (reset) {
                    start = block.timestamp;
                    spent = 0;
                    started = true;
                }
                spent += value;
            }
            MandateAccount.Session memory s = account.sessions(sessionAddress);
            assertEq(s.spent, spent);
            assertEq(s.windowStart, start);
            assertLe(s.spent, g.budget);
        }
    }
}
