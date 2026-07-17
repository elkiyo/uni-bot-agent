// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {RangeVaultArb} from "./RangeVaultArb.sol";

/// @title VaultFactoryArb
/// @notice Arbitrum-specific fork of VaultFactory.sol — kept as its own file, same
/// reasoning as RangeVaultArb.sol: never touches what Celo's VaultFactory already has
/// deployed. Deploys RangeVaultArb instances as EIP-1167 minimal clones.
contract VaultFactoryArb {
    error TokenMismatch();

    address public immutable implementation;
    address public immutable platformConfig;
    address public immutable positionManager;
    address public immutable swapRouter;

    mapping(address => address[]) private _vaultsByOwner;
    address[] public allVaults;

    event VaultCreated(
        address indexed owner, address indexed vault, address pool, address token0, address token1, uint24 fee
    );

    constructor(address _platformConfig, address _positionManager, address _swapRouter) {
        implementation = address(new RangeVaultArb());
        platformConfig = _platformConfig;
        positionManager = _positionManager;
        swapRouter = _swapRouter;
    }

    /// @notice Deploy a fresh vault for `msg.sender`, pointed at `pool`. `stableToken`/
    /// `volatileToken` are the caller's intended pair, in either order — Uniswap V3
    /// itself decides which one is actually `token0` (sorted by address, not by which is
    /// the stablecoin), and that order differs per chain: USDT < WETH on Celo, but
    /// WETH < USDC on Arbitrum. Deriving the real order from the pool on-chain (instead
    /// of trusting the caller's order, the previous design) is what makes
    /// `positionManager.mint()` resolve to the right pool at all — passing token0/token1
    /// out of order makes Uniswap's periphery compute a different (nonexistent) pool
    /// address, so initPosition() could never succeed. Confirmed in production
    /// 2026-07-17: the first real Arbitrum vault was created with (stableToken,
    /// volatileToken) blindly assumed to be (token0, token1), silently mismatching the
    /// pool's real order and leaving the vault permanently unable to open a position.
    function createVault(address pool, address stableToken, address volatileToken, uint24 fee)
        external
        returns (address vault)
    {
        address poolToken0 = IUniswapV3Pool(pool).token0();
        address poolToken1 = IUniswapV3Pool(pool).token1();
        bool stableIsToken0;
        if (stableToken == poolToken0 && volatileToken == poolToken1) {
            stableIsToken0 = true;
        } else if (stableToken == poolToken1 && volatileToken == poolToken0) {
            stableIsToken0 = false;
        } else {
            revert TokenMismatch();
        }

        vault = Clones.clone(implementation);
        RangeVaultArb(vault).initialize(
            msg.sender, platformConfig, pool, poolToken0, poolToken1, stableIsToken0, fee, positionManager, swapRouter
        );

        _vaultsByOwner[msg.sender].push(vault);
        allVaults.push(vault);

        emit VaultCreated(msg.sender, vault, pool, poolToken0, poolToken1, fee);
    }

    function getVaultsByOwner(address ownerAddr) external view returns (address[] memory) {
        return _vaultsByOwner[ownerAddr];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
