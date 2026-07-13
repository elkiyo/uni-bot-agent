// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {RangeVault} from "./RangeVault.sol";

/// @title VaultFactory
/// @notice Deploys RangeVault instances as EIP-1167 minimal clones. This is what makes
/// uni-bot-agent a platform rather than a single hand-run vault: anyone can call
/// createVault() to get their own non-custodial vault pointed at the platform's
/// operator. See PLAN.md ("Los 3 roles del sistema" / "Plataforma pública completa").
contract VaultFactory {
    address public immutable implementation;
    address public immutable platformConfig;
    address public immutable positionManager;
    address public immutable swapRouter;
    address public immutable uniLabPaymentWallet;

    mapping(address => address[]) private _vaultsByOwner;
    address[] public allVaults;

    event VaultCreated(
        address indexed owner, address indexed vault, address pool, address token0, address token1, uint24 fee
    );

    constructor(
        address _platformConfig,
        address _positionManager,
        address _swapRouter,
        address _uniLabPaymentWallet
    ) {
        implementation = address(new RangeVault());
        platformConfig = _platformConfig;
        positionManager = _positionManager;
        swapRouter = _swapRouter;
        uniLabPaymentWallet = _uniLabPaymentWallet;
    }

    /// @notice Deploy a fresh vault for `msg.sender`, pointed at `pool` (token0/token1/fee
    /// must match the pool's own values — the caller supplies them so the vault doesn't
    /// need to make an extra call back into the pool during initialize()).
    function createVault(address pool, address token0, address token1, uint24 fee)
        external
        returns (address vault)
    {
        vault = Clones.clone(implementation);
        RangeVault(vault).initialize(
            msg.sender, platformConfig, pool, token0, token1, fee, positionManager, swapRouter, uniLabPaymentWallet
        );

        _vaultsByOwner[msg.sender].push(vault);
        allVaults.push(vault);

        emit VaultCreated(msg.sender, vault, pool, token0, token1, fee);
    }

    function getVaultsByOwner(address ownerAddr) external view returns (address[] memory) {
        return _vaultsByOwner[ownerAddr];
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
