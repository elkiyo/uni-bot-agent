// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

import {PlatformConfig} from "../src/PlatformConfig.sol";
import {VaultFactoryArbCompound} from "../src/compound/VaultFactoryArbCompound.sol";
import {RangeVaultArbCompound} from "../src/compound/RangeVaultArbCompound.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";

/// Fork tests against real Arbitrum mainnet, for RangeVaultArbCompound /
/// VaultFactoryArbCompound — the interest-compounding + flexible-deposit fork of
/// RangeVaultArb.sol/VaultFactoryArb.sol (see that contract's class docstring for
/// why it's a separate file instead of an edit to RangeVaultArb.sol, which this
/// suite never touches). Same fork setup as RangeVaultArbitrum.t.sol.
contract RangeVaultArbCompoundTest is Test {
    address constant POOL = 0xC6962004f452bE9203591991D15f6b388e09E8D0; // USDC/WETH 0.05% — same pool Arbitrum's standard vaults already use
    address constant USDC = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831; // real token1 here
    address constant WETH = 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1; // real token0 here
    // USDT0 — a real, distinct-from-USDC stablecoin on Arbitrum, with genuine
    // liquidity against USDC (0xbcE7...12a5, 0.05% pool, confirmed nonzero
    // on-chain liquidity 2026-07-25). Used only to exercise depositToken()'s
    // "third-party token" path — not the platform's own stable leg.
    address constant USDT0 = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;
    uint24 constant USDT0_USDC_FEE = 500;
    address constant POSITION_MANAGER = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant SWAP_ROUTER02 = 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45;

    address platformOwner = makeAddr("platformOwner");
    address defaultOperator = makeAddr("defaultOperator");
    address treasury = makeAddr("treasury");
    address lp = makeAddr("lp");
    address stranger = makeAddr("stranger");

    PlatformConfig config;
    VaultFactoryArbCompound factory;
    RangeVaultArbCompound vault;
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
        factory = new VaultFactoryArbCompound(address(config), POSITION_MANAGER, SWAP_ROUTER02);

        vm.prank(lp);
        address v = factory.createVault(POOL, USDC, WETH, 500);
        vault = RangeVaultArbCompound(v);

        deal(USDC, lp, 2_000_000_000); // 2,000 USDC (6 decimals)
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

        RangeVaultArbCompound.SwapInstruction memory initSwap =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: false, amountIn: 475_000_000, amountOutMinimum: 0, fee: 500});
        vm.prank(defaultOperator);
        vault.initPosition(initSwap, 0, 0);
    }

    /// Generates REAL Uniswap trading fees against whatever position is
    /// currently open and in range, same technique as RangeVault.t.sol's own
    /// helper — an unrelated trader swaps through the real forked pool.
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

    function _noSwap() internal pure returns (RangeVaultArbCompound.SwapInstruction memory) {
        return RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});
    }

    /// Same conversion _toStableUsd()/_nativeWeiToStableRaw() do on-chain,
    /// replicated here so tests can independently predict what the contract
    /// should have emitted — token1 (USDC) is the stable leg on this fork's
    /// pool (stableIsToken0 = false), so this mirrors that branch only.
    function _toStableUsdRef(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        uint256 step1 = (amount0 * sqrtPriceX96) >> 96;
        uint256 converted0 = (step1 * sqrtPriceX96) >> 96;
        return amount1 + converted0;
    }

    /// Single-direction trade (USDC->WETH only) — Uniswap V3 charges the fee
    /// on the INPUT token of each swap, so this accrues real fee ONLY in USDC
    /// (token1, the stable leg here), leaving the WETH (token0) side exactly
    /// zero. Lets tests assert netFeeUsd/principalUsd's stable-only branch
    /// with no price-conversion uncertainty involved.
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

    /// Finds and decodes the single most recent occurrence of `eventSig`
    /// (e.g. "FeesReinjected(uint256,uint256,uint256,uint256,uint256)") from
    /// `emitter` within an already-fetched log array — needed because
    /// principalUsd/netFeeUsd are local variables the contract never exposes
    /// as public state, only ever emitted. Takes the array instead of calling
    /// vm.getRecordedLogs() itself: that cheatcode DRAINS the buffer on every
    /// call, so a test that needs to check two different events from the same
    /// transaction must fetch once and search the same array twice, not call
    /// this per event.
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
    // autoCompoundFees toggle
    // ---------------------------------------------------------------------

    function test_setAutoCompoundFees_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompound.NotOwner.selector);
        vault.setAutoCompoundFees(true);
    }

    function test_setAutoCompoundFees_ownerCanToggle() public {
        assertFalse(vault.autoCompoundFees());
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        assertTrue(vault.autoCompoundFees());

        vm.prank(lp);
        vault.setAutoCompoundFees(false);
        assertFalse(vault.autoCompoundFees());
    }

    // ---------------------------------------------------------------------
    // collectFees() — manual claim, behavior gated by the toggle
    // ---------------------------------------------------------------------

    function test_collectFees_paysOwnerWhenAutoCompoundOff() public {
        _openPosition();
        _generateTradingFees();

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(lp);
        (uint256 netFee0, uint256 netFee1) = vault.collectFees(_noSwap(), 0, 0);

        assertGt(netFee0 + netFee1, 0, "some real fee should have accrued from the trade");
        assertEq(IERC20(WETH).balanceOf(lp) - lpWethBefore, netFee0, "owner should receive token0 (WETH) net fees");
        assertEq(IERC20(USDC).balanceOf(lp) - lpUsdcBefore, netFee1, "owner should receive token1 (USDC) net fees");
    }

    function test_collectFees_reinjectsWhenAutoCompoundOn() public {
        _openPosition();
        _generateTradingFees();

        vm.prank(lp);
        vault.setAutoCompoundFees(true);

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);
        uint256 operatorUsdcBefore = IERC20(USDC).balanceOf(defaultOperator);
        uint256 operatorWethBefore = IERC20(WETH).balanceOf(defaultOperator);

        vm.prank(lp);
        vault.collectFees(_noSwap(), 0, 0);

        assertEq(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should receive nothing when compounding");
        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should receive nothing when compounding");
        assertTrue(
            IERC20(USDC).balanceOf(defaultOperator) > operatorUsdcBefore
                || IERC20(WETH).balanceOf(defaultOperator) > operatorWethBefore,
            "platform should still take its performance cut regardless of compounding"
        );

        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore, "fees should be reinjected as real liquidity, not paid out");
        assertEq(vault.lastFeeClaimTimestamp(), block.timestamp);
    }

    function test_collectFees_revertsWithNoPosition() public {
        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompound.NoPosition.selector);
        vault.collectFees(_noSwap(), 0, 0);
    }

    // ---------------------------------------------------------------------
    // harvestFees() — operator-triggered scheduled/threshold claim
    // ---------------------------------------------------------------------

    function test_harvestFees_revertsWhenAutoCompoundOff() public {
        _openPosition();
        vm.prank(defaultOperator);
        vm.expectRevert(RangeVaultArbCompound.AutoCompoundNotEnabled.selector);
        vault.harvestFees(_noSwap(), 0, 0);
    }

    function test_harvestFees_revertsForNonOperator() public {
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompound.NotOperator.selector);
        vault.harvestFees(_noSwap(), 0, 0);
    }

    function test_harvestFees_reinjectsAndUpdatesLastClaimTimestamp() public {
        _openPosition();
        _generateTradingFees();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);

        (,,,,,,, uint128 liquidityBefore,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());

        vm.warp(block.timestamp + 1 hours);
        vm.prank(defaultOperator);
        vault.harvestFees(_noSwap(), 0, 0);

        assertEq(vault.lastFeeClaimTimestamp(), block.timestamp, "lastFeeClaimTimestamp should advance to now");
        (,,,,,,, uint128 liquidityAfter,,,,) =
            INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        assertGt(liquidityAfter, liquidityBefore, "harvestFees should reinject real liquidity");
    }

    // ---------------------------------------------------------------------
    // rebalance() — the "free" automatic path, folded into the next mint
    // ---------------------------------------------------------------------

    function test_rebalance_reinjectsFeesWhenAutoCompoundOn() public {
        _openPosition();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);
        _generateTradingFees();

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(defaultOperator);
        uint256 newTokenId = vault.rebalance(lower2, upper2, _noSwap(), 0, 0, 0);

        assertEq(IERC20(USDC).balanceOf(lp), lpUsdcBefore, "owner should get nothing when compounding");
        assertEq(IERC20(WETH).balanceOf(lp), lpWethBefore, "owner should get nothing when compounding");
        assertEq(vault.lastFeeClaimTimestamp(), block.timestamp, "the folded-in fee should count as a claim");

        (,,,,,,, uint128 liquidityAfter,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(newTokenId);
        assertGt(liquidityAfter, 0, "new position should have real liquidity, including the folded-in fees");
    }

    function test_rebalance_paysOwnerWhenAutoCompoundOff() public {
        _openPosition();
        _generateTradingFees();

        vm.warp(block.timestamp + 1 days + 1);
        (int24 lower2, int24 upper2) = _alignedRangeAroundMarket(2000);

        uint256 lpUsdcBefore = IERC20(USDC).balanceOf(lp);
        uint256 lpWethBefore = IERC20(WETH).balanceOf(lp);

        vm.prank(defaultOperator);
        vault.rebalance(lower2, upper2, _noSwap(), 0, 0, 0);

        assertTrue(
            IERC20(USDC).balanceOf(lp) > lpUsdcBefore || IERC20(WETH).balanceOf(lp) > lpWethBefore,
            "owner should still be paid when compounding is off, exactly like RangeVaultArb.sol"
        );
    }

    // ---------------------------------------------------------------------
    // depositToken() — flexible deposits
    // ---------------------------------------------------------------------

    function test_depositToken_noSwapWhenTokenInIsStable() public {
        RangeVaultArbCompound.SwapInstruction memory unused =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});

        vm.prank(lp);
        vault.depositToken(USDC, 100_000_000, unused, 0, 0, 10_000_000, 90_000_000, 0);

        assertEq(vault.reserveBalance(), 10_000_000);
        assertEq(vault.investableUsdt(), 90_000_000);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 100_000_000);
    }

    function test_depositToken_sellsOnlyExcessWhenVolatileAboveTarget() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 200_000_000, gasReserveAmount: 0});

        uint256 wethAmount = 0.5 ether;
        deal(WETH, lp, wethAmount);
        vm.prank(lp);
        IERC20(WETH).approve(address(vault), wethAmount);

        // Sell HALF the deposited WETH back to USDC (token0->token1: WETH is
        // token0 on Arbitrum) — the other half must stay as real WETH,
        // untouched, ready for initPosition()'s mint with no round-trip.
        RangeVaultArbCompound.SwapInstruction memory sellExcess =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0.25 ether, amountOutMinimum: 0, fee: 500});

        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        vm.prank(lp);
        // investableAmount here credits whatever USDC the sale actually
        // produced — the test doesn't need the exact off-chain quote to be
        // right, just needs to demonstrate the WETH that wasn't sold stays put.
        vault.depositToken(WETH, wethAmount, sellExcess, 0, 0, 0, 1, 0);

        assertEq(
            IERC20(WETH).balanceOf(address(vault)),
            vaultWethBefore + wethAmount - 0.25 ether,
            "unsold WETH should sit as real balance, not round-tripped through a sell-then-rebuy"
        );

        (int24 lower, int24 upper) = _alignedRangeAroundMarket(2000);
        vm.startPrank(lp);
        vault.configureTarget({
            investmentAmountUsd: 200_000_000,
            _targetTickLower: lower,
            _targetTickUpper: upper,
            _maxRebalances: 5,
            _reinjectionAmount: 0,
            _periodicRebalanceInterval: 1 days,
            _recenterMarginBps: 500,
            _exitTopCeilingMarginBps: 300,
            _feeClaimThresholdBps: 0,
            _feeClaimIntervalSeconds: 0
        });
        vault.setRiskParams(500, 0, 500);
        vm.stopPrank();

        uint256 wethBeforeMint = IERC20(WETH).balanceOf(address(vault));
        vm.prank(defaultOperator);
        uint256 tokenId = vault.initPosition(_noSwap(), 0, 0);

        assertGt(tokenId, 0);
        (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(tokenId);
        assertGt(liquidity, 0, "position should mint using the WETH that was never sold");
        assertLt(
            IERC20(WETH).balanceOf(address(vault)),
            wethBeforeMint,
            "the unsold WETH should get consumed directly by the mint, not sit idle"
        );
    }

    function test_depositToken_buysShortfallWhenVolatileBelowTarget() public {
        vm.prank(lp);
        vault.deposit({reserveAmount: 0, investableAmount: 500_000_000, gasReserveAmount: 0});

        uint256 wethAmount = 0.05 ether; // deliberately short
        deal(WETH, lp, wethAmount);
        vm.prank(lp);
        IERC20(WETH).approve(address(vault), wethAmount);

        // Buy MORE WETH using some of the already-deposited USDC
        // (token1->token0 here, since WETH is token0 on Arbitrum) — the
        // deposited WETH itself is never touched, only the shortfall is bought.
        RangeVaultArbCompound.SwapInstruction memory buyShortfall =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: false, amountIn: 100_000_000, amountOutMinimum: 0, fee: 500});

        uint256 vaultWethBefore = IERC20(WETH).balanceOf(address(vault));
        uint256 investableBefore = vault.investableUsdt();

        vm.prank(lp);
        vault.depositToken(WETH, wethAmount, buyShortfall, 0, 0, 0, 0, 0);

        assertGt(
            IERC20(WETH).balanceOf(address(vault)),
            vaultWethBefore + wethAmount,
            "vault should hold more WETH than just what was deposited - some was bought"
        );
        assertEq(
            vault.investableUsdt(),
            investableBefore - 100_000_000,
            "buying the shortfall must debit investableUsdt by exactly the stable spent"
        );
    }

    function test_depositToken_sellsAllWhenTokenInIsThirdParty() public {
        uint256 usdt0Amount = 100_000_000; // 100 USDT0 (6 decimals)
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        RangeVaultArbCompound.SwapInstruction memory unused =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});

        uint256 vaultUsdcBefore = IERC20(USDC).balanceOf(address(vault));
        vm.prank(lp);
        // thirdPartyFee routes the USDT0->USDC leg through the real 0.05%
        // pool confirmed live on the fork; investableAmount is a conservative
        // lower bound of what the sale should produce (100 USDT0 for well
        // over 90 USDC after a stable/stable swap).
        vault.depositToken(USDT0, usdt0Amount, unused, USDT0_USDC_FEE, 90_000_000, 0, 90_000_000, 0);

        assertEq(IERC20(USDT0).balanceOf(address(vault)), 0, "all deposited USDT0 should be sold, none held directly");
        assertGt(
            IERC20(USDC).balanceOf(address(vault)),
            vaultUsdcBefore,
            "the USDC proceeds from the sale should land in the vault"
        );
        assertEq(vault.investableUsdt(), 90_000_000);
    }

    function test_depositToken_revertsBelowAmountOutMinimum() public {
        uint256 usdt0Amount = 100_000_000;
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        RangeVaultArbCompound.SwapInstruction memory unused =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});

        vm.prank(lp);
        vm.expectRevert(); // Uniswap's router reverts with "Too little received" — an unrealistically high floor must fail
        vault.depositToken(USDT0, usdt0Amount, unused, USDT0_USDC_FEE, 1_000_000_000_000, 0, 0, 0);
    }

    function test_depositToken_onlyOwner() public {
        RangeVaultArbCompound.SwapInstruction memory unused =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});
        vm.prank(stranger);
        vm.expectRevert(RangeVaultArbCompound.NotOwner.selector);
        vault.depositToken(USDC, 1, unused, 0, 0, 0, 1, 0);
    }

    /// The platform-cap check now runs BEFORE any transferFrom/swap, same
    /// order deposit() itself uses (moved there specifically so a doomed
    /// deposit fails fast instead of paying for a transfer+swap first). Since
    /// a revert unwinds the whole transaction either way, black-box state
    /// alone can't distinguish "checked before" from "checked after" —  this
    /// test's job is narrower but still real: confirm the cap check keeps
    /// firing correctly (right error, still reachable) on the non-stable
    /// tokenIn path after the reorder, a path that didn't exist before this
    /// function did.
    function test_depositToken_revertsWhenCapExceeded_thirdPartyTokenPath() public {
        uint256 usdt0Amount = 100_000_000;
        deal(USDT0, lp, usdt0Amount);
        vm.prank(lp);
        IERC20(USDT0).approve(address(vault), usdt0Amount);

        RangeVaultArbCompound.SwapInstruction memory unused =
            RangeVaultArbCompound.SwapInstruction({token0ToToken1: true, amountIn: 0, amountOutMinimum: 0, fee: 500});

        vm.prank(lp);
        vm.expectRevert(RangeVaultArbCompound.DepositExceedsPlatformCap.selector);
        vault.depositToken(USDT0, usdt0Amount, unused, USDT0_USDC_FEE, 0, 0, MAX_DEPOSIT_USD + 1, 0);
    }

    // ---------------------------------------------------------------------
    // B1/A1 accounting — FeesReinjected.netFeeUsd, Withdrawn.principalUsd
    // ---------------------------------------------------------------------

    function test_FeesReinjected_netFeeUsd_stableLegOnlyIsExact() public {
        _openPosition();
        _generateTradingFeesStableLegOnly();
        vm.prank(lp);
        vault.setAutoCompoundFees(true);

        vm.recordLogs();
        vm.prank(lp);
        (uint256 netFee0, uint256 netFee1) = vault.collectFees(_noSwap(), 0, 0);

        assertEq(netFee0, 0, "single-direction USDC->WETH trade should accrue fee only in USDC (token1)");
        assertGt(netFee1, 0, "some real stable-leg fee should have accrued");

        bytes memory data =
            _lastLogData(vm.getRecordedLogs(), address(vault), "FeesReinjected(uint256,uint256,uint256,uint256,uint256)");
        (,,,, uint256 netFeeUsd) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256));

        // No conversion needed when the entire fee is already in the stable
        // leg — netFeeUsd should equal netFee1 exactly, bit for bit.
        assertEq(netFeeUsd, netFee1, "netFeeUsd should equal the stable-only fee exactly, no volatile-leg conversion");
    }

    function test_FeesReinjected_netFeeUsd_bothLegsNonZero_matchesReferenceConversion() public {
        _openPosition();
        _generateTradingFees(); // both directions -> fee accrues in both token0 (WETH) and token1 (USDC)
        vm.prank(lp);
        vault.setAutoCompoundFees(true);

        vm.recordLogs();
        vm.prank(lp);
        (uint256 netFee0, uint256 netFee1) = vault.collectFees(_noSwap(), 0, 0);

        assertGt(netFee0, 0, "round-trip trade should leave real WETH fee too");
        assertGt(netFee1, 0, "round-trip trade should leave real USDC fee too");

        bytes memory data =
            _lastLogData(vm.getRecordedLogs(), address(vault), "FeesReinjected(uint256,uint256,uint256,uint256,uint256)");
        (,,,, uint256 netFeeUsd) = abi.decode(data, (uint256, uint256, uint256, uint256, uint256));

        assertEq(
            netFeeUsd,
            _toStableUsdRef(netFee0, netFee1),
            "netFeeUsd should match the same sqrtPriceX96 conversion the contract itself uses"
        );
        assertGt(netFeeUsd, netFee1, "the WETH leg's converted value should add something on top of the raw USDC fee");
    }

    /// The specific case the plan called out: a withdrawal that pulls BOTH
    /// position principal (positionShareBps>0) AND idle funds including
    /// reserve (fundsShareBps>0, with reserveBalance already nonzero from
    /// _openPosition's deposit) in the same transaction. principalUsd must
    /// count the position principal and the investable share, but NOT the
    /// reserve share and NOT the owner's fee cut — even though all of it
    /// leaves the vault together in the same total0/total1 transfer.
    function test_Withdrawn_principalUsd_excludesFeesAndReserve() public {
        _openPosition();
        _generateTradingFeesStableLegOnly(); // known netFee0=0, isolates the fee-exclusion check to one leg
        uint256 reserveBefore = vault.reserveBalance();
        uint256 investableBefore = vault.investableUsdt();
        assertGt(reserveBefore, 0, "sanity: _openPosition left a nonzero reserve to try to wrongly include");

        (,,,,,,, uint128 liquidity,,,,) = INonfungiblePositionManager(POSITION_MANAGER).positions(vault.positionTokenId());
        uint128 expectedPartialLiquidity = uint128((uint256(liquidity) * 5_000) / 10_000);

        vm.recordLogs();
        vm.prank(lp);
        vault.withdraw(5_000, 5_000);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes memory decreaseLiqData =
            _lastLogData(logs, POSITION_MANAGER, "DecreaseLiquidity(uint256,uint128,uint256,uint256)");
        (uint128 loggedLiquidity, uint256 removed0, uint256 removed1) =
            abi.decode(decreaseLiqData, (uint128, uint256, uint256));
        assertEq(loggedLiquidity, expectedPartialLiquidity, "sanity: decoded the right DecreaseLiquidity log");

        bytes memory withdrawnData = _lastLogData(logs, address(vault), "Withdrawn(uint256,uint256,uint256)");
        (,, uint256 principalUsd) = abi.decode(withdrawnData, (uint256, uint256, uint256));

        uint256 investableShare = investableBefore / 2; // fundsShareBps = 5_000 = 50%
        uint256 reserveShare = reserveBefore / 2;
        assertGt(reserveShare, 0, "sanity: a real reserve share left the vault in this same withdrawal");

        uint256 expectedPrincipalUsd = _toStableUsdRef(removed0, removed1) + investableShare;
        assertEq(
            principalUsd,
            expectedPrincipalUsd,
            "principalUsd should be exactly position-principal + investable share, excluding the reserve share that left in the same tx"
        );
    }
}
