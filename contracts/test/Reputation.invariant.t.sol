// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RepBaseTest} from "./RepBase.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";

/// Random sequences of authorize, authorizeWithIdentity, settlement, rate, rule and reviewer
/// changes, allowlist changes, feedback, release and time.
contract RepHandler is Test {
    PolicyWallet internal wallet;
    MockUSDC internal usdc;
    MockErc8004 internal registry;
    address internal agent;
    uint256 internal agentKey;
    address internal operator;
    address internal svcPayee;
    uint256 internal svcId;
    address[3] internal payees;
    address[5] internal reviewers;

    bytes32[] public nonces; // every authorized nonce
    mapping(bytes32 => address) internal payeeOf;
    mapping(bytes32 => uint256) internal amountOf;
    mapping(bytes32 => uint256) internal validBeforeOf;
    mapping(bytes32 => uint256) public ratesOf;
    uint256 public rateCount;
    uint256 public settledTotal;
    uint256 public violations;
    uint256 private seq;

    struct Cfg {
        address agent;
        uint256 agentKey;
        address operator;
        address allowlisted;
        address svcPayee;
        uint256 svcId;
        address[3] trusted;
    }

    constructor(PolicyWallet w, MockUSDC u, MockErc8004 r, Cfg memory c) {
        (wallet, usdc, registry) = (w, u, r);
        (agent, agentKey, operator, svcPayee, svcId) = (c.agent, c.agentKey, c.operator, c.svcPayee, c.svcId);
        payees = [c.allowlisted, c.svcPayee, address(0xBAD)];
        reviewers = [c.trusted[0], c.trusted[1], c.trusted[2], address(w), address(0xCAFE)];
    }

    function _track(bytes32 nonce, address to, uint256 amount, uint256 validBefore) internal {
        nonces.push(nonce);
        (payeeOf[nonce], amountOf[nonce], validBeforeOf[nonce]) = (to, amount, validBefore);
        if (wallet.spentOn(block.timestamp / 1 days) > wallet.dailyBudget()) violations++;
    }

    function authorize(uint256 amount, uint256 payeeIx) external {
        bytes32 nonce = keccak256(abi.encode("a", ++seq));
        address to = payees[payeeIx % 3];
        amount = bound(amount, 1, 2e6);
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        if (wallet.authorize(nonce, to, amount, 0, validBefore, bytes32(0))) _track(nonce, to, amount, validBefore);
    }

    function authorizeWithIdentity(uint256 amount, uint256 payeeIx, bool realId) external {
        bytes32 nonce = keccak256(abi.encode("i", ++seq));
        address to = payees[payeeIx % 3];
        amount = bound(amount, 1, 2e6);
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        if (wallet.authorizeWithIdentity(nonce, to, amount, 0, validBefore, bytes32(0), realId ? svcId : 999)) {
            _track(nonce, to, amount, validBefore);
        }
    }

    /// Mostly one of the last three nonces, so settle → rate sequences happen often.
    function _pick(uint256 ix) internal view returns (bytes32) {
        uint256 n = nonces.length;
        return ix % 4 == 0 ? nonces[ix % n] : nonces[n - 1 - (ix / 4) % (n < 3 ? n : 3)];
    }

    function settle(uint256 ix) external {
        if (nonces.length == 0) return;
        bytes32 nonce = _pick(ix);
        if (usdc.authorizationState(address(wallet), nonce) || block.timestamp >= validBeforeOf[nonce]) return;
        (,,,,, bool active) = wallet.reservations(nonce);
        if (!active || usdc.balanceOf(address(wallet)) < amountOf[nonce]) return;
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(wallet), payeeOf[nonce], amountOf[nonce], 0, validBeforeOf[nonce], nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        usdc.transferWithAuthorization(
            address(wallet), payeeOf[nonce], amountOf[nonce], 0, validBeforeOf[nonce], nonce, abi.encodePacked(r, s, v)
        );
        settledTotal += amountOf[nonce];
    }

    function rate(uint256 ix, uint8 score) external {
        bytes32 nonce = nonces.length == 0 || ix % 5 == 0 ? keccak256(abi.encode("unknown", ix)) : _pick(ix);
        vm.prank(agent);
        try wallet.rate(nonce, uint8(bound(score, 0, 100)), "accurate", "") {
            ratesOf[nonce]++;
            rateCount++;
        } catch {}
    }

    function setReputationRule(bool enabled, uint8 minAvg, uint64 minCount) external {
        vm.prank(operator);
        try wallet.setReputationRule(enabled, uint8(bound(minAvg, 0, 110)), uint64(bound(minCount, 0, 6))) {} catch {}
    }

    function setTrustedReviewer(uint256 ix, bool trusted) external {
        vm.prank(operator);
        try wallet.setTrustedReviewer(reviewers[ix % 5], trusted) {} catch {}
    }

    function setPayee(bool allowed) external {
        vm.prank(operator);
        wallet.setPayee(svcPayee, allowed);
    }

    function review(uint256 ix, uint8 value) external {
        address reviewer = reviewers[ix % 5];
        if (reviewer == address(wallet)) return; // the wallet reviews only through rate()
        vm.prank(reviewer);
        registry.giveFeedback(svcId, int128(int256(bound(value, 40, 100))), 0, "x", "", "", "", bytes32(0));
    }

    function release(uint256 ix) external {
        if (nonces.length == 0) return;
        bytes32 nonce = nonces[ix % nonces.length];
        (,,,,, bool active) = wallet.reservations(nonce);
        if (!active || block.timestamp < validBeforeOf[nonce] || usdc.authorizationState(address(wallet), nonce)) return;
        wallet.release(nonce);
    }

    function replay(uint256 ix) external {
        if (nonces.length == 0) return;
        vm.prank(agent);
        try wallet.authorizeWithIdentity(nonces[ix % nonces.length], svcPayee, 1, 0, block.timestamp + 1, bytes32(0), svcId) {
            violations++; // a nonce was accepted twice
        } catch {}
    }

    function warp(uint256 secs) external {
        // Mostly short steps (authorizations live 300 s), sometimes a day.
        vm.warp(block.timestamp + (secs % 4 == 0 ? bound(secs, 1, 1 days) : bound(secs, 1, 120)));
    }

    function nonceCount() external view returns (uint256) {
        return nonces.length;
    }
}

/// T022: rated ⇒ hasIdentity ∧ settled; at most one rating per nonce; the rule is never on with
/// zero reviewers; and 001's invariants still hold.
contract ReputationInvariantTest is RepBaseTest {
    RepHandler internal handler;
    uint256 internal initialBalance;

    function setUp() public override {
        super.setUp();
        handler = new RepHandler(wallet, usdc, registry, RepHandler.Cfg(agent, agentKey, operator, payee, svcPayee, svcId, [r1, r2, r3]));
        initialBalance = usdc.balanceOf(address(wallet));
        targetContract(address(handler));
    }

    function invariant_ratedImpliesIdentityAndSettled() public view {
        uint256 n = handler.nonceCount();
        for (uint256 i; i < n; i++) {
            bytes32 nonce = handler.nonces(i);
            (bool hasIdentity,, bool rated) = wallet.attempt(nonce);
            if (rated) {
                assertTrue(hasIdentity, "rated without identity");
                assertTrue(usdc.authorizationState(address(wallet), nonce), "rated without settlement");
            }
            assertLe(handler.ratesOf(nonce), 1, "rated twice");
        }
    }

    function invariant_oneRegistryEntryPerRating() public view {
        assertEq(registry.getLastIndex(svcId, address(wallet)), handler.rateCount());
    }

    function invariant_ruleNeverOnWithoutReviewers() public view {
        (bool enabled,,) = wallet.reputationRule();
        if (enabled) assertGt(wallet.trustedReviewers().length, 0);
    }

    function invariant_001_noLimitBreachedAndNoReplay() public view {
        assertEq(handler.violations(), 0);
    }

    function invariant_001_balanceChangesOnlyBySettlement() public view {
        assertEq(usdc.balanceOf(address(wallet)), initialBalance - handler.settledTotal());
    }
}
