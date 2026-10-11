// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/IJobEscrow.sol";

/// Security review F1: a payout the token refuses (blacklist) never freezes a job. The job
/// closes, the price is owed to the recipient, and anyone can withdraw it once the token allows.
contract JobEscrowDeferredTest is EscrowBaseTest {
    /// Closes `jobId` along the given outcome with the recipient blacklisted, and checks the
    /// deferral: closed, PaymentDeferred, held unchanged, surplus untouched, then withdrawable.
    function _assertDeferred(bytes32 jobId, IJobEscrow.Outcome outcome, address to, function(bytes32) internal close)
        internal
    {
        usdc.blacklist(to);
        uint256 heldBefore = escrow.held();
        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobClosed(jobId, outcome, to, PRICE);
        vm.expectEmit(address(escrow));
        emit IJobEscrow.PaymentDeferred(jobId, to, PRICE);
        close(jobId);

        IJobEscrow.Job memory j = escrow.job(jobId);
        assertEq(uint8(j.status), uint8(IJobEscrow.Status.Closed));
        assertEq(uint8(j.outcome), uint8(outcome));
        assertEq(escrow.owed(to), PRICE);
        assertEq(escrow.held(), heldBefore, "owed money is still held");

        // Not surplus: the owner can't take it.
        uint256 escrowBal = usdc.balanceOf(address(escrow));
        escrow.recoverSurplus(address(this));
        assertEq(usdc.balanceOf(address(escrow)), escrowBal);

        // Still refused: the withdrawal reverts and the credit stays.
        vm.expectRevert("Blacklistable: account is blacklisted");
        escrow.withdrawOwed(to);
        assertEq(escrow.owed(to), PRICE);

        // Allowed again: anyone can send it, once.
        usdc.unBlacklist(to);
        uint256 before = usdc.balanceOf(to);
        vm.prank(stranger);
        vm.expectEmit(address(escrow));
        emit IJobEscrow.OwedWithdrawn(to, PRICE);
        escrow.withdrawOwed(to);
        assertEq(usdc.balanceOf(to), before + PRICE);
        assertEq(escrow.owed(to), 0);
        assertEq(escrow.held(), heldBefore - PRICE);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NothingOwed.selector, to));
        escrow.withdrawOwed(to);
    }

    function _accept(bytes32 id) internal {
        vm.prank(agent);
        escrow.accept(id);
    }

    function _timeoutAfterReview(bytes32 id) internal {
        vm.warp(block.timestamp + REVIEW);
        escrow.claimTimeout(id);
    }

    function _arbiterPays(bytes32 id) internal {
        vm.prank(arbiter);
        escrow.resolve(id, true);
    }

    function _arbiterRefunds(bytes32 id) internal {
        vm.prank(arbiter);
        escrow.resolve(id, false);
    }

    function _deliveryTimeout(bytes32 id) internal {
        vm.warp(block.timestamp + DELIVER_IN + 1);
        escrow.claimTimeout(id);
    }

    function _arbiterTimeout(bytes32 id) internal {
        vm.warp(block.timestamp + DISPUTE);
        escrow.claimTimeout(id);
    }

    function test_Accepted_WorkerBlacklisted() public {
        _assertDeferred(_delivered(), IJobEscrow.Outcome.ACCEPTED, worker, _accept);
    }

    /// The case the review found: before the fix this job could never close.
    function test_ReviewTimeout_WorkerBlacklisted() public {
        _assertDeferred(_delivered(), IJobEscrow.Outcome.REVIEW_TIMEOUT, worker, _timeoutAfterReview);
    }

    function test_ArbiterPaid_WorkerBlacklisted() public {
        _assertDeferred(_disputed(), IJobEscrow.Outcome.ARBITER_PAID, worker, _arbiterPays);
    }

    function test_DeliveryTimeout_HirerBlacklisted() public {
        _assertDeferred(_hired(), IJobEscrow.Outcome.DELIVERY_TIMEOUT, address(wallet), _deliveryTimeout);
    }

    function test_ArbiterRefunded_HirerBlacklisted() public {
        _assertDeferred(_disputed(), IJobEscrow.Outcome.ARBITER_REFUNDED, address(wallet), _arbiterRefunds);
    }

    function test_ArbiterTimeout_HirerBlacklisted() public {
        _assertDeferred(_disputed(), IJobEscrow.Outcome.ARBITER_TIMEOUT, address(wallet), _arbiterTimeout);
    }

    /// A caller can't force a payout into the deferred path by sending too little gas: either it
    /// pays, or the whole call reverts and the job stays as it was. (This holds by the 63/64 rule
    /// even without DEFER_GAS_FLOOR, which is checked to pass both ways; the floor is a backstop.)
    function test_GasStarvedTimeout_NeverDefers() public {
        bytes32 jobId = _delivered();
        vm.warp(block.timestamp + REVIEW);
        for (uint256 gas = 20_000; gas <= 400_000; gas += 5_000) {
            uint256 snap = vm.snapshotState();
            (bool ok,) = address(escrow).call{gas: gas}(abi.encodeCall(escrow.claimTimeout, (jobId)));
            if (ok) {
                assertEq(escrow.owed(worker), 0, "a successful timeout must have paid, not deferred");
                assertEq(usdc.balanceOf(worker), PRICE);
            } else {
                assertEq(uint8(escrow.job(jobId).status), uint8(IJobEscrow.Status.Delivered));
            }
            vm.revertToState(snap);
        }
    }

    function test_OwedAddsUpAcrossJobs() public {
        bytes32 a = _delivered();
        bytes32 b = _delivered();
        usdc.blacklist(worker);
        vm.startPrank(agent);
        escrow.accept(a);
        escrow.accept(b);
        vm.stopPrank();
        assertEq(escrow.owed(worker), 2 * PRICE);
        usdc.unBlacklist(worker);
        escrow.withdrawOwed(worker);
        assertEq(usdc.balanceOf(worker), 2 * PRICE);
        assertEq(escrow.held(), 0);
    }

    // ── F2 ────────────────────────────────────────────────────────────────────────────────

    function test_WorkerCantBeTheArbiterOrTheEscrow() public {
        vm.startPrank(operator);
        wallet.setPayee(operator, true);
        vm.stopPrank();
        address[2] memory bad = [operator, address(escrow)];
        for (uint256 i; i < 2; i++) {
            bytes32 nonce = _nonce();
            assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
            IJobEscrow.OpenParams memory p = _params(nonce, PRICE, bad[i]);
            vm.prank(agent);
            vm.expectRevert(JobEscrow.InvalidTerms.selector);
            escrow.open(p);
        }
    }
}
