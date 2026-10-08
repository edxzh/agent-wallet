// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BaseTest} from "./Base.t.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// Drives the wallet with random sequences of authorize, settle, release, rule changes and time.
contract Handler is Test {
    PolicyWallet internal wallet;
    MockUSDC internal usdc;
    address internal agent;
    uint256 internal agentKey;
    address internal operator;
    address[2] internal payees;
    bytes32[2] internal tasks;

    bytes32[] public authorized;
    mapping(bytes32 => uint256) public validBeforeOf;
    mapping(bytes32 => address) public payeeOf;
    mapping(bytes32 => uint256) public amountOf;
    uint256 public settledTotal;
    uint256 public violations; // an authorization that breached a limit when it was made
    uint256 private seq;

    constructor(PolicyWallet w, MockUSDC u, address a, uint256 k, address op, address p, bytes32 t) {
        (wallet, usdc, agent, agentKey, operator) = (w, u, a, k, op);
        payees = [p, address(0xBEEF)];
        tasks = [t, bytes32(0)];
    }

    function authorize(uint256 amount, uint256 payeeIx, uint256 taskIx, uint256 ttl) external {
        bytes32 nonce = keccak256(abi.encode("h", ++seq));
        address to = payees[payeeIx % 2];
        bytes32 taskId = tasks[taskIx % 2];
        amount = bound(amount, 1, 3e6);
        uint256 validBefore = block.timestamp + bound(ttl, 1, 2 days);
        vm.prank(agent);
        if (wallet.authorize(nonce, to, amount, 0, validBefore, taskId)) {
            authorized.push(nonce);
            (validBeforeOf[nonce], payeeOf[nonce], amountOf[nonce]) = (validBefore, to, amount);
            if (wallet.spentOn(block.timestamp / 1 days) > wallet.dailyBudget()) violations++;
            if (taskId != bytes32(0)) {
                (uint256 budget, uint256 spent) = wallet.task(taskId);
                if (spent > budget) violations++;
            }
        }
    }

    function settle(uint256 ix) external {
        if (authorized.length == 0) return;
        bytes32 nonce = authorized[ix % authorized.length];
        if (usdc.authorizationState(address(wallet), nonce) || block.timestamp >= validBeforeOf[nonce]) return;
        (,,,,, bool active) = wallet.reservations(nonce);
        if (!active) return;
        bytes32 structHash = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(wallet), payeeOf[nonce], amountOf[nonce], 0, validBeforeOf[nonce], nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
        if (usdc.balanceOf(address(wallet)) < amountOf[nonce]) return;
        usdc.transferWithAuthorization(
            address(wallet), payeeOf[nonce], amountOf[nonce], 0, validBeforeOf[nonce], nonce, abi.encodePacked(r, s, v)
        );
        settledTotal += amountOf[nonce];
    }

    function release(uint256 ix) external {
        if (authorized.length == 0) return;
        bytes32 nonce = authorized[ix % authorized.length];
        (,,,,, bool active) = wallet.reservations(nonce);
        if (!active || block.timestamp < validBeforeOf[nonce] || usdc.authorizationState(address(wallet), nonce)) return;
        wallet.release(nonce);
    }

    function setPolicy(uint256 cap, uint256 daily) external {
        vm.prank(operator);
        wallet.setPolicy(bound(cap, 1, 3e6), bound(daily, 1, 10e6));
    }

    function setTask(uint256 budget) external {
        vm.prank(operator);
        wallet.setTask(tasks[0], bound(budget, 0, 5e6));
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    function authorizedCount() external view returns (uint256) {
        return authorized.length;
    }

    function replay(uint256 ix) external {
        if (authorized.length == 0) return;
        bytes32 nonce = authorized[ix % authorized.length];
        vm.prank(agent);
        try wallet.authorize(nonce, payees[0], 1, 0, block.timestamp + 1, bytes32(0)) {
            violations++; // a nonce was accepted twice
        } catch {}
    }
}

/// SC-002 and FR-010: spend never exceeds a limit when authorized, no nonce is authorized twice,
/// and USDC leaves the wallet only through settled authorizations.
contract InvariantsTest is BaseTest {
    Handler internal handler;
    uint256 internal initialBalance;

    function setUp() public override {
        super.setUp();
        handler = new Handler(wallet, usdc, agent, agentKey, operator, payee, TASK);
        vm.prank(operator);
        wallet.setPayee(address(0xBEEF), true);
        initialBalance = usdc.balanceOf(address(wallet));
        targetContract(address(handler));
    }

    function invariant_noLimitBreachedAtAuthorization() public view {
        assertEq(handler.violations(), 0);
    }

    function invariant_balanceChangesOnlyBySettlement() public view {
        assertEq(usdc.balanceOf(address(wallet)), initialBalance - handler.settledTotal());
    }
}
