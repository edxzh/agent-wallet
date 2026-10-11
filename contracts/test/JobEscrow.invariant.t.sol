// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IJobEscrow} from "../src/IJobEscrow.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// A hostile client: says yes to every check and signs anything. It can only spend its own money.
contract FakeClient {
    address public agent;
    address public operator;

    constructor(address a, address op) {
        agent = a;
        operator = op;
    }

    function checkPayee(address, bool, uint256) external pure returns (uint8) {
        return 0;
    }

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/// Random sequences of hire (real wallet and hostile client), deliver, accept, reject, resolve,
/// timeouts, direct transfers to the escrow (front-running), surplus recovery and time.
contract EscrowHandler is Test {
    JobEscrow internal escrow;
    PolicyWallet internal wallet;
    MockUSDC internal usdc;
    FakeClient internal fake;
    address internal agent;
    uint256 internal agentKey;
    address internal worker;
    address internal arbiter;
    address internal owner;

    bytes32[] public jobs;
    mapping(bytes32 => uint256) public amountOf;
    mapping(bytes32 => uint256) public closes; // ghost: how many times each job paid out
    uint256 public paidOut; // ghost: total paid by closes, or deferred (owed) by them
    uint256 public closedAmounts; // ghost: total price of closed jobs
    uint256 private seq;

    constructor(JobEscrow e, PolicyWallet w, MockUSDC u, uint256 k, address wk, address arb, address own) {
        escrow = e;
        wallet = w;
        usdc = u;
        agentKey = k;
        agent = vm.addr(k);
        worker = wk;
        arbiter = arb;
        owner = own;
        fake = new FakeClient(address(this), arb);
        u.mint(address(fake), 1_000_000e6);
    }

    function jobCount() external view returns (uint256) {
        return jobs.length;
    }

    function _pick(uint256 i) internal view returns (bytes32) {
        return jobs[i % jobs.length];
    }

    function _params(address client, bytes32 nonce, uint256 amount, bytes memory sig)
        internal
        view
        returns (IJobEscrow.OpenParams memory)
    {
        return IJobEscrow.OpenParams({
            client: client,
            nonce: nonce,
            amount: amount,
            validBefore: block.timestamp + 300,
            signature: sig,
            worker: worker,
            workerHasClaim: false,
            workerAgentId: 0,
            arbiter: arbiter,
            deliverBy: uint64(block.timestamp + 1 days),
            reviewWindow: 2 hours,
            disputeWindow: 3 days,
            specHash: keccak256("spec")
        });
    }

    function hire(uint256 amount) external {
        amount = bound(amount, 1, 1e6);
        bytes32 nonce = keccak256(abi.encode("inv", ++seq));
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        if (!wallet.authorize(nonce, address(escrow), amount, 0, validBefore, bytes32(0))) return;
        bytes memory sig = _sig(nonce, amount, validBefore);
        vm.prank(agent);
        (bool opened, bytes32 jobId) = escrow.open(_params(address(wallet), nonce, amount, sig));
        if (opened) _track(jobId, amount);
    }

    function _sig(bytes32 nonce, uint256 amount, uint256 validBefore) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                address(wallet),
                address(escrow),
                amount,
                0,
                validBefore,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function hireFromFake(uint256 amount) external {
        amount = bound(amount, 1, 1_000e6);
        bytes32 nonce = keccak256(abi.encode("fake", ++seq));
        (bool opened, bytes32 jobId) = escrow.open(_params(address(fake), nonce, amount, ""));
        if (opened) _track(jobId, amount);
    }

    function _track(bytes32 jobId, uint256 amount) internal {
        jobs.push(jobId);
        amountOf[jobId] = amount;
    }

    function deliver(uint256 i) external {
        if (jobs.length == 0) return;
        vm.prank(worker);
        try escrow.deliver(_pick(i), keccak256("result")) {} catch {}
    }

    function accept(uint256 i) external {
        if (jobs.length == 0) return;
        bytes32 id = _pick(i);
        address who = escrow.job(id).client == address(fake) ? address(this) : agent;
        vm.prank(who);
        _closing(id, abi.encodeCall(escrow.accept, (id)));
    }

    function reject(uint256 i) external {
        if (jobs.length == 0) return;
        bytes32 id = _pick(i);
        address who = escrow.job(id).client == address(fake) ? address(this) : agent;
        vm.prank(who);
        try escrow.reject(id, bytes32(0)) {} catch {}
    }

    function resolve(uint256 i, bool payWorker) external {
        if (jobs.length == 0) return;
        bytes32 id = _pick(i);
        vm.prank(arbiter);
        _closing(id, abi.encodeCall(escrow.resolve, (id, payWorker)));
    }

    function timeout(uint256 i) external {
        if (jobs.length == 0) return;
        bytes32 id = _pick(i);
        _closing(id, abi.encodeCall(escrow.claimTimeout, (id)));
    }

    function directTransfer(uint256 amount) external {
        amount = bound(amount, 1, 1e6);
        if (usdc.isBlacklisted(address(fake))) return;
        vm.prank(address(fake));
        usdc.transfer(address(escrow), amount);
    }

    function recover() external {
        vm.prank(owner);
        escrow.recoverSurplus(owner);
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 2 days));
    }

    function _closing(bytes32 id, bytes memory call) internal {
        bool wasClosed = escrow.job(id).status == IJobEscrow.Status.Closed;
        uint256 before = usdc.balanceOf(address(escrow));
        uint256 owedBefore = totalOwed();
        (bool ok,) = address(escrow).call(call);
        if (ok && !wasClosed && escrow.job(id).status == IJobEscrow.Status.Closed) {
            closes[id]++;
            paidOut += (before - usdc.balanceOf(address(escrow))) + (totalOwed() - owedBefore);
            closedAmounts += amountOf[id];
        }
    }

    /// Recipients a job can pay: the worker, the real hiring wallet, the hostile client.
    function recipients() public view returns (address[3] memory) {
        return [worker, address(wallet), address(fake)];
    }

    function totalOwed() public view returns (uint256 sum) {
        address[3] memory r = recipients();
        for (uint256 i; i < 3; i++) sum += escrow.owed(r[i]);
    }

    /// The token starts or stops refusing one recipient (Circle's blacklist).
    function toggleBlacklist(uint256 i) external {
        address a = recipients()[i % 3];
        if (usdc.isBlacklisted(a)) usdc.unBlacklist(a);
        else usdc.blacklist(a);
    }

    function withdrawOwed(uint256 i) external {
        try escrow.withdrawOwed(recipients()[i % 3]) {} catch {}
    }
}

contract JobEscrowInvariantTest is EscrowBaseTest {
    EscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        vm.prank(operator);
        wallet.setPolicy(CAP, 1_000_000 * CAP); // budgets aren't under test here
        usdc.mint(address(wallet), 1_000_000e6);
        // The deployer (this test) owns the escrow; the handler acts as owner via prank.
        handler = new EscrowHandler(escrow, wallet, usdc, agentKey, worker, arbiter, address(this));
        targetContract(address(handler));
    }

    /// Money held is exactly the price of every job not yet closed, plus refused payouts still owed.
    function invariant_HeldIsUnclosedJobsPlusOwed() public view {
        uint256 sum;
        for (uint256 i; i < handler.jobCount(); i++) {
            bytes32 id = handler.jobs(i);
            if (escrow.job(id).status != IJobEscrow.Status.Closed) sum += handler.amountOf(id);
        }
        assertEq(escrow.held(), sum + handler.totalOwed());
    }

    /// The escrow always holds at least what it owes (surplus recovery and direct transfers can't break it).
    function invariant_BalanceCoversHeld() public view {
        assertGe(usdc.balanceOf(address(escrow)), escrow.held());
    }

    /// Each job paid out at most once, and every close paid (or owed) exactly its price.
    function invariant_EachJobClosesOnce_ForItsPrice() public view {
        for (uint256 i; i < handler.jobCount(); i++) {
            assertLe(handler.closes(handler.jobs(i)), 1);
        }
        assertEq(handler.paidOut(), handler.closedAmounts());
    }
}
