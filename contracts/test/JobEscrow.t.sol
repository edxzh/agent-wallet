// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/IJobEscrow.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {Reason} from "../src/Reason.sol";

/// A contract that claims to be a wallet but has no checkPayee (like a 001 wallet).
contract NoCheckWallet {
    address public agent;

    constructor(address a) {
        agent = a;
    }
}

contract JobEscrowTest is EscrowBaseTest {
    // ── US1: hire, deliver, accept ────────────────────────────────────────────────────────

    function test_HireDeliverAccept_PaysWorker() public {
        uint256 day = block.timestamp / 1 days;
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        bytes32 jobId = _hired();

        assertEq(escrow.held(), PRICE);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore - PRICE);
        assertEq(wallet.spentOn(day), PRICE, "the wallet's budget counts the job like any payment");
        IJobEscrow.Job memory j = escrow.job(jobId);
        assertEq(uint8(j.status), uint8(IJobEscrow.Status.Open));
        assertEq(j.client, address(wallet));
        assertEq(j.worker, worker);
        assertEq(j.specHash, SPEC);

        vm.prank(worker);
        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobDelivered(jobId, RESULT);
        escrow.deliver(jobId, RESULT);

        vm.prank(agent);
        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobClosed(jobId, IJobEscrow.Outcome.ACCEPTED, worker, PRICE);
        escrow.accept(jobId);

        assertEq(usdc.balanceOf(worker), PRICE);
        assertEq(escrow.held(), 0);
        j = escrow.job(jobId);
        assertEq(uint8(j.status), uint8(IJobEscrow.Status.Closed));
        assertEq(uint8(j.outcome), uint8(IJobEscrow.Outcome.ACCEPTED));
        assertEq(j.resultHash, RESULT);
    }

    function test_JobOpened_RecordsTheFundingNonce() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker);
        bytes32 jobId = escrow.jobIdFor(address(wallet), nonce);
        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobOpened(
            jobId, address(wallet), worker, arbiter, nonce, PRICE, p.deliverBy, REVIEW, DISPUTE, SPEC, 0
        );
        vm.prank(agent);
        escrow.open(p);
    }

    function test_OverCap_RefusedByTheWallet_NoJob() public {
        bytes32 nonce = _nonce();
        assertFalse(_authorize(nonce, address(escrow), CAP + 1, bytes32(0)), "the wallet's cap still applies");
        IJobEscrow.OpenParams memory p = _params(nonce, CAP + 1, worker);
        vm.prank(agent);
        vm.expectRevert(); // nothing reserved, so the wallet won't validate the signature
        escrow.open(p);
        assertEq(uint8(escrow.job(escrow.jobIdFor(address(wallet), nonce)).status), uint8(IJobEscrow.Status.None));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_EscrowNotAllowed_RefusedByTheWallet() public {
        vm.prank(operator);
        wallet.setPayee(address(escrow), false);
        (bool opened,) = _hire(PRICE, worker);
        assertFalse(opened);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    // ── Whom the wallet may pay (002 rules apply to the worker) ───────────────────────────

    function test_UnlistedWorker_RefusedAsEvent_NoMoneyMoves() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, stranger);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        bytes32 jobId = escrow.jobIdFor(address(wallet), nonce);

        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobRefused(jobId, address(wallet), stranger, nonce, Reason.PAYEE_NOT_ALLOWED);
        vm.prank(agent);
        (bool opened, bytes32 id) = escrow.open(p);

        assertFalse(opened);
        assertEq(id, jobId);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore, "no money moved");
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.job(jobId).status), uint8(IJobEscrow.Status.None));

        // The wallet's reservation expires as usual and gives the budget back.
        vm.warp(p.validBefore);
        wallet.release(nonce);
        assertEq(wallet.spentOn(block.timestamp / 1 days), 0);
    }

    function test_RuleOn_WorkerWithoutIdentity_Unverified() public {
        vm.prank(operator);
        wallet.setReputationRule(true, MIN_AVG, MIN_COUNT);
        (bool opened,) = _hire(PRICE, stranger);
        assertFalse(opened);
    }

    function test_RuleOn_WorkerWithGoodReputation_Hired() public {
        vm.prank(operator);
        wallet.setReputationRule(true, MIN_AVG, MIN_COUNT);
        _reviews(svcId, 3, 90);
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, svcPayee);
        p.workerHasClaim = true;
        p.workerAgentId = svcId;
        vm.prank(agent);
        (bool opened, bytes32 jobId) = escrow.open(p);
        assertTrue(opened);
        assertEq(escrow.job(jobId).workerAgentId, svcId);
    }

    function test_ImpostorWorker_IdentityMismatch() public {
        _reviews(svcId, 3, 90);
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker); // allowlisted, but claims svcId
        p.workerHasClaim = true;
        p.workerAgentId = svcId;
        vm.expectEmit(address(escrow));
        emit IJobEscrow.JobRefused(
            escrow.jobIdFor(address(wallet), nonce), address(wallet), worker, nonce, Reason.PAYEE_IDENTITY_MISMATCH
        );
        vm.prank(agent);
        (bool opened,) = escrow.open(p);
        assertFalse(opened);
    }

    function test_WalletWithoutCheckPayee_IsARefusal() public {
        NoCheckWallet fake = new NoCheckWallet(agent);
        IJobEscrow.OpenParams memory p = _params(_nonce(), PRICE, worker);
        p.client = address(fake);
        vm.prank(agent);
        (bool opened,) = escrow.open(p);
        assertFalse(opened);
    }

    // ── US2: dispute, settled by the arbiter ──────────────────────────────────────────────

    function test_Reject_ThenArbiterPaysWorker() public {
        bytes32 jobId = _disputed();
        assertEq(uint8(escrow.job(jobId).status), uint8(IJobEscrow.Status.Disputed));
        vm.prank(arbiter);
        escrow.resolve(jobId, true);
        assertEq(usdc.balanceOf(worker), PRICE);
        assertEq(uint8(escrow.job(jobId).outcome), uint8(IJobEscrow.Outcome.ARBITER_PAID));
    }

    function test_Reject_ThenArbiterRefundsHirer() public {
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        bytes32 jobId = _disputed();
        vm.prank(arbiter);
        escrow.resolve(jobId, false);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore);
        assertEq(uint8(escrow.job(jobId).outcome), uint8(IJobEscrow.Outcome.ARBITER_REFUNDED));
    }

    function test_Disputed_NeitherSideCanMoveTheMoney() public {
        bytes32 jobId = _disputed();
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongStatus.selector, jobId, IJobEscrow.Status.Disputed));
        escrow.accept(jobId);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongStatus.selector, jobId, IJobEscrow.Status.Disputed));
        escrow.deliver(jobId, RESULT);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotDue.selector, jobId));
        escrow.claimTimeout(jobId);
    }

    // ── US3: nobody is stuck (each window has exactly one boundary) ───────────────────────

    function test_DeliveryTimeout_Boundary() public {
        bytes32 jobId = _hired();
        uint64 deliverBy = escrow.job(jobId).deliverBy;
        vm.warp(deliverBy);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotDue.selector, jobId));
        escrow.claimTimeout(jobId);
        uint256 snap = vm.snapshotState();
        vm.prank(worker);
        escrow.deliver(jobId, RESULT); // still on time at deliverBy
        vm.revertToState(snap);

        vm.warp(uint256(deliverBy) + 1);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.TooLate.selector, jobId));
        escrow.deliver(jobId, RESULT);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        vm.prank(stranger);
        escrow.claimTimeout(jobId);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore + PRICE);
        assertEq(uint8(escrow.job(jobId).outcome), uint8(IJobEscrow.Outcome.DELIVERY_TIMEOUT));
    }

    function test_ReviewTimeout_Boundary() public {
        bytes32 jobId = _delivered();
        uint256 end = uint256(escrow.job(jobId).deliveredAt) + REVIEW;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotDue.selector, jobId));
        escrow.claimTimeout(jobId);
        uint256 snap = vm.snapshotState();
        vm.prank(agent);
        escrow.reject(jobId, bytes32(0)); // still in the window
        vm.revertToState(snap);

        vm.warp(end);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.TooLate.selector, jobId));
        escrow.reject(jobId, bytes32(0));
        vm.prank(stranger);
        escrow.claimTimeout(jobId);
        assertEq(usdc.balanceOf(worker), PRICE);
        assertEq(uint8(escrow.job(jobId).outcome), uint8(IJobEscrow.Outcome.REVIEW_TIMEOUT));
    }

    function test_AcceptAfterReviewWindow_StillPaysWorker() public {
        bytes32 jobId = _delivered();
        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(agent);
        escrow.accept(jobId);
        assertEq(usdc.balanceOf(worker), PRICE);
    }

    function test_ArbiterTimeout_Boundary_RefundsHirer() public {
        bytes32 jobId = _disputed();
        uint256 end = uint256(escrow.job(jobId).disputedAt) + DISPUTE;
        vm.warp(end - 1);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotDue.selector, jobId));
        escrow.claimTimeout(jobId);

        vm.warp(end);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.TooLate.selector, jobId));
        escrow.resolve(jobId, true);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        escrow.claimTimeout(jobId);
        assertEq(usdc.balanceOf(address(wallet)), walletBefore + PRICE);
        assertEq(uint8(escrow.job(jobId).outcome), uint8(IJobEscrow.Outcome.ARBITER_TIMEOUT));
    }

    function test_ClosedJob_CannotCloseAgain() public {
        bytes32 jobId = _delivered();
        vm.prank(agent);
        escrow.accept(jobId);
        vm.warp(block.timestamp + 60 days);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotDue.selector, jobId));
        escrow.claimTimeout(jobId);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongStatus.selector, jobId, IJobEscrow.Status.Closed));
        escrow.accept(jobId);
    }

    // ── Permissions (constitution III: every restricted function, agent and strangers) ────

    function test_Open_OnlyTheHiringWalletsAgent() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker);
        for (uint256 i; i < 3; i++) {
            address who = [stranger, operator, worker][i];
            vm.prank(who);
            vm.expectRevert(JobEscrow.NotClientAgent.selector);
            escrow.open(p);
        }
    }

    function test_AcceptReject_OnlyTheHiringWalletsAgent() public {
        bytes32 jobId = _delivered();
        for (uint256 i; i < 3; i++) {
            address who = [stranger, operator, worker][i];
            vm.startPrank(who);
            vm.expectRevert(JobEscrow.NotClientAgent.selector);
            escrow.accept(jobId);
            vm.expectRevert(JobEscrow.NotClientAgent.selector);
            escrow.reject(jobId, bytes32(0));
            vm.stopPrank();
        }
    }

    function test_Deliver_OnlyTheWorker() public {
        bytes32 jobId = _hired();
        for (uint256 i; i < 3; i++) {
            address who = [stranger, operator, agent][i];
            vm.prank(who);
            vm.expectRevert(JobEscrow.NotWorker.selector);
            escrow.deliver(jobId, RESULT);
        }
    }

    function test_Resolve_OnlyTheArbiter() public {
        bytes32 jobId = _disputed();
        for (uint256 i; i < 3; i++) {
            address who = [stranger, agent, worker][i];
            vm.prank(who);
            vm.expectRevert(JobEscrow.NotArbiter.selector);
            escrow.resolve(jobId, true);
        }
    }

    function test_RecoverSurplus_OnlyTheOwner() public {
        for (uint256 i; i < 3; i++) {
            address who = [stranger, agent, worker][i];
            vm.prank(who);
            vm.expectRevert(JobEscrow.NotOwner.selector);
            escrow.recoverSurplus(who);
        }
    }

    function test_AgentRotation_NewAgentTakesOver() public {
        bytes32 jobId = _delivered();
        address next = makeAddr("next-agent");
        vm.prank(operator);
        wallet.setAgent(next);
        vm.prank(agent);
        vm.expectRevert(JobEscrow.NotClientAgent.selector);
        escrow.accept(jobId);
        vm.prank(next);
        escrow.accept(jobId);
        assertEq(usdc.balanceOf(worker), PRICE);
    }

    function test_WorkerWallet_ItsAgentDelivers_WalletIsPaid() public {
        address workerAgent = makeAddr("worker-agent");
        vm.prank(operator);
        PolicyWallet workerWallet = PolicyWallet(factory.createWallet(workerAgent, "worker-bot-01", CAP, DAILY));
        vm.prank(operator);
        wallet.setPayee(address(workerWallet), true);
        (bool opened, bytes32 jobId) = _hire(PRICE, address(workerWallet));
        assertTrue(opened);
        vm.prank(workerAgent);
        escrow.deliver(jobId, RESULT);
        vm.prank(agent);
        escrow.accept(jobId);
        assertEq(usdc.balanceOf(address(workerWallet)), PRICE);
    }

    // ── Front-running and surplus ─────────────────────────────────────────────────────────

    function test_FrontRunTransfer_OpenReverts_SurplusRecoverable_HeldUntouched() public {
        bytes32 heldJob = _hired();
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker);
        // Someone saw the signature and submitted the transfer themselves.
        vm.prank(stranger);
        usdc.transferWithAuthorization(address(wallet), address(escrow), PRICE, 0, p.validBefore, nonce, p.signature);
        vm.prank(agent);
        vm.expectRevert("authorization used");
        escrow.open(p);

        assertEq(usdc.balanceOf(address(escrow)), 2 * PRICE);
        assertEq(escrow.held(), PRICE);
        uint256 walletBefore = usdc.balanceOf(address(wallet));
        vm.prank(address(this)); // the deployer is the owner
        escrow.recoverSurplus(address(wallet));
        assertEq(usdc.balanceOf(address(wallet)), walletBefore + PRICE);
        assertEq(usdc.balanceOf(address(escrow)), PRICE, "held money never leaves through recoverSurplus");

        vm.prank(worker);
        escrow.deliver(heldJob, RESULT);
        vm.prank(agent);
        escrow.accept(heldJob);
        assertEq(usdc.balanceOf(worker), PRICE);
    }

    function test_SignatureForAnotherAmount_Reverts() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker);
        p.amount = PRICE + 1; // the wallet only validates the digest it reserved
        vm.prank(agent);
        vm.expectRevert("invalid signature");
        escrow.open(p);
    }

    // ── Terms ─────────────────────────────────────────────────────────────────────────────

    function test_InvalidTerms_Revert() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory base = _params(nonce, PRICE, worker);
        IJobEscrow.OpenParams[7] memory bad;
        for (uint256 i; i < 7; i++) {
            bad[i] = base;
        }
        bad[0].amount = 0;
        bad[1].worker = address(wallet);
        bad[2].deliverBy = uint64(block.timestamp);
        bad[3].deliverBy = uint64(block.timestamp + 30 days + 1);
        bad[4].reviewWindow = 1 hours - 1;
        bad[5].disputeWindow = 30 days + 1;
        bad[6].reviewWindow = 30 days + 1;
        for (uint256 i; i < 7; i++) {
            vm.prank(agent);
            vm.expectRevert(JobEscrow.InvalidTerms.selector);
            escrow.open(bad[i]);
        }
        base.worker = address(0);
        vm.prank(agent);
        vm.expectRevert(JobEscrow.ZeroAddress.selector);
        escrow.open(base);
    }

    function test_SameFundingTwice_JobExists() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, address(escrow), PRICE, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, PRICE, worker);
        vm.prank(agent);
        (, bytes32 jobId) = escrow.open(p);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.JobExists.selector, jobId));
        escrow.open(p);
    }

    function test_EmptyResult_Reverts() public {
        bytes32 jobId = _hired();
        vm.prank(worker);
        vm.expectRevert(JobEscrow.EmptyHash.selector);
        escrow.deliver(jobId, bytes32(0));
    }

    /// Shared fixture with packages/agent/test/escrow.test.ts (jobIdFor in TypeScript).
    function test_JobIdFixture() public view {
        assertEq(
            escrow.jobIdFor(address(0xaa), 0x1111111111111111111111111111111111111111111111111111111111111111),
            0xef5cb546cac640baee42539553d7824bef1d6007efbe5b23cda0b12012e22441
        );
    }

    function test_WrongChain_Reverts() public {
        vm.chainId(1);
        vm.expectRevert(JobEscrow.WrongChain.selector);
        new JobEscrow(address(usdc));
    }
}
