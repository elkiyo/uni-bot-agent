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
    error InsufficientUsdtBudget();
    error InsufficientReserve();
    error InsufficientInvestableBalance();
    error InvalidSwapInstruction();
    error DepositExceedsPlatformCap();
    error ZeroAddress();
    error NotPositionManager();
    error VaultClosed();
    error VaultNotEmpty();
    error ReinjectionExceedsCap();

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

    address public uniLabPaymentWallet;
    // No fixed fee constant: uni-lab.xyz's pricing (GET /api/v1/pricing) can
    // change at any time, so the amount is supplied by the keeper per call
    // (see payUniLabFee) instead of hardcoded here — see PLAN.md.

    // ---------------------------------------------------------------------
    // Operator
    // ---------------------------------------------------------------------

    address public operator;

    // ---------------------------------------------------------------------
    // Ledgers — all three are carved out of the same token0 balance but must
    // never be spent on each other's behalf (see PLAN.md "Nota de contabilidad").
    // ---------------------------------------------------------------------

    uint256 public investableUsdt; // capital not yet deployed into a position
    uint256 public usdtBudget; // earmarked for payUniLabFee()
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
    uint256 public maxRangeDeviationBps; // max ticks (1 bps == 1 tick, see _checkRangeNearMarket) the new range's center may sit from the current pool tick

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

    event Deposited(uint256 investableAmount, uint256 usdtBudgetAmount, uint256 reserveAmount);
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
    event UniLabFeePaid(uint256 amount, uint256 remainingBudget);
    event Withdrawn(uint256 amount0, uint256 amount1);
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
        address _swapRouter,
        address _uniLabPaymentWallet
    ) external initializer {
        if (
            _owner == address(0) || _platformConfig == address(0) || _pool == address(0)
                || _positionManager == address(0) || _swapRouter == address(0) || _uniLabPaymentWallet == address(0)
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
        uniLabPaymentWallet = _uniLabPaymentWallet;

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

    /// @notice Deposit USDT only (token0). Split across the three ledgers by the owner.
    function deposit(uint256 usdtBudgetAmount, uint256 reserveAmount, uint256 investableAmount)
        external
        onlyOwner
        notClosed
        nonReentrant
    {
        uint256 total = usdtBudgetAmount + reserveAmount + investableAmount;
        uint256 cap = IPlatformConfig(platformConfig).maxDepositUsd();
        uint256 currentTotal = usdtBudget + reserveBalance + investableUsdt;
        if (cap != 0 && currentTotal + total > cap) revert DepositExceedsPlatformCap();

        IERC20(token0).safeTransferFrom(msg.sender, address(this), total);

        usdtBudget += usdtBudgetAmount;
        reserveBalance += reserveAmount;
        investableUsdt += investableAmount;

        emit Deposited(investableAmount, usdtBudgetAmount, reserveAmount);
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
    // Operator: uni-lab.xyz payment (separate tx — see PLAN.md, the keeper
    // needs this tx's hash before it can call uni-lab's API for the range)
    // ---------------------------------------------------------------------

    /// @notice Pays uni-lab.xyz `amount` of token0 from usdtBudget. `amount` is
    /// supplied by the keeper, which queries GET /api/v1/pricing right before
    /// calling this — uni-lab's price isn't fixed and can change at any time,
    /// so this contract doesn't hardcode or cap it; the owner's exposure is
    /// already bounded by however much they chose to put in usdtBudget.
    function payUniLabFee(uint256 amount) external onlyOperator nonReentrant returns (uint256 remainingBudget) {
        if (usdtBudget < amount) revert InsufficientUsdtBudget();
        usdtBudget -= amount;
        IERC20(token0).safeTransfer(uniLabPaymentWallet, amount);
        emit UniLabFeePaid(amount, usdtBudget);
        return usdtBudget;
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

        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - usdtBudget - reserveBalance;
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

        // Any leftover dust that didn't go into the mint stays as investableUsdt/token1 dust.
        investableUsdt = amount0 - used0;

        emit PositionInitialized(tokenId, used0, used1);
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

        // 1) Recover 100% of the current position.
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

        // 2) Let the keeper rearrange the recovered balance toward the new range's ratio.
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
            uint256 freeToken0 = IERC20(token0).balanceOf(address(this)) - usdtBudget - reserveBalance;
            if (freeToken0 < fee) revert InsufficientInvestableBalance();
            IERC20(token0).safeTransfer(operator, fee);
        }

        // 5) Mint the new position with whatever's left over (investable pool only —
        // usdtBudget and reserveBalance are excluded and untouched).
        uint256 amount0 = IERC20(token0).balanceOf(address(this)) - usdtBudget - reserveBalance;
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
        investableUsdt = amount0 - used0;
        rebalanceCount += 1;
        lastRebalanceTimestamp = block.timestamp;

        emit Rebalanced(newTokenId, newTickLower, newTickUpper, reinjectAmount, fee);
    }

    // ---------------------------------------------------------------------
    // Owner: withdraw — the only path principal can ever leave the vault
    // ---------------------------------------------------------------------

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
        usdtBudget = 0;
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
        usdtBudget = 0;
        reserveBalance = 0;

        if (amount0 > 0) IERC20(token0).safeTransfer(owner, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(owner, amount1);

        emit EmergencyWithdraw(amount0, amount1);
    }

    /// @notice Permanently deactivates the vault. The owner must have already
    /// drained everything via withdrawAll()/emergencyWithdrawPosition() first —
    /// this reverts unless the position is closed AND all three ledgers AND the
    /// vault's actual token0/token1 balances are all exactly zero, so a vault can
    /// never end up "closed" while still holding funds. Irreversible: once closed,
    /// deposit/configureTarget/setRiskParams/initPosition/rebalance all revert
    /// forever (see `notClosed`). withdraw functions stay callable — harmless
    /// no-ops on an empty vault — so the owner is never locked out of anything.
    function closeVault() external onlyOwner {
        if (closed) revert VaultClosed();
        if (
            positionTokenId != 0 || investableUsdt != 0 || usdtBudget != 0 || reserveBalance != 0
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

    /// @dev In Uniswap V3, `1.0001^1` is exactly a 1 bps price move — so a tick
    /// delta and a basis-point price delta are the same number. This lets us bound
    /// how far the operator's proposed range may sit from the live pool price
    /// without any extra math or oracle: compare the range's center tick directly
    /// against `maxRangeDeviationBps`.
    function _checkRangeNearMarket(int24 tickLower, int24 tickUpper) internal view {
        (, int24 currentTick,,,,,) = pool.slot0();
        int24 centerTick = (tickLower + tickUpper) / 2;
        int24 delta = centerTick > currentTick ? centerTick - currentTick : currentTick - centerTick;
        // delta is always >= 0 by construction above, and ticks are bounded to +-887272
        // (well within uint24), so both casts are lossless.
        // forge-lint: disable-next-line(unsafe-typecast)
        if (uint256(uint24(delta)) > maxRangeDeviationBps) revert RangeTooFarFromMarket();
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
