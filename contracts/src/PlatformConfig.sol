// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformConfig
/// @notice Central, live-read configuration for the uni-bot-agent platform. Every
/// RangeVault reads rebalanceFee/defaultOperator/maxDepositUsd from here at call time
/// instead of copying them at creation — so the platform owner can adjust pricing and
/// risk limits for every vault at once. See PLAN.md ("Los 3 roles del sistema") for
/// why this is a separate contract from RangeVault: it is the *platform's* knob, not
/// something an individual vault owner or the operator can touch.
contract PlatformConfig is Ownable2Step {
    /// @notice Fee (in `feeToken` units) paid to a vault's operator per successful rebalance.
    uint256 public rebalanceFee;

    /// @notice Token `rebalanceFee` and `maxDepositUsd` are denominated in — USDT on Celo.
    address public feeToken;

    /// @notice Where uni-lab.xyz payments and vault operations expect the operator to be
    /// paid from by default. New vaults use this as their initial `operator` unless the
    /// vault owner overrides it later via RangeVault.setOperator().
    address public defaultOperator;

    /// @notice Global cap on total USDT a single vault may hold, while RangeVault is
    /// unaudited (see PLAN.md "Riesgos"). Zero means "no cap" — kept non-zero deliberately
    /// for the hackathon.
    uint256 public maxDepositUsd;

    event RebalanceFeeUpdated(uint256 newFee);
    event FeeTokenUpdated(address newToken);
    event DefaultOperatorUpdated(address newOperator);
    event MaxDepositUsdUpdated(uint256 newMax);

    constructor(
        address initialOwner,
        address _feeToken,
        address _defaultOperator,
        uint256 _rebalanceFee,
        uint256 _maxDepositUsd
    ) Ownable(initialOwner) {
        require(_feeToken != address(0), "feeToken=0");
        require(_defaultOperator != address(0), "defaultOperator=0");
        feeToken = _feeToken;
        defaultOperator = _defaultOperator;
        rebalanceFee = _rebalanceFee;
        maxDepositUsd = _maxDepositUsd;
    }

    function setRebalanceFee(uint256 newFee) external onlyOwner {
        rebalanceFee = newFee;
        emit RebalanceFeeUpdated(newFee);
    }

    function setFeeToken(address newToken) external onlyOwner {
        require(newToken != address(0), "feeToken=0");
        feeToken = newToken;
        emit FeeTokenUpdated(newToken);
    }

    function setDefaultOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "operator=0");
        defaultOperator = newOperator;
        emit DefaultOperatorUpdated(newOperator);
    }

    function setMaxDepositUsd(uint256 newMax) external onlyOwner {
        maxDepositUsd = newMax;
        emit MaxDepositUsdUpdated(newMax);
    }
}
