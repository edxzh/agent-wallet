// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {IPolicyWallet, IPolicyWalletFactory} from "../src/IPolicyWallet.sol";
import {Reason} from "../src/Reason.sol";

contract PolicyWalletTest is BaseTest {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    // ── T015: creation ────────────────────────────────────────────────────────────────────
    function test_createWallet_setsOperatorAgentAndPolicy() public view {
        assertEq(wallet.operator(), operator);
        assertEq(wallet.agent(), agent);
        assertEq(wallet.token(), address(usdc));
        assertEq(wallet.name(), "research-bot-01");
        assertEq(wallet.perPaymentCap(), CAP);
        assertEq(wallet.dailyBudget(), DAILY);
        assertFalse(wallet.paused());
    }

    function test_createWallet_emitsWalletCreated() public {
        vm.expectEmit(false, true, true, true);
        emit IPolicyWalletFactory.WalletCreated(address(0), stranger, agent, "w2");
        vm.prank(stranger);
        factory.createWallet(agent, "w2", CAP, DAILY);
    }

    function test_clone_cannotBeReinitialized() public {
        vm.expectRevert();
        wallet.initialize(stranger, stranger, "x", 1, 1);
    }

    function test_reasonValuesAreStable() public pure {
        assertEq(uint8(Reason.PAUSED), 1);
        assertEq(uint8(Reason.INSUFFICIENT_FUNDS), 7);
    }

    // ── T015: authorize success path ──────────────────────────────────────────────────────
    function test_authorize_success_reservesBudgetAndDigest() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        bytes32 digest = _digest(payee, 10_000, 0, validBefore, nonce);

        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.PaymentAuthorized(nonce, payee, TASK, 10_000, validBefore, digest);
        vm.prank(agent);
        assertTrue(wallet.authorize(nonce, payee, 10_000, 0, validBefore, TASK));

        assertEq(wallet.spentOn(block.timestamp / 1 days), 10_000);
        (, uint256 spent) = wallet.task(TASK);
        assertEq(spent, 10_000);
        assertTrue(wallet.reservedDigest(digest));
    }

    function test_authorize_noTask_skipsTaskBudget() public {
        assertTrue(_authorize(_nonce(), payee, CAP, bytes32(0)));
        (, uint256 spent) = wallet.task(TASK);
        assertEq(spent, 0);
    }

    // ── T015: ERC-1271 ────────────────────────────────────────────────────────────────────
    function test_isValidSignature_onlyReservedDigestSignedByAgent() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        bytes32 digest = _digest(payee, 10_000, 0, validBefore, nonce);

        assertEq(wallet.isValidSignature(digest, _sign(agentKey, digest)), INVALID, "unreserved");
        vm.prank(agent);
        wallet.authorize(nonce, payee, 10_000, 0, validBefore, TASK);

        assertEq(wallet.isValidSignature(digest, _sign(agentKey, digest)), MAGIC, "reserved + agent");
        (, uint256 otherKey) = makeAddrAndKey("other");
        assertEq(wallet.isValidSignature(digest, _sign(otherKey, digest)), INVALID, "non-agent signer");
        assertEq(wallet.isValidSignature(digest, hex"1234"), INVALID, "garbage");
    }

    function test_settlement_viaUsdcTransferWithAuthorization() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        wallet.authorize(nonce, payee, 10_000, 0, validBefore, TASK);
        bytes memory sig = _sign(agentKey, _digest(payee, 10_000, 0, validBefore, nonce));

        usdc.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, sig);
        assertEq(usdc.balanceOf(payee), 10_000);

        vm.expectRevert(bytes("authorization used")); // replay of the same signed payload (quickstart 5)
        usdc.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, sig);
    }

    function test_settlement_rejectsUnauthorizedTransfer() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        bytes memory sig = _sign(agentKey, _digest(payee, 10_000, 0, validBefore, nonce));
        vm.expectRevert(bytes("invalid signature"));
        usdc.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, sig);
    }

    // ── T027: access control and replay ───────────────────────────────────────────────────
    function test_operatorOnly_revertsForAgentAndStranger() public {
        address[2] memory callers = [agent, stranger];
        for (uint256 i; i < callers.length; i++) {
            vm.startPrank(callers[i]);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setPolicy(100 * USDC1, 100 * USDC1);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setPayee(callers[i], true);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setTask(TASK, 100 * USDC1);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.setAgent(callers[i]);
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.pause();
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.unpause();
            vm.expectRevert(PolicyWallet.NotOperator.selector);
            wallet.withdraw(callers[i], 1);
            vm.stopPrank();
        }
    }

    function test_authorize_revertsForNonAgent() public {
        bytes32 nonce = _nonce();
        vm.prank(operator);
        vm.expectRevert(PolicyWallet.NotAgent.selector);
        wallet.authorize(nonce, payee, 1, 0, block.timestamp + 300, TASK);
    }

    function test_authorize_revertsOnReusedNonce_evenAfterRefusal() public {
        bytes32 nonce = _nonce();
        assertTrue(_authorize(nonce, payee, 10_000, TASK));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NonceAlreadyUsed.selector, nonce));
        wallet.authorize(nonce, payee, 10_000, 0, block.timestamp + 300, TASK);

        bytes32 refused = _nonce();
        assertFalse(_authorize(refused, stranger, 10_000, TASK));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NonceAlreadyUsed.selector, refused));
        wallet.authorize(refused, payee, 10_000, 0, block.timestamp + 300, TASK);
    }

    // ── Operator setters emit RuleChanged (T029) ──────────────────────────────────────────
    function test_setters_emitRuleChanged() public {
        vm.startPrank(operator);
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.RuleChanged("perPaymentCap", bytes32(0), CAP, 2 * USDC1);
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.RuleChanged("dailyBudget", bytes32(0), DAILY, 9 * USDC1);
        wallet.setPolicy(2 * USDC1, 9 * USDC1);

        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.RuleChanged("payee", bytes32(uint256(uint160(stranger))), 0, 1);
        wallet.setPayee(stranger, true);

        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.RuleChanged("taskBudget", TASK, TASK_BUDGET, 3 * USDC1);
        wallet.setTask(TASK, 3 * USDC1);

        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.RuleChanged("agent", bytes32(0), uint256(uint160(agent)), uint256(uint160(stranger)));
        wallet.setAgent(stranger);
        vm.stopPrank();
    }

    function test_setPolicy_rejectsZero() public {
        vm.startPrank(operator);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setPolicy(0, DAILY);
        vm.expectRevert(PolicyWallet.InvalidPolicy.selector);
        wallet.setPolicy(CAP, 0);
        vm.stopPrank();
    }

    function test_rotatedAgent_oldKeyLosesAccess() public {
        vm.prank(operator);
        wallet.setAgent(stranger);
        vm.prank(agent);
        vm.expectRevert(PolicyWallet.NotAgent.selector);
        wallet.authorize(_nonce(), payee, 1, 0, block.timestamp + 300, TASK);
    }

    function test_withdraw_byOperator() public {
        vm.prank(operator);
        wallet.withdraw(operator, 5 * USDC1);
        assertEq(usdc.balanceOf(operator), 5 * USDC1);
    }

    // ── T041: pause / unpause ─────────────────────────────────────────────────────────────
    function test_pause_refusesEveryAttempt_thenUnpauseRestores() public {
        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.Paused();
        wallet.pause();

        bytes32 nonce = _nonce();
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.PaymentRefused(nonce, payee, TASK, 10_000, Reason.PAUSED);
        assertFalse(_authorize(nonce, payee, 10_000, TASK));

        vm.prank(operator);
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.Unpaused();
        wallet.unpause();
        assertTrue(_authorize(_nonce(), payee, 10_000, TASK));
    }

    function test_loweredCap_appliesToNextAttempt() public {
        assertTrue(_authorize(_nonce(), payee, 10_000, TASK));
        vm.prank(operator);
        wallet.setPolicy(5_000, DAILY);
        bytes32 nonce = _nonce();
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.PaymentRefused(nonce, payee, TASK, 10_000, Reason.OVER_PER_PAYMENT_CAP);
        assertFalse(_authorize(nonce, payee, 10_000, TASK));
    }

    // ── T030: release ─────────────────────────────────────────────────────────────────────
    function test_release_returnsBudgetAfterExpiry() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        bytes32 digest = _digest(payee, 500_000, 0, validBefore, nonce);
        vm.prank(agent);
        wallet.authorize(nonce, payee, 500_000, 0, validBefore, TASK);
        uint256 day = block.timestamp / 1 days;

        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NotExpired.selector, nonce));
        wallet.release(nonce);

        vm.warp(validBefore);
        vm.expectEmit(true, true, true, true);
        emit IPolicyWallet.PaymentExpired(nonce, 500_000);
        vm.prank(stranger); // anyone may release
        wallet.release(nonce);

        assertEq(wallet.spentOn(day), 0);
        (, uint256 spent) = wallet.task(TASK);
        assertEq(spent, 0);
        assertFalse(wallet.reservedDigest(digest), "digest no longer signable");

        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NothingToRelease.selector, nonce));
        wallet.release(nonce);
    }

    function test_release_revertsIfSettled() public {
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        wallet.authorize(nonce, payee, 10_000, 0, validBefore, TASK);
        bytes memory sig = _sign(agentKey, _digest(payee, 10_000, 0, validBefore, nonce));
        usdc.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, sig);
        vm.warp(validBefore);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.AlreadySettled.selector, nonce));
        wallet.release(nonce);
    }
}
