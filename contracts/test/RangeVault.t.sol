// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {RangeVault} from "../src/RangeVault.sol";

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
    // Test-only stand-in for uni-lab.xyz's payment wallet — real one is
    // 0x4B53D27c81f9E842D50a1940E27B8009B64c615B per PLAN.md, doesn't matter for these tests.
    address uniLabWallet = makeAddr("uniLabWallet");

    PlatformConfig config;
    VaultFactory factory;
    RangeVault vault;
    IUniswapV3Pool pool = IUniswapV3Pool(POOL);
    int24 tickSpacing;

    uint256 constant REBALANCE_FEE = 1_000_000; // 1 USDT
    uint256 constant MAX_DEPOSIT_USD = 20_000_000_000; // 20,000 USDT cap while unaudited

    function setUp() public {
        vm.createSelectFork(vm.envString("CELO_RPC_URL"));
        tickSpacing = pool.tickSpacing();

        config = new PlatformConfig(platformOwner, USDT, defaultOperator, REBALANCE_FEE, MAX_DEPOSIT_USD);
        factory = new VaultFactory(address(config), POSITION_MANAGER, SWAP_ROUTER02, uniLabWallet);

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

    // ---------------------------------------------------------------------
    // Happy path
    // ---------------------------------------------------------------------

    function test_fullLifecycle_deposit_initPosition_rebalance_withdraw() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000); // ~20% wide, plenty of room

        vm.startPrank(lp);
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget({
            investmentAmountUsd: 4_800_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 50_000_000,
            _periodicRebalanceInterval: 1 days
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        assertEq(vault.usdtBudget(), 5_000_000);
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

        // Budget/reserve untouched by initPosition.
        assertEq(vault.usdtBudget(), 5_000_000);
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

        vm.prank(stranger);
        vm.expectRevert(RangeVault.NotOperator.selector);
        vault.payUniLabFee(500_000);
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
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: 1_000_000_000});
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 days);
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 days);
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 1, 0, 1 hours); // maxRebalances = 1
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

    function test_payUniLabFee_revertsWhenBudgetInsufficient() public {
        vm.prank(lp);
        vault.deposit({usdtBudgetAmount: 100_000, reserveAmount: 0, investableAmount: 0}); // 0.1 USDT budget

        vm.prank(defaultOperator);
        vm.expectRevert(RangeVault.InsufficientUsdtBudget.selector);
        vault.payUniLabFee(200_000); // asking for 0.2 USDT, more than the 0.1 USDT budget
    }

    function test_payUniLabFee_sendsExactAmountKeeperRequests() public {
        vm.prank(lp);
        vault.deposit({usdtBudgetAmount: 2_000_000, reserveAmount: 0, investableAmount: 0}); // 2 USDT budget

        // uni-lab's price isn't fixed (see PLAN.md) — the keeper supplies whatever
        // GET /api/v1/pricing said at call time, e.g. 0.2 USDT here.
        uint256 amount = 200_000;
        uint256 before = IERC20(USDT).balanceOf(uniLabWallet);
        vm.prank(defaultOperator);
        vault.payUniLabFee(amount);
        assertEq(IERC20(USDT).balanceOf(uniLabWallet) - before, amount);
        assertEq(vault.usdtBudget(), 2_000_000 - amount);
    }

    function test_platformFeeChangeAppliesLiveToExistingVault() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 0, investableAmount: 5_000_000_000});
        vault.configureTarget(5_000_000_000, lower, upper, 5, 0, 1 hours);
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
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: MAX_DEPOSIT_USD + 1});
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 hours); // cap = 50 USDT
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 10_000_000, investableAmount: 4_990_000_000});
        vault.configureTarget(4_990_000_000, lower, upper, 5, 100_000_000, 1 hours);
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
        vault.deposit({usdtBudgetAmount: 5_000_000, reserveAmount: 200_000_000, investableAmount: 4_800_000_000});
        vault.configureTarget(4_800_000_000, lower, upper, 5, 50_000_000, 1 hours);
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
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: 1_000_000_000});

        vm.prank(lp);
        vm.expectRevert(RangeVault.VaultNotEmpty.selector);
        vault.closeVault();
    }

    function test_closeVault_revertsIfPositionOpen() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.configureTarget(1_000_000_000, lower, upper, 5, 0, 1 hours);
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
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: 1_000_000_000});
        vault.withdrawAll();
        vault.closeVault();
        assertTrue(vault.closed());

        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.deposit({usdtBudgetAmount: 0, reserveAmount: 0, investableAmount: 1});

        vm.expectRevert(RangeVault.VaultClosed.selector);
        vault.configureTarget(1, 0, 100, 1, 0, 1 hours);

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
}
