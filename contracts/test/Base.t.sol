// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../src/PolicyWalletFactory.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockErc8004} from "./mocks/MockErc8004.sol";

/// Shared setup: mock USDC, implementation + factory, one funded wallet with an allowed payee
/// and a task. Amounts in USDC base units (6 decimals).
abstract contract BaseTest is Test {
    uint256 internal constant USDC1 = 1e6;
    uint256 internal constant CAP = 1 * USDC1;
    uint256 internal constant DAILY = 5 * USDC1;
    bytes32 internal constant TASK = keccak256("market-research");
    uint256 internal constant TASK_BUDGET = 2 * USDC1;

    MockUSDC internal usdc;
    MockErc8004 internal registry;
    PolicyWalletFactory internal factory;
    PolicyWallet internal wallet;

    address internal operator = makeAddr("operator");
    uint256 internal agentKey;
    address internal agent;
    address internal payee = makeAddr("payee");
    address internal stranger = makeAddr("stranger");

    uint256 private _nonceSeq;

    function setUp() public virtual {
        vm.warp(1_760_000_000); // a realistic timestamp
        (agent, agentKey) = makeAddrAndKey("agent");
        usdc = new MockUSDC();
        registry = new MockErc8004();
        factory = new PolicyWalletFactory(address(new PolicyWallet(address(usdc), address(registry), address(registry))));
        vm.prank(operator);
        wallet = PolicyWallet(factory.createWallet(agent, "research-bot-01", CAP, DAILY));
        vm.startPrank(operator);
        wallet.setPayee(payee, true);
        wallet.setTask(TASK, TASK_BUDGET);
        vm.stopPrank();
        usdc.mint(address(wallet), 20 * USDC1);
    }

    function _nonce() internal returns (bytes32) {
        return keccak256(abi.encode("nonce", ++_nonceSeq));
    }

    function _authorize(bytes32 nonce, address to, uint256 amount, bytes32 taskId) internal returns (bool) {
        vm.prank(agent);
        return wallet.authorize(nonce, to, amount, 0, block.timestamp + 300, taskId);
    }

    function _digest(address to, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(wallet), to, amount, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}
