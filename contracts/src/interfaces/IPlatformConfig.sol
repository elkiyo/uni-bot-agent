// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Read-only view a RangeVault needs from PlatformConfig. Kept as a narrow
/// interface (instead of importing the concrete contract) so RangeVault only depends
/// on the three values it actually reads live on every rebalance.
interface IPlatformConfig {
    function rebalanceFee() external view returns (uint256);
    function feeToken() external view returns (address);
    function defaultOperator() external view returns (address);
    function maxDepositUsd() external view returns (uint256);
    function performanceFeeBps() external view returns (uint256);
}
