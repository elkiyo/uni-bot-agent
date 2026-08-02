// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "../interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";
import {IPlatformConfig} from "../interfaces/IPlatformConfig.sol";

/// @title RangeVaultArbCompoundV3
/// @notice Fork of RangeVaultArbCompoundV2.sol — never editing an already-deployed
/// contract, same fork discipline as every other variant here (see CLAUDE.md's
/// "Arquitectura de contratos"). Bundles 6 fixes/features, decided and documented
/// together in CLAUDE.md's "Pendientes/próximos pasos" (2026-08-01) rather than
/// shipped one at a time:
///
///   1. Saturating subtraction in withdrawAll()/emergencyWithdrawPosition()'s
///      principalUsd calc — a purely informational B1-audit number must never be
///      able to block the actual fund transfer, especially in the function meant
///      to be the last-resort exit.
///   2. Defensive clamps (uncountedInvestable <= investableUsdt) after every
///      measured investableUsdt reassignment — depositToken() already had this
///      pattern (see its own comment), the other 7 call sites that reassign
///      investableUsdt from a measured balance didn't, which is how V2's real
///      production bug happened (root-caused live against vault
///      0x7186CE90...4D78c7, see CLAUDE.md for the exact tx).
///   3. investableAmount only accepted before the first position exists —
///      deposit()/depositToken() now revert if the owner tries to fund the
///      "invertible" bucket after a position is already open (use
///      increasePosition()/increasePositionWithToken() instead).
///   4. withdraw() now respects autoCompoundFees on a partial exit: reinjects
///      fees into the REMAINING position instead of paying them out mixed with
///      principal (except on a full 100% close, where there's no remaining
///      position to reinject into).
///   5. Stable-only payout, two complementary mechanisms:
///      (a) payoutFeesInStableOnly — a persistent owner preference (needed
///          because rebalance() is keeper-triggered; the keeper reads this from
///          chain state, it can't be handed a per-call choice). Converts the
///          volatile leg of any DIRECTLY-paid fee to the vault's stable token,
///          in collectFees()/rebalance()/ownerRebalance()'s non-compounding
///          branches.
///      (b) a per-call SwapInstruction on withdraw()/withdrawAll() — the owner
///          is always present signing those, so no persistent flag is needed;
///          they simply size however much of THIS payout (principal + fees
///          combined) they want converted, from $0 up to 100%.
///      emergencyWithdrawPosition() is DELIBERATELY EXCLUDED from both — see
///      its own docstring below.
///   6. Hard ceiling — an owner-configurable absolute price ceiling for the
///      volatile asset. When crossed, rebalance()/ownerRebalance() close the
///      position, convert 100% to stable, do NOT mint a new position, and
///      auto-pause — the vault stays parked in stable until the owner manually
///      unpause()s and decides what to do next.
///
/// No formal audit before this deploy (same explicit user decision as V2 — see
/// CLAUDE.md). Existing V2 vaults are NOT migrated; this only applies to vaults
/// created via the new VaultFactoryArbCompoundV3.
contract RangeVaultArbCompoundV3 is Initializable, ReentrancyGuardUpgradeable, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotOwner();
    error NotOperator();
    error Paused();
    error AlreadyInitializedPosition();
    error NoPosition();
    error TargetNotConfigured();
    error RangeTooFarFromMarket();
    error TooSoonToRebalance();
    error RebalanceLimitReached();
    error InsufficientReserve();
    error InvalidSwapInstruction();
    error DepositExceedsPlatformCap();
    error ZeroAddress();
    error NotPositionManager();
    error VaultClosed();
    error VaultNotEmpty();
    error ReinjectionExceedsCap();
    error InvalidShareBps();
    error AutoCompoundNotEnabled();
    /// @notice Fix #3 — the "invertible" bucket can only ever be funded before
    /// the first position exists. Use increasePosition()/increasePositionWithToken()
    /// to add capital to an already-open position instead.
    error InvestableAfterPositionExists();

    // ---------------------------------------------------------------------
    // Immutable-ish config (set once in initialize())
    // ---------------------------------------------------------------------

    address public owner;
    address public platformConfig;

    IUniswapV3Pool public pool;
    address public token0; // Uniswap's real token0 — the LOWER of the two addresses, not necessarily the stablecoin
    address public token1; // Uniswap's real token1
    bool public stableIsToken0; // true on Celo (USDT<WETH), false on Arbitrum (WETH<USDC)
    uint24 public feeTier;

    INonfungiblePositionManager public positionManager;
    ISwapRouter02 public swapRouter;

    // ---------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------

    address public operator;

    // ---------------------------------------------------------------------
    // Ledgers — all three are carved out of the same stable-leg balance but
    // must never be spent on each other's behalf.
    // ---------------------------------------------------------------------

    uint256 public investableUsdt; // capital not yet deployed into a position
    uint256 public reserveBalance; // capital available for the keeper to reinject into a position, over time
    // Dedicated, owner-funded budget for rebalance()'s keeper gas
    // reimbursement — deliberately separate from investableUsdt.
    uint256 public gasReserveBalance;

    /// @notice `investableUsdt` mixes two things that must be treated
    /// differently for B1 (cumulative investment) accounting off-chain:
    /// genuinely new capital from a LATER deposit()/depositToken() call (made
    /// after a position already exists) that hasn't been folded into the
    /// position yet, vs. leftover stable-side residue from a prior mint that
    /// was already counted once. `uncountedInvestable` tracks ONLY the
    /// former. As of fix #3, a LATER deposit()/depositToken() call with
    /// investableAmount > 0 always reverts (see InvestableAfterPositionExists),
    /// so this counter can now only ever grow via increasePosition()/
    /// increasePositionWithToken() — kept as its own field regardless, since
    /// the invariant-protection (fix #2) and the withdraw()-side exclusion
    /// logic built around it are unchanged.
    ///
    /// Fix #2: every function that reassigns investableUsdt from a freshly
    /// MEASURED balance (sweepIdleDust, rebalance, ownerRebalance,
    /// _reinjectFees, increasePosition, increasePositionWithToken,
    /// reinjectIntoPosition) now clamps uncountedInvestable to never exceed
    /// it afterward — depositToken() already had this pattern (see its own
    /// comment); the other 7 call sites didn't, which is how V2's real
    /// production invariant violation happened (root-caused live against
    /// vault 0x7186CE90...4D78c7 on 2026-08-01 — see CLAUDE.md for the exact
    /// tx that broke it: sweepIdleDust() re-measuring investableUsdt to a
    /// value below what uncountedInvestable still tracked, with no clamp to
    /// catch it).
    uint256 public uncountedInvestable;

    bool public creationFeeCharged;

    // ---------------------------------------------------------------------
    // Interés compuesto — todos off-chain-only knobs salvo autoCompoundFees.
    // ---------------------------------------------------------------------

    bool public autoCompoundFees;
    /// @notice Fix #5(a). Only meaningful when autoCompoundFees == false —
    /// left settable regardless (not gated on autoCompoundFees being off) so
    /// the owner can pre-arm it before flipping the other switch, one fewer
    /// tx. Applies automatically, without any per-call choice, whenever a
    /// fee gets paid DIRECTLY to the owner: collectFees()'s non-compounding
    /// branch, and rebalance()/ownerRebalance()'s non-compounding branch —
    /// needed as a persistent on-chain flag specifically because rebalance()
    /// is keeper-triggered, not owner-triggered, so the keeper has no way to
    /// receive a per-call choice from the owner at the moment it runs.
    bool public payoutFeesInStableOnly;
    uint256 public feeClaimThresholdBps;
    uint256 public feeClaimIntervalSeconds;
    uint256 public lastFeeClaimTimestamp;

    // ---------------------------------------------------------------------
    // Feature 6 — hard ceiling: absolute price stop for the volatile asset
    // ---------------------------------------------------------------------

    /// @notice A separate bool instead of a sentinel tick value (e.g.
    /// type(int24).max) — avoids any ambiguity over which raw tick value
    /// means "disabled", and matches this contract's own established pattern
    /// (autoCompoundFees, payoutFeesInStableOnly) of a dedicated enabled flag.
    bool public hardCeilingEnabled;
    /// @notice Stored as a tick (Uniswap's native on-chain unit), same as
    /// targetTickLower/targetTickUpper — the frontend already converts a
    /// human price input to a tick for every other range field, same pattern
    /// here. IMPORTANT: a higher tick does NOT always mean a higher price —
    /// it depends on stableIsToken0 (documented gotcha in this exact
    /// codebase, real production bug 2026-07-17 from assuming Celo's
    /// direction unconditionally). See _isAboveHardCeiling() below for the
    /// direction-aware comparison — never compare hardCeilingTick to the
    /// current tick directly anywhere else.
    int24 public hardCeilingTick;

    // ---------------------------------------------------------------------
    // Target config — owner-set, what the agent should build/maintain
    // ---------------------------------------------------------------------

    bool public targetConfigured;
    int24 public targetTickLower;
    int24 public targetTickUpper;
    uint256 public maxRebalances;
    uint256 public reinjectionAmount;
    uint256 public periodicRebalanceInterval;
    uint256 public recenterMarginBps;
    uint256 public exitTopCeilingMarginBps;

    // ---------------------------------------------------------------------
    // Risk params — owner-set bounds the operator must stay within
    // ---------------------------------------------------------------------

    uint256 public maxSlippageBps;
    uint256 public minRebalanceInterval;
    uint256 public maxRangeDeviationBps;

    // ---------------------------------------------------------------------
    // Runtime state
    // ---------------------------------------------------------------------

    uint256 public positionTokenId;
    uint256 public rebalanceCount;
    uint256 public lastRebalanceTimestamp;
    bool public paused;
    bool public closed;

    struct SwapInstruction {
        bool token0ToToken1;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint24 fee;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    /// @notice `positionAlreadyExists` (positionTokenId != 0 at the moment of
    /// this deposit) is now ALWAYS false past fix #3's revert — kept in the
    /// event signature regardless for off-chain event-decoding compatibility
    /// with the same indexer/B1 logic already built for V1/V2 vaults.
    event Deposited(uint256 investableAmount, uint256 reserveAmount, uint256 gasReserveAmount, bool positionAlreadyExists);
    event CreationFeeCharged(uint256 amount);
    event TargetConfigured(
        uint256 investmentAmountUsd,
        int24 targetTickLower,
        int24 targetTickUpper,
        uint256 maxRebalances,
        uint256 reinjectionAmount,
        uint256 periodicRebalanceInterval,
        uint256 recenterMarginBps,
        uint256 exitTopCeilingMarginBps,
        uint256 feeClaimThresholdBps,
        uint256 feeClaimIntervalSeconds
    );
    event PositionInitialized(uint256 tokenId, uint256 amount0, uint256 amount1);
    /// @notice `consumedUncounted` — how much of this cycle's fold-in was
    /// genuinely new, not-yet-counted investable capital (see
    /// uncountedInvestable's own docstring). Shared by rebalance() and
    /// ownerRebalance(). newTokenId == 0 signals the feature-6 hard-ceiling
    /// exit path (position closed, converted to stable, no new position
    /// minted) — see HardCeilingTriggered below for the dedicated event
    /// that accompanies it instead of the usual mint-related fields.
    event Rebalanced(
        uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 reinjectedAmount, uint256 consumedUncounted
    );
    event KeeperGasReimbursed(uint256 amountUsd, uint256 gasUsed, uint256 effectiveGasPrice);
    event LpFeesPaidToOwner(uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 amount0, uint256 amount1);
    event PerformanceFeeCollected(uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 amount0, uint256 amount1, uint256 principalUsd);
    /// @notice `consumedUncounted`, same meaning as Rebalanced's — shared by
    /// increasePosition() and increasePositionWithToken().
    event PositionIncreased(uint256 usdtAmount, uint256 used0, uint256 used1, uint256 consumedUncounted);
    event ReinjectedIntoPosition(uint256 amount, uint256 used0, uint256 used1);
    /// @notice `consumedUncounted`, same meaning as Rebalanced's.
    event IdleDustSwept(uint256 used0, uint256 used1, uint256 consumedUncounted);
    event OperatorUpdated(address newOperator);
    event RiskParamsUpdated(uint256 maxSlippageBps, uint256 minRebalanceInterval, uint256 maxRangeDeviationBps);
    event PausedSet(bool isPaused);
    event EmergencyWithdraw(uint256 amount0, uint256 amount1, uint256 principalUsd);
    event Closed();
    event AutoCompoundFeesSet(bool enabled);
    event FeesReinjected(uint256 netFee0, uint256 netFee1, uint256 used0, uint256 used1, uint256 netFeeUsd);
    /// @notice Fix #5(a) — emitted whenever setPayoutFeesInStableOnly() is called.
    event PayoutFeesInStableOnlySet(bool enabled);
    /// @notice Feature 6 — emitted whenever setHardCeiling() is called.
    event HardCeilingSet(bool enabled, int24 tick);
    /// @notice Feature 6 — emitted instead of Rebalanced when the hard
    /// ceiling triggers a close-and-park-in-stable exit. `stableAmount` is
    /// the vault's resulting investableUsdt right after (raw stable-decimal
    /// units) — the capital isn't paid out, it stays in the vault, retrievable
    /// via withdraw()/withdrawAll() same as any other idle investable balance.
    event HardCeilingTriggered(uint256 stableAmount);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier notClosed() {
        if (closed) revert VaultClosed();
        _;
    }

    constructor() {
        _disableInitializers();
    }

    /// @notice Called once by VaultFactoryArbCompoundV3 right after cloning.
    function initialize(
        address _owner,
        address _platformConfig,
        address _pool,
        address _token0,
        address _token1,
        bool _stableIsToken0,
        uint24 _feeTier,
        address _positionManager,
        address _swapRouter
    ) external initializer {
        if (
            _owner == address(0) || _platformConfig == address(0) || _pool == address(0)
                || _positionManager == address(0) || _swapRouter == address(0)
        ) {
            revert ZeroAddress();
        }
        __ReentrancyGuard_init();

        owner = _owner;
        platformConfig = _platformConfig;
        pool = IUniswapV3Pool(_pool);
        token0 = _token0;
        token1 = _token1;
        stableIsToken0 = _stableIsToken0;
        feeTier = _feeTier;
        positionManager = INonfungiblePositionManager(_positionManager);
        swapRouter = ISwapRouter02(_swapRouter);

        operator = IPlatformConfig(_platformConfig).defaultOperator();

        IERC20(_token0).forceApprove(_positionManager, type(uint256).max);
        IERC20(_token1).forceApprove(_positionManager, type(uint256).max);
        IERC20(_token0).forceApprove(_swapRouter, type(uint256).max);
        IERC20(_token1).forceApprove(_swapRouter, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Owner: capital + configuration
    // ---------------------------------------------------------------------

    /// @notice Fix #3: reverts if investableAmount > 0 and a position already
    /// exists — the "invertible" bucket can only ever be funded once, before
    /// initPosition() has run. Use increasePosition() (or
    /// increasePositionWithToken()) afterward instead. reserveAmount/
    /// gasReserveAmount are unaffected — those buckets stay fundable anytime.
    function deposit(uint256 reserveAmount, uint256 investableAmount, uint256 gasReserveAmount)
        external
        onlyOwner
        notClosed
        nonReentrant
    {
        if (positionTokenId != 0 && investableAmount > 0) revert InvestableAfterPositionExists();

        uint256 total = reserveAmount + investableAmount + gasReserveAmount;
        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt + gasReserveBalance;
        if (cap != 0 && currentTotal + total > cap) revert DepositExceedsPlatformCap();

        uint256 creationFee;
        if (!creationFeeCharged) {
            creationFeeCharged = true;
            creationFee = IPlatformConfig(platformConfig).creationFeeUsdt();
        }

        IERC20(_stableAddr()).safeTransferFrom(msg.sender, address(this), total + creationFee);

        if (creationFee > 0) {
            IERC20(_stableAddr()).safeTransfer(IPlatformConfig(platformConfig).treasury(), creationFee);
            emit CreationFeeCharged(creationFee);
        }

        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;
        gasReserveBalance += gasReserveAmount;

        emit Deposited(investableAmount, reserveAmount, gasReserveAmount, false);
    }

    /// @notice Depósito flexible, generalizado sobre _stableAddr()/_volatileAddr()
    /// en vez de asumir token0==stable. `tokenIn == _volatileAddr()`: swapIx
    /// vende el excedente o compra el faltante contra el rango objetivo, sin
    /// tocar la porción de volátil que ya calza. Cualquier otro token
    /// no-stable: se vende TODO al stable vía el router genérico.
    ///
    /// Vender el excedente PRODUCE stable nuevo — se acredita más abajo vía
    /// reserveAmount/investableAmount/gasReserveAmount, igual que un
    /// deposit() normal. Comprar el faltante, en cambio, GASTA investableUsdt
    /// ya acreditado (mismo capital ledgereado, no dinero nuevo) — hay que
    /// debitarlo explícitamente ANTES del swap, o el ledger terminaría
    /// sobreestimando el respaldo real en exactamente swapIx.amountIn (mismo
    /// tipo de bug de contabilidad que el resto del contrato evita en
    /// _reinjectFees/reinjectIntoPosition zerando investableUsdt primero).
    ///
    /// Fix #3: same investableAmount-after-first-position restriction as
    /// deposit() above.
    function depositToken(
        address tokenIn,
        uint256 amountIn,
        SwapInstruction calldata swapIx,
        uint24 thirdPartyFee,
        uint256 thirdPartyAmountOutMinimum,
        uint256 reserveAmount,
        uint256 investableAmount,
        uint256 gasReserveAmount
    ) external onlyOwner notClosed nonReentrant {
        if (positionTokenId != 0 && investableAmount > 0) revert InvestableAfterPositionExists();

        // Checked BEFORE any transfer/swap runs (same order deposit() itself
        // uses) — a deposit that's certain to exceed the cap fails fast,
        // instead of spending gas on a transferFrom + swap it's just going to
        // unwind anyway. Doesn't depend on the swap's outcome either way:
        // reserveAmount/investableAmount/gasReserveAmount are caller-supplied,
        // independent of what tokenIn actually converts to.
        uint256 total = reserveAmount + investableAmount + gasReserveAmount;
        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt + gasReserveBalance;
        if (cap != 0 && currentTotal + total > cap) revert DepositExceedsPlatformCap();

        if (amountIn > 0) IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        address stableAddr = _stableAddr();
        if (tokenIn == _volatileAddr()) {
            bool sellingVolatile = stableIsToken0 ? !swapIx.token0ToToken1 : swapIx.token0ToToken1;
            if (!sellingVolatile && swapIx.amountIn > 0) {
                investableUsdt -= swapIx.amountIn;
                // This debit spends already-ledgered investableUsdt without
                // distinguishing whether it draws from the counted or
                // uncounted portion — clamp defensively so
                // uncountedInvestable can never end up exceeding
                // investableUsdt (which would later underflow-revert in
                // withdraw()/withdrawAll()). Errs toward undercounting B1 in
                // this specific edge case, never toward a stuck vault.
                if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;
            }
            _executeSwap(swapIx);
        } else if (tokenIn != stableAddr && amountIn > 0) {
            IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
            swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: stableAddr,
                    fee: thirdPartyFee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: thirdPartyAmountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        uint256 creationFee;
        if (!creationFeeCharged) {
            creationFeeCharged = true;
            creationFee = IPlatformConfig(platformConfig).creationFeeUsdt();
        }
        if (creationFee > 0) {
            IERC20(stableAddr).safeTransfer(IPlatformConfig(platformConfig).treasury(), creationFee);
            emit CreationFeeCharged(creationFee);
        }

        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;
        gasReserveBalance += gasReserveAmount;

        emit Deposited(investableAmount, reserveAmount, gasReserveAmount, false);
    }

    function increasePosition(
        SwapInstruction calldata swapIx,
        uint256 usdtAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner notClosed nonReentrant {
        if (positionTokenId == 0) revert NoPosition();
        if (usdtAmount == 0) return;

        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt;
        if (cap != 0 && currentTotal + usdtAmount > cap) revert DepositExceedsPlatformCap();

        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        IERC20(_stableAddr()).safeTransferFrom(msg.sender, address(this), usdtAmount);

        _executeSwap(swapIx);

        uint256 stableBal =
            IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > usdtAmount) stableBal = usdtAmount;
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        // Increment by the MEASURED amount that actually arrived (stableBal),
        // never the caller-declared usdtAmount — see uncountedInvestable's
        // own docstring for why the distinction matters.
        uncountedInvestable += stableBal;

        (, uint256 used0, uint256 used1) = positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            })
        );

        uint256 foldedIn = _stableOf(used0, used1);
        uint256 consumedUncounted = foldedIn < uncountedInvestable ? foldedIn : uncountedInvestable;
        uncountedInvestable -= consumedUncounted;

        investableUsdt = preExistingInvestable + (stableBal - foldedIn);
        // Fix #2 — defensive clamp after every measured investableUsdt reassignment.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        emit PositionIncreased(usdtAmount, used0, used1, consumedUncounted);
    }

    /// @notice Same as increasePosition() but accepts any ERC20 — reuses
    /// depositToken()'s third-party-swap pattern (sell 100% of tokenIn into
    /// the vault's own stable), then feeds the result into the exact same
    /// increaseLiquidity() tail. `tokenIn == the vault's own stable` degrades
    /// to a no-swap passthrough, so this is a strict superset of
    /// increasePosition(). Deliberately does NOT special-case
    /// `tokenIn == _volatileAddr()` the way depositToken() does — the vault
    /// already picks up any volatile-leg balance automatically at mint time
    /// via `IERC20(_volatileAddr()).balanceOf(address(this))`, so adding
    /// volatile-token liquidity directly already works today via a plain
    /// transfer + increasePosition().
    function increasePositionWithToken(
        address tokenIn,
        uint256 amountIn,
        uint24 thirdPartyFee,
        uint256 thirdPartyAmountOutMinimum,
        SwapInstruction calldata swapIx,
        uint256 usdtAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner notClosed nonReentrant {
        if (positionTokenId == 0) revert NoPosition();
        if (usdtAmount == 0) return;

        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt;
        if (cap != 0 && currentTotal + usdtAmount > cap) revert DepositExceedsPlatformCap();

        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        address stableAddr = _stableAddr();
        if (amountIn > 0) IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        if (tokenIn != stableAddr && amountIn > 0) {
            IERC20(tokenIn).forceApprove(address(swapRouter), amountIn);
            swapRouter.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: stableAddr,
                    fee: thirdPartyFee,
                    recipient: address(this),
                    amountIn: amountIn,
                    amountOutMinimum: thirdPartyAmountOutMinimum,
                    sqrtPriceLimitX96: 0
                })
            );
        }

        _executeSwap(swapIx);

        uint256 stableBal =
            IERC20(stableAddr).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > usdtAmount) stableBal = usdtAmount;
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        uncountedInvestable += stableBal; // measured, not declared — see increasePosition()'s own comment

        (, uint256 used0, uint256 used1) = positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            })
        );

        uint256 foldedIn = _stableOf(used0, used1);
        uint256 consumedUncounted = foldedIn < uncountedInvestable ? foldedIn : uncountedInvestable;
        uncountedInvestable -= consumedUncounted;

        investableUsdt = preExistingInvestable + (stableBal - foldedIn);
        // Fix #2 — defensive clamp after every measured investableUsdt reassignment.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        emit PositionIncreased(usdtAmount, used0, used1, consumedUncounted);
    }

    function configureTarget(
        uint256 investmentAmountUsd,
        int24 _targetTickLower,
        int24 _targetTickUpper,
        uint256 _maxRebalances,
        uint256 _reinjectionAmount,
        uint256 _periodicRebalanceInterval,
        uint256 _recenterMarginBps,
        uint256 _exitTopCeilingMarginBps,
        uint256 _feeClaimThresholdBps,
        uint256 _feeClaimIntervalSeconds
    ) external onlyOwner notClosed {
        targetTickLower = _targetTickLower;
        targetTickUpper = _targetTickUpper;
        maxRebalances = _maxRebalances;
        reinjectionAmount = _reinjectionAmount;
        periodicRebalanceInterval = _periodicRebalanceInterval;
        recenterMarginBps = _recenterMarginBps;
        exitTopCeilingMarginBps = _exitTopCeilingMarginBps;
        feeClaimThresholdBps = _feeClaimThresholdBps;
        feeClaimIntervalSeconds = _feeClaimIntervalSeconds;
        targetConfigured = true;

        emit TargetConfigured(
            investmentAmountUsd,
            _targetTickLower,
            _targetTickUpper,
            _maxRebalances,
            _reinjectionAmount,
            _periodicRebalanceInterval,
            _recenterMarginBps,
            _exitTopCeilingMarginBps,
            _feeClaimThresholdBps,
            _feeClaimIntervalSeconds
        );
    }

    function setRiskParams(uint256 _maxSlippageBps, uint256 _minRebalanceInterval, uint256 _maxRangeDeviationBps)
        external
        onlyOwner
        notClosed
    {
        maxSlippageBps = _maxSlippageBps;
        minRebalanceInterval = _minRebalanceInterval;
        maxRangeDeviationBps = _maxRangeDeviationBps;
        emit RiskParamsUpdated(_maxSlippageBps, _minRebalanceInterval, _maxRangeDeviationBps);
    }

    function setOperator(address newOperator) external onlyOwner {
        operator = newOperator;
        emit OperatorUpdated(newOperator);
    }

    function pause() external onlyOwner {
        paused = true;
        emit PausedSet(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit PausedSet(false);
    }

    function setAutoCompoundFees(bool enabled) external onlyOwner notClosed {
        autoCompoundFees = enabled;
        emit AutoCompoundFeesSet(enabled);
    }

    /// @notice Fix #5(a). Settable regardless of autoCompoundFees's current
    /// value (see this field's own docstring above for why) — only actually
    /// changes behavior while autoCompoundFees is false.
    function setPayoutFeesInStableOnly(bool enabled) external onlyOwner notClosed {
        payoutFeesInStableOnly = enabled;
        emit PayoutFeesInStableOnlySet(enabled);
    }

    /// @notice Feature 6. `tick` is only meaningful while `enabled` is true —
    /// see hardCeilingTick's own docstring on direction (higher tick isn't
    /// always a higher price).
    function setHardCeiling(bool enabled, int24 tick) external onlyOwner notClosed {
        hardCeilingEnabled = enabled;
        hardCeilingTick = tick;
        emit HardCeilingSet(enabled, tick);
    }

    // ---------------------------------------------------------------------
    // Operator: build the initial position
    // ---------------------------------------------------------------------

    function initPosition(SwapInstruction calldata swapIx, uint256 amount0Min, uint256 amount1Min)
        external
        onlyOperator
        whenNotPaused
        notClosed
        nonReentrant
        returns (uint256 tokenId)
    {
        uint256 gasStart = gasleft();

        if (positionTokenId != 0) revert AlreadyInitializedPosition();
        if (!targetConfigured) revert TargetNotConfigured();
        _checkRangeNearMarket(targetTickLower, targetTickUpper);

        uint256 investable = investableUsdt;
        investableUsdt = 0;

        _executeSwap(swapIx);

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > investable) {
            stableBal = investable;
        }
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        uint256 used0;
        uint256 used1;
        (tokenId,, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: feeTier,
                tickLower: targetTickLower,
                tickUpper: targetTickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        positionTokenId = tokenId;
        lastRebalanceTimestamp = block.timestamp;

        (uint256 swept0, uint256 swept1) = _sweepDustIntoPosition(tokenId, amount0 - used0, amount1 - used1);

        investableUsdt = stableBal - _stableOf(used0, used1) - _stableOf(swept0, swept1);
        // Fix #2 — defensive clamp (uncountedInvestable is always 0 here in
        // practice, since nothing can mark capital "uncounted" before a
        // position exists — kept for uniformity/defense-in-depth anyway).
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        _reimburseKeeperGas(gasStart);

        emit PositionInitialized(tokenId, used0 + swept0, used1 + swept1);
    }

    // ---------------------------------------------------------------------
    // Operator: rebalance
    // ---------------------------------------------------------------------

    /// @notice Fix #5(a) + Feature 6 add one new param, `feePayoutSwapIx`,
    /// dual-purpose (mutually exclusive uses, so one param covers both):
    /// (a) normal case, non-compounding, payoutFeesInStableOnly enabled —
    ///     sizes the fee's volatile-leg-to-stable conversion.
    /// (b) hard-ceiling-triggered case — sizes the FULL close-out-to-stable
    ///     conversion (principal + fees combined) instead.
    /// `swapIx` (existing) is untouched — still only for the new mint's own
    /// balancing swap, never runs at all in the ceiling-triggered case since
    /// no new mint happens there.
    function rebalance(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
        SwapInstruction calldata feePayoutSwapIx,
        uint256 reinjectAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOperator whenNotPaused notClosed nonReentrant returns (uint256 newTokenId) {
        uint256 gasStart = gasleft();

        if (positionTokenId == 0) revert NoPosition();
        if (rebalanceCount >= maxRebalances) revert RebalanceLimitReached();

        bool periodicDue = periodicRebalanceInterval != 0
            && block.timestamp >= lastRebalanceTimestamp + periodicRebalanceInterval;
        bool cooldownPassed = block.timestamp >= lastRebalanceTimestamp + minRebalanceInterval;
        if (!cooldownPassed) revert TooSoonToRebalance();
        if (!periodicDue && !_isOutOfRange()) revert TooSoonToRebalance();

        newTokenId =
            _rebalanceCore(newTickLower, newTickUpper, swapIx, feePayoutSwapIx, reinjectAmount, amount0Min, amount1Min);

        _reimburseKeeperGas(gasStart);
    }

    // ---------------------------------------------------------------------
    // Owner: force a rebalance on demand
    // ---------------------------------------------------------------------

    /// @notice Same effect as rebalance(), but the owner triggers it
    /// directly — no need to wait for the operator's next cycle to pick up
    /// a config change (recenterMarginBps, periodicRebalanceInterval, etc.).
    /// The new range still has to come from uni-lab.xyz's real calculation
    /// (computed off-chain, same as for rebalance() — see
    /// runOwnerRebalanceViaUniLab in rebalancer.ts) — this function never
    /// derives newTickLower/newTickUpper itself, same as rebalance().
    /// Deliberately skips rebalance()'s periodicDue/_isOutOfRange() gate:
    /// the owner is choosing this is worth doing, not the keeper's automated
    /// heuristic — but the cooldown and rebalanceCount cap still apply, so
    /// this can't be spammed or used to exceed the owner's own configured
    /// limit. No _reimburseKeeperGas() — the owner pays their own gas
    /// directly, same reasoning as collectFees() (owner, no reimbursement)
    /// vs. harvestFees() (operator, reimbursed). Same feePayoutSwapIx
    /// dual-purpose param and hard-ceiling handling as rebalance() — see
    /// that function's own docstring.
    function ownerRebalance(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
        SwapInstruction calldata feePayoutSwapIx,
        uint256 reinjectAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner whenNotPaused notClosed nonReentrant returns (uint256 newTokenId) {
        if (positionTokenId == 0) revert NoPosition();
        if (rebalanceCount >= maxRebalances) revert RebalanceLimitReached();

        bool cooldownPassed = block.timestamp >= lastRebalanceTimestamp + minRebalanceInterval;
        if (!cooldownPassed) revert TooSoonToRebalance();

        newTokenId =
            _rebalanceCore(newTickLower, newTickUpper, swapIx, feePayoutSwapIx, reinjectAmount, amount0Min, amount1Min);
    }

    /// @dev Shared body of rebalance()/ownerRebalance() — everything past
    /// each function's own gate check (periodicDue/_isOutOfRange() for the
    /// former, none for the latter) is identical between them: the hard-
    /// ceiling check, decreaseLiquidity+collect, fee handling, the mint swap,
    /// optional reserve reinjection, the new mint, dust sweep, and ledger
    /// update. Factored out purely to keep RangeVaultArbCompoundV3's
    /// deployed bytecode under EIP-170's 24576-byte limit — duplicating this
    /// ~90-line body across both functions pushed the contract to 25969
    /// bytes, confirmed via a real deploy attempt against a local Arbitrum
    /// fork reverting with empty data (the classic signature of a
    /// contract-size-limit violation, not a require()/custom-error revert).
    /// No behavior change from inlining this into each caller — gas
    /// reimbursement (rebalance()-only) and rebalanceCount/
    /// lastRebalanceTimestamp bookkeeping in the ceiling branch stay exactly
    /// where they were.
    function _rebalanceCore(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
        SwapInstruction calldata feePayoutSwapIx,
        uint256 reinjectAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) internal returns (uint256 newTokenId) {
        bool aboveCeiling = _isAboveHardCeiling();
        if (!aboveCeiling) _checkRangeNearMarket(newTickLower, newTickUpper);

        (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
        uint256 removed0;
        uint256 removed1;
        if (liquidity > 0) {
            (removed0, removed1) = positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: positionTokenId,
                    liquidity: liquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        if (aboveCeiling) {
            // Feature 6 — deducts the platform's cut from the fee portion
            // only (same as always), everything else (principal + net fees)
            // stays in the vault's own balance and gets converted below —
            // nothing pays out to the owner here, this is a rebalance
            // outcome, not a withdrawal. The owner retrieves it later via
            // withdraw()/withdrawAll(), same as any idle investable balance.
            _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
            _closeToStableAndPause(feePayoutSwapIx);
            rebalanceCount += 1;
            lastRebalanceTimestamp = block.timestamp;
            return 0;
        }

        uint256 lpFee0 = collected0 - removed0;
        uint256 lpFee1 = collected1 - removed1;
        (uint256 netFee0, uint256 netFee1) = _splitPerformanceFee(lpFee0, lpFee1);
        if (autoCompoundFees) {
            if (netFee0 > 0 || netFee1 > 0) {
                lastFeeClaimTimestamp = block.timestamp;
                emit FeesReinjected(netFee0, netFee1, 0, 0, _toStableUsd(netFee0, netFee1));
            }
        } else {
            if (payoutFeesInStableOnly) (netFee0, netFee1) = _convertPayoutToStable(netFee0, netFee1, feePayoutSwapIx);
            if (netFee0 > 0) IERC20(token0).safeTransfer(owner, netFee0);
            if (netFee1 > 0) IERC20(token1).safeTransfer(owner, netFee1);
            if (netFee0 > 0 || netFee1 > 0) emit LpFeesPaidToOwner(netFee0, netFee1);
        }

        _executeSwap(swapIx);

        if (reinjectAmount > 0) {
            if (reinjectAmount > reinjectionAmount) revert ReinjectionExceedsCap();
            if (reinjectAmount > reserveBalance) revert InsufficientReserve();
            reserveBalance -= reinjectAmount;
        }

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        uint256 used0;
        uint256 used1;
        (newTokenId,, used0, used1) = positionManager.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: feeTier,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: address(this),
                deadline: block.timestamp
            })
        );

        positionTokenId = newTokenId;

        (uint256 swept0, uint256 swept1) = _sweepDustIntoPosition(newTokenId, amount0 - used0, amount1 - used1);

        uint256 foldedInStable = _stableOf(used0, used1) + _stableOf(swept0, swept1);
        uint256 consumedUncounted = foldedInStable < uncountedInvestable ? foldedInStable : uncountedInvestable;
        uncountedInvestable -= consumedUncounted;

        investableUsdt = stableBal - foldedInStable;
        // Fix #2 — defensive clamp after every measured investableUsdt reassignment.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        rebalanceCount += 1;
        lastRebalanceTimestamp = block.timestamp;

        emit Rebalanced(newTokenId, newTickLower, newTickUpper, reinjectAmount, consumedUncounted);
    }

    function reinjectIntoPosition(
        SwapInstruction calldata swapIx,
        uint256 amount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOperator whenNotPaused notClosed nonReentrant {
        uint256 gasStart = gasleft();

        if (positionTokenId == 0) revert NoPosition();
        if (amount == 0) return;
        if (amount > reinjectionAmount) revert ReinjectionExceedsCap();
        if (amount > reserveBalance) revert InsufficientReserve();

        reserveBalance -= amount;

        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        _executeSwap(swapIx);

        uint256 stableBal =
            IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > amount) stableBal = amount;
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        (, uint256 used0, uint256 used1) = positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            })
        );

        investableUsdt = preExistingInvestable + (stableBal - _stableOf(used0, used1));
        // Fix #2 — defensive clamp after every measured investableUsdt reassignment.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        _reimburseKeeperGas(gasStart);

        emit ReinjectedIntoPosition(amount, used0, used1);
    }

    /// @notice Reclamo programado de comisiones — ver RangeVaultCompound.sol.
    /// Reembolsa gas al keeper igual que el resto de entrypoints operator-only
    /// que el keeper envía como su propia transacción. Sigue requiriendo
    /// autoCompoundFees == true (harvestFees() never pays out directly to the
    /// owner, so payoutFeesInStableOnly has no bearing here).
    function harvestFees(SwapInstruction calldata swapIx, uint256 amount0Min, uint256 amount1Min)
        external
        onlyOperator
        whenNotPaused
        notClosed
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        uint256 gasStart = gasleft();

        if (positionTokenId == 0) revert NoPosition();
        if (!autoCompoundFees) revert AutoCompoundNotEnabled();

        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (amount0, amount1) = _splitPerformanceFee(collected0, collected1);

        _reinjectFees(amount0, amount1, swapIx, amount0Min, amount1Min, 0, 0);

        _reimburseKeeperGas(gasStart);
    }

    function sweepIdleDust(SwapInstruction calldata swapIx, uint256 amount0Min, uint256 amount1Min)
        external
        onlyOperator
        whenNotPaused
        notClosed
        nonReentrant
    {
        uint256 gasStart = gasleft();

        if (positionTokenId == 0) revert NoPosition();

        _executeSwap(swapIx);

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        (, uint256 used0, uint256 used1) = positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            })
        );

        uint256 foldedInStable = _stableOf(used0, used1);
        uint256 consumedUncounted = foldedInStable < uncountedInvestable ? foldedInStable : uncountedInvestable;
        uncountedInvestable -= consumedUncounted;

        investableUsdt = stableBal - foldedInStable;
        // Fix #2 — this is the exact site where V2's real production bug
        // happened (see uncountedInvestable's own docstring at the top of
        // this file) — the clamp below is the actual fix for that incident.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        _reimburseKeeperGas(gasStart);

        emit IdleDustSwept(used0, used1, consumedUncounted);
    }

    // ---------------------------------------------------------------------
    // Owner: collect fees — trading fees only, principal untouched
    // ---------------------------------------------------------------------

    /// @notice Fix #5(a) adds `feePayoutSwapIx` — only consumed in the
    /// non-compounding branch when payoutFeesInStableOnly is enabled; a
    /// no-op (amountIn == 0) otherwise, same convention as every other
    /// SwapInstruction param in this contract.
    function collectFees(SwapInstruction calldata swapIx, SwapInstruction calldata feePayoutSwapIx, uint256 amount0Min, uint256 amount1Min)
        external
        onlyOwner
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (positionTokenId == 0) revert NoPosition();

        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (amount0, amount1) = _splitPerformanceFee(collected0, collected1);

        if (autoCompoundFees) {
            _reinjectFees(amount0, amount1, swapIx, amount0Min, amount1Min, 0, 0);
        } else {
            if (payoutFeesInStableOnly) (amount0, amount1) = _convertPayoutToStable(amount0, amount1, feePayoutSwapIx);
            if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
            if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);
            lastFeeClaimTimestamp = block.timestamp;
            emit FeesCollected(amount0, amount1);
        }
    }

    // ---------------------------------------------------------------------
    // Owner: withdraw — the only path principal can ever leave the vault
    // ---------------------------------------------------------------------

    /// @notice The 4 ledger buckets are fully independent (V2 behavior,
    /// unchanged). Fix #4 + Feature 5(b) layered in:
    ///   - Partial exit (positionShareBps < 10_000) with autoCompoundFees on:
    ///     fees reinject into the REMAINING position via `feeSwapIx` — pure
    ///     principal (no fees mixed in) is what reaches amount0/amount1.
    ///   - Partial exit with autoCompoundFees off: fees pay out directly,
    ///     optionally converted to stable first if payoutFeesInStableOnly is
    ///     on (`feeSwapIx` sized for that), tracked in their own
    ///     LpFeesPaidToOwner event — never merged into amount0/amount1.
    ///   - Full close (positionShareBps == 10_000): no remaining position to
    ///     reinject into either way — fees pay out merged with principal,
    ///     same as V2, but payoutFeesInStableOnly still applies here
    ///     (intent-based: from the owner's perspective a full close is
    ///     indistinguishable from any other direct fee payout).
    ///   - `payoutSwapIx` (Feature 5(b)) always runs LAST, on whatever
    ///     total0/total1 end up being after the branch above resolves —
    ///     works identically regardless of autoCompoundFees's state, since
    ///     it only ever sees pure principal (when compounding is on) or
    ///     principal+fees (when off), never double-converts what feeSwapIx
    ///     already touched.
    function withdraw(
        uint256 positionShareBps,
        uint256 investableShareBps,
        uint256 reserveShareBps,
        uint256 gasReserveShareBps,
        SwapInstruction calldata feeSwapIx,
        SwapInstruction calldata payoutSwapIx,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner nonReentrant {
        if (
            positionShareBps > 10_000 || investableShareBps > 10_000 || reserveShareBps > 10_000
                || gasReserveShareBps > 10_000
        ) revert InvalidShareBps();
        if (
            positionShareBps == 0 && investableShareBps == 0 && reserveShareBps == 0 && gasReserveShareBps == 0
        ) revert InvalidShareBps();

        uint256 amount0;
        uint256 amount1;
        // Principal removed from the position — SEPARATE from amount0/amount1
        // above, which also fold in the owner's fee share in the full-close
        // case only (partial-exit-plus-compounding never merges them at
        // all — fix #4). Fees never counted toward B1, so principalUsd below
        // must be computed from these, never from amount0/amount1 directly.
        uint256 removedPrincipal0;
        uint256 removedPrincipal1;

        if (positionShareBps > 0 && positionTokenId != 0) {
            (amount0, amount1, removedPrincipal0, removedPrincipal1) =
                _withdrawPositionShare(positionShareBps, feeSwapIx, amount0Min, amount1Min);
        }

        uint256 investableShare = (investableUsdt * investableShareBps) / 10_000;
        uint256 reserveShare = (reserveBalance * reserveShareBps) / 10_000;
        uint256 gasReserveShare = (gasReserveBalance * gasReserveShareBps) / 10_000;
        investableUsdt -= investableShare;
        reserveBalance -= reserveShare;
        gasReserveBalance -= gasReserveShare;

        // investableShare itself can be a mix of already-counted capital and
        // still-uncounted pending top-ups (see uncountedInvestable's own
        // docstring) — the slice proportional to investableShareBps shrinks
        // uncountedInvestable the same way the position/reserve/gas shares
        // above shrink their own ledgers, and principalUsd must exclude the
        // uncounted portion (can't subtract from B1 what was never added).
        uint256 uncountedShare = (uncountedInvestable * investableShareBps) / 10_000;
        uncountedInvestable -= uncountedShare;

        // Deliberately excludes fees (never in B1), reserveShare/
        // gasReserveShare (reserve only ever counts in B1 at the moment it's
        // REINJECTED — withdrawing it un-reinjected is withdrawing capital
        // that was never added to B1 in the first place, so it can't
        // subtract from it either), and uncountedShare (same reasoning,
        // applied to the investable leg).
        uint256 principalUsd = _toStableUsd(removedPrincipal0, removedPrincipal1) + (investableShare - uncountedShare);

        (uint256 ledger0, uint256 ledger1) = _toToken01(investableShare + reserveShare + gasReserveShare, 0);
        uint256 total0 = amount0 + ledger0;
        uint256 total1 = amount1 + ledger1;

        // Feature 5(b) — per-call "todo en stable", owner-sized, runs last,
        // over whatever this specific withdrawal ends up paying out.
        (total0, total1) = _convertPayoutToStable(total0, total1, payoutSwapIx);

        if (total0 > 0) IERC20(token0).safeTransfer(owner, total0);
        if (total1 > 0) IERC20(token1).safeTransfer(owner, total1);

        emit Withdrawn(total0, total1, principalUsd);
    }

    /// @dev Extracted from withdraw() purely to keep local-variable count
    /// under control (stack-too-deep risk with 8 params + this much local
    /// state) — no behavior difference from having it inline. Returns
    /// amount0/amount1/removedPrincipal0/removedPrincipal1 — the caller MUST
    /// capture all four from the call site, Solidity doesn't mutate a
    /// value-type argument in place.
    function _withdrawPositionShare(
        uint256 positionShareBps,
        SwapInstruction calldata feeSwapIx,
        uint256 amount0Min,
        uint256 amount1Min
    ) internal returns (uint256 amount0, uint256 amount1, uint256 removedPrincipal0, uint256 removedPrincipal1) {
        (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
        uint128 partialLiquidity = uint128((uint256(liquidity) * positionShareBps) / 10_000);
        uint256 removed0;
        uint256 removed1;
        if (partialLiquidity > 0) {
            (removed0, removed1) = positionManager.decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: positionTokenId,
                    liquidity: partialLiquidity,
                    amount0Min: 0,
                    amount1Min: 0,
                    deadline: block.timestamp
                })
            );
        }
        (uint256 collected0, uint256 collected1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: positionTokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        (uint256 netFee0, uint256 netFee1) = _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
        removedPrincipal0 = removed0;
        removedPrincipal1 = removed1;

        if (positionShareBps == 10_000) {
            positionTokenId = 0;
            // Full close — no remaining position to reinject into regardless
            // of autoCompoundFees; fees merge with principal same as V2, but
            // still respect payoutFeesInStableOnly (intent-based — see this
            // function's own docstring).
            if (payoutFeesInStableOnly) (netFee0, netFee1) = _convertPayoutToStable(netFee0, netFee1, feeSwapIx);
            amount0 = removed0 + netFee0;
            amount1 = removed1 + netFee1;
        } else if (autoCompoundFees) {
            // Fix #4 — fees reinject into the position that's staying open;
            // the owner receives pure principal only. removed0/removed1 must
            // be excluded from _reinjectFees()'s own balance measurement —
            // decreaseLiquidity() above already deposited them into the
            // vault's raw balance too, see _reinjectFees()'s own docstring.
            _reinjectFees(
                netFee0, netFee1, feeSwapIx, amount0Min, amount1Min, _stableOf(removed0, removed1),
                stableIsToken0 ? removed1 : removed0
            );
            amount0 = removed0;
            amount1 = removed1;
        } else {
            if (payoutFeesInStableOnly) (netFee0, netFee1) = _convertPayoutToStable(netFee0, netFee1, feeSwapIx);
            if (netFee0 > 0) IERC20(token0).safeTransfer(owner, netFee0);
            if (netFee1 > 0) IERC20(token1).safeTransfer(owner, netFee1);
            if (netFee0 > 0 || netFee1 > 0) emit LpFeesPaidToOwner(netFee0, netFee1);
            amount0 = removed0;
            amount1 = removed1;
        }
    }

    /// @notice Fix #1 (saturating subtraction) + Feature 5(b) (`payoutSwapIx`).
    function withdrawAll(SwapInstruction calldata feeSwapIx, SwapInstruction calldata payoutSwapIx)
        external
        onlyOwner
        nonReentrant
    {
        uint256 removed0;
        uint256 removed1;
        if (positionTokenId != 0) {
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
            if (liquidity > 0) {
                (removed0, removed1) = positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: positionTokenId,
                        liquidity: liquidity,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    })
                );
            }
            (uint256 collected0, uint256 collected1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: positionTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            (uint256 netFee0, uint256 netFee1) = _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
            // Fees aren't tracked separately here (everything sweeps out
            // undifferentiated below, same as V2) — if the preference is on,
            // just convert them in place; the stable proceeds land in the
            // vault's own balance and get swept out regardless of currency
            // by the balanceOf reads right below.
            if (payoutFeesInStableOnly) _convertPayoutToStable(netFee0, netFee1, feeSwapIx);
            positionTokenId = 0;
        }

        // Fix #1 — saturating subtraction. This principalUsd figure only
        // feeds the audit event (B1 accounting off-chain); it must never be
        // able to block the actual fund transfer below.
        uint256 investableCounted = investableUsdt > uncountedInvestable ? investableUsdt - uncountedInvestable : 0;
        uint256 principalUsd = _toStableUsd(removed0, removed1) + investableCounted;

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;
        gasReserveBalance = 0;
        uncountedInvestable = 0;

        // Feature 5(b) — owner-sized "todo en stable" over the full sweep.
        (amount0, amount1) = _convertPayoutToStable(amount0, amount1, payoutSwapIx);

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit Withdrawn(amount0, amount1, principalUsd);
    }

    /// @notice Fix #1 (saturating subtraction) only — deliberately excludes
    /// Feature 5 entirely (no SwapInstruction param, ignores
    /// payoutFeesInStableOnly). This is the last-resort exit; its ENTIRE
    /// purpose is to work no matter what state the rest of the system is
    /// in. Adding a swap dependency here would reintroduce, in a worse form,
    /// exactly the category of risk fix #1 exists to remove: an external
    /// call (swapRouter.exactInputSingle) that can revert for reasons
    /// entirely outside this vault's control — insufficient pool liquidity,
    /// an unmet amountOutMinimum, the router itself paused. An owner with
    /// payoutFeesInStableOnly enabled will get raw mixed-token funds
    /// specifically from this one call — a deliberate, documented
    /// inconsistency, not an oversight. Surface this in the frontend
    /// wherever the emergency-exit action is exposed.
    function emergencyWithdrawPosition() external onlyOwner nonReentrant {
        paused = true;
        emit PausedSet(true);

        uint256 removed0;
        uint256 removed1;
        if (positionTokenId != 0) {
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
            if (liquidity > 0) {
                (removed0, removed1) = positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: positionTokenId,
                        liquidity: liquidity,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    })
                );
            }
            (uint256 collected0, uint256 collected1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: positionTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
            positionTokenId = 0;
        }

        // Fix #1 — saturating subtraction, same reasoning as withdrawAll().
        uint256 investableCounted = investableUsdt > uncountedInvestable ? investableUsdt - uncountedInvestable : 0;
        uint256 principalUsd = _toStableUsd(removed0, removed1) + investableCounted;

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;
        gasReserveBalance = 0;
        uncountedInvestable = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit EmergencyWithdraw(amount0, amount1, principalUsd);
    }

    function closeVault() external onlyOwner {
        if (closed) revert VaultClosed();
        if (
            positionTokenId != 0 || investableUsdt != 0 || reserveBalance != 0 || gasReserveBalance != 0
                || IERC20(token0).balanceOf(address(this)) != 0 || IERC20(token1).balanceOf(address(this)) != 0
        ) {
            revert VaultNotEmpty();
        }
        closed = true;
        emit Closed();
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    uint256 constant GAS_REIMBURSEMENT_OVERHEAD = 40_000;

    function _reimburseKeeperGas(uint256 gasStart) internal {
        uint256 effectiveGasPrice = tx.gasprice < block.basefee * 3 ? tx.gasprice : block.basefee * 3;
        uint256 gasUsed = gasStart - gasleft() + GAS_REIMBURSEMENT_OVERHEAD;
        uint256 gasCostUsd = _nativeWeiToStableRaw(gasUsed * effectiveGasPrice);
        uint256 gasReimbursed = gasCostUsd < gasReserveBalance ? gasCostUsd : gasReserveBalance;
        if (gasReimbursed > 0) {
            gasReserveBalance -= gasReimbursed;
            IERC20(_stableAddr()).safeTransfer(operator, gasReimbursed);
            emit KeeperGasReimbursed(gasReimbursed, gasUsed, effectiveGasPrice);
        }
    }

    /// @dev Reinyecta fees ya cobradas (post-_splitPerformanceFee) al principal
    /// de la posición abierta — ver RangeVaultCompound.sol para el porqué del
    /// swap mixto (fees llegan en las dos piernas a la vez). Generalizado
    /// sobre _stableAddr()/_volatileAddr()/_toToken01()/_stableOf() como el
    /// resto de esta variante Arbitrum.
    /// @dev `excludeStableExtra`/`excludeVolatileExtra` — additional balance
    /// to treat as "not available for this reinject", beyond the usual
    /// preExistingInvestable/reserveBalance/gasReserveBalance ledgers. Zero
    /// for collectFees()/harvestFees() (the vault's balance at that point
    /// genuinely is only the fee, nothing else). Nonzero for
    /// _withdrawPositionShare()'s compounding-partial-exit branch: that call
    /// site runs AFTER decreaseLiquidity() has already deposited the
    /// REMOVED PRINCIPAL into the vault's raw token balance too — without
    /// this exclusion, this function's balance-delta measurement can't tell
    /// principal and fee apart, sweeps the principal into the reinject
    /// alongside the fee, and then reverts trying to pay the owner an amount
    /// that's already been spent (confirmed live via a fork test: "ERC20:
    /// transfer amount exceeds balance").
    function _reinjectFees(
        uint256 netFee0,
        uint256 netFee1,
        SwapInstruction calldata swapIx,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 excludeStableExtra,
        uint256 excludeVolatileExtra
    ) internal {
        if (netFee0 == 0 && netFee1 == 0) return;

        // Valued from the fee amounts themselves, at the pool's price right
        // now — before _executeSwap below, which only trades one leg for the
        // other at that same price and creates no new value, so computing it
        // here vs. after is equivalent modulo swap slippage/fees (negligible
        // for this accounting figure, same tolerance the rest of the B1/A1
        // design already accepts).
        uint256 netFeeUsd = _toStableUsd(netFee0, netFee1);

        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        _executeSwap(swapIx);

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance
            - gasReserveBalance - excludeStableExtra;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this)) - excludeVolatileExtra;
        (uint256 amount0, uint256 amount1) = _toToken01(stableBal, volatileBal);

        (, uint256 used0, uint256 used1) = positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: positionTokenId,
                amount0Desired: amount0,
                amount1Desired: amount1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: block.timestamp
            })
        );

        investableUsdt = preExistingInvestable + (stableBal - _stableOf(used0, used1));
        // Fix #2 — defensive clamp after every measured investableUsdt reassignment.
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        lastFeeClaimTimestamp = block.timestamp;
        emit FeesReinjected(netFee0, netFee1, used0, used1, netFeeUsd);
    }

    function _splitPerformanceFee(uint256 fee0, uint256 fee1) internal returns (uint256 net0, uint256 net1) {
        uint256 bps = IPlatformConfig(platformConfig).performanceFeeBps();
        uint256 platform0 = (fee0 * bps) / 10_000;
        uint256 platform1 = (fee1 * bps) / 10_000;
        if (platform0 > 0) IERC20(token0).safeTransfer(operator, platform0);
        if (platform1 > 0) IERC20(token1).safeTransfer(operator, platform1);
        if (platform0 > 0 || platform1 > 0) emit PerformanceFeeCollected(platform0, platform1);
        net0 = fee0 - platform0;
        net1 = fee1 - platform1;
    }

    function _sweepDustIntoPosition(uint256 tokenId, uint256 leftover0, uint256 leftover1)
        internal
        returns (uint256 swept0, uint256 swept1)
    {
        if (leftover0 == 0 && leftover1 == 0) return (0, 0);
        try positionManager.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId: tokenId,
                amount0Desired: leftover0,
                amount1Desired: leftover1,
                amount0Min: 0,
                amount1Min: 0,
                deadline: block.timestamp
            })
        ) returns (uint128, uint256 used0, uint256 used1) {
            swept0 = used0;
            swept1 = used1;
        } catch {
            swept0 = 0;
            swept1 = 0;
        }
    }

    /// @notice Feature 5 — converts up to swapIx.amountIn of whatever
    /// volatile-token leg is present in (amount0, amount1) into the vault's
    /// stable token, returning the resulting (out0, out1) with the same
    /// total economic value, just re-split toward stable. Shared by both
    /// mechanisms: the persistent payoutFeesInStableOnly preference
    /// (collectFees/rebalance/ownerRebalance's fee-only amounts) and the
    /// per-call payoutSwapIx (withdraw/withdrawAll's principal+fee amounts),
    /// plus Feature 6's full close-out. Operates on NET amounts only (post-
    /// _splitPerformanceFee where relevant) — the platform's cut is always
    /// taken first, in the original token split, never touched by this.
    ///
    /// swapIx.amountIn == 0 is a complete no-op (returns the input
    /// unchanged) — same convention as _executeSwap itself, so a caller who
    /// doesn't want any conversion just passes the same inert default used
    /// everywhere else in this contract.
    ///
    /// Deliberately reverts (rather than silently clamping) if
    /// swapIx.amountIn exceeds the volatile amount actually present in THIS
    /// call's (amount0, amount1) — the one place in this contract where a
    /// caller-supplied SwapInstruction gets validated against a hard,
    /// known-in-advance bound, unlike a mint/reinject swap's target amount
    /// (a heuristic, not a fact). Closes off selling volatile balance that
    /// has nothing to do with this specific payout. Under-sizing (amountIn
    /// less than the full volatile leg) degrades gracefully instead —
    /// whatever isn't converted just pays out raw alongside the converted
    /// stable, no revert.
    function _convertPayoutToStable(uint256 amount0, uint256 amount1, SwapInstruction calldata swapIx)
        internal
        returns (uint256 out0, uint256 out1)
    {
        uint256 volatileAmount = stableIsToken0 ? amount1 : amount0;
        if (swapIx.amountIn > volatileAmount) revert InvalidSwapInstruction();
        if (swapIx.amountIn == 0) return (amount0, amount1);

        bool sellsVolatileForStable = stableIsToken0 ? !swapIx.token0ToToken1 : swapIx.token0ToToken1;
        if (!sellsVolatileForStable) revert InvalidSwapInstruction();

        uint256 stableBefore = IERC20(_stableAddr()).balanceOf(address(this));
        _executeSwap(swapIx);
        uint256 stableReceived = IERC20(_stableAddr()).balanceOf(address(this)) - stableBefore;

        uint256 remainingVolatile = volatileAmount - swapIx.amountIn;
        uint256 stableAmount = stableIsToken0 ? amount0 : amount1;
        (out0, out1) = _toToken01(stableAmount + stableReceived, remainingVolatile);
    }

    /// @notice Feature 6 — closes the position out to 100% stable and
    /// auto-pauses, called from rebalance()/ownerRebalance() once the hard
    /// ceiling has been confirmed crossed and decreaseLiquidity+collect have
    /// already run (the caller passes control here right after). Reuses
    /// `paused`/`whenNotPaused` (already blocks initPosition()/rebalance())
    /// instead of a new flag — this is also what stops checkVault() (keeper,
    /// off-chain) from mistaking positionTokenId == 0 for "brand new vault,
    /// needs its first position" and trying to auto-reopen: initPosition()
    /// itself reverts while paused, no keeper-side change needed. withdraw()
    /// has no whenNotPaused gate, so the owner can always retrieve the
    /// parked stable balance regardless.
    function _closeToStableAndPause(SwapInstruction calldata exitSwapIx) internal {
        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        (uint256 exitAmount0, uint256 exitAmount1) = _toToken01(stableBal, volatileBal);
        (exitAmount0, exitAmount1) = _convertPayoutToStable(exitAmount0, exitAmount1, exitSwapIx);

        // Stays inside the vault as investableUsdt — this is a rebalance
        // outcome, not a withdrawal. The owner still owns this capital, now
        // parked in stable, retrievable via withdraw()/withdrawAll() same as
        // any other idle investable balance.
        investableUsdt = _stableOf(exitAmount0, exitAmount1);
        if (uncountedInvestable > investableUsdt) uncountedInvestable = investableUsdt;

        positionTokenId = 0;
        paused = true;
        emit PausedSet(true);
        emit HardCeilingTriggered(investableUsdt);
    }

    function _stableAddr() internal view returns (address) {
        return stableIsToken0 ? token0 : token1;
    }

    function _volatileAddr() internal view returns (address) {
        return stableIsToken0 ? token1 : token0;
    }

    function _toToken01(uint256 stableAmt, uint256 volatileAmt) internal view returns (uint256, uint256) {
        return stableIsToken0 ? (stableAmt, volatileAmt) : (volatileAmt, stableAmt);
    }

    function _stableOf(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        return stableIsToken0 ? amount0 : amount1;
    }

    function _nativeWeiToStableRaw(uint256 volatileWei) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        if (stableIsToken0) {
            uint256 step1 = (volatileWei << 96) / sqrtPriceX96;
            return (step1 << 96) / sqrtPriceX96;
        } else {
            uint256 step1 = (volatileWei * sqrtPriceX96) >> 96;
            return (step1 * sqrtPriceX96) >> 96;
        }
    }

    /// @dev Values a pair of real token0/token1 amounts entirely in the
    /// stable leg's raw units, at the pool's CURRENT spot price — the stable
    /// leg passes through unchanged, the volatile leg goes through
    /// _nativeWeiToStableRaw (same math _reimburseKeeperGas already relies on
    /// for gas cost, nothing gas-specific about it). Shared by every B1
    /// accounting event this contract emits (FeesReinjected.netFeeUsd,
    /// Withdrawn/EmergencyWithdraw.principalUsd) so both directions —
    /// capital entering the position (reinjection) and capital leaving it
    /// (withdrawal) — are valued the exact same way, at the exact moment
    /// each happens.
    function _toStableUsd(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        uint256 stableRaw = _stableOf(amount0, amount1);
        uint256 volatileRaw = stableIsToken0 ? amount1 : amount0;
        return stableRaw + _nativeWeiToStableRaw(volatileRaw);
    }

    function _executeSwap(SwapInstruction calldata swapIx) internal {
        if (swapIx.amountIn == 0) return;
        if (swapIx.fee == 0) revert InvalidSwapInstruction();
        address tokenIn = swapIx.token0ToToken1 ? token0 : token1;
        address tokenOut = swapIx.token0ToToken1 ? token1 : token0;
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: swapIx.fee,
                recipient: address(this),
                amountIn: swapIx.amountIn,
                amountOutMinimum: swapIx.amountOutMinimum,
                sqrtPriceLimitX96: 0
            })
        );
    }

    function _checkRangeNearMarket(int24 tickLower, int24 tickUpper) internal view {
        (, int24 currentTick,,,,,) = pool.slot0();
        int256 slack = int256(maxRangeDeviationBps);
        int256 lowerBound = int256(tickLower) - slack;
        int256 upperBound = int256(tickUpper) + slack;
        int256 current = int256(currentTick);
        if (current < lowerBound || current > upperBound) revert RangeTooFarFromMarket();
    }

    function _isOutOfRange() internal view returns (bool) {
        (,,,,, int24 posTickLower, int24 posTickUpper, uint128 liquidity,,,,) =
            positionManager.positions(positionTokenId);
        if (liquidity == 0) return true;
        (, int24 currentTick,,,,,) = pool.slot0();
        return currentTick < posTickLower || currentTick > posTickUpper;
    }

    /// @notice Feature 6 — direction-aware comparison against hardCeilingTick.
    /// A higher tick means a HIGHER price when stableIsToken0 is false
    /// (Arbitrum: token0=volatile, token1=stable — raw price token1/token0
    /// rises with tick, and that raw price IS the stable-per-volatile price).
    /// A higher tick means a LOWER price when stableIsToken0 is true (Celo:
    /// token0=stable — the stable-per-volatile price is the INVERSE of the
    /// raw token1/token0 price, so it falls as tick rises). Same direction
    /// logic this codebase's own off-chain keeper already uses for
    /// `floorTick` (see rebalancer.ts) — mirrored here on-chain rather than
    /// trusted from any caller, since this gate exists specifically so a
    /// misbehaving/compromised operator can't rebalance past the owner's
    /// configured ceiling regardless of what it claims off-chain.
    function _isAboveHardCeiling() internal view returns (bool) {
        if (!hardCeilingEnabled) return false;
        (, int24 currentTick,,,,,) = pool.slot0();
        return stableIsToken0 ? currentTick <= hardCeilingTick : currentTick >= hardCeilingTick;
    }

    // ---------------------------------------------------------------------
    // ERC721 receiver — required to hold the Uniswap V3 position NFT
    // ---------------------------------------------------------------------

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        return this.onERC721Received.selector;
    }
}
