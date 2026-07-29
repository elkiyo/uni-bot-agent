// SPDX-License-Identifier: MIT
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

/// @title RangeVaultArbCompoundV2
/// @notice Fork of RangeVaultArbCompound.sol adding `ownerRebalance()` — lets
/// the owner force a rebalance themselves (e.g. right after changing
/// recenterMarginBps or another agent parameter) instead of waiting for the
/// operator's next cycle to happen to pick it up. Everything else is
/// identical to RangeVaultArbCompound.sol, which is never touched (same fork
/// discipline as every other variant here — see CLAUDE.md's "Arquitectura de
/// contratos"). ownerRebalance() deliberately skips the periodicDue/
/// _isOutOfRange() gate rebalance() has (the owner is choosing to do this,
/// not the keeper's automated heuristic) but keeps the cooldown and
/// rebalanceCount cap; it never calls _reimburseKeeperGas() either, same
/// owner-pays-their-own-gas reasoning as collectFees() vs. harvestFees().
contract RangeVaultArbCompoundV2 is Initializable, ReentrancyGuardUpgradeable, IERC721Receiver {
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

    /// @notice V2 only. `investableUsdt` mixes two things that must be
    /// treated differently for B1 (cumulative investment) accounting off-chain:
    /// genuinely new capital from a LATER deposit()/depositToken() call (made
    /// after a position already exists) that hasn't been folded into the
    /// position yet, vs. leftover stable-side residue from a prior mint that
    /// was already counted once. `uncountedInvestable` tracks ONLY the
    /// former — incremented in deposit()/depositToken() when a position
    /// already exists, decremented (by the MEASURED, not caller-declared,
    /// amount actually folded in — see increasePosition()'s own comment on
    /// why) every time rebalance()/ownerRebalance()/sweepIdleDust()/
    /// increasePosition()/increasePositionWithToken() folds investableUsdt
    /// into the live position. Deliberately never touched by initPosition()
    /// or the very first deposit() (pre-position) — that capital counts
    /// immediately via Deposited.investableAmount, same as V1, since it's
    /// provably always 0 until a position exists (see Deposited's own
    /// `positionAlreadyExists` field below).
    uint256 public uncountedInvestable;

    bool public creationFeeCharged;

    // ---------------------------------------------------------------------
    // Interés compuesto — todos off-chain-only knobs salvo autoCompoundFees.
    // ---------------------------------------------------------------------

    bool public autoCompoundFees;
    uint256 public feeClaimThresholdBps;
    uint256 public feeClaimIntervalSeconds;
    uint256 public lastFeeClaimTimestamp;

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

    /// @notice V2: `positionAlreadyExists` (positionTokenId != 0 at the
    /// moment of this deposit) — required for the off-chain B1 calculation
    /// to know whether investableAmount counts immediately (no position
    /// yet, same as V1) or waits for uncountedInvestable to be folded in
    /// later. positionTokenId isn't monotonic (a full withdraw resets it to
    /// 0, initPosition() can run again after), so this can't be
    /// reconstructed off-chain from current state alone — it must be
    /// recorded at the moment it happens.
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
    /// @notice V2: `consumedUncounted` — how much of this cycle's fold-in
    /// was genuinely new, not-yet-counted investable capital (see
    /// uncountedInvestable's own docstring). Shared by rebalance() and
    /// ownerRebalance().
    event Rebalanced(
        uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 reinjectedAmount, uint256 consumedUncounted
    );
    event KeeperGasReimbursed(uint256 amountUsd, uint256 gasUsed, uint256 effectiveGasPrice);
    event LpFeesPaidToOwner(uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 amount0, uint256 amount1);
    event PerformanceFeeCollected(uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 amount0, uint256 amount1, uint256 principalUsd);
    /// @notice V2: `consumedUncounted`, same meaning as Rebalanced's — shared
    /// by increasePosition() and increasePositionWithToken().
    event PositionIncreased(uint256 usdtAmount, uint256 used0, uint256 used1, uint256 consumedUncounted);
    event ReinjectedIntoPosition(uint256 amount, uint256 used0, uint256 used1);
    /// @notice V2: `consumedUncounted`, same meaning as Rebalanced's.
    event IdleDustSwept(uint256 used0, uint256 used1, uint256 consumedUncounted);
    event OperatorUpdated(address newOperator);
    event RiskParamsUpdated(uint256 maxSlippageBps, uint256 minRebalanceInterval, uint256 maxRangeDeviationBps);
    event PausedSet(bool isPaused);
    event EmergencyWithdraw(uint256 amount0, uint256 amount1, uint256 principalUsd);
    event Closed();
    event AutoCompoundFeesSet(bool enabled);
    event FeesReinjected(uint256 netFee0, uint256 netFee1, uint256 used0, uint256 used1, uint256 netFeeUsd);

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

    /// @notice Called once by VaultFactoryArbCompound right after cloning.
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

    function deposit(uint256 reserveAmount, uint256 investableAmount, uint256 gasReserveAmount)
        external
        onlyOwner
        notClosed
        nonReentrant
    {
        uint256 total = reserveAmount + investableAmount + gasReserveAmount;
        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt + gasReserveBalance;
        if (cap != 0 && currentTotal + total > cap) revert DepositExceedsPlatformCap();

        uint256 creationFee;
        if (!creationFeeCharged) {
            creationFeeCharged = true;
            creationFee = IPlatformConfig(platformConfig).creationFeeUsdt();
        }

        bool positionAlreadyExists = positionTokenId != 0;

        IERC20(_stableAddr()).safeTransferFrom(msg.sender, address(this), total + creationFee);

        if (creationFee > 0) {
            IERC20(_stableAddr()).safeTransfer(IPlatformConfig(platformConfig).treasury(), creationFee);
            emit CreationFeeCharged(creationFee);
        }

        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;
        gasReserveBalance += gasReserveAmount;
        if (positionAlreadyExists) uncountedInvestable += investableAmount;

        emit Deposited(investableAmount, reserveAmount, gasReserveAmount, positionAlreadyExists);
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

        bool positionAlreadyExists = positionTokenId != 0;

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
        if (positionAlreadyExists) uncountedInvestable += investableAmount;

        emit Deposited(investableAmount, reserveAmount, gasReserveAmount, positionAlreadyExists);
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

        // V2: increment by the MEASURED amount that actually arrived
        // (stableBal), never the caller-declared usdtAmount — see
        // uncountedInvestable's own docstring for why the distinction
        // matters (a swapIx that sells some of it away, or a caller-declared
        // amount that overstates the real transfer, can otherwise break the
        // uncountedInvestable <= investableUsdt invariant and later brick
        // withdrawAll() with an underflow).
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
        emit PositionIncreased(usdtAmount, used0, used1, consumedUncounted);
    }

    /// @notice V2: same as increasePosition() but accepts any ERC20 —
    /// reuses depositToken()'s third-party-swap pattern (sell 100% of
    /// tokenIn into the vault's own stable), then feeds the result into the
    /// exact same increaseLiquidity() tail. `tokenIn == the vault's own
    /// stable` degrades to a no-swap passthrough, so this is a strict
    /// superset of increasePosition(). Deliberately does NOT special-case
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

        _reimburseKeeperGas(gasStart);

        emit PositionInitialized(tokenId, used0 + swept0, used1 + swept1);
    }

    // ---------------------------------------------------------------------
    // Operator: rebalance
    // ---------------------------------------------------------------------

    function rebalance(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
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

        _checkRangeNearMarket(newTickLower, newTickUpper);

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

        uint256 lpFee0 = collected0 - removed0;
        uint256 lpFee1 = collected1 - removed1;
        (uint256 netFee0, uint256 netFee1) = _splitPerformanceFee(lpFee0, lpFee1);
        if (autoCompoundFees) {
            if (netFee0 > 0 || netFee1 > 0) {
                lastFeeClaimTimestamp = block.timestamp;
                emit FeesReinjected(netFee0, netFee1, 0, 0, _toStableUsd(netFee0, netFee1));
            }
        } else {
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

        _reimburseKeeperGas(gasStart);

        rebalanceCount += 1;
        lastRebalanceTimestamp = block.timestamp;

        emit Rebalanced(newTokenId, newTickLower, newTickUpper, reinjectAmount, consumedUncounted);
    }

    // ---------------------------------------------------------------------
    // Owner: force a rebalance on demand (new in V2)
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
    /// vs. harvestFees() (operator, reimbursed).
    function ownerRebalance(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
        uint256 reinjectAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOwner whenNotPaused notClosed nonReentrant returns (uint256 newTokenId) {
        if (positionTokenId == 0) revert NoPosition();
        if (rebalanceCount >= maxRebalances) revert RebalanceLimitReached();

        bool cooldownPassed = block.timestamp >= lastRebalanceTimestamp + minRebalanceInterval;
        if (!cooldownPassed) revert TooSoonToRebalance();

        _checkRangeNearMarket(newTickLower, newTickUpper);

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

        uint256 lpFee0 = collected0 - removed0;
        uint256 lpFee1 = collected1 - removed1;
        (uint256 netFee0, uint256 netFee1) = _splitPerformanceFee(lpFee0, lpFee1);
        if (autoCompoundFees) {
            if (netFee0 > 0 || netFee1 > 0) {
                lastFeeClaimTimestamp = block.timestamp;
                emit FeesReinjected(netFee0, netFee1, 0, 0, _toStableUsd(netFee0, netFee1));
            }
        } else {
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

        _reimburseKeeperGas(gasStart);

        emit ReinjectedIntoPosition(amount, used0, used1);
    }

    /// @notice Reclamo programado de comisiones — ver RangeVaultCompound.sol.
    /// Reembolsa gas al keeper igual que el resto de entrypoints operator-only
    /// que el keeper envía como su propia transacción.
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

        _reinjectFees(amount0, amount1, swapIx, amount0Min, amount1Min);

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

        _reimburseKeeperGas(gasStart);

        emit IdleDustSwept(used0, used1, consumedUncounted);
    }

    // ---------------------------------------------------------------------
    // Owner: collect fees — trading fees only, principal untouched
    // ---------------------------------------------------------------------

    function collectFees(SwapInstruction calldata swapIx, uint256 amount0Min, uint256 amount1Min)
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
            _reinjectFees(amount0, amount1, swapIx, amount0Min, amount1Min);
        } else {
            if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
            if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);
            lastFeeClaimTimestamp = block.timestamp;
            emit FeesCollected(amount0, amount1);
        }
    }

    // ---------------------------------------------------------------------
    // Owner: withdraw — the only path principal can ever leave the vault
    // ---------------------------------------------------------------------

    /// @notice V2: the 4 ledger buckets are now fully independent — a single
    /// shared `fundsShareBps` used to apply to investableUsdt/reserveBalance/
    /// gasReserveBalance all at once (V1 behavior). Position + fee handling
    /// is unchanged from V1.
    function withdraw(
        uint256 positionShareBps,
        uint256 investableShareBps,
        uint256 reserveShareBps,
        uint256 gasReserveShareBps
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
        // above, which also fold in the owner's fee share (netFee0/netFee1).
        // Fees never counted toward B1 (see PLAN.md), so principalUsd below
        // must be computed from these, never from amount0/amount1 directly.
        uint256 removedPrincipal0;
        uint256 removedPrincipal1;

        if (positionShareBps > 0 && positionTokenId != 0) {
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
            amount0 = removed0 + netFee0;
            amount1 = removed1 + netFee1;
            removedPrincipal0 = removed0;
            removedPrincipal1 = removed1;
            if (positionShareBps == 10_000) positionTokenId = 0;
        }

        uint256 investableShare = (investableUsdt * investableShareBps) / 10_000;
        uint256 reserveShare = (reserveBalance * reserveShareBps) / 10_000;
        uint256 gasReserveShare = (gasReserveBalance * gasReserveShareBps) / 10_000;
        investableUsdt -= investableShare;
        reserveBalance -= reserveShare;
        gasReserveBalance -= gasReserveShare;

        // V2: investableShare itself can be a mix of already-counted capital
        // and still-uncounted pending top-ups (see uncountedInvestable's own
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

        if (total0 > 0) IERC20(token0).safeTransfer(owner, total0);
        if (total1 > 0) IERC20(token1).safeTransfer(owner, total1);

        emit Withdrawn(total0, total1, principalUsd);
    }

    function withdrawAll() external onlyOwner nonReentrant {
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

        // Same exclusion rule as withdraw() above: principal from the
        // position (removed0/removed1) + all of investableUsdt EXCEPT
        // whatever's still uncounted (never added to B1, can't be
        // subtracted from it) — never fees, never un-reinjected reserve.
        uint256 principalUsd = _toStableUsd(removed0, removed1) + (investableUsdt - uncountedInvestable);

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;
        gasReserveBalance = 0;
        uncountedInvestable = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit Withdrawn(amount0, amount1, principalUsd);
    }

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

        // Same exclusion rule as withdraw()/withdrawAll() above.
        uint256 principalUsd = _toStableUsd(removed0, removed1) + (investableUsdt - uncountedInvestable);

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
    function _reinjectFees(
        uint256 netFee0,
        uint256 netFee1,
        SwapInstruction calldata swapIx,
        uint256 amount0Min,
        uint256 amount1Min
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

        uint256 stableBal =
            IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
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

        investableUsdt = preExistingInvestable + (stableBal - _stableOf(used0, used1));
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
    /// each happens. See PLAN.md / wild-exploring-bumblebee.md for the B1/A1
    /// accounting model this feeds.
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

    // ---------------------------------------------------------------------
    // ERC721 receiver — required to hold the Uniswap V3 position NFT
    // ---------------------------------------------------------------------

    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(positionManager)) revert NotPositionManager();
        return this.onERC721Received.selector;
    }
}
