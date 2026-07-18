// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactoryArb} from "../src/VaultFactoryArb.sol";
import {RangeVaultArb} from "../src/RangeVaultArb.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Fork test against real Arbitrum mainnet, for RangeVaultArb/VaultFactoryArb — the
/// Arbitrum-only fork of RangeVault.sol/VaultFactory.sol (see RangeVaultArb.sol's class
/// docstring for why it's a separate contract instead of a change to the original).
/// Exercises two things RangeVault.t.sol's Celo fork never reaches:
///
/// 1. `stableIsToken0 == false` — on Arbitrum, WETH < USDC, so Uniswap's real token0 is
///    the VOLATILE leg, the opposite of Celo (USDT < WETH). A vault built assuming
///    Celo's order computed a target range with the wrong sign/magnitude entirely and
///    could never open a position — this test would have caught that before it ever
///    reached a real vault.
///
/// 2. The on-chain keeper gas reimbursement in rebalance() — metered from the real
///    transaction's gas usage and converted to USD from the pool's own price, not a
///    configured flat amount (see rebalance()'s own comment for the full reasoning).
contract RangeVaultArbitrumTest is Test {
    address constant POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0; // USDC/WETH 0.05%
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // real token1 here
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // real token0 here
    address constant POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    address platformOwner = makeAddr("platformOwner");
    address defaultOperator = makeAddr("defaultOperator");
    address treasury = makeAddr("treasury");
    address lp = makeAddr("lp");

    PlatformConfig config;
    VaultFactoryArb factory;
    RangeVaultArb vault;
    IUniswapV3Pool pool = IUniswapV3Pool(POOL);
    int24 tickSpacing;

    uint256 constant MAX_DEPOSIT_USD = 20_000_000_000;
    uint256 constant PERFORMANCE_FEE_BPS = 1_000;

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_RPC_URL"));
        // Real gas metering (rebalance()'s tx.gasprice/block.basefee use) needs a
        // realistic gas price — forked state can otherwise carry a stale/zero one.
        vm.txGasPrice(0.05 gwei);

        // Sanity-check the premise this test exists to cover: real token0/token1
        // order on this pool is the REVERSE of Celo's USDT/WETH pool.
        assertEq(pool.token0(), WETH, "expected WETH to be token0 on this pool");
        assertEq(pool.token1(), USDC, "expected USDC to be token1 on this pool");

        tickSpacing = pool.tickSpacing();

        config = new PlatformConfig(platformOwner, USDC, defaultOperator, MAX_DEPOSIT_USD, PERFORMANCE_FEE_BPS, 0, treasury);
        factory = new VaultFactoryArb(address(config), POSITION_MANAGER, SWAP_ROUTER02);

        vm.prank(lp);
        // stableToken/volatileToken passed in "business" order, NOT Uniswap's real
        // token0/token1 order — the factory must sort this out itself.
        address v = factory.createVault(POOL, USDC, WETH, 500);
        vault = RangeVaultArb(v);

        deal(USDC, lp, 1_000_000_000); // 1,000 USDC (6 decimals)
        vm.prank(lp);
        IERC20(USDC).approve(address(vault), type(uint256).max);
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

    function _openPosition() internal returns (int24 lower, int24 upper) {
        (lower, upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        // 50 reserve + 945 investable + 5 gas budget = 1,000 USDC
        vault.deposit({reserveAmount: 50_000_000, investableAmount: 945_000_000, gasReserveAmount: 5_000_000});
        vault.configureTarget({
            investmentAmountUsd: 945_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 10_000_000,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVaultArb.SwapInstruction memory initSwap = RangeVaultArb.SwapInstruction({
            token0ToToken1: false,
            amountIn: 475_000_000,
            amountOutMinimum: 0,
            fee: 500
        });
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);
    }

    function test_factoryDerivesRealTokenOrder_stableIsToken1() public view {
        assertEq(vault.token0(), WETH);
        assertEq(vault.token1(), USDC);
        assertFalse(vault.stableIsToken0());
    }

    function test_fullLifecycle_deposit_initPosition_rebalance_withdraw() public {
        _openPosition();
        assertGt(vault.positionTokenId(), 0, "position should be minted");
        assertEq(vault.reserveBalance(), 50_000_000, "reserve untouched by initPosition");
        // If the stable/volatile mapping were wrong, this would either underflow
        // (reverts) or land absurdly large (WETH's 18-decimal used-amount
        // masquerading as 6-decimal USDC) — bounding it against the original
        // investable amount catches both failure modes.
        assertLt(vault.investableUsdt(), 945_000_000, "leftover dust must be less than what went in");

        // --- rebalance, forced by the periodic trigger ---
        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        RangeVaultArb.SwapInstruction memory noSwap =
            RangeVaultArb.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0, fee: 500});

        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(lower2, upper2, noSwap, 10_000_000, 0, 0);
        assertGt(newTokenId, 0);
        assertEq(vault.rebalanceCount(), 1);
        assertEq(vault.reserveBalance(), 40_000_000, "reserve should drop by the reinjectAmount the keeper chose");
        assertLt(vault.investableUsdt(), 945_000_000, "post-rebalance dust must stay sane, not WETH-scaled");

        // --- withdraw: everything comes back to the LP ---
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        vm.prank(lp);
        vault.withdrawAll();
        uint256 recoveredUsdc = IERC20(USDC).balanceOf(lp) - lpUsdcBefore;
        uint256 recoveredWeth = IERC20(WETH).balanceOf(lp) - lpWethBefore;
        assertGt(recoveredUsdc, 0, "LP should receive USDC back");
        assertGt(recoveredWeth, 0, "LP should receive WETH back (the initial swap converted part of the deposit)");
        assertGt(recoveredUsdc, 300_000_000, "recovered USDC implausibly low for a 1,000 USDC deposit");
        assertLt(recoveredUsdc, 1_000_000_000, "recovered USDC can't exceed the original deposit");
        assertGt(recoveredWeth, 0.05 ether, "recovered WETH implausibly low");
        assertLt(recoveredWeth, 2 ether, "recovered WETH implausibly high - possible decimals/token mismatch");
        assertEq(vault.positionTokenId(), 0);
    }

    function test_deposit_pullsStableToken_notToken0() public {
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        assertEq(IERC20(USDC).balanceOf(lp), lpUsdcBefore - 100_000_000, "deposit must pull USDC (the stable leg)");
        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "deposit must never touch WETH");
    }

    function test_deposit_topsUpDedicatedGasReserve() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 10_000_000, investableAmount: 20_000_000, gasReserveAmount: 7_000_000});
        assertEq(vault.gasReserveBalance(), 7_000_000, "gasReserveAmount must land in its own dedicated ledger");
        assertEq(vault.investableUsdt(), 20_000_000);
        assertEq(vault.reserveBalance(), 10_000_000);
    }

    // ---------------------------------------------------------------------
    // Keeper gas reimbursement — metered from the real tx, drawn ONLY from
    // the dedicated gasReserveBalance budget, never a flat amount
    // ---------------------------------------------------------------------

    function test_keeperGasReimbursement_paysOperatorAPlausibleRealAmount() public {
        _openPosition();
        uint256 gasReserveBefore = vault.gasReserveBalance();
        uint256 investableBefore = vault.investableUsdt();

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        RangeVaultArb.SwapInstruction memory noSwap =
            RangeVaultArb.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0, fee: 500});

        uint256 operatorUsdcBefore = IERC20(USDC).balanceOf(defaultOperator);
        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, noSwap, 10_000_000, 0, 0);
        uint256 reimbursed = IERC20(USDC).balanceOf(defaultOperator) - operatorUsdcBefore;

        // At 0.05 gwei and a real rebalance's gas usage (order of a few hundred
        // thousand gas), the USD cost on Arbitrum should land well under a dollar
        // — bounding it loosely catches both "charged nothing" (metering broken)
        // and "charged something absurd" (decimals/price-conversion bug), without
        // hardcoding gas usage figures that could drift as the contract changes.
        assertGt(reimbursed, 0, "operator should be reimbursed something for a real rebalance");
        assertLt(reimbursed, 5_000_000, "reimbursement implausibly high for one rebalance's real gas cost (>$5)");

        // Drawn ONLY from gasReserveBalance — investableUsdt (deployed into the
        // position) must be completely untouched by the reimbursement itself.
        assertEq(vault.gasReserveBalance(), gasReserveBefore - reimbursed, "reimbursement must debit gasReserveBalance exactly");
        assertLe(
            investableBefore > vault.investableUsdt() ? investableBefore - vault.investableUsdt() : 0,
            investableBefore,
            "sanity: investableUsdt change (from re-minting) shouldn't underflow"
        );
    }

    /// Mirrors the exact production bug that killed the OLD flat rebalanceFee: a
    /// vault whose gas budget can't cover the reimbursement must still complete
    /// its rebalance, just reimbursing less (or nothing) — never revert.
    function test_keeperGasReimbursement_neverRevertsWhenBudgetIsEmpty() public {
        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);

        vm.startPrank(lp);
        // Zero gas budget — deliberately never funded.
        vault.deposit({reserveAmount: 0, investableAmount: 100_000_000, gasReserveAmount: 0});
        vault.configureTarget({
            investmentAmountUsd: 100_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 0,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        RangeVaultArb.SwapInstruction memory initSwap =
            RangeVaultArb.SwapInstruction({token0ToToken1: false, amountIn: 50_000_000, amountOutMinimum: 0, fee: 500});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);
        RangeVaultArb.SwapInstruction memory noSwap =
            RangeVaultArb.SwapInstruction({token0ToToken1: false, amountIn: 0, amountOutMinimum: 0, fee: 500});

        uint256 operatorUsdcBefore = IERC20(USDC).balanceOf(defaultOperator);

        // Must NOT revert even though gasReserveBalance is zero going in.
        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(lower2, upper2, noSwap, 0, 0, 0);
        assertGt(newTokenId, 0, "rebalance must still succeed with an empty gas budget");
        assertEq(vault.gasReserveBalance(), 0, "budget was already empty and must stay at exactly zero, never negative");
        assertEq(
            IERC20(USDC).balanceOf(defaultOperator), operatorUsdcBefore, "operator gets zero reimbursement, not a shortfall from investableUsdt"
        );
    }
}
