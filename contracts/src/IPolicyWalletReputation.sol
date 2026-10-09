// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Reason} from "./Reason.sol";

/// Feature 002 additions to IPolicyWallet (specs/002-trusted-payees-erc8004/contracts/
/// policy-wallet-reputation.md). Nothing in 001's interface changes.
interface IPolicyWalletReputation {
    // ── Record (new events; 001's events unchanged) ──────────────────────────────────────
    /// Emitted by authorizeWithIdentity on success, right after PaymentAuthorized for the same nonce.
    event PayeeIdentityVerified(bytes32 indexed nonce, uint256 indexed agentId, address indexed payee);
    /// Emitted by rate(); the registry's NewFeedback is emitted in the same transaction.
    event PaymentRated(bytes32 indexed nonce, uint256 indexed agentId, uint8 score, string tag, uint64 feedbackIndex);
    // RuleChanged (001) gains fields: "repEnabled" | "repMinAverage" | "repMinCount" | "trustedReviewer" (key = reviewer, 0/1)

    // ── Agent ─────────────────────────────────────────────────────────────────────────────
    /// 001's authorize plus a claimed ERC-8004 identity for the payee. Never reverts on a policy
    /// failure; reverts only for a non-agent caller, a reused nonce, or too little gas.
    function authorizeWithIdentity(
        bytes32 nonce,
        address payee,
        uint256 amount,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 taskId,
        uint256 payeeAgentId
    ) external returns (bool);

    /// One rating for a settled, identity-checked payment of this wallet, with the wallet as reviewer.
    function rate(bytes32 nonce, uint8 score, string calldata tag, string calldata endpoint) external;

    // ── Operator only ─────────────────────────────────────────────────────────────────────
    function setReputationRule(bool enabled, uint8 minAverage, uint64 minCount) external;
    function setTrustedReviewer(address reviewer, bool trusted) external;

    // ── Views ─────────────────────────────────────────────────────────────────────────────
    function identityRegistry() external view returns (address);
    function reputationRegistry() external view returns (address);
    function reputationRule() external view returns (bool enabled, uint8 minAverage, uint64 minCount);
    function trustedReviewers() external view returns (address[] memory);
    /// The scope check (data-model step 3) as a view. Same internal function as authorize; NONE if it passes.
    function checkPayee(address payee, bool hasClaim, uint256 payeeAgentId) external view returns (Reason);
    function attempt(bytes32 nonce) external view returns (bool hasIdentity, uint256 payeeAgentId, bool rated);
}
