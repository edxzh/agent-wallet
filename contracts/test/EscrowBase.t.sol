// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RepBaseTest} from "./RepBase.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/IJobEscrow.sol";

/// Shared setup for feature 004: the hiring wallet (research-bot-01 from BaseTest) allows the
/// escrow and a worker as payees. The 002 reputation rule is off here unless a test turns it on,
/// so an unlisted worker is PAYEE_NOT_ALLOWED. The arbiter is the operator.
abstract contract EscrowBaseTest is RepBaseTest {
    uint64 internal constant DELIVER_IN = 1 days;
    uint32 internal constant REVIEW = 2 hours;
    uint32 internal constant DISPUTE = 3 days;
    uint256 internal constant PRICE = 500_000; // 0.5 USDC, under the 1 USDC cap
    bytes32 internal constant SPEC = keccak256("summarise ETH-USDC quotes");
    bytes32 internal constant RESULT = keccak256("summary v1");

    JobEscrow internal escrow;
    address internal worker = makeAddr("worker");
    address internal arbiter;

    function setUp() public virtual override {
        super.setUp();
        arbiter = operator;
        escrow = new JobEscrow(address(usdc));
        vm.startPrank(operator);
        wallet.setReputationRule(false, MIN_AVG, MIN_COUNT);
        wallet.setPayee(address(escrow), true);
        wallet.setPayee(worker, true);
        vm.stopPrank();
    }

    function _params(bytes32 nonce, uint256 amount, address to) internal view returns (IJobEscrow.OpenParams memory p) {
        uint256 validBefore = block.timestamp + 300;
        p = IJobEscrow.OpenParams({
            client: address(wallet),
            nonce: nonce,
            amount: amount,
            validBefore: validBefore,
            signature: _sign(agentKey, _digest(address(escrow), amount, 0, validBefore, nonce)),
            worker: to,
            workerHasClaim: false,
            workerAgentId: 0,
            arbiter: arbiter,
            deliverBy: uint64(block.timestamp + DELIVER_IN),
            reviewWindow: REVIEW,
            disputeWindow: DISPUTE,
            specHash: SPEC
        });
    }

    /// The hirer's two steps: the wallet authorizes a payment to the escrow (every 001 rule), then
    /// the escrow checks the worker with the wallet (002) and pulls the money.
    function _hire(uint256 amount, address to) internal returns (bool opened, bytes32 jobId) {
        bytes32 nonce = _nonce();
        if (!_authorize(nonce, address(escrow), amount, bytes32(0))) return (false, bytes32(0));
        IJobEscrow.OpenParams memory p = _params(nonce, amount, to);
        vm.prank(agent);
        return escrow.open(p);
    }

    function _hired() internal returns (bytes32 jobId) {
        bool opened;
        (opened, jobId) = _hire(PRICE, worker);
        assertTrue(opened, "job should open");
    }

    function _delivered() internal returns (bytes32 jobId) {
        jobId = _hired();
        vm.prank(worker);
        escrow.deliver(jobId, RESULT);
    }

    function _disputed() internal returns (bytes32 jobId) {
        jobId = _delivered();
        vm.prank(agent);
        escrow.reject(jobId, keccak256("wrong pair"));
    }
}
