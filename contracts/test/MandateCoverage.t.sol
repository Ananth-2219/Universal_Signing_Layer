// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MandateAccountBase, MandateAccount} from "./MandateAccountBase.sol";

/// A receiver that re-enters the account with a normal call inside receive().
/// A plain call is used (not a low-level call) so the inner revert must bubble out.
contract DirectReenterTarget {
    MandateAccount public immutable account;
    MandateAccount.Operation public nested;
    bytes public nestedSignature;

    constructor(MandateAccount account_) {
        account = account_;
    }

    function arm(MandateAccount.Operation memory nested_, bytes memory nestedSignature_) external {
        nested = nested_;
        nestedSignature = nestedSignature_;
    }

    receive() external payable {
        // The outer executeWithSessionSig is still running, so this reverts with the
        // reentrancy guard error and bubbles out as the outer call's CallFailed.
        account.executeWithSessionSig(nested, nestedSignature);
    }
}

/// Coverage file for the Phase 5 requirement matrix. Every test here covers a row that
/// no earlier test covered; rows already covered elsewhere are listed in docs/phase-5.md.
contract MandateCoverageTest is MandateAccountBase {
    // R20: a receiver calling executeWithSessionSig again from receive() makes the OUTER
    // call revert with CallFailed, and no state (spent, windowStart, nonces, balances) changes.
    function testReentrantDirectCallRevertsOuterWithCallFailedAndChangesNoState() public {
        _register();
        DirectReenterTarget target = new DirectReenterTarget(account);
        MandateAccount.Operation memory nested = _op(1, 2);
        target.arm(nested, _opSig(nested, sessionKey, address(account), block.chainid));

        MandateAccount.Operation memory op = _op(1, 1);
        op.to = address(target);
        bytes memory sig = _opSig(op, sessionKey, address(account), block.chainid);
        uint256 accountBalance = address(account).balance;

        vm.prank(RECEIVER);
        vm.expectRevert(MandateAccount.CallFailed.selector);
        account.executeWithSessionSig(op, sig);

        assertEq(account.sessions(sessionAddress).spent, 0);
        assertEq(account.sessions(sessionAddress).windowStart, 0);
        assertFalse(account.operationNonceUsed(sessionAddress, 1));
        assertFalse(account.operationNonceUsed(sessionAddress, 2));
        assertEq(address(target).balance, 0);
        assertEq(address(account).balance, accountBalance);
        // The account is still usable afterwards; only the re-entrant call was rejected.
        op.to = RECEIVER;
        account.executeWithSessionSig(op, _opSig(op, sessionKey, address(account), block.chainid));
        assertEq(RECEIVER.balance, 1);
    }
}
