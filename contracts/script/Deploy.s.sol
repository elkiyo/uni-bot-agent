// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";

/// Deploys PlatformConfig + VaultFactory to any EVM chain with a Uniswap V3
/// deployment. RangeVault's implementation is deployed automatically inside
/// VaultFactory's constructor (see VaultFactory.sol) — every vault is a
/// clone of that one instance. RangeVault/PlatformConfig/VaultFactory
/// themselves have no chain-specific logic; only the addresses below differ
/// per chain.
///
/// Signer-agnostic: uses `vm.startBroadcast()` with no explicit key, so the
/// actual signer comes from whatever `forge script` CLI flags you pass
/// (--ledger --sender ..., --private-key ..., --account ..., etc).
///
/// Required env vars: PLATFORM_OWNER (your Ledger/Safe address —
/// becomes PlatformConfig's direct owner via Ownable2Step; can be handed off
/// to a multisig or a timelock later with transferOwnership(), no redeploy
/// needed — see autorange.md), DEFAULT_OPERATOR (the platform's keeper wallet —
/// see autorange.md "Los 3 roles del sistema"), MAX_DEPOSIT_USD (6 decimals, hard
/// cap per vault while unaudited — see autorange.md "Riesgos"),
/// PERFORMANCE_FEE_BPS (basis points cut of LP trading fees, e.g. 1_000 =
/// 10%), CREATION_FEE_USDT (one-time fee charged on a vault's first
/// deposit(), 6 decimals, default 0 = disabled), TREASURY (where
/// CREATION_FEE_USDT lands — defaults to PLATFORM_OWNER if unset).
///
/// Chain-specific env vars — default to Celo mainnet's addresses if unset, so
/// the existing Celo deploy flow needs nothing new; pass all three explicitly
/// for any other chain: STABLE_TOKEN (the pool's token0 — USDT on Celo, USDC
/// on Arbitrum; RangeVault never assumes USDT specifically, it's just
/// whichever token the vault's pool pairs against the volatile leg),
/// POSITION_MANAGER (that chain's Uniswap V3 NonfungiblePositionManager),
/// SWAP_ROUTER02 (that chain's Uniswap V3 SwapRouter02).
///
/// NOTE if this is a re-deploy replacing an existing PlatformConfig (e.g. to
/// pick up a new RangeVault feature via a fresh VaultFactory): this always
/// deploys a BRAND NEW PlatformConfig too, starting fresh from these env
/// vars/defaults rather than copying the currently-live contract's values —
/// pass MAX_DEPOSIT_USD/PERFORMANCE_FEE_BPS/CREATION_FEE_USDT/TREASURY
/// explicitly if you want continuity with whatever's already in production.
///
/// Usage (Ledger, Celo):
///   forge script script/Deploy.s.sol:Deploy --rpc-url $CELO_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
///
/// Usage (Ledger, Arbitrum — verified addresses, 2026-07-17):
///   STABLE_TOKEN=0xaf88d065e77c8cC2239327C5EDb3A432268e5831 \
///   POSITION_MANAGER=0xC36442b4a4522E871399CD717aBDD847Ab11FE88 \
///   SWAP_ROUTER02=0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 \
///     forge script script/Deploy.s.sol:Deploy --rpc-url $ARBITRUM_RPC_URL \
///     --ledger --sender $PLATFORM_OWNER --broadcast
contract Deploy is Script {
    // Celo mainnet defaults — used when the chain-specific env vars below are
    // unset, so a plain `forge script ... --rpc-url $CELO_RPC_URL` keeps
    // working exactly as before this became multichain.
    address constant USDT_CELO = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant POSITION_MANAGER_CELO = 0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A;
    address constant SWAP_ROUTER02_CELO = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;

    function run() external {
        address platformOwner = vm.envAddress("PLATFORM_OWNER");
        address defaultOperator = vm.envAddress("DEFAULT_OPERATOR");
        uint256 maxDepositUsd = vm.envOr("MAX_DEPOSIT_USD", uint256(1_000_000_000)); // 1,000 USDT default cap
        uint256 performanceFeeBps = vm.envOr("PERFORMANCE_FEE_BPS", uint256(1_000)); // 10% default
        uint256 creationFeeUsdt = vm.envOr("CREATION_FEE_USDT", uint256(0)); // disabled by default
        address treasury = vm.envOr("TREASURY", platformOwner);

        address stableToken = vm.envOr("STABLE_TOKEN", USDT_CELO);
        address positionManager = vm.envOr("POSITION_MANAGER", POSITION_MANAGER_CELO);
        address swapRouter02 = vm.envOr("SWAP_ROUTER02", SWAP_ROUTER02_CELO);

        vm.startBroadcast();

        PlatformConfig config = new PlatformConfig(
            platformOwner, stableToken, defaultOperator, maxDepositUsd, performanceFeeBps, creationFeeUsdt, treasury
        );

        VaultFactory factory = new VaultFactory(address(config), positionManager, swapRouter02);

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
