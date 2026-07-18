// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUniswapV3Pool} from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IPlatformConfig} from "./interfaces/IPlatformConfig.sol";

/// @title RangeVaultArb
/// @notice Arbitrum-specific fork of RangeVault.sol (the contract Celo runs) —
/// kept as its own file, deliberately NOT merged back into RangeVault.sol, so a
/// real change here can never touch what Celo's live vaults are already running
/// on. Two things differ from RangeVault.sol:
///
/// 1. token0/token1 generalization: Uniswap V3 decides token0/token1 by address
///    sort order, not by which one is the stablecoin — true on Celo (USDT < WETH)
///    but false on Arbitrum (WETH < USDC). `stableIsToken0` records, per vault,
///    which slot actually holds the dollar leg; `_stableAddr()`/`_toToken01()`/
///    `_stableOf()` below map to/from Uniswap's own token0/token1 space wherever
///    this contract calls into the pool or position manager. Confirmed in
///    production 2026-07-17: a vault created assuming Celo's order everywhere
///    computed a target range on the opposite side of the real price and passed
///    token0/token1 out of order to VaultFactory, which made
///    positionManager.mint() resolve to the wrong pool address entirely — see
///    VaultFactoryArb.sol.
///
/// 2. Keeper gas reimbursement on every onlyOperator entrypoint that the keeper
///    sends as its own real transaction (initPosition, rebalance,
///    reinjectIntoPosition, sweepIdleDust) — see _reimburseKeeperGas()'s own
///    comment for why it's metered from the real transaction instead of a flat
///    configured amount.
///
/// Deployed as an EIP-1167 minimal clone by VaultFactoryArb — hence Initializable
/// instead of a constructor. `owner` (the LP) is the only address that can ever
/// receive principal back via withdraw(); `operator` (the platform's keeper) can
/// only trigger initPosition()/rebalance(), which always keep funds and the
/// position NFT inside this contract, and are bounded by owner-set
/// range/interval/count limits it cannot alter itself.
contract RangeVaultArb is Initializable, ReentrancyGuardUpgradeable, IERC721Receiver {
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

    // ---------------------------------------------------------------------
    // Immutable-ish config (set once in initialize())
    // ---------------------------------------------------------------------

    address public owner;
    address public platformConfig;

    IUniswapV3Pool public pool;
    address public token0; // Uniswap's real token0 — the LOWER of the two addresses, not necessarily the stablecoin
    address public token1; // Uniswap's real token1
    bool public stableIsToken0; // true on Celo (USDT<WETH), false on Arbitrum (WETH<USDC) — see class docstring
    uint24 public feeTier;

    INonfungiblePositionManager public positionManager;
    ISwapRouter02 public swapRouter;

    // ---------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------

    address public operator;

    // ---------------------------------------------------------------------
    // Ledgers — all three are carved out of the same stable-leg balance but
    // must never be spent on each other's behalf (see PLAN.md "Nota de
    // contabilidad").
    // ---------------------------------------------------------------------

    uint256 public investableUsdt; // capital not yet deployed into a position
    uint256 public reserveBalance; // capital available for the keeper to reinject into a position, over time
    // Dedicated, owner-funded budget for rebalance()'s keeper gas
    // reimbursement (see that function's own comment) — deliberately
    // separate from investableUsdt so the owner can see exactly how much
    // runway is left to pay the keeper's real gas cost, independent of
    // capital actually deployed into the position. Reimbursement draws
    // ONLY from here, never spills into investableUsdt/reserveBalance —
    // once this hits zero, rebalance() simply stops reimbursing (still
    // succeeds, see that function's own docs) until the owner tops it up.
    uint256 public gasReserveBalance;

    // Set on the vault's first successful deposit() — gates PlatformConfig's
    // one-time creationFeeUsdt so it's charged exactly once per vault, ever,
    // regardless of how many times the owner tops up later.
    bool public creationFeeCharged;

    // ---------------------------------------------------------------------
    // Target config — owner-set, what the agent should build/maintain
    // ---------------------------------------------------------------------

    bool public targetConfigured;
    int24 public targetTickLower;
    int24 public targetTickUpper;
    uint256 public maxRebalances;
    // Ceiling on how much reserveBalance the keeper may move into the position
    // in a single rebalance() call (see the `reinjectAmount` param there) — the
    // keeper decides the actual amount per cycle, up to this cap.
    uint256 public reinjectionAmount;
    uint256 public periodicRebalanceInterval;
    // How far below the live price the keeper sets the new floor (D1) when
    // rebuilding a range from scratch — out-of-range-bottom recovery, or the
    // floor half of an out-of-range-top rebuild. Read by the off-chain keeper
    // (rebalancer.ts), not used on-chain — stored here so it's an owner
    // knob instead of a hardcoded constant. Basis points (500 = 5%).
    uint256 public recenterMarginBps;
    // How far above the live price the keeper sets the new ceiling when
    // rebuilding after an out-of-range-top break — that break already means
    // the position is ~100% stable, so this is deliberately a much smaller
    // margin than recenterMarginBps. Same as above: off-chain-only, owner
    // knob. Basis points (300 = 3%).
    uint256 public exitTopCeilingMarginBps;

    // ---------------------------------------------------------------------
    // Risk params — owner-set bounds the operator must stay within
    // ---------------------------------------------------------------------

    uint256 public maxSlippageBps; // basis points, applied by the keeper off-chain when it sizes amountOutMinimum
    uint256 public minRebalanceInterval; // seconds, floor between rebalances
    uint256 public maxRangeDeviationBps; // extra slack in ticks (1 bps == 1 tick, see _checkRangeNearMarket) the pool price may sit outside the proposed [tickLower, tickUpper] and still be accepted

    // ---------------------------------------------------------------------
    // Runtime state
    // ---------------------------------------------------------------------

    uint256 public positionTokenId;
    uint256 public rebalanceCount;
    uint256 public lastRebalanceTimestamp;
    bool public paused;

    /// @notice Permanently deactivated via closeVault() once verifiably empty.
    /// A closed vault can never deposit/configure/build a position again, so a
    /// leftover clone address can't silently reactivate if someone (accidentally
    /// or not) sends it tokens after the owner walked away.
    bool public closed;

    // ---------------------------------------------------------------------
    // Swap instruction — how the keeper tells the vault to convert between
    // token0/token1 before minting. Sizing (how much, which direction) is
    // computed off-chain by the agent from uni-lab.xyz's response; the
    // contract only enforces the slippage floor.
    // ---------------------------------------------------------------------

    struct SwapInstruction {
        bool token0ToToken1;
        uint256 amountIn;
        uint256 amountOutMinimum;
        // Which fee-tier pool to route THIS swap through — independent of
        // feeTier (the pool the LP position itself lives in). The keeper
        // picks whichever pool for this token pair has the deepest live
        // liquidity, since price impact on a large sizing/rebalance swap can
        // dwarf the flat pool fee. The position itself still only ever
        // mints/lives in feeTier; this only changes where the CONVERSION
        // swap executes before that mint.
        uint24 fee;
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(uint256 investableAmount, uint256 reserveAmount, uint256 gasReserveAmount);
    event CreationFeeCharged(uint256 amount);
    event TargetConfigured(
        uint256 investmentAmountUsd,
        int24 targetTickLower,
        int24 targetTickUpper,
        uint256 maxRebalances,
        uint256 reinjectionAmount,
        uint256 periodicRebalanceInterval,
        uint256 recenterMarginBps,
        uint256 exitTopCeilingMarginBps
    );
    event PositionInitialized(uint256 tokenId, uint256 amount0, uint256 amount1);
    event Rebalanced(uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 reinjectedAmount);
    event KeeperGasReimbursed(uint256 amountUsd, uint256 gasUsed, uint256 effectiveGasPrice);
    event LpFeesPaidToOwner(uint256 amount0, uint256 amount1);
    event FeesCollected(uint256 amount0, uint256 amount1);
    event PerformanceFeeCollected(uint256 amount0, uint256 amount1);
    event Withdrawn(uint256 amount0, uint256 amount1);
    event PositionIncreased(uint256 usdtAmount, uint256 used0, uint256 used1);
    event ReinjectedIntoPosition(uint256 amount, uint256 used0, uint256 used1);
    event IdleDustSwept(uint256 used0, uint256 used1);
    event OperatorUpdated(address newOperator);
    event RiskParamsUpdated(uint256 maxSlippageBps, uint256 minRebalanceInterval, uint256 maxRangeDeviationBps);
    event PausedSet(bool isPaused);
    event EmergencyWithdraw(uint256 amount0, uint256 amount1);
    event Closed();

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

    /// @notice Called once by VaultFactoryArb right after cloning.
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

        // Router/position manager need standing approval to pull token0/token1 from the vault.
        IERC20(_token0).forceApprove(_positionManager, type(uint256).max);
        IERC20(_token1).forceApprove(_positionManager, type(uint256).max);
        IERC20(_token0).forceApprove(_swapRouter, type(uint256).max);
        IERC20(_token1).forceApprove(_swapRouter, type(uint256).max);
    }

    // ---------------------------------------------------------------------
    // Owner: capital + configuration
    // ---------------------------------------------------------------------

    /// @notice Deposit the stable leg only. Split across the three ledgers by
    /// the owner — gasReserveAmount tops up the dedicated keeper-gas budget
    /// (see gasReserveBalance/rebalance()), independent of capital actually
    /// deployed into the position. On the vault's FIRST deposit only, also
    /// pulls PlatformConfig's one-time creationFeeUsdt on top (never carved
    /// out of any of the three amounts) and forwards it straight to the
    /// platform's treasury.
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

        IERC20(_stableAddr()).safeTransferFrom(msg.sender, address(this), total + creationFee);

        if (creationFee > 0) {
            IERC20(_stableAddr()).safeTransfer(IPlatformConfig(platformConfig).treasury(), creationFee);
            emit CreationFeeCharged(creationFee);
        }

        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;
        gasReserveBalance += gasReserveAmount;

        emit Deposited(investableAmount, reserveAmount, gasReserveAmount);
    }

    /// @notice Tops up the CURRENTLY OPEN position immediately, instead of
    /// depositing into investableUsdt and waiting for the operator's next
    /// rebalance cycle to fold it in via reinjection. Deposits the stable leg
    /// only, consistent with the rest of the vault — the owner never holds the
    /// volatile leg directly — but unlike a fresh mint, adding to an
    /// ALREADY-IN-RANGE position requires both tokens in the position's exact
    /// live ratio (Uniswap computes zero liquidity, and reverts, for any
    /// one-sided add to an in-range position). `swapIx` is the owner-supplied
    /// split to get there. Deliberately NOT blocked by `whenNotPaused` —
    /// pause() stops the operator, never the owner.
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

        // Isolate this call's own deposit from any pre-existing investableUsdt
        // dust (e.g. left over from a prior rebalance) — same reason
        // initPosition() zeroes it before computing amount0: without this,
        // old dust sitting in the same raw balance could get silently swept
        // into this mint while investableUsdt never got debited for it,
        // leaving the ledger overstating what's actually still free.
        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        IERC20(_stableAddr()).safeTransferFrom(msg.sender, address(this), usdtAmount);

        _executeSwap(swapIx);

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > usdtAmount) stableBal = usdtAmount; // guard, same as initPosition()
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
        emit PositionIncreased(usdtAmount, used0, used1);
    }

    /// @notice Define what the agent should build and the caps it must respect.
    function configureTarget(
        uint256 investmentAmountUsd,
        int24 _targetTickLower,
        int24 _targetTickUpper,
        uint256 _maxRebalances,
        uint256 _reinjectionAmount,
        uint256 _periodicRebalanceInterval,
        uint256 _recenterMarginBps,
        uint256 _exitTopCeilingMarginBps
    ) external onlyOwner notClosed {
        targetTickLower = _targetTickLower;
        targetTickUpper = _targetTickUpper;
        maxRebalances = _maxRebalances;
        reinjectionAmount = _reinjectionAmount;
        periodicRebalanceInterval = _periodicRebalanceInterval;
        recenterMarginBps = _recenterMarginBps;
        exitTopCeilingMarginBps = _exitTopCeilingMarginBps;
        targetConfigured = true;

        emit TargetConfigured(
            investmentAmountUsd,
            _targetTickLower,
            _targetTickUpper,
            _maxRebalances,
            _reinjectionAmount,
            _periodicRebalanceInterval,
            _recenterMarginBps,
            _exitTopCeilingMarginBps
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
        operator = newOperator; // address(0) allowed: hard kill switch, no one can rebalance
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
            // swap direction was volatile->stable (shouldn't happen pre-position, but guard anyway)
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

        // The mint's ratio rarely matches amount0/amount1 exactly, leaving dust
        // that would otherwise sit idle until the next rebalance — top up the
        // same just-minted position with whatever's left over instead.
        (uint256 swept0, uint256 swept1) =
            _sweepDustIntoPosition(tokenId, amount0 - used0, amount1 - used1);

        // Any leftover dust that didn't go into either call stays as investableUsdt/volatile dust.
        investableUsdt = stableBal - _stableOf(used0, used1) - _stableOf(swept0, swept1);

        // Same real, metered gas reimbursement as rebalance() — initPosition()
        // is its own separate keeper-sent transaction (not free), so it must
        // be covered by gasReserveBalance too. See _reimburseKeeperGas().
        _reimburseKeeperGas(gasStart);

        emit PositionInitialized(tokenId, used0 + swept0, used1 + swept1);
    }

    // ---------------------------------------------------------------------
    // Operator: rebalance (out-of-range or periodic). newTickLower/newTickUpper
    // and the swap instruction are computed off-chain by the keeper from
    // uni-lab.xyz's /rc-rlp-rebalance response; this function only enforces the
    // guardrails and moves funds.
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

        // 1) Recover 100% of the current position. decreaseLiquidity's return is
        // the PRINCIPAL only (evaluated at the current price); collect() then
        // sweeps that principal together with whatever trading fees had
        // accrued, in one lump sum. The difference is real LP yield earned by
        // the owner's capital, not part of what should be recycled into the
        // next position — sent straight to owner before anything else touches
        // the recovered balance, so it never gets silently re-invested.
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
        if (netFee0 > 0) IERC20(token0).safeTransfer(owner, netFee0);
        if (netFee1 > 0) IERC20(token1).safeTransfer(owner, netFee1);
        if (netFee0 > 0 || netFee1 > 0) emit LpFeesPaidToOwner(netFee0, netFee1);

        // 2) Let the keeper rearrange the recovered (principal-only) balance
        // toward the new range's ratio.
        _executeSwap(swapIx);

        // 3) Reinjection this cycle: the keeper decides whether to reinject and how
        // much (informed by uni-lab's live simulation), not a fixed alternating
        // pattern the contract forces. Bounded by the owner's per-cycle ceiling
        // (`reinjectionAmount`, set in configureTarget) and by what's actually
        // sitting in reserve — the keeper can never move more than either.
        if (reinjectAmount > 0) {
            if (reinjectAmount > reinjectionAmount) revert ReinjectionExceedsCap();
            if (reinjectAmount > reserveBalance) revert InsufficientReserve();
            reserveBalance -= reinjectAmount;
        }

        // 4) Mint the new position with whatever's left over (investable pool only —
        // reserveBalance is excluded and untouched).
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

        // Same dust top-up as initPosition().
        (uint256 swept0, uint256 swept1) = _sweepDustIntoPosition(newTokenId, amount0 - used0, amount1 - used1);

        investableUsdt = stableBal - _stableOf(used0, used1) - _stableOf(swept0, swept1);

        // 5) Keeper gas reimbursement — metered from THIS transaction's real gas
        // usage, not a predefined/configured amount (see _reimburseKeeperGas()'s
        // own docstring for the full reasoning: the overhead constant, the
        // tx.gasprice bound, why it draws only from gasReserveBalance, and why
        // it can never revert the rebalance).
        _reimburseKeeperGas(gasStart);

        rebalanceCount += 1;
        lastRebalanceTimestamp = block.timestamp;

        emit Rebalanced(newTokenId, newTickLower, newTickUpper, reinjectAmount);
    }

    /// @notice Tops up the CURRENTLY OPEN position from reserveBalance
    /// directly, without closing and reopening it via a full rebalance()
    /// cycle. Operator-triggered symmetric counterpart to increasePosition()
    /// (the owner's version, sourced from a fresh deposit instead of
    /// reserve). Gated exactly like rebalance()'s own reinjectAmount
    /// parameter: capped by both the owner's per-cycle ceiling
    /// (reinjectionAmount) and by whatever's actually sitting in reserve.
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

        uint256 stableBal = IERC20(_stableAddr()).balanceOf(address(this)) - preExistingInvestable - reserveBalance - gasReserveBalance;
        uint256 volatileBal = IERC20(_volatileAddr()).balanceOf(address(this));
        if (stableBal > amount) stableBal = amount; // guard, same as increasePosition()
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

        // Same real, metered gas reimbursement as rebalance()/initPosition() —
        // see _reimburseKeeperGas().
        _reimburseKeeperGas(gasStart);

        emit ReinjectedIntoPosition(amount, used0, used1);
    }

    /// @notice Sweeps whatever token0/token1 the vault holds outside
    /// reserveBalance into the currently open position, with a real
    /// corrective swap first — not just an as-is top-up like the internal
    /// `_sweepDustIntoPosition()` helper (called automatically after every
    /// mint, which can only add dust in whatever ratio it already has).
    /// Needed when a prior swap overshot badly enough to leave dust that's
    /// almost entirely one token, with nothing to pair it with. `swapIx` is
    /// sized off-chain from the vault's actual idle balances.
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

        investableUsdt = stableBal - _stableOf(used0, used1);

        // Same real, metered gas reimbursement as rebalance()/initPosition() —
        // see _reimburseKeeperGas().
        _reimburseKeeperGas(gasStart);

        emit IdleDustSwept(used0, used1);
    }

    // ---------------------------------------------------------------------
    // Owner: collect fees — trading fees only, principal untouched
    // ---------------------------------------------------------------------

    /// @notice Collects ONLY the trading fees the open position has accrued,
    /// leaving its liquidity (principal) completely untouched. Unlike
    /// `withdraw()`, which only ever collects as a side effect of removing at
    /// least some liquidity (`positionShareBps > 0`), this calls
    /// positionManager.collect() with no prior decreaseLiquidity — Uniswap V3
    /// only ever returns what's "owed" to a position, and without a
    /// decreaseLiquidity call first, the only thing owed is accrued fees, so
    /// this can never touch principal by construction. Owner-only — subject
    /// to the same performanceFeeBps cut as rebalance()'s LpFeesPaidToOwner —
    /// callable regardless of `paused`, same as withdraw()/withdrawAll():
    /// pausing stops the keeper's automated actions, not the owner's own
    /// claim on money already earned.
    function collectFees() external onlyOwner nonReentrant returns (uint256 amount0, uint256 amount1) {
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

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit FeesCollected(amount0, amount1);
    }

    // ---------------------------------------------------------------------
    // Owner: withdraw — the only path principal can ever leave the vault
    // ---------------------------------------------------------------------

    /// @notice Withdraws from the open position and from the vault's idle
    /// funds (investableUsdt + reserveBalance + gasReserveBalance) INDEPENDENTLY — `positionShareBps`
    /// controls how much of the live position's liquidity to pull,
    /// `fundsShareBps` controls how much of the idle ledgers to pull. Either
    /// can be 0 (skip that pool of capital entirely) or 10_000 (all of it),
    /// on its own. Leaves whatever isn't withdrawn operating normally, unlike
    /// withdrawAll()/emergencyWithdrawPosition() which always close
    /// everything. Always `owner`, never a parameter.
    function withdraw(uint256 positionShareBps, uint256 fundsShareBps) external onlyOwner nonReentrant {
        if (positionShareBps > 10_000 || fundsShareBps > 10_000) revert InvalidShareBps();
        if (positionShareBps == 0 && fundsShareBps == 0) revert InvalidShareBps();

        uint256 amount0;
        uint256 amount1;

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
            // collect() always sweeps 100% of what's owed — the principal just
            // freed above (never taxed, it's the owner's own capital) plus any
            // accrued trading fees, which ARE subject to performanceFeeBps,
            // same as everywhere else fees leave the vault.
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
            // 100% withdrawn from an existing position: the NFT is now empty,
            // so clear positionTokenId the same way withdrawAll() does —
            // otherwise it'd dangle as a reference to a zero-liquidity
            // position instead of a clean "no position" state.
            if (positionShareBps == 10_000) positionTokenId = 0;
        }

        uint256 investableShare = (investableUsdt * fundsShareBps) / 10_000;
        uint256 reserveShare = (reserveBalance * fundsShareBps) / 10_000;
        uint256 gasReserveShare = (gasReserveBalance * fundsShareBps) / 10_000;
        investableUsdt -= investableShare;
        reserveBalance -= reserveShare;
        gasReserveBalance -= gasReserveShare;

        // investableShare/reserveShare/gasReserveShare are stable-denominated
        // ledger amounts, not necessarily token0 — route them to whichever real
        // token is actually the stable leg before combining with amount0/amount1
        // (recovered directly from the position, already in real token0/token1 terms).
        (uint256 ledger0, uint256 ledger1) = _toToken01(investableShare + reserveShare + gasReserveShare, 0);
        uint256 total0 = amount0 + ledger0;
        uint256 total1 = amount1 + ledger1;

        if (total0 > 0) IERC20(token0).safeTransfer(owner, total0);
        if (total1 > 0) IERC20(token1).safeTransfer(owner, total1);

        emit Withdrawn(total0, total1);
    }

    /// @notice Closes the position (if any) and sends every token0/token1 the vault
    /// holds to `owner`. Always `owner`, never a parameter.
    function withdrawAll() external onlyOwner nonReentrant {
        if (positionTokenId != 0) {
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
            // Only the fee slice (collected beyond what decreaseLiquidity just
            // freed) is subject to performanceFeeBps — sent to `operator`
            // immediately, so the balanceOf() reads below already land net.
            _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
            positionTokenId = 0;
        }

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;
        gasReserveBalance = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit Withdrawn(amount0, amount1);
    }

    /// @notice Force-closes the position regardless of operator state and returns
    /// everything to `owner`. Does not require the operator to cooperate.
    function emergencyWithdrawPosition() external onlyOwner nonReentrant {
        paused = true;
        emit PausedSet(true);

        if (positionTokenId != 0) {
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
            _splitPerformanceFee(collected0 - removed0, collected1 - removed1);
            positionTokenId = 0;
        }

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;
        gasReserveBalance = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit EmergencyWithdraw(amount0, amount1);
    }

    /// @notice Permanently deactivates the vault. The owner must have already
    /// drained everything via withdrawAll()/emergencyWithdrawPosition() first —
    /// this reverts unless the position is closed AND both ledgers AND the
    /// vault's actual token0/token1 balances are all exactly zero, so a vault can
    /// never end up "closed" while still holding funds. Irreversible: once closed,
    /// deposit/configureTarget/setRiskParams/initPosition/rebalance all revert
    /// forever (see `notClosed`). withdraw functions stay callable — harmless
    /// no-ops on an empty vault — so the owner is never locked out of anything.
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

    // Approximates the ~21,000 intrinsic tx cost spent before this function's
    // first opcode (invisible to gasleft() measured inside the function) plus
    // this reimbursement step's own SLOAD/transfer/event cost (unmeasurable
    // before it runs) — an accounting approximation of the transaction's own
    // overhead, not a configurable business fee.
    uint256 constant GAS_REIMBURSEMENT_OVERHEAD = 40_000;

    /// @dev Reimburses the operator for THIS transaction's real, metered gas
    /// cost, in the stable leg's USD terms — shared by every onlyOperator
    /// entrypoint that the keeper calls as its own separate on-chain
    /// transaction (initPosition, rebalance, reinjectIntoPosition,
    /// sweepIdleDust). Each caller must capture `gasStart = gasleft()` as
    /// literally its first line and pass it here as its last line, so the
    /// measured delta covers the whole call. Not used by increasePosition()
    /// — that one is onlyOwner, paid for by the owner's own wallet, not the
    /// agent's. See rebalance()'s original inline comment (now here) for the
    /// full reasoning behind the overhead constant, the tx.gasprice bound,
    /// and why this can never revert the caller.
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

    /// @dev Splits accrued LP trading fees by the live `performanceFeeBps`,
    /// sends the platform's cut to `operator`, and returns what's left for
    /// the owner. Called from every path that realizes Uniswap trading fees
    /// (rebalance(), collectFees(), withdraw(), withdrawAll(),
    /// emergencyWithdrawPosition()) with ONLY the fee portion, never
    /// principal — principal is the owner's own capital, the platform never
    /// takes a cut of it. Read live, so the platform owner can adjust it
    /// without touching any vault.
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

    /// @dev A mint's amount0Desired/amount1Desired rarely land in the exact
    /// ratio the range needs, leaving one side as dust that would otherwise
    /// sit idle until the next rebalance. Top up the position just minted
    /// with whatever's left, instead of a separate swap+re-mint. Best-effort,
    /// wrapped in try/catch: if the current price sits entirely outside the
    /// range on one side, the leftover on the *other* side prices out to zero
    /// liquidity and the pool's mint() reverts — which must never fail the
    /// initPosition()/rebalance() it's called from, only skip the top-up.
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

    /// @dev The real address of whichever token0/token1 slot is the dollar leg —
    /// see class docstring. Used only where this contract PULLS/tracks a stable-
    /// denominated amount (deposit, investableUsdt/reserveBalance accounting);
    /// calls into the pool/position manager always use token0/token1 directly,
    /// since those APIs are defined in terms of Uniswap's real slot order.
    function _stableAddr() internal view returns (address) {
        return stableIsToken0 ? token0 : token1;
    }

    function _volatileAddr() internal view returns (address) {
        return stableIsToken0 ? token1 : token0;
    }

    /// @dev Maps a (stable, volatile) amount pair into (amount0, amount1) —
    /// Uniswap's mint()/increaseLiquidity() calls need amounts in real
    /// token0/token1 order regardless of which one is the dollar leg.
    function _toToken01(uint256 stableAmt, uint256 volatileAmt) internal view returns (uint256, uint256) {
        return stableIsToken0 ? (stableAmt, volatileAmt) : (volatileAmt, stableAmt);
    }

    /// @dev Inverse of _toToken01, extracting only the stable side — used to update
    /// investableUsdt from mint()/increaseLiquidity()'s real-token0/token1 return
    /// values. The volatile side is deliberately not tracked by any ledger.
    function _stableOf(uint256 amount0, uint256 amount1) internal view returns (uint256) {
        return stableIsToken0 ? amount0 : amount1;
    }

    /// @dev Converts a wei amount of native gas token into this pool's stable
    /// leg's raw units, using the pool's own live sqrtPriceX96 — no oracle.
    /// Only correct because Arbitrum's native gas token (ETH) IS this pool's
    /// volatile leg (WETH is 1:1 wrapped ETH) — this contract is
    /// Arbitrum-specific (see class docstring), not a general chain-agnostic
    /// assumption. Same two-step shifted-division technique Uniswap's own
    /// SqrtPriceMath uses to convert through a sqrtPriceX96 without needing a
    /// 512-bit mulDiv for realistic input sizes (a gas cost in wei is always
    /// tiny relative to uint256's range).
    function _nativeWeiToStableRaw(uint256 volatileWei) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = pool.slot0();
        if (stableIsToken0) {
            // rawRatio (token1/token0) = (sqrtPriceX96/2^96)^2 = volatileRaw per stableRaw
            // stableRaw = volatileWei / rawRatio = volatileWei * (2^96/sqrtPriceX96)^2
            uint256 step1 = (volatileWei << 96) / sqrtPriceX96;
            return (step1 << 96) / sqrtPriceX96;
        } else {
            // rawRatio (token1/token0) = stableRaw per volatileRaw (token0=volatile here)
            // stableRaw = volatileWei * rawRatio = volatileWei * (sqrtPriceX96/2^96)^2
            uint256 step1 = (volatileWei * sqrtPriceX96) >> 96;
            return (step1 * sqrtPriceX96) >> 96;
        }
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

    /// @dev A legitimate concentrated-liquidity range contains the live pool
    /// price — that's what "in range" means, independent of how wide the
    /// range is. This validates the operator's proposed range directly
    /// against that invariant, instead of computing a derived midpoint and
    /// bounding its distance from market — a legitimate periodic rebalance
    /// that deliberately pins one edge (e.g. keeping the existing floor and
    /// only recentering the ceiling) can land its midpoint arbitrarily far
    /// from price while the range itself still correctly contains it.
    /// `maxRangeDeviationBps` is slack (1 bps == 1 tick, exact in Uniswap V3's
    /// `1.0001^tick` pricing) allowed OUTSIDE the strict bounds — room for the
    /// pool price to move between an off-chain quote and this tx landing
    /// on-chain, not a tolerance for genuinely mispriced ranges.
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
