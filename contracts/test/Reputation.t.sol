// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {RepBaseTest} from "./RepBase.t.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {IPolicyWallet} from "../src/IPolicyWallet.sol";
import {IPolicyWalletReputation} from "../src/IPolicyWalletReputation.sol";
import {Reason} from "../src/Reason.sol";

/// T012: the reputation rule (US1) against MockErc8004.
contract ReputationTest is RepBaseTest {
    uint256 internal constant AMT = 10_000;

    // ── Setters ───────────────────────────────────────────────────────────────────────────

    function test_setters_revertForAgentAndStranger() public {
        address[2] memory callers = [agent, stranger];
        for (uint256 i; i < 2; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setReputationRule(true, 50, 1);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setTrustedReviewer(untrusted, true);
            vm.stopPrank();
        }
    }

    function test_setReputationRule_validation() public {
        vm.startPrank(operator);
        vm.expectRevert(PolicyWallet.InvalidReputationRule.selector);
        wallet.setReputationRule(true, 101, 1);
        vm.expectRevert(PolicyWallet.InvalidReputationRule.selector);
        wallet.setReputationRule(true, 70, 0);
        wallet.setReputationRule(false, 70, 0); // disabling with count 0 is fine
        vm.stopPrank();

        // Enabling with no reviewers reverts.
        PolicyWallet fresh = PolicyWallet(factory.createWallet(agent, "fresh", CAP, DAILY));
        vm.expectRevert(PolicyWallet.InvalidReputationRule.selector);
        fresh.setReputationRule(true, 70, 3); // this test contract is fresh's operator
    }

    function test_setTrustedReviewer_validation() public {
        vm.startPrank(operator);
        vm.expectRevert(PolicyWallet.ZeroAddress.selector);
        wallet.setTrustedReviewer(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.InvalidReviewer.selector, r1));
        wallet.setTrustedReviewer(r1, true); // duplicate
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.InvalidReviewer.selector, untrusted));
        wallet.setTrustedReviewer(untrusted, false); // not a reviewer
        wallet.setTrustedReviewer(makeAddr("r4"), true);
        wallet.setTrustedReviewer(makeAddr("r5"), true);
        vm.expectRevert(PolicyWallet.TooManyReviewers.selector); // a 6th
        wallet.setTrustedReviewer(makeAddr("r6"), true);

        // Removing the last reviewer while enabled reverts; disable first and it works.
        wallet.setTrustedReviewer(makeAddr("r4"), false);
        wallet.setTrustedReviewer(makeAddr("r5"), false);
        wallet.setTrustedReviewer(r1, false);
        wallet.setTrustedReviewer(r2, false);
        vm.expectRevert(PolicyWallet.LastReviewer.selector);
        wallet.setTrustedReviewer(r3, false);
        wallet.setReputationRule(false, MIN_AVG, MIN_COUNT);
        wallet.setTrustedReviewer(r3, false);
        vm.stopPrank();
        assertEq(wallet.trustedReviewers().length, 0);
    }

    function test_setters_emitRuleChanged() public {
        vm.startPrank(operator);
        vm.expectEmit(address(wallet));
        emit IPolicyWallet.RuleChanged("repEnabled", bytes32(0), 1, 1);
        vm.expectEmit(address(wallet));
        emit IPolicyWallet.RuleChanged("repMinAverage", bytes32(0), 70, 80);
        vm.expectEmit(address(wallet));
        emit IPolicyWallet.RuleChanged("repMinCount", bytes32(0), 3, 4);
        wallet.setReputationRule(true, 80, 4);

        vm.expectEmit(address(wallet));
        emit IPolicyWallet.RuleChanged("trustedReviewer", bytes32(uint256(uint160(untrusted))), 0, 1);
        wallet.setTrustedReviewer(untrusted, true);
        vm.stopPrank();
        (bool enabled, uint8 minAvg, uint64 minCount) = wallet.reputationRule();
        assertTrue(enabled);
        assertEq(minAvg, 80);
        assertEq(minCount, 4);
    }

    // ── Check order (data-model.md), one test per row ─────────────────────────────────────

    function _expect(bool hasClaim, address to, uint256 id, Reason want) internal {
        bytes32 nonce = _nonce();
        assertEq(uint8(wallet.checkPayee(to, hasClaim, id)), uint8(want), "checkPayee");
        if (want != Reason.NONE) {
            vm.expectEmit(address(wallet));
            emit IPolicyWallet.PaymentRefused(nonce, to, bytes32(0), AMT, want);
        }
        bool ok = hasClaim ? _authId(nonce, to, AMT, id) : _authorize(nonce, to, AMT, bytes32(0));
        assertEq(ok, want == Reason.NONE, "authorize result");
    }

    function test_order_allowlistedWithLowReputationPasses() public {
        vm.prank(operator);
        wallet.setPayee(svcPayee, true);
        _reviews(svcId, 3, 10);
        _expect(true, svcPayee, svcId, Reason.NONE);
    }

    function test_order_allowlistedWithMismatchIsRefused() public {
        // `payee` is allowlisted (BaseTest) but svcId's wallet is svcPayee.
        _expect(true, payee, svcId, Reason.PAYEE_IDENTITY_MISMATCH);
    }

    function test_order_allowlistedPassesWhenIdentityRegistryFails() public {
        registry.setIdentityFailure(MockErc8004.Mode.REVERT);
        bytes32 nonce = _nonce();
        assertTrue(_authId(nonce, payee, AMT, svcId));
        (bool hasIdentity,,) = wallet.attempt(nonce);
        assertFalse(hasIdentity);
    }

    function test_order_ruleOffNotAllowlisted() public {
        vm.prank(operator);
        wallet.setReputationRule(false, MIN_AVG, MIN_COUNT);
        _reviews(svcId, 5, 90);
        _expect(false, svcPayee, 0, Reason.PAYEE_NOT_ALLOWED);
        _expect(true, svcPayee, svcId, Reason.PAYEE_NOT_ALLOWED);
    }

    function test_order_noIdentity() public {
        _expect(false, svcPayee, 0, Reason.PAYEE_IDENTITY_UNVERIFIED);
    }

    function test_order_mismatch() public {
        _reviews(svcId, 5, 90);
        _expect(true, makeAddr("impostor"), svcId, Reason.PAYEE_IDENTITY_MISMATCH); // someone else's id
        _expect(true, svcPayee, 999, Reason.PAYEE_IDENTITY_MISMATCH); // unknown id reads address(0)
        _expect(true, address(0), 999, Reason.PAYEE_IDENTITY_MISMATCH); // address(0) never matches
    }

    function test_order_summaryFailure() public {
        _reviews(svcId, 5, 90);
        registry.setSummaryFailure(MockErc8004.Mode.REVERT);
        _expect(true, svcPayee, svcId, Reason.REPUTATION_UNAVAILABLE);
    }

    function test_order_notEnoughTrustedReviews() public {
        _reviews(svcId, 2, 90);
        _expect(true, svcPayee, svcId, Reason.NOT_ENOUGH_TRUSTED_REVIEWS);
    }

    function test_order_untrustedReviewsDontCount() public {
        for (uint256 i; i < 10; i++) _review(untrusted, svcId, 100, 0);
        _expect(true, svcPayee, svcId, Reason.NOT_ENOUGH_TRUSTED_REVIEWS);
    }

    function test_order_tooLow() public {
        _reviews(svcId, 3, 40);
        _expect(true, svcPayee, svcId, Reason.PAYEE_REPUTATION_TOO_LOW);
    }

    function test_order_negativeAverageIsTooLow() public {
        _reviews(svcId, 3, -50);
        _expect(true, svcPayee, svcId, Reason.PAYEE_REPUTATION_TOO_LOW);
    }

    function test_order_passEmitsIdentityVerifiedAfterAuthorized() public {
        _reviews(svcId, 5, 85);
        bytes32 nonce = _nonce();
        vm.recordLogs();
        assertTrue(_authId(nonce, svcPayee, AMT, svcId));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2);
        assertEq(logs[0].topics[0], IPolicyWallet.PaymentAuthorized.selector);
        assertEq(logs[1].topics[0], IPolicyWalletReputation.PayeeIdentityVerified.selector);
        assertEq(logs[1].topics[1], nonce);
        assertEq(uint256(logs[1].topics[2]), svcId);
        (bool hasIdentity, uint256 id, bool rated) = wallet.attempt(nonce);
        assertTrue(hasIdentity);
        assertEq(id, svcId);
        assertFalse(rated);
    }

    function test_order_laterRulesStillApply() public {
        _reviews(svcId, 5, 85);
        bytes32 nonce = _nonce();
        vm.expectEmit(address(wallet));
        emit IPolicyWallet.PaymentRefused(nonce, svcPayee, bytes32(0), CAP + 1, Reason.OVER_PER_PAYMENT_CAP);
        assertFalse(_authId(nonce, svcPayee, CAP + 1, svcId));
    }

    function test_decimals_7000AtTwoDecimalsPasses70() public {
        for (uint256 i; i < 3; i++) _review([r1, r2, r3][i], svcId, 7000, 2);
        _expect(true, svcPayee, svcId, Reason.NONE);
    }

    function test_decimals_6999AtTwoDecimalsFails70() public {
        for (uint256 i; i < 3; i++) _review([r1, r2, r3][i], svcId, 6999, 2);
        _expect(true, svcPayee, svcId, Reason.PAYEE_REPUTATION_TOO_LOW);
    }

    // ── Registry failures: refused with 10, never a revert, never a pass ─────────────────

    function test_registryFailures_identity() public {
        _reviews(svcId, 5, 90);
        MockErc8004.Mode[4] memory modes =
            [MockErc8004.Mode.REVERT, MockErc8004.Mode.BURN_GAS, MockErc8004.Mode.GARBAGE, MockErc8004.Mode.HUGE_RETURN];
        for (uint256 i; i < modes.length; i++) {
            registry.setIdentityFailure(modes[i]);
            _expect(true, svcPayee, svcId, Reason.REPUTATION_UNAVAILABLE);
        }
    }

    function test_registryFailures_summary() public {
        _reviews(svcId, 5, 90);
        MockErc8004.Mode[4] memory modes =
            [MockErc8004.Mode.REVERT, MockErc8004.Mode.BURN_GAS, MockErc8004.Mode.GARBAGE, MockErc8004.Mode.HUGE_RETURN];
        for (uint256 i; i < modes.length; i++) {
            registry.setSummaryFailure(modes[i]);
            _expect(true, svcPayee, svcId, Reason.REPUTATION_UNAVAILABLE);
        }
    }

    function test_lowGas_reverts() public {
        _reviews(svcId, 5, 90);
        bytes32 nonce = _nonce();
        uint256 deadline = block.timestamp + 300;
        vm.prank(agent);
        vm.expectRevert(PolicyWallet.InsufficientGas.selector);
        wallet.authorizeWithIdentity{gas: 1_000_000}(nonce, svcPayee, AMT, 0, deadline, bytes32(0), svcId);
        assertFalse(wallet.nonceUsed(nonce)); // nothing recorded
    }

    /// The guard's point (research R2): with the least gas that passes it, the summary read still
    /// gets its full REGISTRY_GAS, so an agent can't force a false REPUTATION_UNAVAILABLE.
    function test_lowGas_minimumPassingGasStillFundsTheRegistry() public {
        vm.startPrank(operator);
        wallet.setTrustedReviewer(makeAddr("r4"), true);
        wallet.setTrustedReviewer(makeAddr("r5"), true); // 5 reviewers: the largest calldata copy
        vm.stopPrank();
        _reviews(svcId, 5, 90);
        registry.setSummaryFailure(MockErc8004.Mode.HEAVY);
        // Calibration: the heavy registry answers with the full budget, but not with 30k less.
        address[] memory trusted = wallet.trustedReviewers();
        bytes memory q = abi.encodeCall(registry.getSummary, (svcId, trusted, "", ""));
        uint256 budget = wallet.REGISTRY_GAS();
        (bool full,) = address(registry).staticcall{gas: budget}(q);
        (bool short_,) = address(registry).staticcall{gas: budget - 30_000}(q);
        assertTrue(full && !short_, "calibration");

        uint256 lo = 5_000_000;
        uint256 hi = 7_000_000; // known to pass the guard
        while (hi - lo > 1) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            (bool passedGuard,) = _tryAuth(mid);
            vm.revertToState(snap);
            if (passedGuard) hi = mid;
            else lo = mid;
        }
        (bool ok, bool authorized) = _tryAuth(hi);
        assertTrue(ok, "minimum gas passes the guard");
        assertTrue(authorized, "and the heavy-but-healthy registry still answers: authorized, not refused 10");
    }

    /// (passed the gas guard, returned true)
    function _tryAuth(uint256 gasLimit) internal returns (bool, bool) {
        bytes32 nonce = keccak256(abi.encode("gas", gasLimit));
        vm.prank(agent);
        (bool success, bytes memory ret) = address(wallet).call{gas: gasLimit}(
            abi.encodeCall(wallet.authorizeWithIdentity, (nonce, svcPayee, AMT, 0, block.timestamp + 300, bytes32(0), svcId))
        );
        if (!success) {
            assertEq(bytes4(ret), PolicyWallet.InsufficientGas.selector, "only the guard may revert");
            return (false, false);
        }
        return (true, abi.decode(ret, (bool)));
    }

    // ── 001 compatibility ─────────────────────────────────────────────────────────────────

    function test_001_authorizeUnchangedWhenRuleDisabled() public {
        vm.prank(operator);
        wallet.setReputationRule(false, MIN_AVG, MIN_COUNT);
        _expect(false, payee, 0, Reason.NONE);
        _expect(false, svcPayee, 0, Reason.PAYEE_NOT_ALLOWED);
    }

    function test_001_ruleOnRefusesUnlistedWithoutIdentityAs8() public {
        _expect(false, svcPayee, 0, Reason.PAYEE_IDENTITY_UNVERIFIED);
        _expect(false, payee, 0, Reason.NONE); // allowlisted still passes
    }

    function test_reasonValuesAreStable() public pure {
        assertEq(uint8(Reason.INSUFFICIENT_FUNDS), 7);
        assertEq(uint8(Reason.PAYEE_IDENTITY_UNVERIFIED), 8);
        assertEq(uint8(Reason.PAYEE_REPUTATION_TOO_LOW), 12);
    }
}
