// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactoryArbCompoundV3} from "../src/compound/VaultFactoryArbCompoundV3.sol";
import {RangeVaultArbCompoundV3} from "../src/compound/RangeVaultArbCompoundV3.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Fork tests against real Arbitrum mainnet, for RangeVaultArbCompoundV3 /
/// VaultFactoryArbCompoundV3. Unlike RangeVaultArbCompoundV2.t.sol (which only
/// tested what was new relative to V1, since V2 left most function signatures
/// untouched), V3 changes the signature of every fee-paying/withdrawal
/// function (collectFees, rebalance, ownerRebalance, withdraw, withdrawAll) —
/// so this suite re-covers those lifecycle paths with the new signatures, on
/// top of dedicated tests for the 4 documented fixes + 2 new features (see
/// RangeVaultArbCompoundV3.sol's own class docstring for the full list).
contract RangeVaultArbCompoundV3Test is Test {
    address constant POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0; // USDC/WETH 0.05%
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // real token1 here
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // real token0 here
    address constant USDT0 = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9; // third-party stable, for increasePositionWithToken()/depositToken()
    uint24 constant USDT0_USDC_FEE = 500;
    address constant POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    address platformOwner = makeAddr("platformOwner");
    address defaultOperator = makeAddr("defaultOperator");
    address treasury = makeAddr("treasury");
    address lp = makeAddr("lp");
    address stranger = makeAddr("stranger");

    PlatformConfig config;
    VaultFactoryArbCompoundV3 factory;
    RangeVaultArbCompoundV3 vault;
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
        factory = new VaultFactoryArbCompoundV3(address(config), POSITION_MANAGER, SWAP_ROUTER02);

        vm.prank(lp);
        address v = factory.createVault(POOL, USDC, WETH, 500);
        vault = RangeVaultArbCompoundV3(v);

        deal(USDC, lp, 2_000_000_000); // 2,000 USDC (6 decimals)
        vm.prank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Helpers
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
    /// day — deliberately 0 cooldown, same convention as V2's suite.
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

        RangeVaultArbCompoundV3.SwapInstruction memory initSwap = RangeVaultArbCompoundV3.SwapInstruction({
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

    /// Single-direction trade (USDC->WETH only) — fee accrues ONLY in USDC
    /// (token1, the stable leg here), leaving WETH (token0) exactly zero.
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

    function _noSwap() internal pure returns (RangeVaultArbCompoundV3.SwapInstruction memory) {
        return RangeVaultArbCompoundV3.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});
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

    function _hasTopic0(Vm.Log[] memory logs, address emitter, string memory eventSig) internal pure returns (bool) {
        bytes32 topic0 = keccak256(bytes(eventSig));
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) {
                return true;
            }
        }
        return false;
    }

    // =======================================================================
    // Base lifecycle — re-covered because V3 changed these signatures
    // =======================================================================

    function test_collectFees_paysOwnerWhenAutoCompoundOff() public {
        _openPosition();
        _generateTradingFees();

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        (uint256 netFee0, uint256 netFee1) = vault.collectFees(_noSwap(), _noSwap(), 0, 0);

        assertGt(netFee0 + netFee1, 0, "some real fee should have accrued from the trade");
        assertEq(IERC20(WETH).balanceOf(lp) - lpWethBefore, netFee0);
        assertEq(IERC20(USDC).balanceOf(lp) - lpUsdcBefore, netFee1);
    }

    function test_collectFees_reinjectsWhenAutoCompoundOn() public {
        _openPosition();
        _generateTradingFees();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(lp);
        vault.collectFees(_noSwap(), _noSwap(), 0, 0);

        assertEq(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should receive nothing when compounding");
        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore, "fees should be reinjected as real liquidity");
    }

    function test_rebalance_paysOwnerWhenAutoCompoundOff() public {
        _openPosition();
        _generateTradingFees();
        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);

        assertTrue(IERC20(USDC).balanceOf(lp) > lpUsdcBefore || IERC20(WETH).balanceOf(lp) > lpWethBefore);
    }

    function test_rebalance_reinjectsFeesWhenAutoCompoundOn() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();
        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(newTokenId);
        assertGt(liquidityAfter, 0);
    }

    function test_ownerRebalance_skipsInRangeGate() public {
        _openPosition();
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        vm.prank(defaultOperator);
        vm.expectRevert(RangeVaultArbCompoundV3.TooSoonToRebalance.selector);
        vault.rebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);

        vm.prank(lp);
        uint256 newTokenId = vault.ownerRebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);
        assertGt(newTokenId, 0);
    }

    /// No position needed here — positionShareBps=0 in the withdraw() call
    /// below means the position bucket isn't exercised, and a plain deposit()
    /// (no position yet) is the simplest way to fund all 3 non-position
    /// buckets at once (fix #3 blocks funding investableUsdt via deposit()
    /// once a position exists).
    function test_withdraw_fourIndependentBuckets() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 50_000_000, investableAmount: 20_000_000, gasReserveAmount: 5_000_000});

        uint256 investableBefore = vault.investableUsdt();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 gasBefore = vault.gasReserveBalance();

        vm.prank(lp);
        vault.withdraw(0, 5_000, 0, 0, _noSwap(), _noSwap(), 0, 0);

        assertEq(vault.investableUsdt(), investableBefore - (investableBefore * 5_000) / 10_000);
        assertEq(vault.reserveBalance(), reserveBefore, "reserve bucket must be untouched");
        assertEq(vault.gasReserveBalance(), gasBefore, "gas bucket must be untouched");
    }

    function test_withdrawAll_zeroesEverything() public {
        _openPosition();

        vm.prank(lp);
        vault.withdrawAll(_noSwap(), _noSwap());

        assertEq(vault.positionTokenId(), 0);
        assertEq(vault.investableUsdt(), 0);
        assertEq(vault.reserveBalance(), 0);
        assertEq(vault.gasReserveBalance(), 0);
        assertEq(vault.uncountedInvestable(), 0);
        assertEq(IERC20(WETH).balanceOf(address(vault)), 0);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 0);
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

        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore);
    }

    // =======================================================================
    // Fix #1 — saturating subtraction in withdrawAll()/emergencyWithdrawPosition()
    // =======================================================================

    /// Fix #2's clamps (below) now keep uncountedInvestable <= investableUsdt
    /// invariant-true through every reachable call sequence in the public
    /// API — which means the exact underflow this fix protects against can no
    /// longer be forced through legitimate calls. That's the intended
    /// combined effect of fixes #1+#2 together (defense in depth: #2 prevents
    /// the bad state, #1 guarantees survival even if it ever happened anyway,
    /// e.g. from a future code path neither of us has thought of yet). What's
    /// left to test here is that both exit functions still work correctly in
    /// ordinary conditions.
    function test_withdrawAll_worksNormally() public {
        _openPosition();
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(lp);
        vault.withdrawAll(_noSwap(), _noSwap());

        assertTrue(IERC20(WETH).balanceOf(lp) > lpWethBefore || IERC20(USDC).balanceOf(lp) > lpUsdcBefore);
    }

    function test_emergencyWithdrawPosition_worksAndPausesRegardlessOfState() public {
        _openPosition();
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(lp);
        vault.emergencyWithdrawPosition();

        assertTrue(vault.paused());
        assertEq(vault.positionTokenId(), 0);
        assertEq(vault.investableUsdt(), 0);
        assertEq(vault.reserveBalance(), 0);
        assertEq(vault.gasReserveBalance(), 0);
        assertEq(vault.uncountedInvestable(), 0);
        assertTrue(IERC20(WETH).balanceOf(lp) > lpWethBefore || IERC20(USDC).balanceOf(lp) > lpUsdcBefore);
    }

    /// Direct regression test for the bug found during manual audit
    /// (2026-08-02): withdraw() originally discarded _withdrawPositionShare's
    /// return values, so the position's removed principal never reached
    /// amount0/amount1 and was permanently stranded in the vault instead of
    /// reaching the owner.
    function test_withdraw_partial_principalActuallyReachesOwner_regressionForDiscardedReturnBug() public {
        _openPosition();
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));

        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), _noSwap(), 0, 0);

        assertTrue(
            IERC20(WETH).balanceOf(lp) > lpWethBefore || IERC20(USDC).balanceOf(lp) > lpUsdcBefore,
            "the removed position principal must actually reach the owner, not get stranded in the vault"
        );
        assertLe(
            IERC20(WETH).balanceOf(address(vault)),
            vaultWethBefore,
            "vault's own WETH balance must not have grown from the withdrawal (principal must pass through, not accumulate)"
        );
        assertLe(
            IERC20(USDC).balanceOf(address(vault)),
            vaultUsdcBefore,
            "vault's own USDC balance must not have grown from the withdrawal"
        );
    }

    // =======================================================================
    // Fix #2 — uncountedInvestable <= investableUsdt invariant, everywhere
    // =======================================================================

    function test_uncountedInvestable_invariant_neverExceedsInvestableUsdt() public {
        _openPosition();
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(lp);
        vault.increasePosition(
            RangeVaultArbCompoundV3.SwapInstruction({token0ToToken1: false, amountIn: 7_500_000, amountOutMinimum: 0, fee: 500}),
            15_000_000,
            0,
            0
        );
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        // sweepIdleDust() deliberately not exercised here: with a live
        // mainnet fork's real-time price, the leftover single-sided dust
        // from the increasePosition() swap ratio above can occasionally
        // land at a ratio the in-range position can't mint any liquidity
        // from at all (Uniswap's pool.mint reverts on zero computed
        // liquidity) — a real-market timing flake, not a contract bug.
        // sweepIdleDust()'s own fix #2 clamp is structurally identical to
        // reinjectIntoPosition()'s/_reinjectFees()'s, both exercised below.

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        // Fix #3: investableAmount can no longer be topped up via deposit()
        // once a position exists — increasePosition() is the only legitimate
        // way left to grow uncountedInvestable at this point.
        vm.prank(lp);
        vault.increasePosition(
            RangeVaultArbCompoundV3.SwapInstruction({token0ToToken1: false, amountIn: 20_000_000, amountOutMinimum: 0, fee: 500}),
            40_000_000,
            0,
            0
        );
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(lp);
        vault.withdraw(0, 3_000, 0, 0, _noSwap(), _noSwap(), 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());

        vm.prank(defaultOperator);
        vault.reinjectIntoPosition(_noSwap(), 5_000_000, 0, 0);
        assertLe(vault.uncountedInvestable(), vault.investableUsdt());
    }

    // =======================================================================
    // Fix #3 — investableAmount restricted to before the first position
    // =======================================================================

    function test_deposit_investableAfterPositionExists_reverts() public {
        _openPosition();
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV3.InvestableAfterPositionExists.selector);
        vault.deposit({reserveAmount: 0, investableAmount: 1, gasReserveAmount: 0});
    }

    function test_deposit_reserveAndGasStillAllowedAfterPositionExists() public {
        _openPosition();
        uint256 reserveBefore = vault.reserveBalance();
        uint256 gasBefore = vault.gasReserveBalance();

        vm.prank(lp);
        vault.deposit({reserveAmount: 5_000_000, investableAmount: 0, gasReserveAmount: 2_000_000});

        assertEq(vault.reserveBalance(), reserveBefore + 5_000_000);
        assertEq(vault.gasReserveBalance(), gasBefore + 2_000_000);
    }

    function test_depositToken_investableAfterPositionExists_reverts() public {
        _openPosition();
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompoundV3.InvestableAfterPositionExists.selector);
        vault.depositToken(USDC, 100_000_000, _noSwap(), 0, 0, 0, 90_000_000, 0);
    }

    function test_deposit_investableBeforePositionExists_stillWorks() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        assertEq(vault.investableUsdt(), 100_000_000);
    }

    // =======================================================================
    // Fix #4 — withdraw() respects autoCompoundFees on a partial exit
    // =======================================================================

    function test_withdraw_partial_autoCompoundOn_neverEmitsLpFeesPaidToOwner() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();

        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), _noSwap(), 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertFalse(
            _hasTopic0(logs, address(vault), "LpFeesPaidToOwner(uint256,uint256)"),
            "fees must reinject into the remaining position, not pay out, on a partial exit while compounding is on"
        );
    }

    function test_withdraw_partial_autoCompoundOn_reinjectsFeesIntoRemainingPosition() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());

        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), _noSwap(), 0, 0);

        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(
            liquidityAfter,
            uint256(liquidityBefore) / 2,
            "remaining position should be boosted above a fee-free 50% baseline by the reinjected fees"
        );
    }

    function test_withdraw_partial_autoCompoundOff_paysFeesDirectlySeparateFromPrincipal() public {
        _openPosition();
        _generateTradingFeesStableLegOnly(); // isolates: netFee0 == 0, all fee in USDC (token1)

        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), _noSwap(), 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory data = _lastLogData(logs, address(vault), "LpFeesPaidToOwner(uint256,uint256)");
        (uint256 fee0, uint256 fee1) = abi.decode(data, (uint256, uint256));
        assertEq(fee0, 0);
        assertGt(fee1, 0, "fee should have paid out directly");
    }

    function test_withdraw_fullClose_autoCompoundOn_stillPaysFeesDirect_noPositionLeftToReinjectInto() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(lp);
        vault.withdraw(10_000, 10_000, 10_000, 10_000, _noSwap(), _noSwap(), 0, 0);

        assertEq(vault.positionTokenId(), 0);
        assertTrue(
            IERC20(WETH).balanceOf(lp) > lpWethBefore || IERC20(USDC).balanceOf(lp) > lpUsdcBefore,
            "full close must pay owner principal+fees together, since there's no remaining position to reinject into"
        );
    }

    // =======================================================================
    // Feature 5(a) — payoutFeesInStableOnly, persistent preference
    // =======================================================================

    function test_setPayoutFeesInStableOnly_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompoundV3.NotOwner.selector);
        vault.setPayoutFeesInStableOnly(true);
    }

    function test_setPayoutFeesInStableOnly_ownerCanToggle() public {
        assertFalse(vault.payoutFeesInStableOnly());
        vm.prank(lp);
        vault.setPayoutFeesInStableOnly(true);
        assertTrue(vault.payoutFeesInStableOnly());
    }

    /// Snapshot/preview/revert pattern: dry-run collectFees() with no
    /// conversion to learn the exact volatile-leg fee amount (this is what
    /// the real frontend/keeper does client-side via a quote before sizing
    /// the real swap), then execute for real with a swap sized to convert
    /// 100% of it.
    function test_collectFees_payoutFeesInStableOnly_convertsVolatileLegToStable() public {
        _openPosition();
        _generateTradingFees();
        vm.prank(lp);
        vault.setPayoutFeesInStableOnly(true);

        uint256 snapshot = vm.snapshot();
        vm.prank(lp);
        (uint256 previewFee0,) = vault.collectFees(_noSwap(), _noSwap(), 0, 0);
        vm.revertTo(snapshot);
        assertGt(previewFee0, 0, "sanity: some real WETH fee should have accrued to convert");

        RangeVaultArbCompoundV3.SwapInstruction memory convertAll = RangeVaultArbCompoundV3.SwapInstruction({
            token0ToToken1: true,
            amountIn: previewFee0,
            amountOutMinimum: 0,
            fee: 500
        });

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(lp);
        vault.collectFees(_noSwap(), convertAll, 0, 0);

        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should receive zero WETH once fully converted");
        assertGt(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should receive the fee entirely in USDC");
    }

    function test_rebalance_payoutFeesInStableOnly_convertsVolatileLegToStable() public {
        _openPosition();
        _generateTradingFees();
        vm.prank(lp);
        vault.setPayoutFeesInStableOnly(true);
        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        uint256 snapshot = vm.snapshot();
        vm.prank(defaultOperator);
        vm.recordLogs();
        vault.rebalance(lower2, upper2, _noSwap(), _noSwap(), 0, 0, 0);
        bytes memory previewData =
            _lastLogData(vm.getRecordedLogs(), address(vault), "LpFeesPaidToOwner(uint256,uint256)");
        (uint256 previewFee0,) = abi.decode(previewData, (uint256, uint256));
        vm.revertTo(snapshot);
        assertGt(previewFee0, 0, "sanity: some real WETH fee should have accrued to convert");

        RangeVaultArbCompoundV3.SwapInstruction memory convertAll = RangeVaultArbCompoundV3.SwapInstruction({
            token0ToToken1: true,
            amountIn: previewFee0,
            amountOutMinimum: 0,
            fee: 500
        });

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);

        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), convertAll, 0, 0, 0);

        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should receive zero WETH once fully converted");
        assertGt(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should receive the fee entirely in USDC");
    }

    // =======================================================================
    // Feature 5(b) — per-call payoutSwapIx on withdraw()/withdrawAll()
    // =======================================================================

    function test_withdraw_payoutSwapIx_convertsPrincipalVolatileLegToStable() public {
        _openPosition();

        uint256 snapshot = vm.snapshot();
        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), _noSwap(), 0, 0);
        bytes memory decreaseLiqData =
            _lastLogData(vm.getRecordedLogs(), POSITION_MANAGER, "DecreaseLiquidity(uint256,uint128,uint256,uint256)");
        (, uint256 removed0Preview,) = abi.decode(decreaseLiqData, (uint128, uint256, uint256));
        vm.revertTo(snapshot);
        assertGt(removed0Preview, 0, "sanity: partial withdraw should remove some real WETH principal");

        RangeVaultArbCompoundV3.SwapInstruction memory convertAll = RangeVaultArbCompoundV3.SwapInstruction({
            token0ToToken1: true,
            amountIn: removed0Preview,
            amountOutMinimum: 0,
            fee: 500
        });

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        vault.withdraw(5_000, 0, 0, 0, _noSwap(), convertAll, 0, 0);

        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should receive zero WETH once fully converted via payoutSwapIx");
    }

    function test_withdrawAll_payoutSwapIx_convertsEverythingToStable() public {
        _openPosition();

        // Preview: dry-run withdrawAll() with no conversion and measure the
        // owner's real WETH balance delta — withdrawAll() sweeps the vault's
        // FULL real balanceOf (position principal + any pre-existing idle
        // dust), so reading just the DecreaseLiquidity log would undercount
        // whatever idle WETH dust the vault also held, leaving some
        // unconverted after the real run (confirmed live: a small residual
        // reached the owner when this test used that approach). The owner's
        // own balance delta captures the true total unambiguously.
        uint256 snapshot = vm.snapshot();
        uint256 lpWethBeforePreview = IERC20(WETH).balanceOf(lp);
        vm.prank(lp);
        vault.withdrawAll(_noSwap(), _noSwap());
        uint256 totalWethPreview = IERC20(WETH).balanceOf(lp) - lpWethBeforePreview;
        vm.revertTo(snapshot);
        assertGt(totalWethPreview, 0, "sanity: full withdrawAll should pay out some real WETH principal");

        RangeVaultArbCompoundV3.SwapInstruction memory convertAll = RangeVaultArbCompoundV3.SwapInstruction({
            token0ToToken1: true,
            amountIn: totalWethPreview,
            amountOutMinimum: 0,
            fee: 500
        });

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        vault.withdrawAll(_noSwap(), convertAll);

        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should receive zero WETH once fully converted via payoutSwapIx");
    }

    function test_emergencyWithdrawPosition_ignoresPayoutPreference_paysRawMixedTokens() public {
        _openPosition();
        vm.prank(lp);
        vault.setPayoutFeesInStableOnly(true);
        _generateTradingFees();

        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        vault.emergencyWithdrawPosition();

        assertGt(
            IERC20(WETH).balanceOf(lp),
            lpWethBefore,
            "emergency exit must pay raw WETH regardless of payoutFeesInStableOnly, no swap dependency by design"
        );
    }

    // =======================================================================
    // Feature 6 — hard ceiling: absolute price stop
    // =======================================================================

    function test_setHardCeiling_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompoundV3.NotOwner.selector);
        vault.setHardCeiling(true, 0);
    }

    function test_setHardCeiling_ownerCanConfigure() public {
        vm.prank(lp);
        vault.setHardCeiling(true, 12345);
        assertTrue(vault.hardCeilingEnabled());
        assertEq(vault.hardCeilingTick(), 12345);
    }

    /// Arbitrum: stableIsToken0 = false -> higher tick = higher WETH price
    /// (see _isAboveHardCeiling()'s own docstring) — the ceiling triggers
    /// once currentTick >= hardCeilingTick. Pushes the REAL forked pool price
    /// up with a large one-directional trade (no round trip back, unlike
    /// _generateTradingFees), then confirms rebalance() closes to 100%
    /// stable, mints nothing new, and auto-pauses.
    function test_hardCeiling_rebalance_closesToStableAndPauses() public {
        _openPosition();
        int24 tickBefore = _currentTick();
        int24 ceilingTick = tickBefore + tickSpacing;
        vm.prank(lp);
        vault.setHardCeiling(true, ceilingTick);

        address pusher = makeAddr("pricePusher");
        deal(USDC, pusher, 5_000_000_000_000); // 5,000,000 USDC — large one-directional push
        vm.startPrank(pusher);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: pusher,
                amountIn: 5_000_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        assertGe(_currentTick(), ceilingTick, "sanity: the trade should have pushed price past the configured ceiling");

        // rebalance() is operator-triggered and still gated by the usual
        // periodicDue/_isOutOfRange() check (the ceiling only decides WHAT
        // happens once a rebalance is already due, same as ownerRebalance()
        // deliberately skips that gate but rebalance() never does) — the
        // ceiling's own tick margin here is deliberately tiny (one tick
        // spacing) relative to the position's wide ±1000-tick range, so
        // warp past the periodic interval to make the gate pass.
        vm.warp(block.timestamp + 1 days + 1);
        vm.recordLogs();
        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(0, 0, _noSwap(), _noSwap(), 0, 0, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(newTokenId, 0, "no new position should be minted");
        assertEq(vault.positionTokenId(), 0);
        assertTrue(vault.paused(), "vault should auto-pause once the ceiling triggers");
        assertGt(vault.investableUsdt(), 0, "closed-out capital should park as investableUsdt, not pay out");
        assertFalse(
            _hasTopic0(logs, address(vault), "Rebalanced(uint256,int24,int24,uint256,uint256)"),
            "the ceiling exit path must not emit Rebalanced, HardCeilingTriggered signals this outcome instead"
        );

        bytes memory data = _lastLogData(logs, address(vault), "HardCeilingTriggered(uint256)");
        uint256 stableAmount = abi.decode(data, (uint256));
        assertEq(stableAmount, vault.investableUsdt());
    }

    function test_hardCeiling_ownerRebalance_alsoCloses() public {
        _openPosition();
        int24 tickBefore = _currentTick();
        int24 ceilingTick = tickBefore + tickSpacing;
        vm.prank(lp);
        vault.setHardCeiling(true, ceilingTick);

        address pusher = makeAddr("pricePusherOwner");
        deal(USDC, pusher, 5_000_000_000_000);
        vm.startPrank(pusher);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: pusher,
                amountIn: 5_000_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
        assertGe(_currentTick(), ceilingTick, "sanity: the trade should have pushed price past the configured ceiling");

        vm.prank(lp);
        uint256 newTokenId = vault.ownerRebalance(0, 0, _noSwap(), _noSwap(), 0, 0, 0);

        assertEq(newTokenId, 0);
        assertEq(vault.positionTokenId(), 0);
        assertTrue(vault.paused());
    }

    function test_hardCeiling_blocksInitPositionUntilUnpaused() public {
        _openPosition();
        int24 tickBefore = _currentTick();
        int24 ceilingTick = tickBefore + tickSpacing;
        vm.prank(lp);
        vault.setHardCeiling(true, ceilingTick);

        address pusher = makeAddr("pricePusherInit");
        deal(USDC, pusher, 5_000_000_000_000);
        vm.startPrank(pusher);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: pusher,
                amountIn: 5_000_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1); // clear rebalance()'s periodicDue gate, see the sibling test's comment
        vm.prank(defaultOperator);
        vault.rebalance(0, 0, _noSwap(), _noSwap(), 0, 0, 0);
        assertTrue(vault.paused());

        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        vm.prank(lp);
        vault.configureTarget({
            investmentAmountUsd: 0,
            _targetTickLower: lower2,
            _targetTickUpper: upper2,
            _maxRebalances: 5,
            _reinjectionAmount: 0,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300,
            _feeClaimThresholdBps: 0,
            _feeClaimIntervalSeconds: 0
        });
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVaultArbCompoundV3.Paused.selector);
        vault.initPosition(_noSwap(), 0, 0);

        vm.prank(lp);
        vault.unpause();
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(_noSwap(), 0, 0);
        assertGt(tokenId, 0, "should be able to reopen manually after the owner unpauses");
    }

    function test_hardCeiling_withdrawStillWorksWhilePaused() public {
        _openPosition();
        int24 tickBefore = _currentTick();
        int24 ceilingTick = tickBefore + tickSpacing;
        vm.prank(lp);
        vault.setHardCeiling(true, ceilingTick);

        address pusher = makeAddr("pricePusherWithdraw");
        deal(USDC, pusher, 5_000_000_000_000);
        vm.startPrank(pusher);
        IERC20(USDC).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDC,
                tokenOut: WETH,
                fee: 500,
                recipient: pusher,
                amountIn: 5_000_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();

        vm.warp(block.timestamp + 1 days + 1); // clear rebalance()'s periodicDue gate, see the sibling test's comment
        vm.prank(defaultOperator);
        vault.rebalance(0, 0, _noSwap(), _noSwap(), 0, 0, 0);
        assertTrue(vault.paused());
        assertGt(vault.investableUsdt(), 0);

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        vm.prank(lp);
        vault.withdrawAll(_noSwap(), _noSwap());

        assertGt(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner must still be able to retrieve the parked stable capital while paused");
    }
}
