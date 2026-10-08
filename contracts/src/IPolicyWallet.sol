// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Reason} from "./Reason.sol";

/// Public interface of the policy wallet (contracts/policy-wallet.md). Event shapes are the public
/// record: changing them is a breaking change for the dashboard and independent verifiers.
interface IPolicyWallet is IERC1271 {
    // ── Record (never removed, never edited) ──────────────────────────────────────────────
    event PaymentAuthorized(
        bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, uint256 validBefore, bytes32 digest
    );
    event PaymentRefused(bytes32 indexed nonce, address indexed payee, bytes32 indexed taskId, uint256 amount, Reason reason);
    event PaymentExpired(bytes32 indexed nonce, uint256 amount);
    /// field ∈ "perPaymentCap" | "dailyBudget" | "payee" (key = payee, 0/1) | "taskBudget" (key = taskId) | "agent"
    event RuleChanged(bytes32 indexed field, bytes32 indexed key, uint256 oldValue, uint256 newValue);
    event Paused();
    event Unpaused();

    // ── Agent ─────────────────────────────────────────────────────────────────────────────
    function authorize(bytes32 nonce, address payee, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 taskId)
        external
        returns (bool);

    // ── Anyone ────────────────────────────────────────────────────────────────────────────
    function release(bytes32 nonce) external;

    // ── Operator only ─────────────────────────────────────────────────────────────────────
    function setPolicy(uint256 perPaymentCap, uint256 dailyBudget) external;
    function setPayee(address payee, bool allowed) external;
    function setTask(bytes32 taskId, uint256 budget) external;
    function setAgent(address agent) external;
    function pause() external;
    function unpause() external;
    function withdraw(address to, uint256 amount) external;

    // ── Views ─────────────────────────────────────────────────────────────────────────────
    function operator() external view returns (address);
    function agent() external view returns (address);
    function token() external view returns (address);
    function name() external view returns (string memory);
    function paused() external view returns (bool);
    function perPaymentCap() external view returns (uint256);
    function dailyBudget() external view returns (uint256);
    function spentOn(uint256 day) external view returns (uint256);
    function task(bytes32 taskId) external view returns (uint256 budget, uint256 spent);
    function isPayeeAllowed(address payee) external view returns (bool);
}

interface IPolicyWalletFactory {
    event WalletCreated(address indexed wallet, address indexed operator, address indexed agent, string name);

    /// Deploys an EIP-1167 clone; msg.sender becomes the operator.
    function createWallet(address agent, string calldata name, uint256 perPaymentCap, uint256 dailyBudget)
        external
        returns (address wallet);
}
