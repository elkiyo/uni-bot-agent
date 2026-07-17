// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {RangeVault} from "../src/RangeVault.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Fork tests against real Celo mainnet contracts — see PLAN.md "Verificación":
/// nothing here touches real capital, `deal()` mints test balances on the fork only.
contract RangeVaultTest is Test {
    // Addresses verified in PLAN.md / cross-checked against Celopedia + CoinGecko + DefiLlama.
    address constant POOL = 0x6F42B9D2085a0dEb711C00A460a98B9863ae4897; // USDT/WETH 0.3%
    address constant USDT = 0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e;
    address constant WETH = 0xD221812de1BD094f35587EE8E174B07B6167D9Af;
    address constant POSITION_MANAGER = 0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A;
    address constant SWAP_ROUTER02 = 0x5615CDAb10dc425a742d643d949a7F474C01abc4;
    address platformOwner = makeAddr("platformOwner");
    address defaultOperator = makeAddr("defaultOperator");
    address lp = makeAddr("lp");
    address stranger = makeAddr("stranger");

    PlatformConfig config;
    VaultFactory factory;
    RangeVault vault;
    IUniswapV3Pool pool = IUniswapV3Pool(POOL);
    int24 tickSpacing;

    uint256 constant REBALANCE_FEE = 1_000_000; // 1 USDT
    uint256 constant MAX_DEPOSIT_USD = 20_000_000_000; // 20,000 USDT cap while unaudited
    uint256 constant PERFORMANCE_FEE_BPS = 1_000; // 10%

    function setUp() public {
        vm.createSelectFork(vm.envString("CELO_RPC_URL"));
        tickSpacing = pool.tickSpacing();

        config =
            new PlatformConfig(platformOwner, USDT, defaultOperator, REBALANCE_FEE, MAX_DEPOSIT_USD, PERFORMANCE_FEE_BPS);
        factory = new VaultFactory(address(config), POSITION_MANAGER, SWAP_ROUTER02);

        vm.prank(lp);
        address v = factory.createVault(POOL, USDT, WETH, 3000);
        vault = RangeVault(v);

        // Fund the LP with real-shaped USDT on the fork (test-only balance, not real funds).
        deal(USDT, lp, 10_000_000_000); // 10,000 USDT (6 decimals)
        vm.prank(lp);
        IERC20(USDT).approve(address(vault), type(uint256).max);
    }

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

    /// Generates REAL Uniswap trading fees against whatever position is
    /// currently open and in range, by having an unrelated trader swap
    /// through the real forked pool — used to test performanceFeeBps
    /// without mocking positionManager.collect().
    function _generateTradingFees() internal {
        address trader = makeAddr("trader");
        deal(USDT, trader, 500_000_000_000); // 500,000 USDT — large enough to move price and accrue real fees
        vm.startPrank(trader);
        IERC20(USDT).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: USDT,
                tokenOut: WETH,
                fee: 3000,
                recipient: trader,
                amountIn: 500_000_000_000,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        // Swap back so the price returns near where it started — keeps the
        // vault's position in range for the rebalance/withdraw call that
        // follows, isolating "fees accrued" from "price moved out of range".
        uint256 wethBal = IERC20(WETH).balanceOf(trader);
        IERC20(WETH).approve(SWAP_ROUTER02, type(uint256).max);
        ISwapRouter02(SWAP_ROUTER02).exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: USDT,
                fee: 3000,
                recipient: trader,
                amountIn: wethBal,
                amountOutMinimum: 0,
                sqrtPriceLimitX96: 0
            })
        );
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------

    function test_fullLifecycle_deposit_initPosition_rebalance_withdraw() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000); // ~20% wide, plenty of room

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget({
            investmentAmountUsd: 4_800_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 50_000_000,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        assertEq(vault.reserveBalance(), 200_000_000);
        assertEq(vault.investableUsdt(), 4_800_000_000);

        // Approximate 50/50 value split into WETH for the initial mint — the real keeper
        // sizes this from uni-lab.xyz's /pool-setup-initial response (see PLAN.md); a
        // rough half-swap is enough to exercise the mechanism end-to-end here.
        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});

        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);
        assertGt(tokenId, 0, "position should be minted");
        assertEq(vault.positionTokenId(), tokenId);

        // Reserve untouched by initPosition.
        assertEq(vault.reserveBalance(), 200_000_000);

        // --- rebalance, forced by the periodic trigger (no price move needed) ---
        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        uint256 operatorBalBefore = IERC20(USDT).balanceOf(defaultOperator);
        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(lower2, upper2, noSwap, 50_000_000, 0, 0);
        assertGt(newTokenId, 0);
        assertEq(vault.rebalanceCount(), 1);
        assertEq(vault.reserveBalance(), 150_000_000, "reserve should drop by the reinjectAmount the keeper chose");
        assertEq(
            IERC20(USDT).balanceOf(defaultOperator) - operatorBalBefore,
            REBALANCE_FEE,
            "operator should be paid exactly the platform fee"
        );

        // --- withdraw: everything comes back to the LP, nobody else ---
        uint256 lpUsdtBefore = IERC20(USDT).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        vm.prank(lp);
        vault.withdrawAll();
        assertGt(IERC20(USDT).balanceOf(lp), lpUsdtBefore, "LP should receive USDT back");
        assertGe(IERC20(WETH).balanceOf(lp), lpWethBefore, "LP should receive any WETH back");
        assertEq(vault.positionTokenId(), 0);
    }

    // ---------------------------------------------------------------------
    // Non-custodial guardrails
    // ---------------------------------------------------------------------

    function test_operatorCannotWithdraw() public {
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.withdrawAll();
    }

    function test_strangerCannotWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.withdrawAll();
    }

    function test_strangerCannotCallOperatorFunctions() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOperator.selector);
        vault.initPosition(noSwap, 0, 0);
    }

    function test_ownerCanRevokeOperator_thenOperatorCannotRebalance() public {
        vm.prank(lp);
        vault.setOperator(address(0));

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.NotOperator.selector);
        vault.initPosition(noSwap, 0, 0);
    }

    function test_emergencyWithdraw_worksEvenWithNoOperator() public {
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.setOperator(address(0)); // simulate a compromised/unresponsive keeper
        uint256 before = IERC20(USDT).balanceOf(lp);
        vault.emergencyWithdrawPosition();
        vm.stopPrank();

        assertGt(IERC20(USDT).balanceOf(lp), before);
        assertTrue(vault.paused());
    }

    function test_rebalanceRevertsWhenRangeTooFarFromMarket() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.warp(block.timestamp + 1 days + 1);
        int24 currentTick = _currentTick();
        int24 wildLower = ((currentTick + 50_000) / tickSpacing) * tickSpacing;
        int24 wildUpper = wildLower + tickSpacing * 10;

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.RangeTooFarFromMarket.selector);
        vault.rebalance(wildLower, wildUpper, noSwap, 0, 0, 0);
    }

    function test_rebalanceRevertsBeforeCooldown() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vault.setRiskParams(500, 12 hours, 100_000); // minRebalanceInterval = 12h
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        // Only 1 hour passed — well under both the 12h cooldown and the 1-day periodic trigger.
        vm.warp(block.timestamp + 1 hours);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.TooSoonToRebalance.selector);
        vault.rebalance(lower, upper, noSwap, 0, 0, 0);
    }

    function test_maxRebalancesCapEnforced() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 1, 0, 1 hours, 500, 300); // maxRebalances = 1
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l2, int24 u2) = _alignedRangeAroundMarket(2000);
        vm.prank(defaultOperator);
        vault.rebalance(l2, u2, noSwap, 0, 0, 0); // consumes the only allowed rebalance

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l3, int24 u3) = _alignedRangeAroundMarket(2000);
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.RebalanceLimitReached.selector);
        vault.rebalance(l3, u3, noSwap, 0, 0, 0);
    }

    function test_platformFeeChangeAppliesLiveToExistingVault() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 hours, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.prank(platformOwner);
        config.setRebalanceFee(9_000_000); // platform doubles its price after the vault existed

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l2, int24 u2) = _alignedRangeAroundMarket(2000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        uint256 before = IERC20(USDT).balanceOf(defaultOperator);
        vm.prank(defaultOperator);
        vault.rebalance(l2, u2, noSwap, 0, 0, 0);
        assertEq(IERC20(USDT).balanceOf(defaultOperator) - before, 9_000_000, "new live fee should apply immediately");
    }

    function test_depositRevertsAbovePlatformCap() public {
        vm.prank(lp);
        vm.expectRevert(RangeVault.DepositExceedsPlatformCap.selector);
        vault.deposit({reserveAmount: 0, investableAmount: MAX_DEPOSIT_USD + 1});
    }

    function test_onlyPlatformOwnerCanChangeConfig() public {
        vm.prank(stranger);
        vm.expectRevert();
        config.setRebalanceFee(1);
    }

    // ---------------------------------------------------------------------
    // Reinjection: keeper-chosen amount, bounded by the owner's cap and by
    // what's actually in reserve — no forced on-chain alternation.
    // ---------------------------------------------------------------------

    function test_rebalanceRevertsWhenReinjectExceedsOwnerCap() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 hours, 500, 300); // cap = 50 USDT
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l2, int24 u2) = _alignedRangeAroundMarket(2000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.ReinjectionExceedsCap.selector);
        vault.rebalance(l2, u2, noSwap, 50_000_001, 0, 0); // 1 wei over the 50 USDT cap
    }

    function test_rebalanceRevertsWhenReinjectExceedsReserve() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        // reserveBalance = 10 USDT, but the owner's per-cycle cap is much higher (100 USDT) —
        // the keeper still can't reinject more than what's actually sitting in reserve.
        vault.deposit({reserveAmount: 10_000_000, investableAmount: 4_990_000_000});
        vault.configureTarget(4_990_000_000, lower, upper, 5, 100_000_000, 1 hours, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_495_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l2, int24 u2) = _alignedRangeAroundMarket(2000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.InsufficientReserve.selector);
        vault.rebalance(l2, u2, noSwap, 11_000_000, 0, 0); // more than the 10 USDT actually in reserve
    }

    function test_rebalance_zeroReinject_leavesReserveUntouched() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 hours, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 l2, int24 u2) = _alignedRangeAroundMarket(2000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        vm.prank(defaultOperator);
        vault.rebalance(l2, u2, noSwap, 0, 0, 0); // keeper chooses not to reinject this cycle
        assertEq(vault.reserveBalance(), 200_000_000, "reserve untouched when reinjectAmount is 0");
    }

    // ---------------------------------------------------------------------
    // closeVault(): must be verifiably empty first, then permanently blocks
    // deposit/configureTarget/setRiskParams/initPosition/rebalance.
    // ---------------------------------------------------------------------

    function test_closeVault_revertsIfFundsRemain() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});

        vm.prank(lp);
        vm.expectRevert(RangeVault.VaultNotEmpty.selector);
        vault.closeVault();
    }

    function test_closeVault_revertsIfPositionOpen() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 hours, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.prank(lp);
        vm.expectRevert(RangeVault.VaultNotEmpty.selector);
        vault.closeVault();
    }

    function test_closeVault_succeedsWhenEmpty_thenBlocksEverything() public {
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.withdrawAll();
        vault.closeVault();
        assertTrue(vault.closed());

        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.deposit({reserveAmount: 0, investableAmount: 1});

        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.configureTarget(1, 0, 100, 1, 0, 1 hours, 500, 300);

        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.setRiskParams(1, 1, 1);
        vm.stopPrank();

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.initPosition(noSwap, 0, 0);
    }

    function test_closeVault_isPermanent_cannotCloseTwice() public {
        vm.startPrank(lp);
        vault.closeVault(); // already empty (nothing ever deposited)
        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.closeVault();
        vm.stopPrank();
    }

    function test_withdrawAll_stillCallableAfterClose_asNoOp() public {
        vm.startPrank(lp);
        vault.closeVault();
        vault.withdrawAll(); // must not revert — owner is never locked out, even post-close
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Partial withdraw / immediate increase (2026-07-15)
    // ---------------------------------------------------------------------

    function test_partialWithdraw_leavesPositionOpenWithRemainder() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);

        uint256 lpUsdtBefore = IERC20(USDT).balanceOf(lp);
        vm.prank(lp);
        vault.withdraw(5_000, 5_000); // 50% of the position, 50% of idle funds

        assertGt(IERC20(USDT).balanceOf(lp), lpUsdtBefore, "LP should receive a partial payout");
        assertEq(vault.positionTokenId(), tokenId, "position should stay open, not closed");
        assertEq(vault.reserveBalance(), 100_000_000, "reserve should be halved");
    }

    function test_withdraw_fundsOnly_leavesPositionFullyStaked() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);
        (,,,,,,, uint128 liquidityBefore,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);

        vm.prank(lp);
        vault.withdraw(0, 10_000); // pull 100% of idle reserve, leave the position untouched

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertEq(liquidityAfter, liquidityBefore, "position liquidity should be untouched");
        assertEq(vault.reserveBalance(), 0, "reserve should be fully withdrawn");
        assertEq(vault.positionTokenId(), tokenId, "position stays open");
    }

    function test_partialWithdraw_revertsOnInvalidShareBps() public {
        vm.startPrank(lp);
        vm.expectRevert(RangeVault.InvalidShareBps.selector);
        vault.withdraw(0, 0);

        vm.expectRevert(RangeVault.InvalidShareBps.selector);
        vault.withdraw(10_001, 0);

        vm.expectRevert(RangeVault.InvalidShareBps.selector);
        vault.withdraw(0, 10_001);
        vm.stopPrank();
    }

    function test_fullShareWithdraw_clearsPositionTokenId() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.prank(lp);
        vault.withdraw(10_000, 10_000); // 100% via the partial-withdraw path

        assertEq(vault.positionTokenId(), 0, "fully-drained position should be cleared, same as withdrawAll()");
    }

    function test_strangerCannotPartialWithdraw() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.withdraw(5_000, 5_000);
    }

    // ---------------------------------------------------------------------
    // Collect fees — trading fees only, principal untouched
    // ---------------------------------------------------------------------

    function test_collectFees_revertsWithNoPosition() public {
        vm.prank(lp);
        vm.expectRevert(RangeVault.NoPosition.selector);
        vault.collectFees();
    }

    function test_collectFees_leavesPositionLiquidityUntouched() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);
        (,,,,,,, uint128 liquidityBefore,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);

        vm.prank(lp);
        vault.collectFees();

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertEq(liquidityAfter, liquidityBefore, "collectFees must never touch position liquidity");
        assertEq(vault.positionTokenId(), tokenId, "position stays open");
    }

    function test_collectFees_callableWhilePaused() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.startPrank(lp);
        vault.pause();
        vault.collectFees(); // must not revert — pause only stops the keeper, not the owner's own claim
        vm.stopPrank();
    }

    function test_strangerCannotCollectFees() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.collectFees();
    }

    function test_operatorCannotCollectFees() public {
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.collectFees();
    }

    // ---------------------------------------------------------------------
    // Performance fee — cut of LP trading fees, applied everywhere fees
    // leave the vault (rebalance, collectFees, withdraw, withdrawAll), never
    // on principal.
    // ---------------------------------------------------------------------

    function test_performanceFee_splitsFeesOnCollectFees() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(4000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        _generateTradingFees();

        uint256 lpUsdtBefore = IERC20(USDT).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 operatorUsdtBefore = IERC20(USDT).balanceOf(defaultOperator);
        uint256 operatorWethBefore = IERC20(WETH).balanceOf(defaultOperator);

        vm.prank(lp);
        (uint256 netFee0, uint256 netFee1) = vault.collectFees();

        uint256 lpGain0 = IERC20(USDT).balanceOf(lp) - lpUsdtBefore;
        uint256 lpGain1 = IERC20(WETH).balanceOf(lp) - lpWethBefore;
        uint256 platformGain0 = IERC20(USDT).balanceOf(defaultOperator) - operatorUsdtBefore;
        uint256 platformGain1 = IERC20(WETH).balanceOf(defaultOperator) - operatorWethBefore;

        assertEq(lpGain0, netFee0, "owner should receive exactly the net amount collectFees() returned");
        assertEq(lpGain1, netFee1, "owner should receive exactly the net amount collectFees() returned");
        assertGt(platformGain0 + platformGain1, 0, "some real fee should have accrued from the trade");

        // gross = owner's net + platform's cut; platform's cut must match
        // performanceFeeBps exactly (same integer-division formula the
        // contract itself uses).
        uint256 gross0 = lpGain0 + platformGain0;
        uint256 gross1 = lpGain1 + platformGain1;
        assertEq(platformGain0, (gross0 * PERFORMANCE_FEE_BPS) / 10_000, "token0 split should match performanceFeeBps exactly");
        assertEq(platformGain1, (gross1 * PERFORMANCE_FEE_BPS) / 10_000, "token1 split should match performanceFeeBps exactly");
    }

    function test_performanceFee_zeroBpsGivesOwnerEverything() public {
        vm.prank(platformOwner);
        config.setPerformanceFeeBps(0);

        (int24 lower, int24 upper) = _alignedRangeAroundMarket(4000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        _generateTradingFees();

        uint256 operatorUsdtBefore = IERC20(USDT).balanceOf(defaultOperator);
        uint256 operatorWethBefore = IERC20(WETH).balanceOf(defaultOperator);

        vm.prank(lp);
        vault.collectFees();

        assertEq(
            IERC20(USDT).balanceOf(defaultOperator), operatorUsdtBefore, "operator should get nothing when performanceFeeBps=0"
        );
        assertEq(
            IERC20(WETH).balanceOf(defaultOperator), operatorWethBefore, "operator should get nothing when performanceFeeBps=0"
        );
    }

    function test_performanceFee_appliesOnWithdrawAll() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(4000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        _generateTradingFees();

        uint256 operatorUsdtBefore = IERC20(USDT).balanceOf(defaultOperator);
        uint256 operatorWethBefore = IERC20(WETH).balanceOf(defaultOperator);

        vm.prank(lp);
        vault.withdrawAll();

        bool operatorGotSomething = IERC20(USDT).balanceOf(defaultOperator) > operatorUsdtBefore
            || IERC20(WETH).balanceOf(defaultOperator) > operatorWethBefore;
        assertTrue(operatorGotSomething, "operator should receive a performance-fee cut on withdrawAll's collected LP fees");
    }

    function test_performanceFee_appliesOnRebalance() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(4000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 0, 1 hours, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 2_400_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        _generateTradingFees();

        vm.warp(block.timestamp + 1 hours + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(4000);
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0});

        uint256 operatorUsdtBefore = IERC20(USDT).balanceOf(defaultOperator);
        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, noSwap, 0, 0, 0);

        // Operator gets the flat REBALANCE_FEE plus (if any token0-side LP
        // fees accrued) a performance cut on top — the exact split ratio is
        // already asserted precisely in test_performanceFee_splitsFeesOnCollectFees
        // via the same _splitPerformanceFee code path; this just confirms
        // the combined payout is at least the flat fee and the call didn't
        // revert with the new logic in place.
        assertGe(IERC20(USDT).balanceOf(defaultOperator) - operatorUsdtBefore, REBALANCE_FEE);
    }

    function test_setPerformanceFeeBps_revertsAboveMax() public {
        vm.prank(platformOwner);
        vm.expectRevert();
        config.setPerformanceFeeBps(10_001);
    }

    function test_strangerCannotSetPerformanceFeeBps() public {
        vm.prank(stranger);
        vm.expectRevert();
        config.setPerformanceFeeBps(500);
    }

    function test_increasePosition_addsLiquidityToOpenPosition() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);

        (,,,,,,, uint128 liquidityBefore,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);

        // Same rough half-swap approximation the other tests use for a fresh
        // mint — an in-range position needs both tokens in its live ratio,
        // not just token0 (see increasePosition()'s natspec).
        RangeVault.SwapInstruction memory topUpSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 100_000_000, amountOutMinimum: 0});
        vm.prank(lp);
        vault.increasePosition(topUpSwap, 200_000_000, 0, 0); // top up with 200 more USDT

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(liquidityAfter, liquidityBefore, "increasePosition should add real liquidity immediately");
    }

    function test_increasePosition_revertsWithNoPosition() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vm.expectRevert(RangeVault.NoPosition.selector);
        vault.increasePosition(noSwap, 100_000_000, 0, 0);
        vm.stopPrank();
    }

    function test_strangerCannotIncreasePosition() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOwner.selector);
        vault.increasePosition(noSwap, 100_000_000, 0, 0);
    }

    function test_reinjectIntoPosition_addsLiquidityFromReserve() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 200_000_000, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);

        (,,,,,,, uint128 liquidityBefore,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);

        RangeVault.SwapInstruction memory topUpSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 50_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.reinjectIntoPosition(topUpSwap, 100_000_000, 0, 0);

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(liquidityAfter, liquidityBefore, "reinjectIntoPosition should add real liquidity immediately");
        assertEq(vault.reserveBalance(), 100_000_000, "reserve should drop by the reinjected amount");
        assertEq(vault.positionTokenId(), tokenId, "same position, not a new mint");
    }

    function test_reinjectIntoPosition_revertsWhenExceedingOwnerCap() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 50_000_000, 1 days, 500, 300); // cap: 50 USDT/cycle
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.ReinjectionExceedsCap.selector);
        vault.reinjectIntoPosition(noSwap, 100_000_000, 0, 0); // asking for 100, cap is 50
    }

    function test_reinjectIntoPosition_revertsWhenExceedingReserve() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 10_000_000, investableAmount: 1_000_000_000}); // only 10 USDT in reserve
        vault.configureTarget(1_000_000_000, lower, upper, 5, 200_000_000, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.InsufficientReserve.selector);
        vault.reinjectIntoPosition(noSwap, 50_000_000, 0, 0); // asking for more than the 10 USDT in reserve
    }

    function test_reinjectIntoPosition_revertsWithNoPosition() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 200_000_000, investableAmount: 0});
        vault.configureTarget(0, 0, 100, 5, 200_000_000, 1 days, 500, 300);
        vm.stopPrank();

        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.NoPosition.selector);
        vault.reinjectIntoPosition(noSwap, 100_000_000, 0, 0);
    }

    function test_strangerCannotReinjectIntoPosition() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOperator.selector);
        vault.reinjectIntoPosition(noSwap, 100_000_000, 0, 0);
    }

    function test_sweepIdleDust_convertsOneSidedLeftoverIntoLiquidity() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 days, 500, 300);
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVault.SwapInstruction memory initSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 500_000_000, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(initSwap, 0, 0);

        // Simulate a badly-oversized initial swap leaving one-sided WETH dust
        // with zero USDT to pair it with — exactly what production hit
        // (vault 0x982b8435...c47505) and what _sweepDustIntoPosition() alone
        // can't fix, since it never swaps, only re-offers the as-is leftover.
        deal(WETH, address(vault), IERC20(WETH).balanceOf(address(vault)) + 0.03 ether);

        (,,,,,,, uint128 liquidityBefore,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        uint256 wethBefore = IERC20(WETH).balanceOf(address(vault));

        RangeVault.SwapInstruction memory correctiveSwap =
            RangeVault.SwapInstruction({token0ToToken1: false, amountIn: 0.015 ether, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vault.sweepIdleDust(correctiveSwap, 0, 0);

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(liquidityAfter, liquidityBefore, "sweepIdleDust should add real liquidity from the stranded WETH");
        assertLt(
            IERC20(WETH).balanceOf(address(vault)), wethBefore, "stranded WETH should be reduced after the sweep"
        );
    }

    function test_sweepIdleDust_revertsWithNoPosition() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.NoPosition.selector);
        vault.sweepIdleDust(noSwap, 0, 0);
    }

    function test_strangerCannotSweepIdleDust() public {
        RangeVault.SwapInstruction memory noSwap =
            RangeVault.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0});
        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOperator.selector);
        vault.sweepIdleDust(noSwap, 0, 0);
    }
}
