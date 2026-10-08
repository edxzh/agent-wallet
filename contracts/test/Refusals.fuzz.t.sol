// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {IPolicyWallet} from "../src/IPolicyWallet.sol";
import {Reason} from "../src/Reason.sol";

/// SC-001: for every reason, a refused attempt returns false, emits exactly that reason, does not
/// revert, and moves nothing (USDC balance, today's spend and the task's spend unchanged).
contract RefusalsFuzzTest is BaseTest {
    function _expectRefused(bytes32 nonce, address to, uint256 amount, uint256 validBefore, bytes32 taskId, Reason reason)
        internal
    {
        uint256 balance = usdc.balanceOf(address(wallet));
        uint256 day = block.timestamp / 1 days;
        uint256 spentToday = wallet.spentOn(day);
        (, uint256 taskSpent) = wallet.task(taskId);

        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.PaymentRefused(nonce, to, taskId, amount, reason);
        vm.prank(agent);
        assertFalse(wallet.authorize(nonce, to, amount, 0, validBefore, taskId));

        assertEq(usdc.balanceOf(address(wallet)), balance, "balance moved");
        assertEq(wallet.spentOn(day), spentToday, "daily spend changed");
        (, uint256 taskSpentAfter) = wallet.task(taskId);
        assertEq(taskSpentAfter, taskSpent, "task spend changed");
    }

    function _warp(uint256 t) internal {
        vm.warp(bound(t, 1_700_000_000, 2_000_000_000));
    }

    function testFuzz_PAUSED(uint256 amount, uint256 t) public {
        _warp(t);
        amount = bound(amount, 1, CAP);
        vm.prank(operator);
        wallet.pause();
        _expectRefused(_nonce(), payee, amount, block.timestamp + 300, TASK, Reason.PAUSED);
    }

    function testFuzz_INVALID_AMOUNT_zero(uint256 t) public {
        _warp(t);
        _expectRefused(_nonce(), payee, 0, block.timestamp + 300, TASK, Reason.INVALID_AMOUNT);
    }

    function testFuzz_INVALID_AMOUNT_expired(uint256 amount, uint256 ago, uint256 t) public {
        _warp(t);
        amount = bound(amount, 1, CAP);
        uint256 validBefore = block.timestamp - bound(ago, 0, 1_000_000);
        _expectRefused(_nonce(), payee, amount, validBefore, TASK, Reason.INVALID_AMOUNT);
    }

    function testFuzz_PAYEE_NOT_ALLOWED(address to, uint256 amount, uint256 t) public {
        _warp(t);
        vm.assume(to != payee);
        amount = bound(amount, 1, CAP);
        _expectRefused(_nonce(), to, amount, block.timestamp + 300, TASK, Reason.PAYEE_NOT_ALLOWED);
    }

    function testFuzz_OVER_PER_PAYMENT_CAP(uint256 amount, uint256 t) public {
        _warp(t);
        amount = bound(amount, CAP + 1, type(uint128).max);
        _expectRefused(_nonce(), payee, amount, block.timestamp + 300, TASK, Reason.OVER_PER_PAYMENT_CAP);
    }

    function testFuzz_OVER_TASK_BUDGET(uint256 first, uint256 second, uint256 t) public {
        _warp(t);
        // Spend `first` + one full cap, leaving less than a cap in the task's budget.
        first = bound(first, 1, CAP);
        assertTrue(_authorize(_nonce(), payee, first, TASK));
        assertTrue(_authorize(_nonce(), payee, CAP, TASK));
        uint256 remaining = TASK_BUDGET - first - CAP;
        second = bound(second, remaining + 1, CAP); // over what remains, within the cap
        _expectRefused(_nonce(), payee, second, block.timestamp + 300, TASK, Reason.OVER_TASK_BUDGET);
    }

    function testFuzz_OVER_TASK_BUDGET_unknownTask(bytes32 taskId, uint256 amount, uint256 t) public {
        _warp(t);
        vm.assume(taskId != TASK && taskId != bytes32(0));
        amount = bound(amount, 1, CAP);
        _expectRefused(_nonce(), payee, amount, block.timestamp + 300, taskId, Reason.OVER_TASK_BUDGET);
    }

    function testFuzz_OVER_DAILY_BUDGET(uint256 amount, uint256 t) public {
        _warp(t);
        // Spend 5 x 1 USDC without a task, filling the daily budget exactly.
        for (uint256 i; i < 5; i++) assertTrue(_authorize(_nonce(), payee, CAP, bytes32(0)));
        amount = bound(amount, 1, CAP);
        _expectRefused(_nonce(), payee, amount, block.timestamp + 300, bytes32(0), Reason.OVER_DAILY_BUDGET);
    }

    function testFuzz_INSUFFICIENT_FUNDS(uint256 balance, uint256 amount, uint256 t) public {
        _warp(t);
        balance = bound(balance, 0, CAP - 1);
        uint256 excess = usdc.balanceOf(address(wallet)) - balance;
        vm.prank(operator);
        wallet.withdraw(operator, excess);
        amount = bound(amount, balance + 1, CAP);
        _expectRefused(_nonce(), payee, amount, block.timestamp + 300, TASK, Reason.INSUFFICIENT_FUNDS);
    }

    /// Several rules fail at once: the first in data-model order is the one reported.
    function test_precedence_firstFailingRuleWins() public {
        uint256 all = usdc.balanceOf(address(wallet));
        vm.prank(operator);
        wallet.withdraw(operator, all);
        bytes32 unknownTask = keccak256("unknown");

        // Unlisted payee + over cap + unknown task + no funds → PAYEE_NOT_ALLOWED (3)
        _expectRefused(_nonce(), stranger, 2 * CAP, block.timestamp + 300, unknownTask, Reason.PAYEE_NOT_ALLOWED);
        // Allowed payee, over cap + unknown task + no funds → OVER_PER_PAYMENT_CAP (4)
        _expectRefused(_nonce(), payee, 2 * CAP, block.timestamp + 300, unknownTask, Reason.OVER_PER_PAYMENT_CAP);
        // Under cap, unknown task + no funds → OVER_TASK_BUDGET (5)
        _expectRefused(_nonce(), payee, CAP, block.timestamp + 300, unknownTask, Reason.OVER_TASK_BUDGET);
        // No task, no funds → INSUFFICIENT_FUNDS (7)
        _expectRefused(_nonce(), payee, CAP, block.timestamp + 300, bytes32(0), Reason.INSUFFICIENT_FUNDS);
        // Paused beats everything, even an invalid amount → PAUSED (1)
        vm.prank(operator);
        wallet.pause();
        _expectRefused(_nonce(), stranger, 0, block.timestamp - 1, unknownTask, Reason.PAUSED);
    }
}
