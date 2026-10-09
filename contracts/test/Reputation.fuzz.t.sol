// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RepBaseTest} from "./RepBase.t.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";
import {IPolicyWallet} from "../src/IPolicyWallet.sol";
import {Reason} from "../src/Reason.sol";

/// T013: one fuzz per new reason (8–12). Each case: authorize returns false, PaymentRefused
/// carries exactly that reason, nothing reverts, and the balance and budgets are unchanged.
/// Plus SC-002: untrusted reviewers never change a decision.
contract ReputationFuzzTest is RepBaseTest {
    function _refused(address to, uint256 amount, bool hasClaim, uint256 id, Reason want) internal {
        amount = bound(amount, 1, CAP);
        bytes32 nonce = _nonce();
        uint256 day = block.timestamp / 1 days;
        uint256 balance = usdc.balanceOf(address(wallet));
        uint256 spent = wallet.spentOn(day);
        (, uint256 taskSpent) = wallet.task(TASK);

        vm.expectEmit(address(wallet));
        emit IPolicyWallet.PaymentRefused(nonce, to, TASK, amount, want);
        vm.prank(agent);
        bool ok = hasClaim
            ? wallet.authorizeWithIdentity(nonce, to, amount, 0, block.timestamp + 300, TASK, id)
            : wallet.authorize(nonce, to, amount, 0, block.timestamp + 300, TASK);

        assertFalse(ok);
        assertEq(uint8(wallet.checkPayee(to, hasClaim, id)), uint8(want));
        assertEq(usdc.balanceOf(address(wallet)), balance);
        assertEq(wallet.spentOn(day), spent);
        (, uint256 taskSpentAfter) = wallet.task(TASK);
        assertEq(taskSpentAfter, taskSpent);
    }

    function _unlisted(address to) internal view returns (address) {
        vm.assume(to != address(0) && to != payee && to != svcPayee && !wallet.isPayeeAllowed(to));
        return to;
    }

    function testFuzz_8_identityUnverified(address to, uint256 amount) public {
        _refused(_unlisted(to), amount, false, 0, Reason.PAYEE_IDENTITY_UNVERIFIED);
    }

    function testFuzz_9_identityMismatch(address to, uint256 amount, uint256 id) public {
        to = _unlisted(to);
        // Either the real service's id (registered to svcPayee) or an unknown id (address(0)).
        id = id % 2 == 0 ? svcId : bound(id, svcId + 1, type(uint256).max);
        _reviews(svcId, 5, 90); // a good reputation doesn't help an impostor
        _refused(to, amount, true, id, Reason.PAYEE_IDENTITY_MISMATCH);
    }

    function testFuzz_10_reputationUnavailable(uint8 mode, bool identitySide, uint256 amount) public {
        MockErc8004.Mode m = MockErc8004.Mode(bound(mode, 1, 4));
        _reviews(svcId, 5, 90);
        if (identitySide) registry.setIdentityFailure(m);
        else registry.setSummaryFailure(m);
        _refused(svcPayee, amount, true, svcId, Reason.REPUTATION_UNAVAILABLE);
    }

    function testFuzz_11_notEnoughTrustedReviews(uint64 minCount, uint8 n, int128 value, uint256 amount) public {
        minCount = uint64(bound(minCount, 1, 20));
        n = uint8(bound(n, 0, minCount - 1));
        value = int128(bound(value, -100, 100));
        vm.prank(operator);
        wallet.setReputationRule(true, MIN_AVG, minCount);
        _reviews(svcId, n, value);
        _refused(svcPayee, amount, true, svcId, Reason.NOT_ENOUGH_TRUSTED_REVIEWS);
    }

    function testFuzz_12_reputationTooLow(uint8 minAvg, uint8 n, uint256 seed, uint256 amount) public {
        minAvg = uint8(bound(minAvg, 1, 100));
        n = uint8(bound(n, MIN_COUNT, 15));
        vm.prank(operator);
        wallet.setReputationRule(true, minAvg, MIN_COUNT);
        // Every rating below the minimum, so the (truncating) average is too.
        for (uint256 i; i < n; i++) {
            int128 v = int128(int256(bound(uint256(keccak256(abi.encode(seed, i))), 0, uint256(minAvg) + 99))) - 100; // [-100, minAvg - 1]
            _review([r1, r2, r3][i % 3], svcId, v, 0);
        }
        _refused(svcPayee, amount, true, svcId, Reason.PAYEE_REPUTATION_TOO_LOW);
    }

    /// SC-002: adding 1–20 untrusted reviewers with any scores never changes the decision.
    function testFuzz_untrustedNoiseNeverChangesDecision(uint8 trustedN, uint256 seed, uint8 noiseN) public {
        trustedN = uint8(bound(trustedN, 0, 9));
        noiseN = uint8(bound(noiseN, 1, 20));
        for (uint256 i; i < trustedN; i++) {
            _review([r1, r2, r3][i % 3], svcId, int128(int256(bound(uint256(keccak256(abi.encode(seed, i))), 0, 100))), 0);
        }
        Reason before = wallet.checkPayee(svcPayee, true, svcId);
        for (uint256 i; i < noiseN; i++) {
            address noisy = address(uint160(uint256(keccak256(abi.encode("noise", seed, i)))));
            vm.assume(noisy != svcOwner);
            _review(noisy, svcId, int128(int256(bound(uint256(keccak256(abi.encode(seed, "v", i))), 0, 100))), 0);
        }
        assertEq(uint8(wallet.checkPayee(svcPayee, true, svcId)), uint8(before));
    }
}
