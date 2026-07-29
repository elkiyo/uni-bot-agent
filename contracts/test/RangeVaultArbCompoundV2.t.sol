// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactoryArbCompoundV2} from "../src/compound/VaultFactoryArbCompoundV2.sol";
import {RangeVaultArbCompoundV2} from "../src/compound/RangeVaultArbCompoundV2.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Fork tests against real Arbitrum mainnet, for RangeVaultArbCompoundV2 /
/// VaultFactoryArbCompoundV2 — same setup as RangeVaultArbCompound.t.sol
/// (which this suite doesn't touch, still covers V1 on its own). Only tests
/// what's NEW or CHANGED in V2: ownerRebalance(), the 4-bucket withdraw()
/// split, increasePositionWithToken(), and uncountedInvestable. Behavior
/// inherited unchanged from V1 (collectFees/harvestFees/depositToken/etc.)
/// stays covered by RangeVaultArbCompound.t.sol alone — no need to duplicate
/// it here.
contract RangeVaultArbCompoundV2Test is Test {
    address constant POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0; // USDC/WETH 0.05%
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // real token1 here
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // real token0 here
    address constant USDT0 = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9; // third-party stable, for increasePositionWithToken()
    uint24 constant USDT0_USDC_FEE = 500;
    address constant POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    address platformOwner = makeAddr("platformOwner");
    address defaultOperator = makeAddr("defaultOperator");
    address treasury = makeAddr("treasury");
    address lp = makeAddr("lp");
    address stranger = makeAddr("stranger");

    PlatformConfig config;
    VaultFactoryArbCompoundV2 factory;
    RangeVaultArbCompoundV2 vault;
    IUniswapV3Pool pool = IUniswapV3Pool(POOL);
    int24 tickSpacing;

    uint256 constant MAX_DEPOSIT_USD = 20_000_000_000;
    uint256 constant PERFORMANCE_FEE_BPS = 1_000; // 10%

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_RPC_URL"));
        vm.txGasPrice(0.05 gwei);
        tickSpacing = pool.tickSpacing();

        config =
            new PlatformConfig(platformOwner, USDC, defaultOperator, MAX_DEPOSIT_USD, PERFORMANCE_FEE_BPS, 0, treasury);
        factory = new VaultFactoryArbCompoundV2(address(config), POSITION_MANAGER, SWAP_ROUTER02);

        vm.prank(lp);
        address v = factory.createVault(POOL, USDC, WETH, 500);
        vault = RangeVaultArbCompoundV2(v);

        deal(USDC, lp, 2_000_000_000); // 2,000 USDC (6 decimals)
        vm.prank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers — same conventions as RangeVaultArbCompound.t.sol
    // ---------------------------------------------------------------------

    function _currentTick() internal view returns (int24 tick) {
        (, tick,,,,,) = pool.slot0();
    }

    function _alignedRangeAroundMarket(uint256 widthTicks) internal view returns (int24 lower, int24 upper) {
        int24 tick = _currentTick();
        int24 half = int24(uint24(widthTicks / 2));
        lower = ((tick - half) / tickSpacing) * tickSpacing;
        upper = ((tick + half) / tickSpacing) * tickSpacing;
        if (lower == upper) upper += tickSpacing;
    }

    /// maxRebalances=5, minRebalanceInterval=0, periodicRebalanceInterval=1
    /// day — deliberately 0 cooldown so ownerRebalance()'s own cooldown
    /// bypass isn't accidentally masked by a nonzero default; tests that
    /// specifically want a cooldown set it explicitly via setRiskParams.
    function _openPosition() internal returns (int24 lower, int24 upper) {
        (lower, upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 50_000_000, investableAmount: 945_000_000, gasReserveAmount: 5_000_000});
        vault.configureTarget({
            investmentAmountUsd: 945_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 10_000_000,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300,
            _feeClaimThresholdBps: 200,
            _feeClaimIntervalSeconds: 1 days
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVaultArbCompoundV2.SwapInstruction memory initSwap = RangeVaultArbCompoundV2.SwapInstruction({
            token0ToToken1: false,
            amountIn: 475_000_000,
            amountOutMinimum: 0,
            fee: 500
        });
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);
    }

    function _generateTradingFees() internal {
        address trader = makeAddr("trader");
        deal(USDC, trader, 500_000_000_000);
        vm.startPrank(trader);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: trader,
                amountIn: 500_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        uint256 wethBal = IERC20(WETH).balanceOf(trader);
        IERC20(WETH).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDC,
                fee: 500,
                recipient: trader,
                amountIn: wethBal,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    function _generateTradingFeesStableLegOnly() internal {
        address trader = makeAddr("traderStableOnly");
        deal(USDC, trader, 500_000_000_000);
        vm.startPrank(trader);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: trader,
                amountIn: 500_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    function _noSwap() internal pure returns (RangeVaultArbCompoundV2.SwapInstruction memory) {
        return RangeVaultArbCompoundV2.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});
    }

    function _toStableUsdRef(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint256 step1 = (amount0 * sqrtPriceX96) >> 96;
        uint256 converted0 = (step1 * sqrtPriceX96) >> 96;
        return amount1 + converted0;
    }

    function _lastLogData(Vm.Log[] memory logs, address emitter, string memory eventSig)
        internal
        pure
        returns (bytes memory data)
    {
        bytes32 topic0 = keccak256(bytes(eventSig));
        for (uint256 i = logs.length; i > 0; i--) {
            Vm.Log memory log = logs[i - 1];
            if (log.emitter == emitter && log.topics.length > 0 && log.topics[0] == topic0) {
                return log.data;
            }
        }
        revert("event not found in recorded logs");
    }

    // ---------------------------------------------------------------------
    // ownerRebalance() — new in V2
    // ---------------------------------------------------------------------

    function test_ownerRebalance_onlyOwner() public {
        _openPosition();
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompoundV2.NotOwner.selector);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
    }

    function test_ownerRebalance_respectsCooldown() public {
        _openPosition();
        vm.prank(lp);
        vault.setRiskParams(500, 1 days, 500);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.TooSoonToRebalance.selector);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
    }

    function test_ownerRebalance_respectsRebalanceLimitReached() public {
        _openPosition(); // maxRebalances = 5, minRebalanceInterval = 0
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(lp);
            vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        }
        assertEq(vault.rebalanceCount(), 5);
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.RebalanceLimitReached.selector);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
    }

    /// The core new behavior: unlike rebalance(), ownerRebalance() must
    /// succeed even when the position is still comfortably in range and no
    /// periodic cycle is due yet.
    function test_ownerRebalance_skipsInRangeGate() public {
        _openPosition();
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        // Sanity: plain rebalance() would revert here — nothing due, still in range.
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVaultArbCompoundV2.TooSoonToRebalance.selector);
        vault.rebalance(lower2, upper2, _noSwap(), 0, 0, 0);

        vm.prank(lp);
        uint256 newTokenId = vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        assertGt(newTokenId, 0);
    }

    function test_ownerRebalance_noGasReimbursement() public {
        _openPosition();
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        uint256 gasReserveBefore = vault.gasReserveBalance();

        vm.recordLogs();
        vm.prank(lp);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 gasReimbursedTopic0 = keccak256("KeeperGasReimbursed(uint256,uint256,uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0) {
                assertTrue(logs[i].topics[0] != gasReimbursedTopic0, "ownerRebalance must never emit KeeperGasReimbursed");
            }
        }
        assertEq(vault.gasReserveBalance(), gasReserveBefore, "gas reserve must be untouched");
    }

    function test_ownerRebalance_reinjectsFeesWhenAutoCompoundOn() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();

        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        uint256 newTokenId = vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);

        assertEq(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should get nothing when compounding");
        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should get nothing when compounding");
        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(newTokenId);
        assertGt(liquidityAfter, 0, "new position should have real liquidity, including the folded-in fees");
    }

    function test_ownerRebalance_paysOwnerFeesWhenAutoCompoundOff() public {
        _openPosition();
        _generateTradingFees();

        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);

        assertTrue(
            IERC20(USDC).balanceOf(lp) > lpUsdcBefore || IERC20(WETH).balanceOf(lp) > lpWethBefore,
            "owner should still be paid when compounding is off"
        );
    }

    function test_ownerRebalance_alsoTracksUncountedInvestable() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        assertEq(pendingBefore, 20_000_000);

        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.recordLogs();
        vm.prank(lp);
        vault.ownerRebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "Rebalanced(uint256,int24,int24,uint256,uint256)");
        (,, , uint256 consumedUncounted) = abi.decode(data, (int24, int24, uint256, uint256));
        assertEq(consumedUncounted, pendingBefore, "the whole pending top-up should fold in and get counted");
        assertEq(vault.uncountedInvestable(), 0);
    }

    // ---------------------------------------------------------------------
    // withdraw() — split into 4 independent buckets
    // ---------------------------------------------------------------------

    function test_withdraw_invalidShareBps_allFourZero_reverts() public {
        _openPosition();
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.InvalidShareBps.selector);
        vault.withdraw(0, 0, 0, 0);
    }

    function test_withdraw_invalidShareBps_anyOver10000_reverts() public {
        _openPosition();
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.InvalidShareBps.selector);
        vault.withdraw(0, 10_001, 0, 0);
    }

    function test_withdraw_fourIndependentBuckets() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});

        uint256 investableBefore = vault.investableUsdt();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 gasBefore = vault.gasReserveBalance();
        assertGt(investableBefore, 0);
        assertGt(reserveBefore, 0);
        assertGt(gasBefore, 0);

        // Only the investable bucket — reserve and gas must stay untouched.
        vm.prank(lp);
        vault.withdraw(0, 5_000, 0, 0);

        assertEq(vault.investableUsdt(), investableBefore - (investableBefore * 5_000) / 10_000);
        assertEq(vault.reserveBalance(), reserveBefore, "reserve bucket must be untouched");
        assertEq(vault.gasReserveBalance(), gasBefore, "gas bucket must be untouched");
    }

    function test_withdraw_distinctBpsPerBucket_inOneCall() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});

        uint256 investableBefore = vault.investableUsdt();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 gasBefore = vault.gasReserveBalance();

        vm.prank(lp);
        vault.withdraw(0, 2_000, 4_000, 6_000); // 20% / 40% / 60% — all different

        assertEq(vault.investableUsdt(), investableBefore - (investableBefore * 2_000) / 10_000);
        assertEq(vault.reserveBalance(), reserveBefore - (reserveBefore * 4_000) / 10_000);
        assertEq(vault.gasReserveBalance(), gasBefore - (gasBefore * 6_000) / 10_000);
    }

    /// Port of RangeVaultArbCompound.t.sol's own
    /// test_Withdrawn_principalUsd_excludesFeesAndReserve, updated for the
    /// 4-arg signature — principalUsd must count position principal +
    /// investable share, excluding fees, reserve share, AND gas share.
    function test_Withdrawn_principalUsd_excludesFeesAndReserveAndGas() public {
        _openPosition();
        _generateTradingFeesStableLegOnly();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 investableBefore = vault.investableUsdt();
        assertGt(reserveBefore, 0, "sanity: _openPosition left a nonzero reserve to try to wrongly include");
        assertEq(vault.uncountedInvestable(), 0, "sanity: nothing pending in this scenario, no top-up happened");

        (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        uint128 expectedPartialLiquidity = uint128((uint256(liquidity) * 5_000) / 10_000);

        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(5_000, 5_000, 5_000, 5_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory decreaseLiqData =
            _lastLogData(logs, POSITION_MANAGER, "DecreaseLiquidity(uint256,uint128,uint256,uint256)");
        (uint128 loggedLiquidity, uint256 removed0, uint256 removed1) =
            abi.decode(decreaseLiqData, (uint128, uint256, uint256));
        assertEq(loggedLiquidity, expectedPartialLiquidity, "sanity: decoded the right DecreaseLiquidity log");

        bytes memory withdrawnData = _lastLogData(logs, address(vault), "Withdrawn(uint256,uint256,uint256)");
        (,, uint256 principalUsd) = abi.decode(withdrawnData, (uint256, uint256, uint256));

        uint256 investableShare = (investableBefore * 5_000) / 10_000;
        uint256 expectedPrincipalUsd = _toStableUsdRef(removed0, removed1) + investableShare;
        assertEq(
            principalUsd,
            expectedPrincipalUsd,
            "principalUsd should be exactly position-principal + investable share, excluding reserve/gas shares"
        );
    }

    // ---------------------------------------------------------------------
    // increasePositionWithToken() — new in V2
    // ---------------------------------------------------------------------

    function test_increasePositionWithToken_onlyOwner() public {
        _openPosition();
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompoundV2.NotOwner.selector);
        vault.increasePositionWithToken(USDC, 1, 0, 0, _noSwap(), 1, 0, 0);
    }

    function test_increasePositionWithToken_revertsNoPosition() public {
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.NoPosition.selector);
        vault.increasePositionWithToken(USDC, 1, 0, 0, _noSwap(), 1, 0, 0);
    }

    function test_increasePositionWithToken_sellsThirdPartyTokenIntoStable_thenFoldsIntoPosition() public {
        _openPosition();
        uint256 usdt0Amount = 50_000_000;
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());

        vm.prank(lp);
        vault.increasePositionWithToken(USDT0, usdt0Amount, USDT0_USDC_FEE, 45_000_000, _noSwap(), 45_000_000, 0, 0);

        assertEq(IERC20(USDT0).balanceOf(address(vault)), 0, "all USDT0 should be sold, none held directly");
        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore, "liquidity should increase from the folded-in swap proceeds");
    }

    function test_increasePositionWithToken_revertsBelowAmountOutMinimum() public {
        _openPosition();
        uint256 usdt0Amount = 50_000_000;
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        vm.prank(lp);
        vm.expectRevert(); // Uniswap's router reverts with "Too little received"
        vault.increasePositionWithToken(
            USDT0, usdt0Amount, USDT0_USDC_FEE, 1_000_000_000_000, _noSwap(), 45_000_000, 0, 0
        );
    }

    function test_increasePositionWithToken_respectsPlatformCap() public {
        _openPosition();
        uint256 usdt0Amount = 50_000_000;
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV2.DepositExceedsPlatformCap.selector);
        vault.increasePositionWithToken(USDT0, usdt0Amount, USDT0_USDC_FEE, 0, _noSwap(), MAX_DEPOSIT_USD + 1, 0, 0);
    }

    /// tokenIn == the vault's own stable degrades to a no-swap passthrough —
    /// behaves the same as calling increasePosition() directly.
    function test_increasePositionWithToken_stableTokenInPassthrough() public {
        _openPosition();
        uint256 usdcAmount = 50_000_000; // lp already holds plenty from setUp, no extra deal() needed

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());

        vm.prank(lp);
        vault.increasePositionWithToken(USDC, usdcAmount, 0, 0, _noSwap(), usdcAmount, 0, 0);

        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore, "stable tokenIn should pass through with no swap and still fold in");
    }

    // ---------------------------------------------------------------------
    // uncountedInvestable — new in V2
    // ---------------------------------------------------------------------

    function test_uncountedInvestable_zeroBeforePositionExists() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        assertEq(vault.uncountedInvestable(), 0, "no position yet -> nothing pending, counts immediately instead");
    }

    function test_Deposited_positionAlreadyExists_falseBeforeInit() public {
        vm.recordLogs();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        bytes memory data = _lastLogData(vm.getRecordedLogs(), address(vault), "Deposited(uint256,uint256,uint256,bool)");
        (,,, bool positionAlreadyExists) = abi.decode(data, (uint256, uint256, uint256, bool));
        assertFalse(positionAlreadyExists);
    }

    function test_uncountedInvestable_incrementsOnDepositAfterPositionExists() public {
        _openPosition();
        vm.recordLogs();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});

        assertEq(vault.uncountedInvestable(), 20_000_000);

        bytes memory data = _lastLogData(vm.getRecordedLogs(), address(vault), "Deposited(uint256,uint256,uint256,bool)");
        (,,, bool positionAlreadyExists) = abi.decode(data, (uint256, uint256, uint256, bool));
        assertTrue(positionAlreadyExists);
    }

    function test_uncountedInvestable_consumedOnRebalance() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        assertEq(pendingBefore, 20_000_000);

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        vm.recordLogs();
        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "Rebalanced(uint256,int24,int24,uint256,uint256)");
        (,, , uint256 consumedUncounted) = abi.decode(data, (int24, int24, uint256, uint256));
        assertEq(consumedUncounted, pendingBefore, "the entire pending top-up should fold in and get counted this cycle");
        assertEq(vault.uncountedInvestable(), 0);
    }

    /// A stable-only top-up with no swap can only fold in as much as the
    /// position's CURRENT tick-range ratio allows (increaseLiquidity is
    /// constrained by whatever tiny volatile dust the vault happens to
    /// hold) — it need not be fully consumed in one cycle. See
    /// test_uncountedInvestable_partialConsumption for the same property at
    /// a larger, unambiguously-partial scale.
    function test_uncountedInvestable_consumedOnSweepIdleDust() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();

        vm.recordLogs();
        vm.prank(defaultOperator);
        vault.sweepIdleDust(_noSwap(), 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "IdleDustSwept(uint256,uint256,uint256)");
        (,, uint256 consumedUncounted) = abi.decode(data, (uint256, uint256, uint256));
        assertGt(consumedUncounted, 0, "some real pending capital should have folded in");
        assertLe(consumedUncounted, pendingBefore, "can never consume more than what was pending");
        assertEq(vault.uncountedInvestable(), pendingBefore - consumedUncounted);
    }

    function test_uncountedInvestable_consumedOnIncreasePosition() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        assertEq(pendingBefore, 20_000_000);

        vm.recordLogs();
        vm.prank(lp);
        vault.increasePosition(_noSwap(), 10_000_000, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "PositionIncreased(uint256,uint256,uint256,uint256)");
        (,,, uint256 consumedUncounted) = abi.decode(data, (uint256, uint256, uint256, uint256));
        assertLe(consumedUncounted, pendingBefore + 10_000_000, "can never consume more than what was ever pending");
        assertGt(consumedUncounted, 0, "some real pending capital should have folded in");
        assertEq(
            vault.uncountedInvestable(),
            pendingBefore + 10_000_000 - consumedUncounted,
            "remaining pending should equal what didn't get folded this cycle"
        );
    }

    /// A big, deliberately lopsided stable-only top-up (no matching volatile,
    /// no swap) — increaseLiquidity()'s own ratio constraint can only use
    /// part of it, leaving a real leftover for a future cycle to pick up.
    function test_uncountedInvestable_partialConsumption() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 500_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        assertEq(pendingBefore, 500_000_000);

        vm.recordLogs();
        vm.prank(defaultOperator);
        vault.sweepIdleDust(_noSwap(), 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "IdleDustSwept(uint256,uint256,uint256)");
        (,, uint256 consumedUncounted) = abi.decode(data, (uint256, uint256, uint256));

        assertLt(consumedUncounted, pendingBefore, "a lopsided stable-only top-up shouldn't fully fold in one cycle");
        assertGt(vault.uncountedInvestable(), 0, "leftover pending should persist for a future cycle");
        assertEq(vault.uncountedInvestable(), pendingBefore - consumedUncounted);
    }

    function test_uncountedInvestable_withdrawShrinksProportionally() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        uint256 investableBefore = vault.investableUsdt();

        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(0, 5_000, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 expectedUncountedShare = (pendingBefore * 5_000) / 10_000;
        uint256 expectedInvestableShare = (investableBefore * 5_000) / 10_000;
        assertEq(
            vault.uncountedInvestable(), pendingBefore - expectedUncountedShare, "uncounted should shrink proportionally"
        );

        bytes memory data = _lastLogData(logs, address(vault), "Withdrawn(uint256,uint256,uint256)");
        (,, uint256 principalUsd) = abi.decode(data, (uint256, uint256, uint256));
        assertEq(
            principalUsd,
            expectedInvestableShare - expectedUncountedShare,
            "principalUsd should exclude the still-uncounted portion"
        );
    }

    function test_uncountedInvestable_withdrawAll_excludesFromPrincipalUsd_andZeroesLedger() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        uint256 investableBefore = vault.investableUsdt();
        assertGt(pendingBefore, 0);

        vm.recordLogs();
        vm.prank(lp);
        vault.withdrawAll();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(vault.uncountedInvestable(), 0, "full exit must zero uncountedInvestable");
        assertEq(vault.investableUsdt(), 0);
        assertEq(vault.reserveBalance(), 0);
        assertEq(vault.gasReserveBalance(), 0);

        bytes memory decreaseLiqData =
            _lastLogData(logs, POSITION_MANAGER, "DecreaseLiquidity(uint256,uint128,uint256,uint256)");
        (, uint256 removed0, uint256 removed1) = abi.decode(decreaseLiqData, (uint128, uint256, uint256));

        bytes memory withdrawnData = _lastLogData(logs, address(vault), "Withdrawn(uint256,uint256,uint256)");
        (,, uint256 principalUsd) = abi.decode(withdrawnData, (uint256, uint256, uint256));

        uint256 expectedPrincipalUsd = _toStableUsdRef(removed0, removed1) + (investableBefore - pendingBefore);
        assertEq(principalUsd, expectedPrincipalUsd, "principalUsd should exclude the still-uncounted investable portion");
    }

    function test_uncountedInvestable_reinitAfterFullWithdraw_countsImmediatelyAgain() public {
        _openPosition();
        vm.prank(lp);
        vault.withdrawAll();
        assertEq(vault.positionTokenId(), 0);
        assertEq(vault.uncountedInvestable(), 0);

        vm.recordLogs();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "Deposited(uint256,uint256,uint256,bool)");
        (,,, bool positionAlreadyExists) = abi.decode(data, (uint256, uint256, uint256, bool));
        assertFalse(positionAlreadyExists, "after a full exit, the next deposit should count immediately again");
        assertEq(vault.uncountedInvestable(), 0, "should NOT be tracked as pending, counts immediately instead");
    }

    /// Property-style: run a scripted sequence of every function that can
    /// touch investableUsdt/uncountedInvestable and assert the invariant
    /// holds after EVERY single call — this is the test that would have
    /// caught the "increment by declared amount, not measured amount" bug.
    function test_uncountedInvestable_invariant_neverExceedsInvestableUsdt() public {
        _openPosition();
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(lp);
        vault.deposit({reserveAmount: 10_000_000, investableAmount: 30_000_000, gasReserveAmount: 0});
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        // Real swap (not _noSwap()) — the position's near-depleted volatile
        // dust (353 wei of WETH left after _openPosition's own mint) can't
        // support a meaningful increaseLiquidity() on its own; without
        // buying some WETH first, LiquidityAmounts computes 0 liquidity and
        // the pool's mint() reverts. Mirrors _openPosition()'s own ~50%
        // split via initSwap.
        RangeVaultArbCompoundV2.SwapInstruction memory increaseSwap = RangeVaultArbCompoundV2.SwapInstruction({
            token0ToToken1: false,
            amountIn: 7_500_000,
            amountOutMinimum: 0,
            fee: 500
        });
        vm.prank(lp);
        vault.increasePosition(increaseSwap, 15_000_000, 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(defaultOperator);
        vault.sweepIdleDust(_noSwap(), 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), 0, 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 40_000_000, gasReserveAmount: 0});
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(lp);
        vault.withdraw(0, 3_000, 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());
    }

    // ---------------------------------------------------------------------
    // Interaction: feature 1 (withdraw split) x feature 4 (uncountedInvestable)
    // ---------------------------------------------------------------------

    function test_withdraw_and_uncountedInvestable_combined() public {
        _openPosition();
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 20_000_000, gasReserveAmount: 0});
        uint256 pendingBefore = vault.uncountedInvestable();
        uint256 investableBefore = vault.investableUsdt();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 gasBefore = vault.gasReserveBalance();

        vm.prank(lp);
        vault.withdraw(0, 2_500, 1_000, 0); // 25% investable, 10% reserve, 0% gas — fully independent

        assertEq(vault.reserveBalance(), reserveBefore - (reserveBefore * 1_000) / 10_000);
        assertEq(vault.gasReserveBalance(), gasBefore, "gas untouched (0 bps)");
        uint256 expectedInvestableShare = (investableBefore * 2_500) / 10_000;
        assertEq(vault.investableUsdt(), investableBefore - expectedInvestableShare);
        uint256 expectedUncountedShare = (pendingBefore * 2_500) / 10_000;
        assertEq(vault.uncountedInvestable(), pendingBefore - expectedUncountedShare);
    }
}
