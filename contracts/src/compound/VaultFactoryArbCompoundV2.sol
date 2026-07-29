// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {RangeVaultArbCompoundV2} from "./RangeVaultArbCompoundV2.sol";

/// @title VaultFactoryArbCompoundV2
/// @notice Fork of VaultFactoryArbCompound.sol that clones RangeVaultArbCompoundV2
/// (adds ownerRebalance()) instead of RangeVaultArbCompound — kept as its own file
/// so the existing VaultFactoryArbCompound.sol (and every vault already cloned
/// from it) is never touched.
contract VaultFactoryArbCompoundV2 {
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
        implementation = address(new RangeVaultArbCompoundV2());
        platformConfig = _platformConfig;
        positionManager = _positionManager;
        swapRouter = _swapRouter;
    }

    /// @notice Same token0/token1-order derivation as VaultFactoryArb.sol — see
    /// that contract's own docstring for why this is derived from the pool
    /// on-chain instead of trusted from the caller.
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
        RangeVaultArbCompoundV2(vault).initialize(
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
