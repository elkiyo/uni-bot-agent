// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VaultFactoryArbCompound} from "../src/compound/VaultFactoryArbCompound.sol";

/// Deploys VaultFactoryArbCompound to Arbitrum — the interest-compounding +
/// flexible-deposit fork of VaultFactoryArb/RangeVaultArb (see
/// RangeVaultArbCompound.sol's class docstring). Separate from DeployArb.s.sol,
/// which stays exactly what it was before this fork existed and keeps
/// deploying the plain VaultFactoryArb every already-live standard vault was
/// cloned from.
///
/// Unlike DeployArb.s.sol, this does NOT deploy a fresh PlatformConfig —
/// compounding doesn't change platform economics (performanceFeeBps/treasury/
/// maxDepositUsd), so this factory points at the SAME already-live
/// PlatformConfig the standard Arbitrum factory uses, passed in directly via
/// env var rather than redeployed.
///
/// Signer-agnostic: uses `vm.startBroadcast()` with no explicit key, so the
/// actual signer comes from whatever `forge script` CLI flags you pass
/// (--ledger --sender ..., --private-key ..., --account ..., etc).
///
/// Required env vars: PLATFORM_CONFIG (the existing live Arbitrum
/// PlatformConfig address — see DeployArb.s.sol's own deploy log),
/// POSITION_MANAGER (Arbitrum's Uniswap V3 NonfungiblePositionManager),
/// SWAP_ROUTER02 (Arbitrum's Uniswap V3 SwapRouter02) — same values
/// DeployArb.s.sol used, since this points at the identical USDC/WETH pool
/// infrastructure, just a different vault implementation.
///
/// Usage (Ledger, verified addresses, same as DeployArb.s.sol):
///   PLATFORM_CONFIG=<existing PlatformConfig address> \
///   POSITION_MANAGER=0xC36442b4a4522E871399CD717aBDD847Ab11FE88 \
///   SWAP_ROUTER02=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
///     forge script script/DeployArbCompound.s.sol:DeployArbCompound --rpc-url $ARBITRUM_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
contract DeployArbCompound is Script {
    function run() external {
        address platformConfig = vm.envAddress("PLATFORM_CONFIG");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address swapRouter02 = vm.envAddress("SWAP_ROUTER02");

        vm.startBroadcast();

        VaultFactoryArbCompound factory = new VaultFactoryArbCompound(platformConfig, positionManager, swapRouter02);

        vm.stopBroadcast();

        console.log("VaultFactoryArbCompound:   ", address(factory));
        console.log("RangeVaultArbCompound impl:", factory.implementation());
        console.log("Reused PlatformConfig:     ", platformConfig);
        console.log("");
        console.log("Set this in Vercel (NEXT_PUBLIC_COMPOUND_FACTORY_ADDRESS_ARBITRUM):");
        console.log("COMPOUND_FACTORY_ADDRESS=", address(factory));
        console.log("");
        console.log("Also update chains.ts's ARBITRUM.compoundFactoryDeployBlock to this");
        console.log("deployment's block number (see the tx receipt), replacing the");
        console.log("current placeholder value copied from the standard factory.");
    }
}
