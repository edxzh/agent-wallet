// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IPolicyWalletFactory} from "./IPolicyWallet.sol";
import {PolicyWallet} from "./PolicyWallet.sol";

/// @title PolicyWalletFactory
/// @notice Creates EIP-1167 clones of one PolicyWallet implementation. The caller becomes the
/// wallet's operator, the only account allowed to change its rules.
contract PolicyWalletFactory is IPolicyWalletFactory {
    address public immutable implementation;

    constructor(address implementation_) {
        require(implementation_.code.length > 0, "no implementation");
        implementation = implementation_;
    }

    /// @inheritdoc IPolicyWalletFactory
    function createWallet(address agent, string calldata name, uint256 perPaymentCap, uint256 dailyBudget)
        external
        returns (address wallet)
    {
        wallet = Clones.clone(implementation);
        PolicyWallet(wallet).initialize(msg.sender, agent, name, perPaymentCap, dailyBudget);
        emit WalletCreated(wallet, msg.sender, agent, name);
    }
}
