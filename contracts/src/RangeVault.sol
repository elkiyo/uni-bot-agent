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

/// @title RangeVault
/// @notice Non-custodial Uniswap V3 concentrated-liquidity vault. One vault == one
/// position on one pool. See PLAN.md ("Garantía no-custodial") for the full rationale;
/// in short: `owner` (the LP) is the only address that can ever receive principal back
/// via withdraw(); `operator` (the platform's keeper) can only trigger initPosition()/
/// rebalance(), which always keep funds and the position NFT inside this contract, and
/// are bounded by owner-set range/interval/count limits it cannot alter itself.
///
/// Deployed as an EIP-1167 minimal clone by VaultFactory — hence Initializable instead
/// of a constructor. token0 is assumed to be the vault's stablecoin (USDT on Celo);
/// every `*Usd` amount in this contract is denominated directly in token0's smallest
/// unit (no oracle — token0 IS the dollar leg of the pool).
contract RangeVault is Initializable, ReentrancyGuardUpgradeable, IERC721Receiver {
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
    error InsufficientInvestableBalance();
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
    address public token0; // the pool's stablecoin leg (USDT on Celo)
    address public token1; // the pool's volatile leg (WETH on Celo)
    uint24 public feeTier;

    INonfungiblePositionManager public positionManager;
    ISwapRouter02 public swapRouter;

    // ---------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------

    address public operator;

    // ---------------------------------------------------------------------
    // Ledgers — both are carved out of the same token0 balance but must
    // never be spent on each other's behalf (see PLAN.md "Nota de contabilidad").
    // A third ledger, usdtBudget (earmarked for uni-lab.xyz's on-chain
    // payUniLabFee()), was retired 2026-07-15 when uni-lab payments moved
    // entirely to x402 (the operator's own USDC, no vault budget involved) —
    // see HACKATHON.md "Track 2 — x402" and PLAN.md's backlog note.
    // ---------------------------------------------------------------------

    uint256 public investableUsdt; // capital not yet deployed into a position
    uint256 public reserveBalance; // capital available for the keeper to reinject into a position, over time

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
    /// See PLAN.md — a closed vault can never deposit/configure/build a position
    /// again, so a leftover clone address can't silently reactivate if someone
    /// (accidentally or not) sends it tokens after the owner walked away.
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
    }

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event Deposited(uint256 investableAmount, uint256 reserveAmount);
    event TargetConfigured(
        uint256 investmentAmountUsd,
        int24 targetTickLower,
        int24 targetTickUpper,
        uint256 maxRebalances,
        uint256 reinjectionAmount,
        uint256 periodicRebalanceInterval
    );
    event PositionInitialized(uint256 tokenId, uint256 amount0, uint256 amount1);
    event Rebalanced(
        uint256 indexed newTokenId, int24 tickLower, int24 tickUpper, uint256 reinjectedAmount, uint256 feePaid
    );
    event LpFeesPaidToOwner(uint256 amount0, uint256 amount1);
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

    /// @notice Called once by VaultFactory right after cloning.
    function initialize(
        address _owner,
        address _platformConfig,
        address _pool,
        address _token0,
        address _token1,
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

    /// @notice Deposit USDT only (token0). Split across the two ledgers by the owner.
    function deposit(uint256 reserveAmount, uint256 investableAmount) external onlyOwner notClosed nonReentrant {
        uint256 total = reserveAmount + investableAmount;
        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = reserveBalance + investableUsdt;
        if (cap != 0 && currentTotal + total > cap) revert DepositExceedsPlatformCap();

        IERC20(token0).safeTransferFrom(msg.sender, address(this), total);

        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;

        emit Deposited(investableAmount, reserveAmount);
    }

    /// @notice Tops up the CURRENTLY OPEN position immediately, instead of
    /// depositing into investableUsdt and waiting for the operator's next
    /// rebalance cycle to fold it in via reinjection. Deposits USDT only
    /// (token0), consistent with the rest of the vault — the owner never
    /// holds WETH directly — but unlike a fresh mint, adding to an
    /// ALREADY-IN-RANGE position requires both tokens in the position's
    /// exact live ratio (Uniswap computes zero liquidity, and reverts, for
    /// any one-sided add to an in-range position — confirmed against a real
    /// fork test, 2026-07-15). `swapIx` is the owner-supplied split to get
    /// there; unlike initPosition()/rebalance() this needs no off-chain
    /// pricing service to size (no split to *solve*, just the position's
    /// already-known current ratio at the pool's live price) — the frontend
    /// computes it client-side from `positionManager.positions()` + the
    /// pool's `slot0()`, both already public reads. Whatever portion Uniswap
    /// still can't use stays as investableUsdt dust, same as
    /// initPosition()/rebalance(). Deliberately NOT blocked by
    /// `whenNotPaused` — pause() stops the operator, never the owner.
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
        // old dust sitting in the same raw token0 balance could get silently
        // swept into this mint while investableUsdt never got debited for it,
        // leaving the ledger overstating what's actually still free.
        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        IERC20(token0).safeTransferFrom(msg.sender, address(this), usdtAmount);

        _executeSwap(swapIx);

        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - preExistingInvestable - reserveBalance;
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        if (amount0 > usdtAmount) amount0 = usdtAmount; // guard, same as initPosition()

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

        investableUsdt = preExistingInvestable + (amount0 - used0);
        emit PositionIncreased(usdtAmount, used0, used1);
    }

    /// @notice Define what the agent should build and the caps it must respect.
    function configureTarget(
        uint256 investmentAmountUsd,
        int24 _targetTickLower,
        int24 _targetTickUpper,
        uint256 _maxRebalances,
        uint256 _reinjectionAmount,
        uint256 _periodicRebalanceInterval
    ) external onlyOwner notClosed {
        targetTickLower = _targetTickLower;
        targetTickUpper = _targetTickUpper;
        maxRebalances = _maxRebalances;
        reinjectionAmount = _reinjectionAmount;
        periodicRebalanceInterval = _periodicRebalanceInterval;
        targetConfigured = true;

        emit TargetConfigured(
            investmentAmountUsd, _targetTickLower, _targetTickUpper, _maxRebalances, _reinjectionAmount,
            _periodicRebalanceInterval
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
        if (positionTokenId != 0) revert AlreadyInitializedPosition();
        if (!targetConfigured) revert TargetNotConfigured();
        _checkRangeNearMarket(targetTickLower, targetTickUpper);

        uint256 investable = investableUsdt;
        investableUsdt = 0;

        _executeSwap(swapIx);

        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - reserveBalance;
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        if (amount0 > investable) {
            // swap direction was token1->token0 (shouldn't happen pre-position, but guard anyway)
            amount0 = investable;
        }

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

        // Any leftover dust that didn't go into either call stays as investableUsdt/token1 dust.
        investableUsdt = amount0 - used0 - swept0;

        emit PositionInitialized(tokenId, used0 + swept0, used1 + swept1);
    }

    // ---------------------------------------------------------------------
    // Operator: rebalance (out-of-range or periodic — see PLAN.md "Reglas de
    // rebalanceo"). newTickLower/newTickUpper and the swap instruction are
    // computed off-chain by the keeper from uni-lab.xyz's /rc-rlp-rebalance
    // response; this function only enforces the guardrails and moves funds.
    // ---------------------------------------------------------------------

    function rebalance(
        int24 newTickLower,
        int24 newTickUpper,
        SwapInstruction calldata swapIx,
        uint256 reinjectAmount,
        uint256 amount0Min,
        uint256 amount1Min
    ) external onlyOperator whenNotPaused notClosed nonReentrant returns (uint256 newTokenId) {
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
        if (lpFee0 > 0) IERC20(token0).safeTransfer(owner, lpFee0);
        if (lpFee1 > 0) IERC20(token1).safeTransfer(owner, lpFee1);
        if (lpFee0 > 0 || lpFee1 > 0) emit LpFeesPaidToOwner(lpFee0, lpFee1);

        // 2) Let the keeper rearrange the recovered (principal-only) balance
        // toward the new range's ratio.
        _executeSwap(swapIx);

        // 3) Reinjection this cycle: the keeper decides whether to reinject and how
        // much (informed by uni-lab's live simulation — see PLAN.md), not a fixed
        // alternating pattern the contract forces. Bounded by the owner's per-cycle
        // ceiling (`reinjectionAmount`, set in configureTarget) and by what's
        // actually sitting in reserve — the keeper can never move more than either.
        if (reinjectAmount > 0) {
            if (reinjectAmount > reinjectionAmount) revert ReinjectionExceedsCap();
            if (reinjectAmount > reserveBalance) revert InsufficientReserve();
            reserveBalance -= reinjectAmount;
        }

        // 4) Platform fee, paid to whoever is currently operator, priced live by PlatformConfig.
        uint256 fee = IPlatformConfig(platformConfig).rebalanceFee();
        if (fee > 0) {
            uint256 freeToken0 = IERC20(token0).balanceOf(address(this)) - reserveBalance;
            if (freeToken0 < fee) revert InsufficientInvestableBalance();
            IERC20(token0).safeTransfer(operator, fee);
        }

        // 5) Mint the new position with whatever's left over (investable pool only —
        // reserveBalance is excluded and untouched).
        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - reserveBalance;
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

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

        // Same dust top-up as initPosition() — see PLAN.md backlog note
        // (2026-07-14 production case: ~10% of a rebalance left unswept).
        (uint256 swept0,) = _sweepDustIntoPosition(newTokenId, amount0 - used0, amount1 - used1);

        investableUsdt = amount0 - used0 - swept0;
        rebalanceCount += 1;
        lastRebalanceTimestamp = block.timestamp;

        emit Rebalanced(newTokenId, newTickLower, newTickUpper, reinjectAmount, fee);
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
        if (positionTokenId == 0) revert NoPosition();
        if (amount == 0) return;
        if (amount > reinjectionAmount) revert ReinjectionExceedsCap();
        if (amount > reserveBalance) revert InsufficientReserve();

        reserveBalance -= amount;

        uint256 preExistingInvestable = investableUsdt;
        investableUsdt = 0;

        _executeSwap(swapIx);

        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - preExistingInvestable - reserveBalance;
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        if (amount0 > amount) amount0 = amount; // guard, same as increasePosition()

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

        investableUsdt = preExistingInvestable + (amount0 - used0);
        emit ReinjectedIntoPosition(amount, used0, used1);
    }

    /// @notice Sweeps whatever token0/token1 the vault holds outside
    /// reserveBalance into the currently open position, with a real
    /// corrective swap first — not just an as-is top-up like the internal
    /// `_sweepDustIntoPosition()` helper (called automatically after every
    /// mint, which can only add dust in whatever ratio it already has).
    /// Needed when a prior swap overshot badly enough to leave dust that's
    /// almost entirely one token, with nothing to pair it with — confirmed
    /// in production 2026-07-16 (vault 0x982b8435...c47505: initPosition()'s
    /// swap left ~$67 of WETH stranded with zero matching USDT, past what
    /// the automatic sweep could use). `swapIx` is sized off-chain from the
    /// vault's actual idle balances (investableUsdt + raw token1
    /// balanceOf), same math as initPosition()/rebalance().
    function sweepIdleDust(SwapInstruction calldata swapIx, uint256 amount0Min, uint256 amount1Min)
        external
        onlyOperator
        whenNotPaused
        notClosed
        nonReentrant
    {
        if (positionTokenId == 0) revert NoPosition();

        _executeSwap(swapIx);

        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - reserveBalance;
        uint256 amount1 = IERC20(token1).balanceOf(address(this));

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

        investableUsdt = amount0 - used0;
        emit IdleDustSwept(used0, used1);
    }

    // ---------------------------------------------------------------------
    // Owner: withdraw — the only path principal can ever leave the vault
    // ---------------------------------------------------------------------

    /// @notice Withdraws from the open position and from the vault's idle
    /// funds (investableUsdt + reserveBalance) INDEPENDENTLY — `positionShareBps`
    /// controls how much of the live position's liquidity to pull,
    /// `fundsShareBps` controls how much of the idle ledgers to pull. Either
    /// can be 0 (skip that pool of capital entirely) or 10_000 (all of it),
    /// on its own — e.g. pull 100% of idle reserve while leaving the position
    /// fully staked, or trim the position while leaving reserve untouched for
    /// future reinjection cycles. Leaves whatever isn't withdrawn operating
    /// normally, unlike withdrawAll()/emergencyWithdrawPosition() which
    /// always close everything. Always `owner`, never a parameter — see
    /// PLAN.md. Untracked token1 dust (see initPosition()/rebalance()) isn't
    /// split proportionally here — it stays in the vault and gets picked up
    /// by the next cycle, same as today.
    function withdraw(uint256 positionShareBps, uint256 fundsShareBps) external onlyOwner nonReentrant {
        if (positionShareBps > 10_000 || fundsShareBps > 10_000) revert InvalidShareBps();
        if (positionShareBps == 0 && fundsShareBps == 0) revert InvalidShareBps();

        uint256 amount0;
        uint256 amount1;

        if (positionShareBps > 0 && positionTokenId != 0) {
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
            uint128 partialLiquidity = uint128((uint256(liquidity) * positionShareBps) / 10_000);
            if (partialLiquidity > 0) {
                positionManager.decreaseLiquidity(
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
            // freed above plus any accrued trading fees, which belong to owner
            // in full regardless of positionShareBps (same as rebalance()'s
            // LpFeesPaidToOwner logic).
            (amount0, amount1) = positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: positionTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            // 100% withdrawn from an existing position: the NFT is now empty,
            // so clear positionTokenId the same way withdrawAll() does —
            // otherwise it'd dangle as a reference to a zero-liquidity
            // position instead of a clean "no position" state.
            if (positionShareBps == 10_000) positionTokenId = 0;
        }

        uint256 investableShare = (investableUsdt * fundsShareBps) / 10_000;
        uint256 reserveShare = (reserveBalance * fundsShareBps) / 10_000;
        investableUsdt -= investableShare;
        reserveBalance -= reserveShare;

        uint256 total0 = amount0 + investableShare + reserveShare;
        uint256 total1 = amount1;

        if (total0 > 0) IERC20(token0).safeTransfer(owner, total0);
        if (total1 > 0) IERC20(token1).safeTransfer(owner, total1);

        emit Withdrawn(total0, total1);
    }

    /// @notice Closes the position (if any) and sends every token0/token1 the vault
    /// holds to `owner`. Always `owner`, never a parameter — see PLAN.md.
    function withdrawAll() external onlyOwner nonReentrant {
        if (positionTokenId != 0) {
            (,,,,,,, uint128 liquidity,,,,) = positionManager.positions(positionTokenId);
            if (liquidity > 0) {
                positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: positionTokenId,
                        liquidity: liquidity,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    })
                );
            }
            positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: positionTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            positionTokenId = 0;
        }

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;

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
            if (liquidity > 0) {
                positionManager.decreaseLiquidity(
                    INonfungiblePositionManager.DecreaseLiquidityParams({
                        tokenId: positionTokenId,
                        liquidity: liquidity,
                        amount0Min: 0,
                        amount1Min: 0,
                        deadline: block.timestamp
                    })
                );
            }
            positionManager.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId: positionTokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );
            positionTokenId = 0;
        }

        uint256 amount0 = IERC20(token0).balanceOf(address(this));
        uint256 amount1 = IERC20(token1).balanceOf(address(this));
        investableUsdt = 0;
        reserveBalance = 0;

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
            positionTokenId != 0 || investableUsdt != 0 || reserveBalance != 0
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

    /// @dev A mint's amount0Desired/amount1Desired rarely land in the exact
    /// ratio the range needs, leaving one side as dust that would otherwise
    /// sit idle until the next rebalance (confirmed in production 2026-07-14:
    /// ~10% of a rebalance left unswept in a shallow pool — see PLAN.md
    /// backlog note). Top up the position just minted with whatever's left,
    /// instead of a separate swap+re-mint. Uniswap's own ratio math applies
    /// here too, so this reduces the dust but generally won't zero it out.
    /// Best-effort, wrapped in try/catch: if the current price sits entirely
    /// outside the range on one side, the leftover on the *other* side prices
    /// out to zero liquidity and the pool's mint() reverts — confirmed against
    /// a real fork test (2026-07-15) — which must never fail the
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

    function _executeSwap(SwapInstruction calldata swapIx) internal {
        if (swapIx.amountIn == 0) return;
        address tokenIn = swapIx.token0ToToken1 ? token0 : token1;
        address tokenOut = swapIx.token0ToToken1 ? token1 : token0;
        swapRouter.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: feeTier,
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
    /// against that invariant (the actual [tickLower, tickUpper] bounds a
    /// pricing calculation like uni-lab.xyz's RC/RLP split produces), instead
    /// of computing a derived midpoint and bounding its distance from market —
    /// a legitimate periodic rebalance that deliberately pins one edge (e.g.
    /// keeping the existing floor and only recentering the ceiling) can land
    /// its midpoint arbitrarily far from price while the range itself still
    /// correctly contains it, which the old center-distance check rejected
    /// (see PLAN.md, 2026-07-15).
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
