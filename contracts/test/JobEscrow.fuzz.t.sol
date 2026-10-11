// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {IJobEscrow} from "../src/IJobEscrow.sol";

/// Fuzz (constitution III): every way a job can end pays its full price to exactly one side, and
/// at no moment are both an action and the matching timeout possible.
contract JobEscrowFuzzTest is EscrowBaseTest {
    function testFuzz_EveryPathClosesOnce_FullPriceToOneSide(uint256 amount, uint8 path, uint256 late) public {
        amount = bound(amount, 1, CAP);
        late = bound(late, 0, 40 days);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        (bool opened, bytes32 jobId) = _hire(amount, worker);
        assertTrue(opened);
        IJobEscrow.Job memory j = escrow.job(jobId);
        path = path % 6;

        if (path == 4) {
            vm.warp(uint256(j.deliverBy) + 1 + late); // worker never delivers
            escrow.claimTimeout(jobId);
        } else {
            vm.prank(worker);
            escrow.deliver(jobId, RESULT);
            if (path == 0) {
                vm.prank(agent);
                escrow.accept(jobId);
            } else if (path == 1) {
                vm.warp(block.timestamp + REVIEW + late); // hirer never answers
                escrow.claimTimeout(jobId);
            } else {
                vm.prank(agent);
                escrow.reject(jobId, bytes32(0));
                if (path == 5) {
                    vm.warp(block.timestamp + DISPUTE + late); // arbiter never rules
                    escrow.claimTimeout(jobId);
                } else {
                    vm.prank(arbiter);
                    escrow.resolve(jobId, path == 2);
                }
            }
        }

        bool workerSide = path <= 2;
        assertEq(usdc.balanceOf(worker), workerSide ? amount : 0);
        assertEq(usdc.balanceOf(address(wallet)), workerSide ? walletBefore - amount : walletBefore);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(escrow.held(), 0);
        assertEq(uint8(escrow.job(jobId).status), uint8(IJobEscrow.Status.Closed));
        vm.expectRevert();
        escrow.claimTimeout(jobId);
    }

    /// Open: deliver xor delivery-timeout, at any time.
    function testFuzz_Open_DeliverXorTimeout(uint256 dt) public {
        bytes32 jobId = _hired();
        vm.warp(block.timestamp + bound(dt, 0, 2 * DELIVER_IN));
        uint256 snap = vm.snapshotState();
        vm.prank(worker);
        (bool canDeliver,) = address(escrow).call(abi.encodeCall(escrow.deliver, (jobId, RESULT)));
        vm.revertToState(snap);
        (bool canTimeout,) = address(escrow).call(abi.encodeCall(escrow.claimTimeout, (jobId)));
        assertTrue(canDeliver != canTimeout);
    }

    /// Delivered: reject xor review-timeout, at any time.
    function testFuzz_Delivered_RejectXorTimeout(uint256 dt) public {
        bytes32 jobId = _delivered();
        vm.warp(block.timestamp + bound(dt, 0, 2 * uint256(REVIEW)));
        uint256 snap = vm.snapshotState();
        vm.prank(agent);
        (bool canReject,) = address(escrow).call(abi.encodeCall(escrow.reject, (jobId, bytes32(0))));
        vm.revertToState(snap);
        (bool canTimeout,) = address(escrow).call(abi.encodeCall(escrow.claimTimeout, (jobId)));
        assertTrue(canReject != canTimeout);
    }

    /// Disputed: resolve xor arbiter-timeout, at any time.
    function testFuzz_Disputed_ResolveXorTimeout(uint256 dt, bool payWorker) public {
        bytes32 jobId = _disputed();
        vm.warp(block.timestamp + bound(dt, 0, 2 * uint256(DISPUTE)));
        uint256 snap = vm.snapshotState();
        vm.prank(arbiter);
        (bool canResolve,) = address(escrow).call(abi.encodeCall(escrow.resolve, (jobId, payWorker)));
        vm.revertToState(snap);
        (bool canTimeout,) = address(escrow).call(abi.encodeCall(escrow.claimTimeout, (jobId)));
        assertTrue(canResolve != canTimeout);
    }

    /// Any worker the hirer's wallet doesn't allow is refused, and no money moves.
    function testFuzz_UnallowedWorker_NeverFunded(address w, uint256 amount) public {
        vm.assume(w != address(0) && w != worker && w != address(wallet) && w != payee && w != address(escrow));
        amount = bound(amount, 1, CAP);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        (bool opened,) = _hire(amount, w);
        assertFalse(opened);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
