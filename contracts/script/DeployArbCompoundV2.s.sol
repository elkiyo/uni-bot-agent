// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {VaultFactoryArbCompoundV2} from "../src/compound/VaultFactoryArbCompoundV2.sol";

/// Deploys VaultFactoryArbCompoundV2 to Arbitrum — same as
/// VaultFactoryArbCompound, plus `ownerRebalance()` on the vault
/// implementation (see RangeVaultArbCompoundV2.sol's class docstring).
/// Separate from DeployArbCompound.s.sol, which stays exactly what it was
/// before this fork existed and keeps deploying the plain
/// VaultFactoryArbCompound every already-live compound vault was cloned from.
///
/// Same as DeployArbCompound.s.sol: does NOT deploy a fresh PlatformConfig —
/// this factory points at the SAME already-live PlatformConfig, passed in
/// directly via env var rather than redeployed.
///
/// Signer-agnostic: uses `vm.startBroadcast()` with no explicit key, so the
/// actual signer comes from whatever `forge script` CLI flags you pass
/// (--ledger --sender ..., --private-key ..., --account ..., etc). NOTE:
/// `forge script --ledger` has a known bug in this environment (hidapi
/// error, see CLAUDE.md's "Deploys con Ledger") — use the
/// `forge inspect ... bytecode` + `cast abi-encode` + `cast send --ledger
/// --create` workaround documented there instead.
///
/// Required env vars: PLATFORM_CONFIG (the existing live Arbitrum
/// PlatformConfig address — same one DeployArbCompound.s.sol used),
/// POSITION_MANAGER (Arbitrum's Uniswap V3 NonfungiblePositionManager),
/// SWAP_ROUTER02 (Arbitrum's Uniswap V3 SwapRouter02).
///
/// Usage (Ledger, verified addresses, same as DeployArbCompound.s.sol):
///   PLATFORM_CONFIG=<existing PlatformConfig address> \
///   POSITION_MANAGER=0xC36442b4a4522E871399CD717aBDD847Ab11FE88 \
///   SWAP_ROUTER02=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
///     forge script script/DeployArbCompoundV2.s.sol:DeployArbCompoundV2 --rpc-url $ARBITRUM_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
contract DeployArbCompoundV2 is Script {
    function run() external {
        address platformConfig = vm.envAddress("PLATFORM_CONFIG");
        address positionManager = vm.envAddress("POSITION_MANAGER");
        address swapRouter02 = vm.envAddress("SWAP_ROUTER02");

        vm.startBroadcast();

        VaultFactoryArbCompoundV2 factory = new VaultFactoryArbCompoundV2(platformConfig, positionManager, swapRouter02);

        vm.stopBroadcast();

        console.log("VaultFactoryArbCompoundV2:   ", address(factory));
        console.log("RangeVaultArbCompoundV2 impl:", factory.implementation());
        console.log("Reused PlatformConfig:       ", platformConfig);
        console.log("");
        console.log("Set this in Vercel (NEXT_PUBLIC_COMPOUND_FACTORY_ADDRESS_ARBITRUM):");
        console.log("COMPOUND_FACTORY_ADDRESS=", address(factory));
        console.log("");
        console.log("Also update chains.ts's ARBITRUM.compoundFactoryDeployBlock to this");
        console.log("deployment's block number (see the tx receipt).");
    }
}
