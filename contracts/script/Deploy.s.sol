// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {SwapContract} from "../src/SwapContract.sol";

/**
 * @notice Deploy SwapContract to Base Sepolia (or any EVM chain).
 *
 * Usage:
 *   PRIVATE_KEY=0x... forge script script/Deploy.s.sol \
 *     --rpc-url https://sepolia.base.org --broadcast
 *
 * After it runs, copy the printed address into app/lib/contract.js
 * (CONTRACT_ADDRESS) and the printed block into CONTRACT_DEPLOY_BLOCK so the
 * order-book log scan starts at deploy, not genesis.
 */
contract Deploy is Script {
    function run() external returns (SwapContract swap) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        swap = new SwapContract();
        vm.stopBroadcast();

        console.log("SwapContract deployed at:", address(swap));
        console.log("-> set CONTRACT_ADDRESS in app/lib/contract.js");
        console.log("-> set CONTRACT_DEPLOY_BLOCK to:", block.number);
    }
}
