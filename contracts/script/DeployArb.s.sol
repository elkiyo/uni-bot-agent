// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactoryArb} from "../src/VaultFactoryArb.sol";

/// Deploys PlatformConfig + VaultFactoryArb to Arbitrum. Separate from Deploy.s.sol
/// (which stays exactly what it was before RangeVaultArb/VaultFactoryArb existed,
/// deploying the original RangeVault/VaultFactory Celo already runs) — see
/// RangeVaultArb.sol's class docstring for why this fork exists at all.
///
/// PlatformConfig itself is unchanged/shared source (no Arbitrum-specific logic —
/// it's just per-chain config data), but THIS script always deploys a brand new
/// instance for Arbitrum, independent of whatever Celo's PlatformConfig currently has.
///
/// Signer-agnostic: uses `vm.startBroadcast()` with no explicit key, so the
/// actual signer comes from whatever `forge script` CLI flags you pass
/// (--ledger --sender ..., --private-key ..., --account ..., etc).
///
/// Required env vars: PLATFORM_OWNER (your Ledger/Safe address — becomes
/// PlatformConfig's direct owner via Ownable2Step), DEFAULT_OPERATOR (the
/// platform's keeper wallet), STABLE_TOKEN (Arbitrum USDC), POSITION_MANAGER
/// (Arbitrum's Uniswap V3 NonfungiblePositionManager), SWAP_ROUTER02
/// (Arbitrum's Uniswap V3 SwapRouter02). Optional: MAX_DEPOSIT_USD (6
/// decimals, default 1,000 USDC), PERFORMANCE_FEE_BPS (default 1,000 = 10%),
/// CREATION_FEE_USDT (6 decimals, default 0 = disabled), TREASURY (defaults
/// to PLATFORM_OWNER).
///
/// Usage (Ledger, verified addresses, 2026-07-17):
///   STABLE_TOKEN=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
///   POSITION_MANAGER=0xC36442b4a4522E871399CD717aBDD847Ab11FE88 \
///   SWAP_ROUTER02=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
///     forge script script/DeployArb.s.sol:DeployArb --rpc-url $ARBITRUM_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
contract DeployArb is Script {
    function run() external {
        address platformOwner = vm.envAddress("PLATFORM_OWNER");
        address defaultOperator = vm.envAddress("DEFAULT_OPERATOR");
        address stableToken = vm.envAddress("STABLE_TOKEN");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address swapRouter02 = vm.envAddress("SWAP_ROUTER02");

        uint256 maxDepositUsd = vm.envOr("MAX_DEPOSIT_USD", uint256(1_000_000_000)); // 1,000 USDC default cap
        uint256 performanceFeeBps = vm.envOr("PERFORMANCE_FEE_BPS", uint256(1_000)); // 10% default
        uint256 creationFeeUsdt = vm.envOr("CREATION_FEE_USDT", uint256(0)); // disabled by default
        address treasury = vm.envOr("TREASURY", platformOwner);

        vm.startBroadcast();

        PlatformConfig config = new PlatformConfig(
            platformOwner, stableToken, defaultOperator, maxDepositUsd, performanceFeeBps, creationFeeUsdt, treasury
        );

        VaultFactoryArb factory = new VaultFactoryArb(address(config), positionManager, swapRouter02);

        vm.stopBroadcast();

        console.log("PlatformConfig:      ", address(config));
        console.log("VaultFactoryArb:     ", address(factory));
        console.log("RangeVaultArb impl:  ", factory.implementation());
        console.log("");
        console.log("Set these in Vercel (NEXT_PUBLIC_*_ARBITRUM):");
        console.log("FACTORY_ADDRESS=", address(factory));
        console.log("PLATFORM_CONFIG_ADDRESS=", address(config));
    }
}
