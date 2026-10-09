// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {PolicyWallet} from "../src/PolicyWallet.sol";
import {PolicyWalletFactory} from "../src/PolicyWalletFactory.sol";

/// Deploys the PolicyWallet implementation and the factory. Base Sepolia only (constitution I).
/// The ERC-8004 registry proxies come from config/erc8004.json (pinned, research R8).
/// forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --private-key $OPERATOR_PRIVATE_KEY
///
/// Wallets are EIP-1167 clones of one implementation, so wallets created by an earlier factory
/// keep the earlier code: recreate them from the new factory to get feature 002's rules.
contract Deploy is Script {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external returns (address implementation, address factory) {
        require(block.chainid == 84532, "Base Sepolia (84532) only");
        string memory cfg = vm.readFile(string.concat(vm.projectRoot(), "/../config/erc8004.json"));
        address identity = vm.parseJsonAddress(cfg, ".identity.proxy");
        address reputation = vm.parseJsonAddress(cfg, ".reputation.proxy");
        require(identity.code.length > 0 && reputation.code.length > 0, "ERC-8004 registries not found");
        vm.startBroadcast();
        implementation = address(new PolicyWallet(USDC, identity, reputation));
        factory = address(new PolicyWalletFactory(implementation));
        vm.stopBroadcast();
        console2.log("implementation", implementation);
        console2.log("factory", factory);
    }
}
