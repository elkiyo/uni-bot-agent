// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformConfig
/// @notice Central, live-read configuration for the uni-bot-agent platform. Every
/// RangeVault reads performanceFeeBps/defaultOperator/maxDepositUsd from here at call
/// time instead of copying them at creation — so the platform owner can adjust pricing
/// and risk limits for every vault at once. See autorange.md ("Los 3 roles del sistema") for
/// why this is a separate contract from RangeVault: it is the *platform's* knob, not
/// something an individual vault owner or the operator can touch.
///
/// No more flat rebalanceFee (removed 2026-07-16): the platform's only revenue now is
/// performanceFeeBps, a cut of LP trading fees actually earned — the flat per-rebalance
/// fee used to come straight out of a vault's investable capital regardless of whether
/// the vault had earned anything, which is what a stuck vault (100%-WETH position, zero
/// USDT to pay a fee denominated in USDT) got stuck on in production. performanceFeeBps
/// only ever takes a cut of real yield, never principal.
contract PlatformConfig is Ownable2Step {
    /// @notice Token `maxDepositUsd` is denominated in — USDT on Celo.
    address public feeToken;

    /// @notice Where uni-lab.xyz payments and vault operations expect the operator to be
    /// paid from by default. New vaults use this as their initial `operator` unless the
    /// vault owner overrides it later via RangeVault.setOperator().
    address public defaultOperator;

    /// @notice Global cap on total USDT a single vault may hold, while RangeVault is
    /// unaudited (see autorange.md "Riesgos"). Zero means "no cap" — kept non-zero deliberately
    /// for the hackathon.
    uint256 public maxDepositUsd;

    /// @notice Cut of every LP trading fee the platform takes before the rest reaches
    /// the vault owner — applied both when rebalance() pays out accrued fees and when
    /// the owner calls collectFees() directly (same source of money either way, so
    /// exempting one would just be a way to dodge the other). Basis points, e.g. 1000
    /// = 10%. Read live at payout time — adjustable without touching any vault.
    uint256 public performanceFeeBps;

    /// @notice One-time fee (token0/USDT, 6 decimals) charged on a vault's first
    /// deposit() — separate from performanceFeeBps, which only ever taxes yield.
    /// This is a flat cost of onboarding, paid once per vault, on top of whatever
    /// the owner deposits (never carved out of investableUsdt/reserveBalance).
    /// Zero means no creation fee.
    uint256 public creationFeeUsdt;

    /// @notice Where creationFeeUsdt lands — deliberately separate from
    /// defaultOperator, so platform-level onboarding revenue doesn't mix with the
    /// keeper's own operating wallet.
    address public treasury;

    event FeeTokenUpdated(address newToken);
    event DefaultOperatorUpdated(address newOperator);
    event MaxDepositUsdUpdated(uint256 newMax);
    event PerformanceFeeBpsUpdated(uint256 newFeeBps);
    event CreationFeeUsdtUpdated(uint256 newFee);
    event TreasuryUpdated(address newTreasury);

    constructor(
        address initialOwner,
        address _feeToken,
        address _defaultOperator,
        uint256 _maxDepositUsd,
        uint256 _performanceFeeBps,
        uint256 _creationFeeUsdt,
        address _treasury
    ) Ownable(initialOwner) {
        require(_feeToken != address(0), "feeToken=0");
        require(_defaultOperator != address(0), "defaultOperator=0");
        require(_performanceFeeBps <= 10_000, "performanceFeeBps>100%");
        require(_treasury != address(0), "treasury=0");
        feeToken = _feeToken;
        defaultOperator = _defaultOperator;
        maxDepositUsd = _maxDepositUsd;
        performanceFeeBps = _performanceFeeBps;
        creationFeeUsdt = _creationFeeUsdt;
        treasury = _treasury;
    }

    function setPerformanceFeeBps(uint256 newFeeBps) external onlyOwner {
        require(newFeeBps <= 10_000, "performanceFeeBps>100%");
        performanceFeeBps = newFeeBps;
        emit PerformanceFeeBpsUpdated(newFeeBps);
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

    function setCreationFeeUsdt(uint256 newFee) external onlyOwner {
        creationFeeUsdt = newFee;
        emit CreationFeeUsdtUpdated(newFee);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "treasury=0");
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }
}
