// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../src/PolicyWalletFactory.sol";

/// Deploys the PolicyWallet implementation and the factory. Base Sepolia only (constitution I).
/// forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --private-key $OPERATOR_PRIVATE_KEY
contract Deploy is Script {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (address implementation, address factory) {
        require(block.chainid == 84532, "Base Sepolia (84532) only");
        vm.startBroadcast();
        implementation = address(new PolicyWallet(USDC));
        factory = address(new PolicyWalletFactory(implementation));
        vm.stopBroadcast();
        console2.log("implementation", implementation);
        console2.log("factory", factory);
    }
}
