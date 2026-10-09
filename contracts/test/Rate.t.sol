// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {RepBaseTest} from "./RepBase.t.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {IPolicyWalletReputation} from "../src/IPolicyWalletReputation.sol";

/// T021: rate() (US2) against MockErc8004. A rating exists only for a settled, identity-checked
/// payment of this wallet, once, with the agentId from the attempt record (research R4).
contract RateTest is RepBaseTest {
    uint256 internal constant AMT = 10_000;
    string internal constant URL = "https://api.demo.yunshu.ai/s/reliable/quote";

    function setUp() public override {
        super.setUp();
        _reviews(svcId, 5, 90);
    }

    /// Authorize with identity and settle through USDC, as the facilitator would.
    function _paid() internal returns (bytes32 nonce) {
        nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        assertTrue(wallet.authorizeWithIdentity(nonce, svcPayee, AMT, 0, validBefore, bytes32(0), svcId));
        bytes memory sig = _sign(agentKey, _digest(svcPayee, AMT, 0, validBefore, nonce));
        usdc.transferWithAuthorization(address(wallet), svcPayee, AMT, 0, validBefore, nonce, sig);
    }

    function _rate(bytes32 nonce, uint8 score, string memory tag, string memory endpoint) internal {
        vm.prank(agent);
        wallet.rate(nonce, score, tag, endpoint);
    }

    function test_rate_settledPaymentPublishesFeedback() public {
        bytes32 nonce = _paid();
        uint64 before = registry.getLastIndex(svcId, address(wallet));
        vm.expectEmit(address(wallet));
        emit IPolicyWalletReputation.PaymentRated(nonce, svcId, 90, "accurate", before + 1);
        vm.recordLogs();
        _rate(nonce, 90, "accurate", URL);
        Vm.Log memory fb = vm.getRecordedLogs()[0]; // the registry's NewFeedback
        assertEq(fb.emitter, address(registry));
        assertEq(fb.topics[0], MockErc8004.NewFeedback.selector);
        assertEq(uint256(fb.topics[1]), svcId);
        assertEq(address(uint160(uint256(fb.topics[2]))), address(wallet)); // the wallet is the reviewer
        assertEq(fb.topics[3], keccak256("accurate"));
        assertEq(keccak256(fb.data), keccak256(_feedbackData(before + 1, nonce)));
        (bool hasIdentity, uint256 id, bool rated) = wallet.attempt(nonce);
        assertTrue(hasIdentity && rated);
        assertEq(id, svcId);
    }

    /// giveFeedback(agentId, 90, 0, "accurate", "agent-wallet/v1", URL, "", nonce) as logged.
    function _feedbackData(uint64 index, bytes32 nonce) internal pure returns (bytes memory) {
        return abi.encode(index, int128(90), uint8(0), "accurate", "agent-wallet/v1", URL, "", nonce);
    }

    function test_rate_ratingCountsWhenWalletIsTrusted() public {
        vm.prank(operator);
        wallet.setTrustedReviewer(address(wallet), true);
        address[] memory clients = new address[](1);
        clients[0] = address(wallet);
        _rate(_paid(), 40, "stale", URL);
        (uint64 count, int128 value,) = registry.getSummary(svcId, clients, "", "");
        assertEq(count, 1);
        assertEq(value, 40);
    }

    function test_rate_revertsForNonAgent() public {
        bytes32 nonce = _paid();
        vm.prank(stranger);
        vm.expectRevert(PolicyWallet.NotAgent.selector);
        wallet.rate(nonce, 90, "accurate", URL);
        vm.prank(operator);
        vm.expectRevert(PolicyWallet.NotAgent.selector);
        wallet.rate(nonce, 90, "accurate", URL);
    }

    function test_rate_revertsWithoutIdentity() public {
        // Paid through 001's authorize (allowlisted payee, no claim): settled but not ratable.
        bytes32 nonce = _nonce();
        uint256 validBefore = block.timestamp + 300;
        assertTrue(_authorize(nonce, payee, AMT, bytes32(0)));
        bytes memory sig = _sign(agentKey, _digest(payee, AMT, 0, validBefore, nonce));
        usdc.transferWithAuthorization(address(wallet), payee, AMT, 0, validBefore, nonce, sig);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NotRatable.selector, nonce));
        wallet.rate(nonce, 90, "accurate", URL);
    }

    function test_rate_revertsForRefusedOrUnknownNonce() public {
        bytes32 refused = _nonce();
        vm.prank(agent);
        assertFalse(wallet.authorizeWithIdentity(refused, makeAddr("impostor"), AMT, 0, block.timestamp + 300, bytes32(0), svcId));
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NotRatable.selector, refused));
        wallet.rate(refused, 90, "accurate", URL);
        bytes32 unknown = keccak256("never-seen");
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NotRatable.selector, unknown));
        wallet.rate(unknown, 90, "accurate", URL);
        vm.stopPrank();
    }

    function test_rate_revertsWhenNotSettled() public {
        bytes32 nonce = _nonce();
        assertTrue(_authId(nonce, svcPayee, AMT, svcId));
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.NotSettled.selector, nonce));
        wallet.rate(nonce, 90, "accurate", URL);
    }

    function test_rate_onlyOnce() public {
        bytes32 nonce = _paid();
        _rate(nonce, 90, "accurate", URL);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(PolicyWallet.AlreadyRated.selector, nonce));
        wallet.rate(nonce, 10, "malformed", URL);
    }

    function test_rate_bounds() public {
        bytes32 nonce = _paid();
        vm.startPrank(agent);
        vm.expectRevert(PolicyWallet.InvalidRating.selector);
        wallet.rate(nonce, 101, "accurate", URL);
        vm.expectRevert(PolicyWallet.InvalidRating.selector);
        wallet.rate(nonce, 90, "", URL);
        vm.expectRevert(PolicyWallet.InvalidRating.selector);
        wallet.rate(nonce, 90, "123456789012345678901234567890123", URL); // 33 bytes
        bytes memory long = new bytes(201);
        vm.expectRevert(PolicyWallet.InvalidRating.selector);
        wallet.rate(nonce, 90, "accurate", string(long));
        wallet.rate(nonce, 100, "12345678901234567890123456789012", string(new bytes(200))); // limits are inclusive
        vm.stopPrank();
    }

    function test_rate_registryRejectionRevertsAndLeavesUnrated() public {
        bytes32 nonce = _paid();
        // The services-owner approves the wallet as an operator of its identities: the registry's
        // self-feedback ban then rejects the wallet's rating.
        vm.prank(svcOwner);
        registry.setApprovalForAll(address(wallet), true);
        vm.prank(agent);
        vm.expectRevert(bytes("Self-feedback not allowed"));
        wallet.rate(nonce, 90, "accurate", URL);
        (,, bool rated) = wallet.attempt(nonce);
        assertFalse(rated);
    }
}
