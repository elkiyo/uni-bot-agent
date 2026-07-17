// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys PlatformConfig + VaultFactory to Celo mainnet. RangeVault's
/// implementation is deployed automatically inside VaultFactory's constructor
/// (see VaultFactory.sol) — every vault is a clone of that one instance.
///
/// Signer-agnostic: uses `vm.startBroadcast()` with no explicit key, so the
/// actual signer comes from whatever `forge script` CLI flags you pass
/// (--ledger --sender ..., --private-key ..., --account ..., etc).
///
/// Required env vars: CELO_RPC_URL, PLATFORM_OWNER (your Ledger/Safe address —
/// becomes PlatformConfig's direct owner via Ownable2Step; can be handed off
/// to a multisig or a timelock later with transferOwnership(), no redeploy
/// needed — see PLAN.md), DEFAULT_OPERATOR (the platform's keeper wallet —
/// see PLAN.md "Los 3 roles del sistema"), MAX_DEPOSIT_USD (6 decimals, hard
/// cap per vault while unaudited — see PLAN.md "Riesgos"),
/// PERFORMANCE_FEE_BPS (basis points cut of LP trading fees, e.g. 1_000 =
/// 10%), CREATION_FEE_USDT (one-time fee charged on a vault's first
/// deposit(), 6 decimals, default 0 = disabled), TREASURY (where
/// CREATION_FEE_USDT lands — defaults to PLATFORM_OWNER if unset).
///
/// NOTE if this is a re-deploy replacing an existing PlatformConfig (e.g. to
/// pick up a new RangeVault feature via a fresh VaultFactory): this always
/// deploys a BRAND NEW PlatformConfig too, starting fresh from these env
/// vars/defaults rather than copying the currently-live contract's values —
/// pass MAX_DEPOSIT_USD/PERFORMANCE_FEE_BPS/CREATION_FEE_USDT/TREASURY
/// explicitly if you want continuity with whatever's already in production.
///
/// Usage (Ledger):
///   forge script script/Deploy.s.sol:Deploy --rpc-url $CELO_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
contract Deploy is Script {
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant POSITION_MANAGER = 0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A;
    address constant SWAP_ROUTER02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    function run() external {
        address platformOwner = vm.envAddress("PLATFORM_OWNER");
        address defaultOperator = vm.envAddress("DEFAULT_OPERATOR");
        uint256 maxDepositUsd = vm.envOr("MAX_DEPOSIT_USD", uint256(1_000_000_000)); // 1,000 USDT default cap
        uint256 performanceFeeBps = vm.envOr("PERFORMANCE_FEE_BPS", uint256(1_000)); // 10% default
        uint256 creationFeeUsdt = vm.envOr("CREATION_FEE_USDT", uint256(0)); // disabled by default
        address treasury = vm.envOr("TREASURY", platformOwner);

        vm.startBroadcast();

        PlatformConfig config = new PlatformConfig(
            platformOwner, USDT, defaultOperator, maxDepositUsd, performanceFeeBps, creationFeeUsdt, treasury
        );

        VaultFactory factory = new VaultFactory(address(config), POSITION_MANAGER, SWAP_ROUTER02);

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
