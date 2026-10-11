// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Reason} from "./Reason.sol";

/// Public interface of the job escrow (specs/004-agent-hires-agent). Event shapes are the public
/// record: changing them is a breaking change for the dashboard and independent verifiers.
interface IJobEscrow {
    enum Status {
        None,
        Open,
        Delivered,
        Disputed,
        Closed
    }

    /// How a job closed. Append only, never reorder.
    enum Outcome {
        NONE,
        ACCEPTED, //          1 hirer accepted the delivery → worker
        REVIEW_TIMEOUT, //    2 hirer didn't answer in the review window → worker
        ARBITER_PAID, //      3 arbiter settled a dispute for the worker → worker
        DELIVERY_TIMEOUT, //  4 worker missed the deadline → hirer
        ARBITER_REFUNDED, //  5 arbiter settled a dispute for the hirer → hirer
        ARBITER_TIMEOUT //    6 arbiter didn't rule in the dispute window → hirer
    }

    struct OpenParams {
        /// The hiring PolicyWallet: the EIP-3009 `from`, and where refunds go.
        address client;
        /// The nonce the hirer's wallet authorized (payee = this escrow).
        bytes32 nonce;
        uint256 amount;
        uint256 validBefore;
        /// The hirer agent's signature over the wallet's reserved TransferWithAuthorization digest.
        bytes signature;
        /// Where the price goes: an account, or a worker's own PolicyWallet.
        address worker;
        bool workerHasClaim;
        /// The worker's ERC-8004 agentId, if it claims one (checked by the hirer's wallet).
        uint256 workerAgentId;
        address arbiter;
        uint64 deliverBy;
        uint32 reviewWindow;
        uint32 disputeWindow;
        /// Hash of what the hirer asked for.
        bytes32 specHash;
    }

    struct Job {
        address client;
        address worker;
        address arbiter;
        uint128 amount;
        uint64 deliverBy;
        uint64 deliveredAt;
        uint64 disputedAt;
        uint32 reviewWindow;
        uint32 disputeWindow;
        Status status;
        Outcome outcome;
        bytes32 specHash;
        bytes32 resultHash;
        uint256 workerAgentId;
    }

    // ── Record (never removed, never edited) ──────────────────────────────────────────────
    event JobOpened(
        bytes32 indexed jobId,
        address indexed client,
        address indexed worker,
        address arbiter,
        bytes32 nonce,
        uint256 amount,
        uint64 deliverBy,
        uint32 reviewWindow,
        uint32 disputeWindow,
        bytes32 specHash,
        uint256 workerAgentId
    );
    /// The hirer's wallet wouldn't pay this worker: no money moved, and the wallet's reservation
    /// expires as usual (anyone can `release` it after `validBefore`).
    event JobRefused(
        bytes32 indexed jobId, address indexed client, address indexed worker, bytes32 nonce, Reason reason
    );
    event JobDelivered(bytes32 indexed jobId, bytes32 resultHash);
    event JobDisputed(bytes32 indexed jobId, bytes32 reasonHash);
    event JobClosed(bytes32 indexed jobId, Outcome outcome, address indexed to, uint256 amount);
    event SurplusRecovered(address indexed to, uint256 amount);

    // ── Hirer (the client wallet's current agent) ─────────────────────────────────────────
    /// Opens and funds a job, or emits JobRefused and returns (false, jobId) if the hirer's wallet
    /// wouldn't pay the worker.
    function open(OpenParams calldata p) external returns (bool opened, bytes32 jobId);
    function accept(bytes32 jobId) external;
    function reject(bytes32 jobId, bytes32 reasonHash) external;

    // ── Worker (the worker account, or its wallet's agent) ────────────────────────────────
    function deliver(bytes32 jobId, bytes32 resultHash) external;

    // ── Arbiter ───────────────────────────────────────────────────────────────────────────
    function resolve(bytes32 jobId, bool payWorker) external;

    // ── Anyone ────────────────────────────────────────────────────────────────────────────
    /// Closes a job whose deadline or window has passed (see Outcome).
    function claimTimeout(bytes32 jobId) external;

    // ── Owner ─────────────────────────────────────────────────────────────────────────────
    /// Sends money that belongs to no job (e.g. a front-run transfer) to `to`. Never held money.
    function recoverSurplus(address to) external;

    // ── Views ─────────────────────────────────────────────────────────────────────────────
    function token() external view returns (address);
    function owner() external view returns (address);
    function held() external view returns (uint256);
    function job(bytes32 jobId) external view returns (Job memory);
    function jobIdFor(address client, bytes32 nonce) external pure returns (bytes32);
}
