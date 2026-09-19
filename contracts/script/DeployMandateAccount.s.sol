// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MandateAccount} from "../src/MandateAccount.sol";

/// Deploys ONE non-upgradeable MandateAccount (the frozen section 6 interface) and
/// records its address for the SDK. Accounts are deployed first on every chain, because
/// each mandate grant needs that chain's account address before the owner signs.
///
/// This script reads NO key material. Signing comes from the CLI:
///   local anvil:  --rpc-url $ANVIL_RPC --unlocked --sender <anvil account>
///   testnet:      --rpc-url $SEPOLIA_RPC_URL --private-key $DEPLOYER_PRIVATE_KEY
/// The written file contains the chain id, the account address and the owner address only.
contract DeployMandateAccount is Script {
    function run() external returns (MandateAccount account) {
        // OWNER_ADDRESS is the user's own wallet. When unset (or empty in .env) it falls
        // back to the broadcaster, so no key or address has to be hard-coded anywhere.
        string memory configured = vm.envOr("OWNER_ADDRESS", string(""));
        address owner = bytes(configured).length == 0 ? msg.sender : vm.parseAddress(configured);
        require(owner != address(0), "OWNER_ADDRESS must not be zero");

        vm.startBroadcast();
        account = new MandateAccount(owner);
        vm.stopBroadcast();

        // Address-only record; the SDK adapter reads this per chain.
        vm.createDir("./deployments", true);
        string memory json = vm.serializeUint("usl", "chainId", block.chainid);
        json = vm.serializeAddress("usl", "mandateAccount", address(account));
        json = vm.serializeAddress("usl", "owner", owner);
        vm.writeJson(json, string.concat("./deployments/", vm.toString(block.chainid), ".json"));

        // Prove the deployed code answers the frozen interface before reporting success.
        require(account.owner() == owner, "deployed owner mismatch");
        console.log("MandateAccount deployed at", address(account));
        console.log("Owner (the user's signing wallet)", owner);
        console.log("Chain id", block.chainid);
    }
}
