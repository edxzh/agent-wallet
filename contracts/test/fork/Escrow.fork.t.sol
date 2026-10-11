// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../../src/PolicyWalletFactory.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {IJobEscrow} from "../../src/IJobEscrow.sol";

interface IUSDCFork {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function blacklister() external view returns (address);
    function blacklist(address) external;
    function unBlacklist(address) external;
}

/// 004: against the real Base Sepolia USDC (FiatToken v2.2), a job funded by a PolicyWallet's
/// authorized digest opens through the escrow's own transferWithAuthorization call (ERC-1271),
/// and closes paying the worker. Nothing is broadcast. Skipped when RPC_URL is unset.
contract EscrowForkTest is Test {
    IUSDCFork constant USDC = IUSDCFork(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    bytes32 constant TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    address constant IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant REPUTATION = 0x8004B663056A597Dffe9eCcC1965A193B7388713;
    // research-bot-01: holds the demo's test USDC. Impersonated on the fork only; nothing is broadcast.
    address constant FUNDER = 0xC788272Fe9c76810ef1bA2539B56822405eDb0Fc;

    PolicyWallet wallet;
    JobEscrow escrow;
    address agent;
    uint256 agentKey;
    address worker = makeAddr("worker");
    bool noRpc;

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noRpc = true;
            return;
        }
        vm.createSelectFork(rpc);
        if (USDC.balanceOf(FUNDER) < 100_000) {
            noRpc = true;
            return;
        }
        (agent, agentKey) = makeAddrAndKey("agent");
        PolicyWalletFactory factory =
            new PolicyWalletFactory(address(new PolicyWallet(address(USDC), IDENTITY, REPUTATION)));
        wallet = PolicyWallet(factory.createWallet(agent, "fork", 1e6, 5e6));
        escrow = new JobEscrow(address(USDC));
        wallet.setPayee(address(escrow), true); // this test contract is the operator
        wallet.setPayee(worker, true);
        vm.prank(FUNDER);
        USDC.transfer(address(wallet), 100_000);
    }

    function _params(bytes32 nonce, uint256 amount) internal view returns (IJobEscrow.OpenParams memory) {
        uint256 validBefore = block.timestamp + 300;
        bytes32 structHash =
            keccak256(abi.encode(TYPEHASH, address(wallet), address(escrow), amount, 0, validBefore, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(agentKey, keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash)));
        return IJobEscrow.OpenParams({
            client: address(wallet),
            nonce: nonce,
            amount: amount,
            validBefore: validBefore,
            signature: abi.encodePacked(r, s, v),
            worker: worker,
            workerHasClaim: false,
            workerAgentId: 0,
            arbiter: address(this),
            deliverBy: uint64(block.timestamp + 1 days),
            reviewWindow: 2 hours,
            disputeWindow: 3 days,
            specHash: keccak256("fork spec")
        });
    }

    function test_fork_jobOpensThroughRealUsdc_AndPaysWorker() public {
        vm.skip(noRpc);
        if (noRpc) return;
        bytes32 nonce = keccak256("fork-escrow-1");
        vm.prank(agent);
        assertTrue(wallet.authorize(nonce, address(escrow), 10_000, 0, block.timestamp + 300, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, 10_000);
        vm.prank(agent);
        (bool opened, bytes32 jobId) = escrow.open(p);
        assertTrue(opened);
        assertEq(USDC.balanceOf(address(escrow)), 10_000);

        vm.prank(worker);
        escrow.deliver(jobId, keccak256("fork result"));
        vm.prank(agent);
        escrow.accept(jobId);
        assertEq(USDC.balanceOf(worker), 10_000);
        assertEq(USDC.balanceOf(address(escrow)), 0);
    }

    /// Security review F1 on Circle's real token: a blacklisted worker's payout is owed, not stuck,
    /// and paid once Circle lifts the blacklist (the blacklister is impersonated on the fork only).
    function test_fork_blacklistedWorker_PayoutOwedThenWithdrawn() public {
        vm.skip(noRpc);
        if (noRpc) return;
        bytes32 nonce = keccak256("fork-escrow-3");
        vm.prank(agent);
        assertTrue(wallet.authorize(nonce, address(escrow), 10_000, 0, block.timestamp + 300, bytes32(0)));
        IJobEscrow.OpenParams memory p = _params(nonce, 10_000);
        vm.prank(agent);
        (, bytes32 jobId) = escrow.open(p);
        vm.prank(worker);
        escrow.deliver(jobId, keccak256("fork result"));

        address blacklister = USDC.blacklister();
        vm.prank(blacklister);
        USDC.blacklist(worker);
        vm.prank(agent);
        escrow.accept(jobId);
        assertEq(uint8(escrow.job(jobId).status), uint8(IJobEscrow.Status.Closed));
        assertEq(escrow.owed(worker), 10_000);
        assertEq(USDC.balanceOf(worker), 0);
        vm.expectRevert();
        escrow.withdrawOwed(worker);

        vm.prank(blacklister);
        USDC.unBlacklist(worker);
        escrow.withdrawOwed(worker);
        assertEq(USDC.balanceOf(worker), 10_000);
        assertEq(escrow.held(), 0);
    }

    function test_fork_unauthorizedFundingIsRejectedByUsdc() public {
        vm.skip(noRpc);
        if (noRpc) return;
        IJobEscrow.OpenParams memory p = _params(keccak256("fork-escrow-2"), 10_000); // signed, never authorized
        vm.prank(agent);
        vm.expectRevert();
        escrow.open(p);
        assertEq(USDC.balanceOf(address(escrow)), 0);
    }
}
