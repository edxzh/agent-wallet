// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";

/// Shared setup for feature 002: a service identity owned by a separate services-owner whose
/// registered wallet is `svcPayee` (not allowlisted), three trusted reviewers, and the rule
/// "average >= 70 from >= 3 trusted reviews" on.
abstract contract RepBaseTest is BaseTest {
    uint8 internal constant MIN_AVG = 70;
    uint64 internal constant MIN_COUNT = 3;

    address internal svcOwner = makeAddr("services-owner");
    address internal svcPayee = makeAddr("service-payee");
    address internal r1 = makeAddr("reviewer-1");
    address internal r2 = makeAddr("reviewer-2");
    address internal r3 = makeAddr("reviewer-3");
    address internal untrusted = makeAddr("untrusted");
    uint256 internal svcId;

    function setUp() public virtual override {
        super.setUp();
        vm.prank(svcOwner);
        registry.register("data:,decoy"); // id 0 exists, so a real service never has id 0 here
        vm.startPrank(svcOwner);
        svcId = registry.register("data:,service");
        registry.setAgentWallet(svcId, svcPayee);
        vm.stopPrank();
        vm.startPrank(operator);
        wallet.setTrustedReviewer(r1, true);
        wallet.setTrustedReviewer(r2, true);
        wallet.setTrustedReviewer(r3, true);
        wallet.setReputationRule(true, MIN_AVG, MIN_COUNT);
        vm.stopPrank();
    }

    function _review(address reviewer, uint256 id, int128 value, uint8 decimals) internal {
        vm.prank(reviewer);
        registry.giveFeedback(id, value, decimals, "accurate", "agent-wallet/v1", "", "", bytes32(0));
    }

    /// n ratings of `value` spread across the three trusted reviewers.
    function _reviews(uint256 id, uint256 n, int128 value) internal {
        address[3] memory rs = [r1, r2, r3];
        for (uint256 i; i < n; i++) _review(rs[i % 3], id, value, 0);
    }

    function _authId(bytes32 nonce, address to, uint256 amount, uint256 agentId) internal returns (bool) {
        vm.prank(agent);
        return wallet.authorizeWithIdentity(nonce, to, amount, 0, block.timestamp + 300, bytes32(0), agentId);
    }
}
