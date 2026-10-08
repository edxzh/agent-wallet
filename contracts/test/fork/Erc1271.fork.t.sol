// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {PolicyWallet} from "../../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../../src/PolicyWalletFactory.sol";

interface IUSDC {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
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

/// T016: against the real Base Sepolia USDC (FiatToken v2.2), a PolicyWallet's authorized digest,
/// signed by the agent key, settles through ERC-1271; an unauthorized one does not.
/// Skipped when RPC_URL is unset.
contract Erc1271ForkTest is Test {
    IUSDC constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    bytes32 constant TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    address constant FUNDER = 0xc6E78B511c87688BC33C9db7539E5E0334B2Ad59; // demo operator, holds test USDC

    PolicyWallet wallet;
    address agent;
    uint256 agentKey;
    address payee = makeAddr("payee");
    bool noRpc;

    function setUp() public {
        string memory rpc = vm.envOr("RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            noRpc = true;
            return;
        }
        vm.createSelectFork(rpc);
        // Funded by impersonating the demo operator; skip rather than fail if it has run low.
        if (USDC.balanceOf(FUNDER) < 100_000) {
            noRpc = true;
            return;
        }
        (agent, agentKey) = makeAddrAndKey("agent");
        PolicyWalletFactory factory = new PolicyWalletFactory(address(new PolicyWallet(address(USDC))));
        wallet = PolicyWallet(factory.createWallet(agent, "fork", 1e6, 5e6));
        wallet.setPayee(payee, true); // this test contract is the operator
        vm.prank(FUNDER);
        USDC.transfer(address(wallet), 100_000);
    }

    function _digest(bytes32 nonce, uint256 amount, uint256 validBefore) internal view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(TYPEHASH, address(wallet), payee, amount, 0, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), structHash));
    }

    function _sig(bytes32 digest) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_fork_authorizedPaymentSettlesThroughRealUsdc() public {
        vm.skip(noRpc);
        if (noRpc) return;
        bytes32 nonce = keccak256("fork-nonce-1");
        uint256 validBefore = block.timestamp + 300;
        vm.prank(agent);
        assertTrue(wallet.authorize(nonce, payee, 10_000, 0, validBefore, bytes32(0)));

        USDC.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, _sig(_digest(nonce, 10_000, validBefore)));
        assertEq(USDC.balanceOf(payee), 10_000);
        assertTrue(USDC.authorizationState(address(wallet), nonce));
    }

    function test_fork_unauthorizedPaymentIsRejectedByUsdc() public {
        vm.skip(noRpc);
        if (noRpc) return;
        bytes32 nonce = keccak256("fork-nonce-2");
        uint256 validBefore = block.timestamp + 300;
        bytes memory sig = _sig(_digest(nonce, 10_000, validBefore)); // agent-signed, but never authorized
        vm.expectRevert();
        USDC.transferWithAuthorization(address(wallet), payee, 10_000, 0, validBefore, nonce, sig);
        assertEq(USDC.balanceOf(payee), 0);
    }
}
