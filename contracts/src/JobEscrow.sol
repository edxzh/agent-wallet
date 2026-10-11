// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IJobEscrow} from "./IJobEscrow.sol";
import {IPolicyWallet} from "./IPolicyWallet.sol";
import {IPolicyWalletReputation} from "./IPolicyWalletReputation.sol";
import {Reason} from "./Reason.sol";

interface IEIP3009Transfer {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @title JobEscrow
/// @notice One agent hires another (specs/004-agent-hires-agent). The hirer's PolicyWallet pays
/// the price into this escrow through its normal `authorize` (cap, budgets) plus an EIP-3009
/// transfer, and the escrow first asks that wallet whether it may pay the worker (`checkPayee`,
/// allowlist / identity / reputation). The money is held until the hirer accepts the delivery, a
/// dispute is settled by the job's arbiter, or a deadline passes. Every job closes exactly once.
/// Base Sepolia only.
contract JobEscrow is IJobEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_DELIVERY = 30 days;
    uint256 public constant MIN_WINDOW = 1 hours;
    uint256 public constant MAX_WINDOW = 30 days;
    /// Gas for reading a wallet's `agent()` or `operator()`: a plain storage read.
    uint256 private constant AGENT_GAS = 50_000;

    address public immutable token;
    address public immutable owner;
    /// Money owed to jobs that haven't closed. Always ≤ this contract's token balance.
    uint256 public held;

    mapping(bytes32 jobId => Job) private _jobs;

    error WrongChain();
    error ZeroAddress();
    error NotClientAgent();
    error NotWorker();
    error NotArbiter();
    error ArbiterNotOperator();
    error NotOwner();
    error InvalidTerms();
    error JobExists(bytes32 jobId);
    error WrongStatus(bytes32 jobId, Status status);
    error TooLate(bytes32 jobId);
    error NotDue(bytes32 jobId);
    error FundingMismatch(uint256 received, uint256 expected);
    error EmptyHash();

    constructor(address token_) {
        if (block.chainid != 84532 && block.chainid != 31337) revert WrongChain(); // Base Sepolia, or local tests
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = msg.sender;
    }

    // ── Hirer ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IJobEscrow
    function open(OpenParams calldata p) external nonReentrant returns (bool opened, bytes32 jobId) {
        if (msg.sender != _agentOf(p.client)) revert NotClientAgent();
        if (p.worker == address(0) || p.arbiter == address(0)) revert ZeroAddress();
        // The hiring wallet's operator settles disputes: the hirer can't judge its own dispute.
        if (p.arbiter != _addressOf(p.client, IPolicyWallet.operator.selector)) revert ArbiterNotOperator();
        if (
            p.worker == p.client || p.amount == 0 || p.amount > type(uint128).max || p.deliverBy <= block.timestamp
                || p.deliverBy > block.timestamp + MAX_DELIVERY || !_validWindow(p.reviewWindow)
                || !_validWindow(p.disputeWindow)
        ) revert InvalidTerms();
        jobId = jobIdFor(p.client, p.nonce);
        if (_jobs[jobId].status != Status.None) revert JobExists(jobId);

        // The hirer's wallet decides whom it may pay. A refusal is an event, never a revert, and
        // moves no money (constitution II).
        Reason reason = _checkWorker(p.client, p.worker, p.workerHasClaim, p.workerAgentId);
        if (reason != Reason.NONE) {
            emit JobRefused(jobId, p.client, p.worker, p.nonce, reason);
            return (false, jobId);
        }

        uint256 before = IERC20(token).balanceOf(address(this));
        IEIP3009Transfer(token)
            .transferWithAuthorization(p.client, address(this), p.amount, 0, p.validBefore, p.nonce, p.signature);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != p.amount) revert FundingMismatch(received, p.amount);

        _jobs[jobId] = Job({
            client: p.client,
            worker: p.worker,
            arbiter: p.arbiter,
            amount: uint128(p.amount),
            deliverBy: p.deliverBy,
            deliveredAt: 0,
            disputedAt: 0,
            reviewWindow: p.reviewWindow,
            disputeWindow: p.disputeWindow,
            status: Status.Open,
            outcome: Outcome.NONE,
            specHash: p.specHash,
            resultHash: bytes32(0),
            workerAgentId: p.workerHasClaim ? p.workerAgentId : 0
        });
        held += p.amount;
        _emitOpened(jobId, p.nonce);
        return (true, jobId);
    }

    /// @inheritdoc IJobEscrow
    function accept(bytes32 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Delivered) revert WrongStatus(jobId, j.status);
        if (msg.sender != _agentOf(j.client)) revert NotClientAgent();
        _close(jobId, j, Outcome.ACCEPTED, j.worker);
    }

    /// @inheritdoc IJobEscrow
    function reject(bytes32 jobId, bytes32 reasonHash) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Delivered) revert WrongStatus(jobId, j.status);
        if (msg.sender != _agentOf(j.client)) revert NotClientAgent();
        if (block.timestamp >= uint256(j.deliveredAt) + j.reviewWindow) revert TooLate(jobId);
        j.status = Status.Disputed;
        j.disputedAt = uint64(block.timestamp);
        emit JobDisputed(jobId, reasonHash);
    }

    // ── Worker ────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IJobEscrow
    function deliver(bytes32 jobId, bytes32 resultHash) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert WrongStatus(jobId, j.status);
        if (msg.sender != j.worker && msg.sender != _agentOf(j.worker)) revert NotWorker();
        if (block.timestamp > j.deliverBy) revert TooLate(jobId);
        if (resultHash == bytes32(0)) revert EmptyHash();
        j.status = Status.Delivered;
        j.deliveredAt = uint64(block.timestamp);
        j.resultHash = resultHash;
        emit JobDelivered(jobId, resultHash);
    }

    // ── Arbiter ───────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IJobEscrow
    function resolve(bytes32 jobId, bool payWorker) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Disputed) revert WrongStatus(jobId, j.status);
        if (msg.sender != j.arbiter) revert NotArbiter();
        if (block.timestamp >= uint256(j.disputedAt) + j.disputeWindow) revert TooLate(jobId);
        if (payWorker) _close(jobId, j, Outcome.ARBITER_PAID, j.worker);
        else _close(jobId, j, Outcome.ARBITER_REFUNDED, j.client);
    }

    // ── Anyone ────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IJobEscrow
    function claimTimeout(bytes32 jobId) external nonReentrant {
        // Each window has one boundary: an action allowed at time t is never also a timeout at t.
        Job storage j = _jobs[jobId];
        if (j.status == Status.Open && block.timestamp > j.deliverBy) {
            _close(jobId, j, Outcome.DELIVERY_TIMEOUT, j.client);
        } else if (j.status == Status.Delivered && block.timestamp >= uint256(j.deliveredAt) + j.reviewWindow) {
            _close(jobId, j, Outcome.REVIEW_TIMEOUT, j.worker);
        } else if (j.status == Status.Disputed && block.timestamp >= uint256(j.disputedAt) + j.disputeWindow) {
            _close(jobId, j, Outcome.ARBITER_TIMEOUT, j.client);
        } else {
            revert NotDue(jobId);
        }
    }

    // ── Owner ─────────────────────────────────────────────────────────────────────────────

    /// @inheritdoc IJobEscrow
    function recoverSurplus(address to) external nonReentrant {
        if (msg.sender != owner) revert NotOwner();
        if (to == address(0)) revert ZeroAddress();
        uint256 surplus = IERC20(token).balanceOf(address(this)) - held;
        IERC20(token).safeTransfer(to, surplus);
        emit SurplusRecovered(to, surplus);
    }

    // ── Views ─────────────────────────────────────────────────────────────────────────────

    function job(bytes32 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /// An EIP-3009 nonce is single-use per authorizer, so (client, nonce) names one funding.
    function jobIdFor(address client, bytes32 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(client, nonce));
    }

    // ── Internal ──────────────────────────────────────────────────────────────────────────

    function _close(bytes32 jobId, Job storage j, Outcome outcome, address to) internal {
        uint256 amount = j.amount;
        j.status = Status.Closed;
        j.outcome = outcome;
        held -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit JobClosed(jobId, outcome, to, amount);
    }

    function _emitOpened(bytes32 jobId, bytes32 nonce) private {
        Job storage j = _jobs[jobId];
        emit JobOpened(
            jobId,
            j.client,
            j.worker,
            j.arbiter,
            nonce,
            j.amount,
            j.deliverBy,
            j.reviewWindow,
            j.disputeWindow,
            j.specHash,
            j.workerAgentId
        );
    }

    function _validWindow(uint32 w) private pure returns (bool) {
        return w >= MIN_WINDOW && w <= MAX_WINDOW;
    }

    /// A PolicyWallet's current agent, or address(0) for an account without one. A low-level call,
    /// so an account with no code, or a contract that reverts or answers oddly, never reverts here.
    function _agentOf(address a) internal view returns (address) {
        return _addressOf(a, IPolicyWallet.agent.selector);
    }

    /// An address-returning view (`agent()`, `operator()`), or address(0) if `a` can't answer.
    function _addressOf(address a, bytes4 selector) internal view returns (address) {
        if (a.code.length == 0) return address(0);
        (bool ok, bytes memory ret) = a.staticcall{gas: AGENT_GAS}(abi.encodeWithSelector(selector));
        if (!ok || ret.length != 32) return address(0);
        uint256 v = abi.decode(ret, (uint256));
        return v > type(uint160).max ? address(0) : address(uint160(v));
    }

    /// The hirer's wallet's own "may I pay this payee" answer (002's free view). A wallet that
    /// can't answer (e.g. a 001 wallet without checkPayee) is a refusal, never a pass.
    function _checkWorker(address client, address worker, bool hasClaim, uint256 agentId)
        internal
        view
        returns (Reason)
    {
        (bool ok, bytes memory ret) = client.staticcall(
            abi.encodeCall(IPolicyWalletReputation.checkPayee, (worker, hasClaim, agentId))
        );
        if (!ok || ret.length != 32) return Reason.REPUTATION_UNAVAILABLE;
        uint256 v = abi.decode(ret, (uint256));
        return v > uint256(Reason.PAYEE_REPUTATION_TOO_LOW) ? Reason.REPUTATION_UNAVAILABLE : Reason(v);
    }
}
