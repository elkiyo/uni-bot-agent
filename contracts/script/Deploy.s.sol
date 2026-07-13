// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys PlatformConfig + VaultFactory to Celo mainnet. RangeVault's
/// implementation is deployed automatically inside VaultFactory's constructor
/// (see VaultFactory.sol) — every vault is a clone of that one instance.
///
/// Required env vars: DEPLOYER_PRIVATE_KEY, CELO_RPC_URL,
/// PLATFORM_OWNER (defaults to the deployer), DEFAULT_OPERATOR (the keeper wallet),
/// REBALANCE_FEE_USDT (6 decimals, e.g. 1_000_000 = 1 USDT),
/// MAX_DEPOSIT_USD (6 decimals, hard cap per vault while unaudited — see PLAN.md "Riesgos").
///
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url $CELO_RPC_URL \
///     --private-key $DEPLOYER_PRIVATE_KEY --broadcast --verify
contract Deploy is Script {
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant POSITION_MANAGER = 0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A;
    address constant SWAP_ROUTER02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address constant UNILAB_PAYMENT_WALLET = 0x4B53D27c81f9E842D50a1940E27B8009B64c615B;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address platformOwner = vm.envOr("PLATFORM_OWNER", deployer);
        address defaultOperator = vm.envAddress("DEFAULT_OPERATOR");
        uint256 rebalanceFee = vm.envOr("REBALANCE_FEE_USDT", uint256(1_000_000)); // 1 USDT default
        uint256 maxDepositUsd = vm.envOr("MAX_DEPOSIT_USD", uint256(1_000_000_000)); // 1,000 USDT default cap

        vm.startBroadcast(deployerKey);

        PlatformConfig config =
            new PlatformConfig(platformOwner, USDT, defaultOperator, rebalanceFee, maxDepositUsd);

        VaultFactory factory =
            new VaultFactory(address(config), POSITION_MANAGER, SWAP_ROUTER02, UNILAB_PAYMENT_WALLET);

        vm.stopBroadcast();

        console.log("PlatformConfig:", address(config));
        console.log("VaultFactory:  ", address(factory));
        console.log("RangeVault impl:", factory.implementation());
        console.log("");
        console.log("Set these in agent/.env:");
        console.log("FACTORY_ADDRESS=", address(factory));
        console.log("PLATFORM_CONFIG_ADDRESS=", address(config));
    }
}
