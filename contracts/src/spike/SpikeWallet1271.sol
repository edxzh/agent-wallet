// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title SpikeWallet1271 (T010, Base Sepolia test only)
/// @notice Minimal contract wallet for the payment-design test (research R2): it holds USDC and
/// accepts an EIP-3009 authorization signed by its agent key via ERC-1271. It has no spending
/// rules; it only answers whether the x402 facilitator settles payments from a contract payer.
contract SpikeWallet1271 is IERC1271 {
    using SafeERC20 for IERC20;

    address public immutable agent;
    address public immutable deployer;

    constructor(address agent_) {
        require(block.chainid == 84532, "Base Sepolia only");
        require(agent_ != address(0), "zero agent");
        agent = agent_;
        deployer = msg.sender;
    }

    /// Valid iff `signature` is a plain ECDSA signature of `digest` by the agent key.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        return err == ECDSA.RecoverError.NoError && signer == agent ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    /// Returns leftover test tokens to the deployer after the test.
    function sweep(IERC20 token) external {
        require(msg.sender == deployer, "only deployer");
        token.safeTransfer(deployer, token.balanceOf(address(this)));
    }
}
