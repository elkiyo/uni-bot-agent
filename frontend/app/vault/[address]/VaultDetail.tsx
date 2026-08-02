"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
} from "wagmi";
import { parseUnits, formatUnits } from "viem";
import { useTaggedWriteContract } from "@/lib/useTaggedWriteContract";
import { Header } from "../../components/Header";
import { AlertModal } from "../../components/AlertModal";
import { DepositTokenSelector, type DepositTokenOption } from "../../components/DepositTokenSelector";
import { useMultiTokenBalances } from "@/lib/useMultiTokenBalances";
import { useThirdPartyDepositQuote } from "@/lib/useThirdPartyDepositQuote";
import { PositionNFT } from "./PositionNFT";
import { ActivityFeed } from "./ActivityFeed";
import { PositionHistory } from "./PositionHistory";
import { ReinjectionHistory } from "./ReinjectionHistory";
import { CapitalLedger } from "./CapitalLedger";
import { GasBreakdown } from "./GasBreakdown";
import { RebalanceCountdown } from "./RebalanceCountdown";
import { erc20Abi, uniswapV3PoolAbi, positionManagerAbi, platformConfigAbi } from "@/lib/contracts";
import type { ChainDef } from "@/lib/chains";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { uncollectedFeesRaw } from "@/lib/positionMath";
import { sizeRebalanceSwap, estimatePositionAmounts } from "@/lib/keeper/swapMath";
import { useVaultFeesSummary } from "@/lib/useVaultFeesSummary";
import { useVaultCumulativeInvestment } from "@/lib/useVaultCumulativeInvestment";
import { useVaultCreatedAt } from "@/lib/useVaultCreatedAt";
import { useVaultPairInfo } from "@/lib/useVaultPairInfo";
import { useSelectedChain } from "@/lib/useSelectedChain";
import { isCompoundBetaWallet } from "@/lib/compoundBeta";
import { useTranslation } from "@/lib/i18n/useTranslation";

const reads = (address: `0x${string}`, chainId: number, vaultAbi: ChainDef["vaultAbi"]) =>
  [
    "owner",
    "operator",
    "positionTokenId",
    "rebalanceCount",
    "maxRebalances",
    "investableUsdt",
    "reserveBalance",
    "targetTickLower",
    "targetTickUpper",
    "paused",
    "closed",
    "targetConfigured",
    "reinjectionAmount",
    "periodicRebalanceInterval",
    "minRebalanceInterval",
    "lastRebalanceTimestamp",
    "maxSlippageBps",
    "maxRangeDeviationBps",
    "recenterMarginBps",
    "exitTopCeilingMarginBps",
    "creationFeeCharged",
    "feeTier",
    "pool",
  ].map((functionName) => ({ address, abi: vaultAbi, functionName, chainId }) as const);

export function VaultDetail({ address }: { address: `0x${string}` }) {
  const { address: connected, chainId: walletChainId } = useAccount();
  const { selectedChain: chain } = useSelectedChain();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useTaggedWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { t } = useTranslation();

  // Which contract this specific vault actually runs — fixed forever at
  // creation time. The fast path is the URL, stamped by create/page.tsx's own
  // redirect (?kind=compound); `chain.compoundVaultAbi` being present too
  // guards against a stale/copy-pasted ?kind=compound link on a chain that
  // never deployed VaultFactoryArbCompound (Celo).
  //
  // Fallback probe for every other case (bare/bookmarked link missing the
  // param, or a share that dropped the query string) — without this, a real
  // compound vault opened without ?kind=compound would silently read/write
  // with the standard ABI: shared-signature reads (owner, positionTokenId,
  // ...) still work since the selectors match, but compound-only writes
  // (collectFees's new 3-arg signature, setAutoCompoundFees, configureTarget's
  // 2 extra params) would revert on-chain — safe (mismatched selector, no
  // fund risk) but a confusing dead end for the owner. `autoCompoundFees()`
  // only exists on the compound ABI, so probing it here is a cheap way to
  // self-correct: succeeds → this address really is a compound vault,
  // reverts/errors → genuinely standard. `retry: false` since a revert here
  // is the expected, common outcome for every standard vault, not a transient
  // failure worth retrying.
  const searchParams = useSearchParams();
  const kindParamSaysCompound = searchParams.get("kind") === "compound";
  const { isSuccess: probedAsCompound } = useReadContract({
    address,
    abi: chain.compoundVaultAbi,
    functionName: "autoCompoundFees",
    chainId: chain.id,
    query: { enabled: !kindParamSaysCompound && Boolean(chain.compoundVaultAbi), retry: false },
  });
  // Intrinsic, on-chain fact — which contract this vault actually runs.
  // Deliberately NOT gated on the connected wallet: it decides which ABI
  // decodes this vault's real events (vaultAbi below feeds every read AND
  // every event-log decode: useVaultEventLogs/useVaultCumulativeInvestment/
  // PositionHistory/ReinjectionHistory/ActivityFeed all inherit it). Gating
  // this on isCompoundBetaWallet was a real production bug (confirmed
  // 2026-07-30): a disconnected visitor — or any non-beta wallet — opening
  // a genuine compound vault's page fell back to the standard ABI, which
  // lacks V2-only event fields (consumedUncounted, positionAlreadyExists,
  // ...). deserializeArgs (lib/eventArgsCodec.ts) silently leaves those
  // fields as raw strings instead of bigint when the ABI doesn't define
  // them; `total += (args.x as bigint)` then does bigint+string, which JS's
  // `+` operator string-concatenates instead of throwing, corrupting B1
  // into a string with no visible error — until that "bigint" hits viem's
  // formatUnits() elsewhere, which does real bigint arithmetic and throws
  // "Cannot mix BigInt and other types", crashing the whole page. Root-
  // caused by reproducing the crash against production with Playwright
  // (100% repeatable) and diffing it against a wallet-connected-as-owner
  // run that also failed identically, then tracing deserializeArgs itself.
  const vaultIsCompoundContract = Boolean(chain.compoundVaultAbi) && (kindParamSaysCompound || probedAsCompound);
  const vaultAbi = vaultIsCompoundContract ? chain.compoundVaultAbi! : chain.vaultAbi;
  // UI/action gating only (owner controls, deposit-token selector, etc.) —
  // this one's supposed to depend on the wallet, see compoundBeta.ts.
  const isCompound = vaultIsCompoundContract && isCompoundBetaWallet(connected);

  // This vault's OWN pair (see lib/useVaultPairInfo.ts) — every vault already
  // supported the chain's single default pair, this is what makes reading a
  // DIFFERENT pair's vault correct too (wild-exploring-bumblebee.md's
  // multi-pair Fase 3). Falls back to the chain's own default while the read
  // is still loading — correct for every vault that exists today, since none
  // are on a non-default pair yet.
  const pairInfo = useVaultPairInfo(address, chain, vaultAbi);
  const stableToken = pairInfo.data?.stableToken ?? chain.stableToken;
  const volatileToken = pairInfo.data?.volatileToken ?? chain.volatileToken;
  const stableIsToken0 = pairInfo.data?.stableIsToken0 ?? chain.stableIsToken0;
  const stableDecimals = pairInfo.data?.stableDecimals ?? 6;
  const volatileDecimals = pairInfo.data?.volatileDecimals ?? 18;
  const stableSymbol = pairInfo.data?.stableSymbol ?? chain.stableSymbol;
  const volatileSymbol = pairInfo.data?.volatileSymbol ?? chain.volatileSymbol;

  // 60s polling keeps the stats live while the keeper acts — the page is a demo
  // surface as much as a control panel. The keeper's own cycle is 5 min and a
  // vault's on-chain state only changes on a rebalance/deposit, so polling
  // much faster than this just re-fetches the same numbers (see
  // useVaultEventLogs.ts's own docstring for the same reasoning).
  const { data, refetch } = useReadContracts({
    contracts: reads(address, chain.id, vaultAbi),
    query: { refetchInterval: 60_000 },
  });

  // Surfaces the keeper's own uni-lab call failures (x402 down, or a 200 with
  // no usable range) instead of letting a stuck rebalance fail silently in
  // server logs — see app/api/vault/[address]/alert. Clears itself once a
  // later call succeeds.
  const { data: vaultAlerts } = useQuery({
    queryKey: ["vault-alerts", chain.id, address],
    queryFn: async () => {
      const res = await fetch(`/api/vault/${address}/alert?chainId=${chain.id}`);
      if (!res.ok) return [];
      const body = (await res.json()) as {
        alerts: Array<{ type: "rebalanceFailed" | "gasReserveDepleted"; message: string; createdAt: string; endpoint?: string }>;
      };
      return body.alerts;
    },
    refetchInterval: 60_000,
  });
  const rebalanceAlert = vaultAlerts?.find((a) => a.type === "rebalanceFailed");
  const gasReserveAlert = vaultAlerts?.find((a) => a.type === "gasReserveDepleted");
  const [
    owner,
    operator,
    positionTokenId,
    rebalanceCount,
    maxRebalances,
    investableUsdt,
    reserveBalance,
    targetTickLower,
    targetTickUpper,
    paused,
    closed,
    targetConfigured,
    reinjectionAmount,
    periodicRebalanceInterval,
    minRebalanceInterval,
    lastRebalanceTimestamp,
    maxSlippageBps,
    maxRangeDeviationBps,
    recenterMarginBps,
    exitTopCeilingMarginBps,
    creationFeeCharged,
    feeTierRaw,
    poolRaw,
  ] = data?.map((d) => d.result) ?? [];
  // A vault's real pool/fee tier is chosen at creation time (createVault's
  // caller picks any pool for the pair, not necessarily chain.pool/
  // chain.feeTier's "default" one) — reading them live instead of assuming
  // the chain default matters for display, for increasePosition's swap fee
  // below, AND for every slot0/tickSpacing read this page does (a wrong
  // pool address there means wrong price/tickSpacing for the vault's real
  // position). Confirmed live 2026-07-19: a real vault (0x5cD98eC8...4A5dEcb)
  // was created against Arbitrum's USDC/WETH 0.30% pool, not the 0.05%
  // default, and every one of these read chain.pool/chain.feeTier before
  // this fix.
  const feeTier = feeTierRaw !== undefined ? Number(feeTierRaw) : chain.feeTier;
  const poolAddress = (poolRaw as `0x${string}` | undefined) ?? chain.pool;

  const { data: creationFeeUsdtRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "creationFeeUsdt",
    chainId: chain.id,
  });
  // Only actually owed if this vault never had a successful deposit() yet —
  // see RangeVault.sol's creationFeeCharged, set permanently true the first
  // time deposit() succeeds.
  const pendingCreationFee = creationFeeCharged === false ? ((creationFeeUsdtRaw as bigint) ?? 0n) : 0n;

  // 0 == no cap, same convention RangeVault.deposit() itself uses — read live
  // so a later platform change (e.g. raising it) is reflected without a
  // frontend redeploy. See handleDepositMore's own check below.
  const { data: maxDepositUsdRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "maxDepositUsd",
    chainId: chain.id,
  });
  const maxDepositUsd = (maxDepositUsdRaw as bigint) ?? 0n;
  const [capAlert, setCapAlert] = useState<string | null>(null);

  // Separate read (not part of the shared `reads()` list above) — only
  // RangeVaultArb has this function at all; calling it against Celo's own
  // ABI (which lacks it entirely) would fail to encode, not just revert.
  const { data: gasReserveBalanceRaw } = useReadContract({
    address,
    abi: vaultAbi,
    functionName: "gasReserveBalance",
    chainId: chain.id,
    query: { enabled: chain.supportsGasReserve, refetchInterval: 60_000 },
  });
  const gasReserveBalance = (gasReserveBalanceRaw as bigint) ?? 0n;

  // Interest-compounding fields — same "separate read" treatment as
  // gasReserveBalance above: only RangeVaultArbCompound has these at all,
  // calling against the standard ABI would fail to encode. See
  // RangeVaultArbCompound.sol for what each one gates.
  const { data: compoundData } = useReadContracts({
    contracts: (
      [
        "autoCompoundFees",
        "feeClaimThresholdBps",
        "feeClaimIntervalSeconds",
        "lastFeeClaimTimestamp",
        "payoutFeesInStableOnly",
        "hardCeilingEnabled",
        "hardCeilingTick",
      ] as const
    ).map((functionName) => ({ address, abi: vaultAbi, functionName, chainId: chain.id }) as const),
    query: { enabled: isCompound, refetchInterval: 60_000 },
  });
  const [
    autoCompoundFeesRaw,
    feeClaimThresholdBps,
    feeClaimIntervalSeconds,
    lastFeeClaimTimestamp,
    payoutFeesInStableOnlyRaw,
    hardCeilingEnabledRaw,
    hardCeilingTick,
  ] = compoundData?.map((d) => d.result) ?? [];
  const autoCompoundFees = Boolean(autoCompoundFeesRaw);
  const payoutFeesInStableOnly = Boolean(payoutFeesInStableOnlyRaw);
  const hardCeilingEnabled = Boolean(hardCeilingEnabledRaw);

  const { data: feesSummary } = useVaultFeesSummary(address, chain, vaultAbi);
  // B1 — see useVaultCumulativeInvestment's own docstring. Raw stable-decimal
  // bigint; converted to a display USD number right where it's used, in
  // PositionNFT's own "invertido vs. valor actual" comparison.
  const { data: cumulativeInvestmentRaw } = useVaultCumulativeInvestment(address, chain, vaultAbi);
  const cumulativeInvestmentUsd =
    cumulativeInvestmentRaw !== undefined ? Number(formatUnits(cumulativeInvestmentRaw, stableDecimals)) : undefined;
  const { data: createdAt } = useVaultCreatedAt(address, chain);
  const { data: slot0 } = useReadContract({
    address: poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
    query: { refetchInterval: 60_000 },
  });
  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;

  // Only needed to convert a manually-typed price range into ticks (see
  // handleReconfigure) — same read create/page.tsx uses for the same reason.
  const { data: tickSpacing } = useReadContract({
    address: poolAddress,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
    chainId: chain.id,
  });

  const feesUsdtStr = formatUnits(feesSummary?.totalUsdt ?? 0n, stableDecimals);
  const feesWethRaw = feesSummary?.totalWeth ?? 0n;
  const feesWethStr = Number(formatUnits(feesWethRaw, volatileDecimals)).toFixed(6);
  // Claimed = LpFeesPaidToOwner + FeesCollected, what actually landed in the
  // owner's wallet. Reinjected = FeesReinjected.netFeeUsd (compound-only,
  // always 0 for a standard vault) — already USD-denominated by the
  // contract itself, no per-leg conversion needed. "Generadas" (feesUsdTotal
  // below) is the TRUE total ever earned — claimed + reinjected — not just
  // what got paid out, so it (and the rentabilidad stat derived from it)
  // doesn't understate a compounding vault's real return.
  const claimedUsd =
    currentTick !== undefined
      ? Number(feesUsdtStr) +
        Number(formatUnits(feesWethRaw, volatileDecimals)) *
          ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals)
      : undefined;
  const reinjectedUsd = Number(formatUnits(feesSummary?.reinjectedUsdRaw ?? 0n, stableDecimals));
  const feesUsdTotal = claimedUsd !== undefined ? claimedUsd + reinjectedUsd : undefined;

  // Rentabilidad = comisiones (USD) sobre B1 (capital invertido acumulado,
  // ver useVaultCumulativeInvestment) — no el depósito inicial solo, que
  // infla el % en cualquier vault que recibió capital después de crearse
  // (top-up, increasePosition, reinyección). No anualizado.
  const rentLabel =
    feesUsdTotal !== undefined && cumulativeInvestmentUsd !== undefined && cumulativeInvestmentUsd > 0
      ? t("vaults.returnLabel", { pct: ((feesUsdTotal / cumulativeInvestmentUsd) * 100).toFixed(2) })
      : undefined;

  // Ganancia neta de operación = comisiones generadas − gas reembolsado al
  // operador — mide si vale la pena operar el vault puramente en costos
  // (ingreso por LP vs. lo que se le paga al keeper), deliberadamente SIN
  // la desvalorización/revalorización del precio del par (eso ya lo cubre
  // "Rentabilidad flotante" más abajo, que sí incluye impermanent loss).
  const gasSpentUsd = Number(formatUnits(feesSummary?.gasReimbursedUsdRaw ?? 0n, stableDecimals));
  const netOperatingProfitUsd = feesUsdTotal !== undefined ? feesUsdTotal - gasSpentUsd : undefined;
  const netOperatingProfitPct =
    netOperatingProfitUsd !== undefined && cumulativeInvestmentUsd !== undefined && cumulativeInvestmentUsd > 0
      ? (netOperatingProfitUsd / cumulativeInvestmentUsd) * 100
      : undefined;

  const isOwner = Boolean(
    connected && owner && (connected as string).toLowerCase() === (owner as string).toLowerCase(),
  );
  const hasPosition = Boolean(positionTokenId && (positionTokenId as bigint) > 0n);

  // Needed to size increasePosition()'s swap (the position's OWN live range,
  // not targetTickLower/Upper, which don't move on rebalance()) and, for
  // compound vaults, the manual collectFees() reinject swap — tokensOwed0/1
  // (indices 10/11) are the same accrued-but-uncollected fee amounts the
  // keeper's own checkFeeClaimDue/runClaimFees use server-side.
  const { data: positionData } = useReadContract({
    address: chain.positionManager,
    abi: positionManagerAbi,
    functionName: "positions",
    args: hasPosition ? [positionTokenId as bigint] : undefined,
    chainId: chain.id,
    query: { enabled: hasPosition, refetchInterval: 60_000 },
  });
  const positionTicks = positionData
    ? {
        tickLower: Number((positionData as readonly unknown[])[5]),
        tickUpper: Number((positionData as readonly unknown[])[6]),
      }
    : undefined;
  const positionLiquidity = positionData ? (positionData as readonly bigint[])[7] : undefined;
  const positionFeeGrowthInsideLast = positionData
    ? {
        feeGrowthInside0LastX128: (positionData as readonly bigint[])[8],
        feeGrowthInside1LastX128: (positionData as readonly bigint[])[9],
      }
    : undefined;
  const positionTokensOwed = positionData
    ? {
        tokensOwed0: (positionData as readonly bigint[])[10],
        tokensOwed1: (positionData as readonly bigint[])[11],
      }
    : undefined;

  // tokensOwed0/1 above only gets checkpointed on a mint/burn/collect call —
  // between rebalances it sits frozen, often at literally zero, even while
  // the position is actively earning (same staleness PositionNFT.tsx's own
  // fee card already works around). Recompute the LIVE accrued amount the
  // same way Uniswap's own app does (see positionMath.ts's uncollectedFeesRaw
  // docstring) so the "Cobrar comisiones" preview and the reinject-swap
  // sizing in handleCollectFees below don't show/act on a stale zero.
  const { data: feeGrowthReads } = useReadContracts({
    contracts: [
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal0X128", chainId: chain.id },
      { address: poolAddress, abi: uniswapV3PoolAbi, functionName: "feeGrowthGlobal1X128", chainId: chain.id },
      {
        address: poolAddress,
        abi: uniswapV3PoolAbi,
        functionName: "ticks",
        args: [positionTicks?.tickLower ?? 0],
        chainId: chain.id,
      },
      {
        address: poolAddress,
        abi: uniswapV3PoolAbi,
        functionName: "ticks",
        args: [positionTicks?.tickUpper ?? 0],
        chainId: chain.id,
      },
    ],
    query: { enabled: Boolean(positionTicks), refetchInterval: 60_000 },
  });
  const positionTokensOwedLive = (() => {
    if (!positionTokensOwed) return undefined;
    const feeGrowthGlobal0X128 = feeGrowthReads?.[0]?.result as bigint | undefined;
    const feeGrowthGlobal1X128 = feeGrowthReads?.[1]?.result as bigint | undefined;
    const tickLowerData = feeGrowthReads?.[2]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
    const tickUpperData = feeGrowthReads?.[3]?.result as readonly [bigint, bigint, bigint, bigint, ...unknown[]] | undefined;
    if (
      !positionTicks ||
      !positionFeeGrowthInsideLast ||
      positionLiquidity === undefined ||
      currentTick === undefined ||
      feeGrowthGlobal0X128 === undefined ||
      feeGrowthGlobal1X128 === undefined ||
      !tickLowerData ||
      !tickUpperData
    ) {
      // Still loading the second round-trip (feeGrowthReads) — undefined
      // here reads as "—"/disabled in the UI rather than a misleading "0",
      // which the raw (possibly genuinely stale) tokensOwed0/1 would show if
      // returned instead. Confirmed live 2026-07-27: opening "Cobrar
      // comisiones" in the brief window before this resolves showed a false
      // 0.000000/0.00 even though real accrued fees existed.
      return undefined;
    }
    const live = uncollectedFeesRaw({
      liquidity: positionLiquidity,
      tokensOwed0: positionTokensOwed.tokensOwed0,
      tokensOwed1: positionTokensOwed.tokensOwed1,
      feeGrowthInside0LastX128: positionFeeGrowthInsideLast.feeGrowthInside0LastX128,
      feeGrowthInside1LastX128: positionFeeGrowthInsideLast.feeGrowthInside1LastX128,
      feeGrowthGlobal0X128,
      feeGrowthGlobal1X128,
      tickLowerOutside0X128: tickLowerData[2],
      tickLowerOutside1X128: tickLowerData[3],
      tickUpperOutside0X128: tickUpperData[2],
      tickUpperOutside1X128: tickUpperData[3],
      currentTick,
      tickLower: positionTicks.tickLower,
      tickUpper: positionTicks.tickUpper,
    });
    return {
      tokensOwed0: BigInt(Math.max(0, Math.floor(live.fees0Raw))),
      tokensOwed1: BigInt(Math.max(0, Math.floor(live.fees1Raw))),
    };
  })();

  // Idle WETH the vault might already be holding (e.g. dust stranded by a
  // prior mis-sized swap) — increasePosition()'s own swap has to account for
  // this too, or the contract's increaseLiquidity() (which sweeps in the
  // vault's FULL token1 balance, not just what this call's swap produces)
  // ends up with more WETH than the swap was sized for, leaving the
  // mismatched USDT side over. Confirmed in production 2026-07-16 (vault
  // 0x0Bf394B3...5dEBCE5b8: $64.92 USDT left over after "Sumar a la
  // posición" ignored ~$190 of pre-existing idle WETH).
  const { data: idleWeth } = useReadContract({
    address: volatileToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
    chainId: chain.id,
    query: { refetchInterval: 60_000 },
  });

  const [depInvestable, setDepInvestable] = useState("0");
  const [depReserve, setDepReserve] = useState("0");
  const [depGasReserve, setDepGasReserve] = useState("0");
  // Once a position exists, the "invertible" field of deposit()/depositToken()
  // is hidden below (see the modal's own JSX) in favor of "Sumar a la
  // posición abierta" (increasePosition()) — a Deposited event only counts
  // toward B1 immediately when positionAlreadyExists is false; once true, it
  // waits for a LATER fold-in that may take a while (see
  // useVaultCumulativeInvestment.ts's own docstring), while PositionIncreased
  // always counts the full amount right away. Reset here (not just hidden)
  // so a stale nonzero value typed before the position existed can never
  // slip into a later deposit() call once it does — same documented-React
  // reset-during-render pattern as prevIsCompoundForToken below.
  const [prevHasPositionForDeposit, setPrevHasPositionForDeposit] = useState(hasPosition);
  if (prevHasPositionForDeposit !== hasPosition) {
    setPrevHasPositionForDeposit(hasPosition);
    if (hasPosition) setDepInvestable("0");
  }

  // Which stablecoin the owner hands over for EACH of the three deposit
  // fields — independent per field, same capability/gating as
  // create/page.tsx's selector (RangeVaultArbCompound's depositToken(),
  // Arbitrum compound vaults only, see chains.ts's compoundDepositTokens
  // docstring). Each resets to the native stable during render whenever
  // this vault stops being compound (same documented-React reset pattern
  // create/page.tsx already uses).
  const [investDepositToken, setInvestDepositToken] = useState<`0x${string}`>(stableToken);
  const [reserveDepositToken, setReserveDepositToken] = useState<`0x${string}`>(stableToken);
  const [gasReserveDepositToken, setGasReserveDepositToken] = useState<`0x${string}`>(stableToken);
  const [prevIsCompoundForToken, setPrevIsCompoundForToken] = useState(isCompound);
  if (prevIsCompoundForToken !== isCompound) {
    setPrevIsCompoundForToken(isCompound);
    if (!isCompound) {
      setInvestDepositToken(stableToken);
      setReserveDepositToken(stableToken);
      setGasReserveDepositToken(stableToken);
    }
  }
  const depositTokenOptions: DepositTokenOption[] = [
    { address: stableToken, decimals: stableDecimals, displaySymbol: stableSymbol },
    ...(isCompound ? (chain.compoundDepositTokens ?? []) : []),
  ];
  function depositTokenMetaFor(addr: `0x${string}`): DepositTokenOption {
    return depositTokenOptions.find((tk) => tk.address.toLowerCase() === addr.toLowerCase()) ?? depositTokenOptions[0];
  }
  const isNative = (addr: `0x${string}`) => addr.toLowerCase() === stableToken.toLowerCase();
  const investTokenMeta = depositTokenMetaFor(investDepositToken);
  const reserveTokenMeta = depositTokenMetaFor(reserveDepositToken);
  const gasReserveTokenMeta = depositTokenMetaFor(gasReserveDepositToken);
  // The connected wallet's own balance of this vault's native stable — no
  // pre-existing read for this in the file (unlike create/page.tsx, this
  // page never validated deposit-more against wallet balance until now).
  const { data: walletStableBalanceRaw } = useReadContract({
    address: stableToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: connected ? [connected] : undefined,
    chainId: chain.id,
    query: { enabled: Boolean(connected), refetchInterval: 60_000 },
  });
  const walletStableBalanceUsd =
    walletStableBalanceRaw !== undefined ? Number(formatUnits(walletStableBalanceRaw as bigint, stableDecimals)) : undefined;
  const { balances: extraDepositTokenBalances } = useMultiTokenBalances(
    chain,
    isCompound ? (chain.compoundDepositTokens ?? []) : [],
    connected,
  );
  const depositTokenBalancesUsd: (number | undefined)[] = [
    walletStableBalanceUsd,
    ...extraDepositTokenBalances.map((b) => b.formatted),
  ];
  function balanceFor(addr: `0x${string}`): number | undefined {
    return isNative(addr) ? walletStableBalanceUsd : extraDepositTokenBalances.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.formatted;
  }

  // Each field quotes INDEPENDENTLY against its own selected token and own
  // typed amount — see create/page.tsx's identical pattern and
  // useThirdPartyDepositQuote's own docstring on why the raw typed amount
  // can never drive the actual ledger split for a non-native field.
  const investRawAmount = parseUnits(depInvestable || "0", investTokenMeta.decimals);
  const reserveRawAmount = parseUnits(depReserve || "0", reserveTokenMeta.decimals);
  const gasReserveRawAmount = chain.supportsGasReserve ? parseUnits(depGasReserve || "0", gasReserveTokenMeta.decimals) : 0n;
  const investQuote = useThirdPartyDepositQuote(
    chain,
    isNative(investDepositToken) ? undefined : (chain.compoundDepositTokens ?? []).find((tk) => tk.address === investDepositToken),
    investRawAmount,
    30n,
  );
  const reserveQuote = useThirdPartyDepositQuote(
    chain,
    isNative(reserveDepositToken) ? undefined : (chain.compoundDepositTokens ?? []).find((tk) => tk.address === reserveDepositToken),
    reserveRawAmount,
    30n,
  );
  const gasReserveQuote = useThirdPartyDepositQuote(
    chain,
    isNative(gasReserveDepositToken)
      ? undefined
      : (chain.compoundDepositTokens ?? []).find((tk) => tk.address === gasReserveDepositToken),
    gasReserveRawAmount,
    30n,
  );
  const investInsufficient =
    !isNative(investDepositToken) &&
    Boolean(depInvestable) &&
    balanceFor(investDepositToken) !== undefined &&
    (parseFloat(depInvestable) || 0) > (balanceFor(investDepositToken) ?? 0);
  const reserveInsufficient =
    !isNative(reserveDepositToken) &&
    Boolean(depReserve) &&
    balanceFor(reserveDepositToken) !== undefined &&
    (parseFloat(depReserve) || 0) > (balanceFor(reserveDepositToken) ?? 0);
  const gasReserveInsufficient =
    chain.supportsGasReserve &&
    !isNative(gasReserveDepositToken) &&
    Boolean(depGasReserve) &&
    balanceFor(gasReserveDepositToken) !== undefined &&
    (parseFloat(depGasReserve) || 0) > (balanceFor(gasReserveDepositToken) ?? 0);
  const nativeDepositTypedSum =
    (isNative(investDepositToken) ? parseFloat(depInvestable) || 0 : 0) +
    (isNative(reserveDepositToken) ? parseFloat(depReserve) || 0 : 0) +
    (chain.supportsGasReserve && isNative(gasReserveDepositToken) ? parseFloat(depGasReserve) || 0 : 0);
  const nativeDepositInsufficient =
    nativeDepositTypedSum > 0 && walletStableBalanceUsd !== undefined && nativeDepositTypedSum > walletStableBalanceUsd;
  const depositInsufficientBalance = nativeDepositInsufficient || investInsufficient || reserveInsufficient || gasReserveInsufficient;
  const depositInsufficientDetails: Array<{ symbol: string; needed: number; balance: number }> = [
    ...(nativeDepositInsufficient ? [{ symbol: stableSymbol, needed: nativeDepositTypedSum, balance: walletStableBalanceUsd ?? 0 }] : []),
    ...(investInsufficient
      ? [{ symbol: investTokenMeta.displaySymbol, needed: parseFloat(depInvestable) || 0, balance: balanceFor(investDepositToken) ?? 0 }]
      : []),
    ...(reserveInsufficient
      ? [{ symbol: reserveTokenMeta.displaySymbol, needed: parseFloat(depReserve) || 0, balance: balanceFor(reserveDepositToken) ?? 0 }]
      : []),
    ...(gasReserveInsufficient
      ? [
          {
            symbol: gasReserveTokenMeta.displaySymbol,
            needed: parseFloat(depGasReserve) || 0,
            balance: balanceFor(gasReserveDepositToken) ?? 0,
          },
        ]
      : []),
  ];
  const pendingDepositQuoteFields = [
    { token: investDepositToken, amount: depInvestable, quote: investQuote, meta: investTokenMeta },
    { token: reserveDepositToken, amount: depReserve, quote: reserveQuote, meta: reserveTokenMeta },
    ...(chain.supportsGasReserve
      ? [{ token: gasReserveDepositToken, amount: depGasReserve, quote: gasReserveQuote, meta: gasReserveTokenMeta }]
      : []),
  ].filter((f) => !isNative(f.token) && (parseFloat(f.amount) || 0) > 0);
  const depositQuoteLoading = pendingDepositQuoteFields.some((f) => f.quote.isLoading);
  const depositQuoteErrored = pendingDepositQuoteFields.find((f) => f.quote.isError);
  // Only used when the vault has no configured range yet (targetConfigured
  // false — e.g. an owner who backed out at signature 3/5 during creation,
  // leaving a real on-chain vault with nothing to reconfigure "from"). Left
  // blank for an already-configured vault, which keeps its current range
  // exactly as before — see handleReconfigure.
  const [cfgPriceMin, setCfgPriceMin] = useState("");
  const [cfgPriceMax, setCfgPriceMax] = useState("");
  const [cfgMaxRebalances, setCfgMaxRebalances] = useState("");
  const [cfgReinjection, setCfgReinjection] = useState("");
  const [cfgPeriodicHours, setCfgPeriodicHours] = useState("");
  const [cfgRecenterMarginPct, setCfgRecenterMarginPct] = useState("");
  const [cfgExitTopCeilingMarginPct, setCfgExitTopCeilingMarginPct] = useState("");
  const [cfgFeeClaimThresholdPct, setCfgFeeClaimThresholdPct] = useState("");
  const [cfgFeeClaimIntervalHours, setCfgFeeClaimIntervalHours] = useState("");
  // Feature 6 — hard ceiling. Human USD price, converted to a tick right
  // before the contract call (tickFromEthPrice, same direction-aware
  // conversion every other range field in this file already uses).
  const [cfgHardCeilingPrice, setCfgHardCeilingPrice] = useState("");
  const [riskMaxSlippagePct, setRiskMaxSlippagePct] = useState("");
  const [riskMinCooldownHours, setRiskMinCooldownHours] = useState("");
  const [riskMaxRangeDeviationTicks, setRiskMaxRangeDeviationTicks] = useState("");
  const [increaseAmount, setIncreaseAmount] = useState("0");
  // Which token the owner hands over for "Sumar a la posición abierta" —
  // same capability/gating as the deposit fields above (compound vaults
  // only, via increasePositionWithToken()'s new third-party-swap path).
  const [increaseDepositToken, setIncreaseDepositToken] = useState<`0x${string}`>(stableToken);
  const [prevIsCompoundForIncrease, setPrevIsCompoundForIncrease] = useState(isCompound);
  if (prevIsCompoundForIncrease !== isCompound) {
    setPrevIsCompoundForIncrease(isCompound);
    if (!isCompound) setIncreaseDepositToken(stableToken);
  }
  const increaseTokenMeta = depositTokenMetaFor(increaseDepositToken);
  const increaseRawAmount = parseUnits(increaseAmount || "0", increaseTokenMeta.decimals);
  const increaseQuote = useThirdPartyDepositQuote(
    chain,
    isNative(increaseDepositToken) ? undefined : (chain.compoundDepositTokens ?? []).find((tk) => tk.address === increaseDepositToken),
    increaseRawAmount,
    30n,
  );
  const increaseInsufficient =
    !isNative(increaseDepositToken) &&
    Boolean(increaseAmount) &&
    balanceFor(increaseDepositToken) !== undefined &&
    (parseFloat(increaseAmount) || 0) > (balanceFor(increaseDepositToken) ?? 0);
  const increaseQuotePending = !isNative(increaseDepositToken) && (parseFloat(increaseAmount) || 0) > 0;
  const increaseQuoteLoading = increaseQuotePending && increaseQuote.isLoading;
  const increaseQuoteErrored = increaseQuotePending && increaseQuote.isError;
  const [withdrawPositionPct, setWithdrawPositionPct] = useState("0");
  // Feature 5(b) — per-call "todo en {stable}" option in the withdraw modal.
  // NOT a persisted preference (unlike payoutFeesInStableOnly) — the owner
  // is present signing this exact transaction, so they just size the
  // conversion for THIS withdrawal, no on-chain flag needed. See
  // handlePartialWithdraw's own sizing comment for how the swap amount is
  // estimated client-side (same estimation-based pattern this codebase
  // already uses for sizeRebalanceSwap, not a simulate-then-execute round
  // trip).
  const [withdrawConvertToStable, setWithdrawConvertToStable] = useState(false);
  // Per-call override for "Cobrar comisiones", same idea as
  // withdrawConvertToStable — defaults to the persistent
  // payoutFeesInStableOnly preference whenever the modal opens, but the
  // owner can flip it just for this one claim without touching the setting.
  const [collectConvertToStable, setCollectConvertToStable] = useState(false);
  // Same feature 5(b) checkbox, mirrored for the "Retirar todo" button —
  // sized at a full 100% share instead of withdrawPositionShareBps.
  const [withdrawAllConvertToStable, setWithdrawAllConvertToStable] = useState(false);
  // withdrawFundsPct: standard (V1) vaults only — withdraw() there still
  // takes one shared bps for investable+reserve+gas. Compound (V2) vaults
  // split it into 3 fully independent buckets below (see withdraw()'s own
  // signature change documented in CLAUDE.md's "Interés compuesto V2").
  const [withdrawFundsPct, setWithdrawFundsPct] = useState("0");
  // Amounts (in the stable token's own units), not percentages — the owner
  // sees each bucket's real available balance and types (or quick-picks) how
  // much of it to withdraw; converted back to bps just before the contract
  // call, since withdraw() itself only ever takes bps (see the derivation
  // below). Quick buttons still emit "25"/"50"/"75"/"100" (LightPctQuickButtons
  // is unchanged) — the onPick handlers convert that to an actual amount.
  const [withdrawInvestableAmount, setWithdrawInvestableAmount] = useState("0");
  const [withdrawReserveAmount, setWithdrawReserveAmount] = useState("0");
  const [withdrawGasReserveAmount, setWithdrawGasReserveAmount] = useState("0");
  // Uniswap-style liquidity actions — "Agregar liquidez"/"Eliminar
  // liquidez"/"Cobrar comisiones" each open their own modal (input step,
  // then a review step before the wallet ever opens) instead of living as
  // inline fields in the page, matching Uniswap's own position-management
  // UX. Preview math (both here and in withdrawPreview below) reuses
  // tokensOwed0/1 (already fetched above for the reinject-swap sizing
  // elsewhere in this file) rather than the fully precise live
  // feeGrowthGlobal calc PositionNFT.tsx uses — good enough for an
  // estimate, not a money-moving computation, same tolerance already
  // accepted elsewhere in this file (see handleReconfigure).
  const [manageModal, setManageModal] = useState<"add" | "remove" | "collect" | "deposit" | null>(null);
  const [manageStep, setManageStep] = useState<"input" | "review">("input");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showRiskLimits, setShowRiskLimits] = useState(false);

  // Sync the "Cobrar comisiones" per-call toggle to the persistent
  // payoutFeesInStableOnly preference every time that modal opens — a
  // sensible starting point, still overridable just for this claim.
  useEffect(() => {
    if (manageModal === "collect") setCollectConvertToStable(payoutFeesInStableOnly);
  }, [manageModal, payoutFeesInStableOnly]);

  // Single choke point for every write in this file — the viewing chain
  // (chain, from useSelectedChain) and the wallet's actual connected chain
  // are deliberately decoupled (see lib/useSelectedChain.tsx), so every
  // write has to confirm the wallet is actually on `chain` before signing.
  async function withTx(label: string, fn: () => Promise<`0x${string}`>) {
    if (!publicClient) return;
    setBusy(label);
    setError(null);
    try {
      if (walletChainId !== chain.id) {
        try {
          await switchChainAsync({ chainId: chain.id });
        } catch {
          setError(t("vaultDetail.errSwitchChain", { chain: chain.name }));
          return;
        }
      }
      const hash = await fn();
      await publicClient.waitForTransactionReceipt({ hash });
      await refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleDepositMore() {
    // Each non-native, non-empty field needs its own live quote resolved
    // first — see useThirdPartyDepositQuote's own docstring on why the raw
    // typed amounts can never be trusted directly for the ledger split
    // below.
    const notReady = pendingDepositQuoteFields.find((f) => f.quote.isLoading || f.quote.isError || f.quote.expectedStableOut === 0n);
    if (notReady) {
      setError(t("vaultDetail.quoteErrorMsg", { symbol: notReady.meta.displaySymbol }));
      return;
    }

    const finalInvestableRaw = isNative(investDepositToken) ? investRawAmount : investQuote.expectedStableOut;
    const finalReserveRaw = isNative(reserveDepositToken) ? reserveRawAmount : reserveQuote.expectedStableOut;
    const finalGasReserveRaw = !chain.supportsGasReserve
      ? 0n
      : isNative(gasReserveDepositToken)
        ? gasReserveRawAmount
        : gasReserveQuote.expectedStableOut;
    const total = finalInvestableRaw + finalReserveRaw + finalGasReserveRaw;
    if (total === 0n) return;

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded, on top
    // of whatever's already committed) — catch it here so the wallet never
    // even pops up for a deposit that's certain to revert on-chain.
    // Confirmed in production 2026-07-17: a user hit DepositExceedsPlatformCap
    // with no explanation, just a raw revert. Uses the FINAL (quoted, when
    // applicable) amounts, never the raw typed third-party-token numbers.
    const currentTotal = ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance;
    if (maxDepositUsd > 0n && currentTotal + total > maxDepositUsd) {
      const room = maxDepositUsd > currentTotal ? maxDepositUsd - currentTotal : 0n;
      setCapAlert(
        t("vaultDetail.capAlertMsg", {
          cap: formatUnits(maxDepositUsd, stableDecimals),
          symbol: stableSymbol,
          current: formatUnits(currentTotal, stableDecimals),
          room: formatUnits(room, stableDecimals),
        }),
      );
      return;
    }

    // Up to 4 calls: ONE combined native deposit() (whichever of the 3
    // fields use the vault's own stable, if any) plus one depositToken() PER
    // third-party field — same reasoning as create/page.tsx's handleCreate
    // (never merged even if two fields share the same non-native token,
    // since each field's own live quote was sized for exactly that field's
    // own amount). The native leg, when present, is always sent FIRST and
    // is the only one whose approve pads in the pending creation fee.
    interface DepositCall {
      approveToken: `0x${string}`;
      approveAmount: bigint;
      functionName: "deposit" | "depositToken";
      args: readonly unknown[];
    }
    const depositCalls: DepositCall[] = [];
    const nativeReserve = isNative(reserveDepositToken) ? finalReserveRaw : 0n;
    const nativeInvestable = isNative(investDepositToken) ? finalInvestableRaw : 0n;
    const nativeGasReserve = chain.supportsGasReserve && isNative(gasReserveDepositToken) ? finalGasReserveRaw : 0n;
    const nativeTotal = nativeReserve + nativeInvestable + nativeGasReserve;
    if (nativeTotal > 0n) {
      depositCalls.push({
        approveToken: stableToken,
        approveAmount: nativeTotal + pendingCreationFee,
        functionName: "deposit",
        args: chain.supportsGasReserve ? [nativeReserve, nativeInvestable, nativeGasReserve] : [nativeReserve, nativeInvestable],
      });
    }
    const inertSwapIx = { token0ToToken1: false, amountIn: 0n, amountOutMinimum: 0n, fee: 0 };
    if (!isNative(investDepositToken) && finalInvestableRaw > 0n) {
      depositCalls.push({
        approveToken: investDepositToken,
        approveAmount: investRawAmount,
        functionName: "depositToken",
        args: [investDepositToken, investRawAmount, inertSwapIx, investQuote.feeTier, investQuote.thirdPartyAmountOutMinimum, 0n, finalInvestableRaw, 0n],
      });
    }
    if (!isNative(reserveDepositToken) && finalReserveRaw > 0n) {
      depositCalls.push({
        approveToken: reserveDepositToken,
        approveAmount: reserveRawAmount,
        functionName: "depositToken",
        args: [reserveDepositToken, reserveRawAmount, inertSwapIx, reserveQuote.feeTier, reserveQuote.thirdPartyAmountOutMinimum, finalReserveRaw, 0n, 0n],
      });
    }
    if (chain.supportsGasReserve && !isNative(gasReserveDepositToken) && finalGasReserveRaw > 0n) {
      depositCalls.push({
        approveToken: gasReserveDepositToken,
        approveAmount: gasReserveRawAmount,
        functionName: "depositToken",
        args: [
          gasReserveDepositToken,
          gasReserveRawAmount,
          inertSwapIx,
          gasReserveQuote.feeTier,
          gasReserveQuote.thirdPartyAmountOutMinimum,
          0n,
          0n,
          finalGasReserveRaw,
        ],
      });
    }

    for (const call of depositCalls) {
      await withTx(t("vaultDetail.txApproving"), () =>
        writeContractAsync({
          address: call.approveToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [address, call.approveAmount],
          chainId: chain.id,
        }),
      );
      await withTx(t("vaultDetail.txDepositing"), () =>
        writeContractAsync({
          address,
          abi: vaultAbi,
          functionName: call.functionName,
          args: call.args,
          chainId: chain.id,
        }),
      );
    }
  }

  async function handleReconfigure() {
    // Two cases, same call: an already-configured vault keeps its current
    // on-chain tick range unless the owner explicitly types a new one in
    // Precio mínimo/máximo (an intentional override, e.g. correcting a
    // range set too wide) — everything else preserves its current value the
    // same way it always has. An UNCONFIGURED vault (targetTickLower/Upper
    // both undefined/0 — e.g. an owner who backed out at signature 3/5
    // during creation: createVault() + approve() went through, but
    // configureTarget() never did) has nothing to fall back to at all, so
    // Precio mínimo/máximo — and every other field below — are REQUIRED in
    // that case; this used to just silently no-op here, stranding that
    // vault with no way to finish setup short of re-doing /create's whole
    // flow (which would also re-pay the creation fee for a second, orphaned
    // vault).
    const wasConfigured = Boolean(targetConfigured);

    let lo: number;
    let hi: number;
    if (cfgPriceMin || cfgPriceMax || !wasConfigured) {
      const priceMin = Number(cfgPriceMin);
      const priceMax = Number(cfgPriceMax);
      if (!(priceMin > 0) || !(priceMax > priceMin)) {
        setError(t("vaultDetail.errPriceRange"));
        return;
      }
      if (tickSpacing === undefined) {
        setError(t("vaultDetail.errNoRange"));
        return;
      }
      // Which typed price maps to the lower/higher tick depends on
      // stableIsToken0 (a higher USD price of ETH is a LOWER tick in this
      // pool's own convention on Celo, higher on Arbitrum) — sort by tick,
      // not by which field the price was typed into, same as create/page.tsx.
      const tickA = alignToTickSpacing(
        tickFromEthPrice(priceMin, stableIsToken0, stableDecimals, volatileDecimals),
        Number(tickSpacing),
      );
      const tickB = alignToTickSpacing(
        tickFromEthPrice(priceMax, stableIsToken0, stableDecimals, volatileDecimals),
        Number(tickSpacing),
      );
      lo = Math.min(tickA, tickB);
      hi = Math.max(tickA, tickB);
    } else {
      // targetConfigured=true implies these are real numbers on-chain, but
      // the client read for them may simply not have resolved yet.
      if (targetTickLower === undefined || targetTickUpper === undefined) {
        setError(t("vaultDetail.errNoRange"));
        return;
      }
      lo = Math.min(Number(targetTickLower), Number(targetTickUpper));
      hi = Math.max(Number(targetTickLower), Number(targetTickUpper));
    }

    if (!wasConfigured && !cfgMaxRebalances) {
      setError(t("vaultDetail.errMaxRebalancesRequired"));
      return;
    }

    await withTx(t("vaultDetail.txReconfiguring"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "configureTarget",
        args: [
          (investableUsdt as bigint) ?? 0n,
          lo,
          hi,
          BigInt(cfgMaxRebalances || String(maxRebalances ?? 0)),
          cfgReinjection ? parseUnits(cfgReinjection, stableDecimals) : ((reinjectionAmount as bigint) ?? 0n),
          cfgPeriodicHours
            ? BigInt(Math.round(Number(cfgPeriodicHours) * 3600))
            : ((periodicRebalanceInterval as bigint) ?? 0n),
          cfgRecenterMarginPct
            ? BigInt(Math.round(Number(cfgRecenterMarginPct) * 100))
            : ((recenterMarginBps as bigint) ?? 500n),
          cfgExitTopCeilingMarginPct
            ? BigInt(Math.round(Number(cfgExitTopCeilingMarginPct) * 100))
            : ((exitTopCeilingMarginBps as bigint) ?? 300n),
          // RangeVaultArbCompound-only trailing pair — the standard ABI's
          // configureTarget() doesn't have these params at all, so they must
          // never be sent on a standard vault (wrong arg count would fail to
          // encode, not just revert).
          ...(isCompound
            ? [
                cfgFeeClaimThresholdPct
                  ? BigInt(Math.round(Number(cfgFeeClaimThresholdPct) * 100))
                  : ((feeClaimThresholdBps as bigint) ?? 0n),
                cfgFeeClaimIntervalHours
                  ? BigInt(Math.round(Number(cfgFeeClaimIntervalHours) * 3600))
                  : ((feeClaimIntervalSeconds as bigint) ?? 0n),
              ]
            : []),
        ],
        chainId: chain.id,
      }),
    );
  }

  async function handleToggleAutoCompound() {
    await withTx(t("vaultDetail.txSettingAutoCompound"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "setAutoCompoundFees",
        args: [!autoCompoundFees],
        chainId: chain.id,
      }),
    );
  }

  // Feature 5(a) — persistent preference. Settable regardless of
  // autoCompoundFees's current value (matches the contract's own docstring —
  // lets the owner pre-arm it before flipping the other switch), only
  // actually changes behavior while autoCompoundFees is off.
  async function handleTogglePayoutFeesInStableOnly() {
    await withTx(t("vaultDetail.txSettingPayoutStable"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "setPayoutFeesInStableOnly",
        args: [!payoutFeesInStableOnly],
        chainId: chain.id,
      }),
    );
  }

  async function handleCollectFees() {
    // Standard vaults: unchanged, no-arg collectFees() straight to the owner.
    if (!isCompound) {
      await withTx(t("vaultDetail.txCollectingFees"), () =>
        writeContractAsync({ address, abi: vaultAbi, functionName: "collectFees", args: [], chainId: chain.id }),
      );
      return;
    }

    // Compound vault (V3): collectFees() now takes (swapIx, feePayoutSwapIx,
    // amount0Min, amount1Min) — with autoCompoundFees off it behaves exactly
    // like the standard call above (empty swapIx, _executeSwap no-ops on
    // amountIn=0). With it on, the accrued tokensOwed0/1 (both legs —
    // Uniswap accrues fees in both at once) need the same mixed-balance
    // correction swap the keeper's own runClaimFees sizes server-side, via
    // sizeRebalanceSwap toward the position's own live ratio — see
    // RangeVaultArbCompound.sol's _reinjectFees docstring for why
    // sizeRebalanceSwap, not sizeInitialSwap.
    let swapIx = { token0ToToken1: true, amountIn: 0n, amountOutMinimum: 0n, fee: feeTier };
    if (autoCompoundFees && positionTicks && positionTokensOwedLive && currentTick !== undefined) {
      const ethPrice = ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals);
      const accruedStableRaw = stableIsToken0 ? positionTokensOwedLive.tokensOwed0 : positionTokensOwedLive.tokensOwed1;
      const accruedVolatileRaw = stableIsToken0 ? positionTokensOwedLive.tokensOwed1 : positionTokensOwedLive.tokensOwed0;
      const swap = sizeRebalanceSwap({
        currentTick,
        newTickLower: positionTicks.tickLower,
        newTickUpper: positionTicks.tickUpper,
        availableStableRaw: accruedStableRaw,
        availableVolatileRaw: accruedVolatileRaw,
        ethPriceUsd: ethPrice,
        stableIsToken0: stableIsToken0,
        stableDecimals,
        volatileDecimals,
      });
      swapIx = {
        token0ToToken1: swap.sellStable === stableIsToken0,
        amountIn: swap.amountIn,
        amountOutMinimum: 0n,
        fee: feeTier,
      };
    }

    // Fix 5(a) — payoutFeesInStableOnly: only relevant in the non-compounding
    // branch (autoCompoundFees off), converting the volatile leg of the
    // accrued fee to the vault's stable token. Sized against the SAME
    // positionTokensOwedLive preview the ratio-matching swap above already
    // reads, just aimed at 100% conversion instead of ratio-matching.
    let feePayoutSwapIx = { token0ToToken1: true, amountIn: 0n, amountOutMinimum: 0n, fee: feeTier };
    if (!autoCompoundFees && collectConvertToStable && positionTokensOwedLive) {
      const volatileOwed = stableIsToken0 ? positionTokensOwedLive.tokensOwed1 : positionTokensOwedLive.tokensOwed0;
      if (volatileOwed > 0n) {
        feePayoutSwapIx = {
          token0ToToken1: !stableIsToken0,
          amountIn: volatileOwed,
          amountOutMinimum: 0n,
          fee: feeTier,
        };
      }
    }

    await withTx(t("vaultDetail.txCollectingFees"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "collectFees",
        args: [swapIx, feePayoutSwapIx, 0n, 0n],
        chainId: chain.id,
      }),
    );
  }

  // Feature 6 — hard ceiling. `enabled=false` keeps sending the CURRENT
  // on-chain tick unchanged (irrelevant while disabled — the contract's own
  // _isAboveHardCeiling() short-circuits on hardCeilingEnabled first) so a
  // temporary disable doesn't lose the configured price for next time.
  async function handleSetHardCeiling(enabled: boolean) {
    let tick = (hardCeilingTick as number) ?? 0;
    if (enabled) {
      if (tickSpacing === undefined) {
        setError(t("vaultDetail.errNoRange"));
        return;
      }
      const priceUsd = Number(cfgHardCeilingPrice);
      if (!priceUsd || priceUsd <= 0) {
        setError(t("vaultDetail.errHardCeilingPriceRequired"));
        return;
      }
      tick = alignToTickSpacing(
        tickFromEthPrice(priceUsd, stableIsToken0, stableDecimals, volatileDecimals),
        Number(tickSpacing),
      );
    }
    await withTx(t("vaultDetail.txSettingHardCeiling"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "setHardCeiling",
        args: [enabled, tick],
        chainId: chain.id,
      }),
    );
    setCfgHardCeilingPrice("");
  }

  async function handleUpdateRiskParams() {
    const newMaxSlippageBps = riskMaxSlippagePct
      ? BigInt(Math.round(Number(riskMaxSlippagePct) * 100))
      : ((maxSlippageBps as bigint) ?? 30n);
    const newMinRebalanceInterval = riskMinCooldownHours
      ? BigInt(Math.round(Number(riskMinCooldownHours) * 3600))
      : ((minRebalanceInterval as bigint) ?? 0n);
    const newMaxRangeDeviationBps = riskMaxRangeDeviationTicks
      ? BigInt(riskMaxRangeDeviationTicks)
      : ((maxRangeDeviationBps as bigint) || 5_000n);

    await withTx(t("vaultDetail.txSettingRisk"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "setRiskParams",
        args: [newMaxSlippageBps, newMinRebalanceInterval, newMaxRangeDeviationBps],
        chainId: chain.id,
      }),
    );
  }

  async function handleIncreasePosition() {
    if (!positionTicks || currentTick === undefined) {
      setError(t("vaultDetail.errNoRange"));
      return;
    }
    const native = isNative(increaseDepositToken);
    // Third-party token (increasePositionWithToken()): the amount that
    // actually lands in the vault's own stable is whatever the sell-side
    // quote says, not the raw typed amount of the foreign token — same
    // reasoning as handleDepositMore's finalInvestableRaw.
    if (!native && (increaseQuote.isLoading || increaseQuote.isError || increaseQuote.expectedStableOut === 0n)) {
      setError(t("vaultDetail.quoteErrorMsg", { symbol: increaseTokenMeta.displaySymbol }));
      return;
    }
    const usdtAmount = native ? parseUnits(increaseAmount || "0", stableDecimals) : increaseQuote.expectedStableOut;
    if (usdtAmount === 0n) return;

    // Sized client-side — no uni-lab consultation needed, this is just the
    // position's already-known live ratio at the pool's current price, both
    // public reads. Uses sizeRebalanceSwap (a MIXED starting balance), not
    // sizeInitialSwap (all-stable), because the contract's increaseLiquidity()
    // sweeps in the vault's FULL volatile-leg balance — including any WETH
    // already sitting idle from a prior mis-sized swap — not just what
    // usdtAmount alone would produce. Ignoring that pre-existing WETH here is
    // exactly what left $64.92 of USDT stranded in production 2026-07-16
    // (vault 0x0Bf394B3...5dEBCE5b8). The stable side is still capped to
    // usdtAmount to match increasePosition()'s own cap — old investableUsdt
    // dust stays untouched. Applies the same way whether usdtAmount came
    // straight from the input (native) or from a third-party sell quote.
    const ethPrice = ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals);
    const swap = sizeRebalanceSwap({
      currentTick,
      newTickLower: positionTicks.tickLower,
      newTickUpper: positionTicks.tickUpper,
      availableStableRaw: usdtAmount,
      availableVolatileRaw: (idleWeth as bigint) ?? 0n,
      ethPriceUsd: ethPrice,
      stableIsToken0: stableIsToken0,
      stableDecimals,
      volatileDecimals,
    });
    const swapIx = {
      token0ToToken1: swap.sellStable === stableIsToken0,
      amountIn: swap.amountIn,
      amountOutMinimum: 0n,
      fee: feeTier,
    };

    if (native) {
      await withTx(t("vaultDetail.txApproving"), () =>
        writeContractAsync({
          address: stableToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [address, usdtAmount],
          chainId: chain.id,
        }),
      );
      await withTx(t("vaultDetail.txIncreasing"), () =>
        writeContractAsync({
          address,
          abi: vaultAbi,
          functionName: "increasePosition",
          args: [swapIx, usdtAmount, 0n, 0n],
          chainId: chain.id,
        }),
      );
    } else {
      await withTx(t("vaultDetail.txApproving"), () =>
        writeContractAsync({
          address: increaseDepositToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [address, increaseRawAmount],
          chainId: chain.id,
        }),
      );
      await withTx(t("vaultDetail.txIncreasing"), () =>
        writeContractAsync({
          address,
          abi: vaultAbi,
          functionName: "increasePositionWithToken",
          args: [
            increaseDepositToken,
            increaseRawAmount,
            increaseQuote.feeTier,
            increaseQuote.thirdPartyAmountOutMinimum,
            swapIx,
            usdtAmount,
            0n,
            0n,
          ],
          chainId: chain.id,
        }),
      );
    }
    setIncreaseAmount("0");
  }

  // ownerRebalance() (V2 only) — the owner forces a rebalance without
  // waiting for the keeper's next cycle, even while still comfortably in
  // range. The new range still has to come from uni-lab.xyz's real
  // calculation (same as every keeper rebalance), so this first asks a
  // server route (paid via the operator's own x402 wallet, no cost to the
  // owner) for the params, then has the owner's OWN wallet sign
  // ownerRebalance() with them — owner pays their own gas, same
  // collectFees()-vs-harvestFees() reasoning as the rest of this file.
  async function handleOwnerRebalance() {
    if (!connected) return;
    setBusy(t("vaultDetail.txComputingRange"));
    setError(null);
    try {
      const res = await fetch(`/api/vault/${address}/owner-rebalance-params`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: chain.id, owner: connected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(t("vaultDetail.errOwnerRebalanceFailed"));
        return;
      }
      setBusy(null);
      // feePayoutSwapIx (V3): sized server-side by owner-rebalance-params
      // when payoutFeesInStableOnly is on and autoCompoundFees is off, same
      // as the keeper's own rebalance() sizing (see rebalancer.ts) —
      // defaults to a no-op (amountIn=0) when the route doesn't return one,
      // which _convertPayoutToStable() treats as "pay the fee raw,
      // unconverted" (safe, just doesn't honor the preference for this one
      // action yet).
      const feePayoutSwapIx = data.feePayoutSwapIx
        ? {
            token0ToToken1: data.feePayoutSwapIx.token0ToToken1,
            amountIn: BigInt(data.feePayoutSwapIx.amountIn),
            amountOutMinimum: BigInt(data.feePayoutSwapIx.amountOutMinimum),
            fee: data.feePayoutSwapIx.fee,
          }
        : { token0ToToken1: true, amountIn: 0n, amountOutMinimum: 0n, fee: feeTier };
      await withTx(t("vaultDetail.txRebalancing"), () =>
        writeContractAsync({
          address,
          abi: vaultAbi,
          functionName: "ownerRebalance",
          args: [
            data.newTickLower,
            data.newTickUpper,
            {
              token0ToToken1: data.swapIx.token0ToToken1,
              amountIn: BigInt(data.swapIx.amountIn),
              amountOutMinimum: BigInt(data.swapIx.amountOutMinimum),
              fee: data.swapIx.fee,
            },
            feePayoutSwapIx,
            BigInt(data.reinjectAmount),
            0n,
            0n,
          ],
          chainId: chain.id,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function handlePartialWithdraw() {
    // Reuses the same bps figures already derived above (withdrawInvestable/
    // Reserve/GasReserveShareBps convert the owner-typed AMOUNTS back to bps
    // via each bucket's own available balance) — never recomputed here, so
    // this can't drift from what the review screen showed.
    const positionShareBps = BigInt(withdrawPositionShareBps);

    if (!isCompound) {
      const withdrawArgs = [positionShareBps, BigInt(Math.round(Number(withdrawFundsPct || "0") * 100))];
      if (withdrawArgs.every((bps) => bps === 0n)) return;
      if (withdrawArgs.some((bps) => bps > 10_000n)) {
        setError(t("vaultDetail.errPctOver100"));
        return;
      }
      await withTx(t("vaultDetail.txWithdrawing"), () =>
        writeContractAsync({ address, abi: vaultAbi, functionName: "withdraw", args: withdrawArgs, chainId: chain.id }),
      );
      setWithdrawPositionPct("0");
      setWithdrawFundsPct("0");
      return;
    }

    // Compound (V3): 4 independent buckets + feeSwapIx (fix #4's reinject
    // sizing when autoCompoundFees is on) + payoutSwapIx (feature 5(b), the
    // "todo en {stable}" checkbox). feeSwapIx defaults to a no-op — the
    // contract still folds fees back into the remaining position correctly
    // without it (confirmed in RangeVaultArbCompoundV3.t.sol), just without
    // ratio-matching optimization.
    const investableShareBps = BigInt(withdrawInvestableShareBps);
    const reserveShareBps = BigInt(withdrawReserveShareBps);
    const gasReserveShareBps = BigInt(withdrawGasReserveShareBps);
    if (
      positionShareBps === 0n && investableShareBps === 0n && reserveShareBps === 0n && gasReserveShareBps === 0n
    ) {
      return;
    }
    if ([positionShareBps, investableShareBps, reserveShareBps, gasReserveShareBps].some((bps) => bps > 10_000n)) {
      setError(t("vaultDetail.errPctOver100"));
      return;
    }

    const noSwap = { token0ToToken1: true, amountIn: 0n, amountOutMinimum: 0n, fee: feeTier };
    let payoutSwapIx = noSwap;
    if (withdrawConvertToStable && positionShareBps > 0n && positionTicks && positionLiquidity !== undefined && positionTokensOwedLive && currentTick !== undefined) {
      // Client-side estimate, same pattern as sizeRebalanceSwap elsewhere in
      // this file — not a simulate-then-execute round trip. Under-sizing
      // (leaving some volatile dust unconverted) degrades gracefully;
      // over-sizing would revert the whole withdraw, so a 1% safety haircut
      // guards against estimation drift between this read and the tx landing.
      const { amount0Raw, amount1Raw } = estimatePositionAmounts({
        liquidity: positionLiquidity,
        currentTick,
        tickLower: positionTicks.tickLower,
        tickUpper: positionTicks.tickUpper,
      });
      const total0 = amount0Raw + Number(positionTokensOwedLive.tokensOwed0);
      const total1 = amount1Raw + Number(positionTokensOwedLive.tokensOwed1);
      const shareFraction = withdrawPositionShareBps / 10_000;
      const volatileRawEstimate = Math.floor((stableIsToken0 ? total1 : total0) * shareFraction * 0.99);
      if (volatileRawEstimate > 0) {
        payoutSwapIx = {
          token0ToToken1: !stableIsToken0,
          amountIn: BigInt(volatileRawEstimate),
          amountOutMinimum: 0n,
          fee: feeTier,
        };
      }
    }

    await withTx(t("vaultDetail.txWithdrawing"), () =>
      writeContractAsync({
        address,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [positionShareBps, investableShareBps, reserveShareBps, gasReserveShareBps, noSwap, payoutSwapIx, 0n, 0n],
        chainId: chain.id,
      }),
    );
    setWithdrawPositionPct("0");
    setWithdrawFundsPct("0");
    setWithdrawInvestableAmount("0");
    setWithdrawReserveAmount("0");
    setWithdrawGasReserveAmount("0");
    setWithdrawConvertToStable(false);
  }

  // Owner-only switch — sits right under the "view on Uniswap" link in
  // PositionNFT's own card instead of up in the page header, so it's next to
  // the position's own external links rather than competing with status
  // badges. Non-owners still get the plain read-only badge up in the eyebrow
  // row (see isCompound && !isOwner above) — never this interactive control.
  const compoundToggle = isCompound && isOwner && (
    <button
      type="button"
      onClick={handleToggleAutoCompound}
      disabled={Boolean(busy)}
      title={t("vaultDetail.autoCompoundToggleHint")}
      className={
        autoCompoundFees
          ? "mt-3 flex w-full items-center justify-center gap-3 rounded-full border-2 border-accent-fill-border bg-accent-fill-bg px-4 py-3 font-mono text-sm font-semibold uppercase tracking-[0.1em] text-accent-fill-text shadow-[0_0_20px_-4px_var(--accent-shadow)] transition-transform hover:scale-[1.02] disabled:opacity-50 disabled:hover:scale-100"
          : "mt-3 flex w-full items-center justify-center gap-3 rounded-full border-2 border-foreground/25 px-4 py-3 font-mono text-sm font-semibold uppercase tracking-[0.1em] text-foreground/80 transition-colors hover:border-accent hover:text-accent-text disabled:opacity-50"
      }
    >
      <span
        className={
          autoCompoundFees
            ? "relative h-6 w-11 shrink-0 rounded-full bg-accent-fill-text/30 transition-colors"
            : "relative h-6 w-11 shrink-0 rounded-full bg-foreground/15 transition-colors"
        }
      >
        <span
          className={
            autoCompoundFees
              ? "absolute top-0.5 left-[1.4rem] h-5 w-5 rounded-full bg-accent-fill-text transition-all"
              : "absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-foreground transition-all"
          }
        />
      </span>
      {autoCompoundFees ? t("vaultDetail.compoundBadgeOn") : t("vaultDetail.compoundBadgeOff")}
    </button>
  );

  // Estimated withdrawal preview — uses the LIVE accrued-fee estimate
  // (positionTokensOwedLive) rather than the position's own possibly-stale
  // tokensOwed0/1, same reasoning as collectPreview below.
  const withdrawPositionShareBps = Math.min(10_000, Math.max(0, Math.round((Number(withdrawPositionPct) || 0) * 100)));
  const withdrawFundsShareBps = Math.min(10_000, Math.max(0, Math.round((Number(withdrawFundsPct) || 0) * 100)));
  // Each bucket's real balance, in human units — shown as "Disponible" next
  // to its own input, and used to convert the typed amount back into the
  // bps withdraw() actually needs. >= available (rather than an exact
  // equality check) both handles the "Máx." quick button landing on bps
  // 10_000 despite float rounding, and clamps a manually-typed overshoot to
  // "withdraw everything" instead of silently doing nothing.
  const investableAvailable = Number(formatUnits((investableUsdt as bigint) ?? 0n, stableDecimals));
  const reserveAvailable = Number(formatUnits((reserveBalance as bigint) ?? 0n, stableDecimals));
  const gasReserveAvailable = Number(formatUnits(gasReserveBalance, stableDecimals));
  const amountToBps = (amount: string, available: number): number => {
    const n = Number(amount) || 0;
    if (n <= 0 || available <= 0) return 0;
    if (n >= available) return 10_000;
    return Math.min(10_000, Math.max(0, Math.round((n / available) * 10_000)));
  };
  const withdrawInvestableShareBps = amountToBps(withdrawInvestableAmount, investableAvailable);
  const withdrawReserveShareBps = amountToBps(withdrawReserveAmount, reserveAvailable);
  const withdrawGasReserveShareBps = amountToBps(withdrawGasReserveAmount, gasReserveAvailable);
  // Inverse of amountToBps, for the quick-pick buttons — LightPctQuickButtons
  // still emits a plain "25"/"50"/"75"/"100" pct string, this turns that into
  // an actual amount of the given bucket's own available balance. toFixed(6)
  // then round-tripped through Number strips trailing zeros (e.g. "12.5"
  // instead of "12.500000") without losing USDC's own 6-decimal precision.
  const amountFromPct = (pct: string, available: number): string => String(Number(((available * (Number(pct) || 0)) / 100).toFixed(6)));
  // A1 — current live value of the position (principal only, no uncollected
  // fees), same formula PositionNFT.tsx uses for its own "$XX.XX" display —
  // duplicated here rather than shared since that component re-derives it
  // from its own reads. Used for the "Valor de la posición" stat below.
  const a1Usd =
    positionTicks && positionLiquidity !== undefined && currentTick !== undefined
      ? (() => {
          const { amount0Raw, amount1Raw } = estimatePositionAmounts({
            liquidity: positionLiquidity,
            currentTick,
            tickLower: positionTicks.tickLower,
            tickUpper: positionTicks.tickUpper,
          });
          const stableRaw = stableIsToken0 ? amount0Raw : amount1Raw;
          const volatileRaw = stableIsToken0 ? amount1Raw : amount0Raw;
          const ethPrice = ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals);
          return stableRaw * 10 ** -stableDecimals + volatileRaw * 10 ** -volatileDecimals * ethPrice;
        })()
      : undefined;
  const withdrawPreview =
    positionTicks && positionLiquidity !== undefined && positionTokensOwedLive && currentTick !== undefined
      ? (() => {
          const { amount0Raw, amount1Raw } = estimatePositionAmounts({
            liquidity: positionLiquidity,
            currentTick,
            tickLower: positionTicks.tickLower,
            tickUpper: positionTicks.tickUpper,
          });
          const total0 = amount0Raw + Number(positionTokensOwedLive.tokensOwed0);
          const total1 = amount1Raw + Number(positionTokensOwedLive.tokensOwed1);
          const shareFraction = withdrawPositionShareBps / 10_000;
          const positionStableRaw = (stableIsToken0 ? total0 : total1) * shareFraction;
          const positionVolatileRaw = (stableIsToken0 ? total1 : total0) * shareFraction;
          const investableUsdtNum = Number((investableUsdt as bigint) ?? 0n);
          const reserveBalanceNum = Number((reserveBalance as bigint) ?? 0n);
          const gasReserveBalanceNum = Number(gasReserveBalance);
          // Standard vaults: one combined bucket. Compound vaults: 3
          // independent buckets, each previewed against its own bps.
          const fundsStableRaw = isCompound
            ? investableUsdtNum * (withdrawInvestableShareBps / 10_000)
            : (investableUsdtNum + reserveBalanceNum) * (withdrawFundsShareBps / 10_000);
          const reserveStableRaw = isCompound ? reserveBalanceNum * (withdrawReserveShareBps / 10_000) : 0;
          const gasReserveStableRaw = isCompound ? gasReserveBalanceNum * (withdrawGasReserveShareBps / 10_000) : 0;
          return {
            positionStable: positionStableRaw * 10 ** -stableDecimals,
            positionVolatile: positionVolatileRaw * 10 ** -volatileDecimals,
            fundsStable: fundsStableRaw * 10 ** -stableDecimals,
            reserveStable: reserveStableRaw * 10 ** -stableDecimals,
            gasReserveStable: gasReserveStableRaw * 10 ** -stableDecimals,
          };
        })()
      : undefined;

  // Currently accrued, uncollected fees — same live estimate as withdrawPreview
  // above, shown in the "Cobrar comisiones" review step.
  const collectPreview = positionTokensOwedLive
    ? {
        stable:
          Number(stableIsToken0 ? positionTokensOwedLive.tokensOwed0 : positionTokensOwedLive.tokensOwed1) *
          10 ** -stableDecimals,
        volatile:
          Number(stableIsToken0 ? positionTokensOwedLive.tokensOwed1 : positionTokensOwedLive.tokensOwed0) *
          10 ** -volatileDecimals,
      }
    : undefined;

  return (
    <>
      {capAlert && (
        <AlertModal title={t("vaultDetail.capAlertTitle")} message={capAlert} onClose={() => setCapAlert(null)} />
      )}
      {manageModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4">
          {/* Solid, LIGHT background (the palette's accent-soft pale yellow,
              #fff7a8 — already defined in globals.css) with dark text
              throughout, rather than a dark panel — two stacked dark
              surfaces (this modal + the dark page behind it) were hard to
              tell apart even fully opaque. Every class below is a
              deliberate dark-on-light override of this file's usual
              light-on-dark ones. */}
          {/* max-h + overflow-y-auto: the withdraw modal's 4 independent
              fields (compound vaults) can run taller than the viewport —
              without this the modal's own header (title + close ✕) got
              pushed off-screen with no way to scroll back up to it.
              Sticky header keeps ✕ reachable at every scroll position. */}
          <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-2xl bg-accent-soft shadow-2xl shadow-black/60">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-2xl bg-accent-soft px-6 pt-6 sm:px-8 sm:pt-8">
              <h3 className="text-xl font-semibold tracking-tight text-[#050505]" style={{ fontFamily: "var(--font-display)" }}>
                {manageModal === "add"
                  ? t("vaultDetail.addLiquidityTitle")
                  : manageModal === "remove"
                    ? t("vaultDetail.removeLiquidityTitle")
                    : manageModal === "collect"
                      ? t("vaultDetail.collectFeesTitle")
                      : t("vaultDetail.deposit")}
              </h3>
              <button
                onClick={() => setManageModal(null)}
                aria-label={t("vaultDetail.withdrawReviewCancel")}
                className="rounded-full p-1 text-black/50 transition-colors hover:bg-black/10 hover:text-black"
              >
                ✕
              </button>
            </div>
            <div className="overflow-y-auto px-6 pb-6 sm:px-8 sm:pb-8">

            {/* ---- Agregar liquidez ---- */}
            {manageModal === "add" && manageStep === "input" && (
              <>
                <p className="mt-1 text-sm text-black/60">{t("vaultDetail.increasePositionHint")}</p>
                <div className="mt-5">
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-black/60">{t("vaultDetail.fieldAmountSymbol", { symbol: increaseTokenMeta.displaySymbol })}</span>
                    {isCompound && (
                      <DepositTokenSelector
                        size="mini"
                        variant="light"
                        tokens={depositTokenOptions}
                        selected={increaseDepositToken}
                        onSelect={setIncreaseDepositToken}
                        balances={depositTokenBalancesUsd}
                      />
                    )}
                    <input
                      className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                      value={increaseAmount}
                      onChange={(e) => setIncreaseAmount(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                </div>
                {increaseInsufficient && (
                  <p className="mt-2 text-sm text-red-700">
                    {t("vaultDetail.insufficientBalanceMsg", {
                      symbol: increaseTokenMeta.displaySymbol,
                      total: (parseFloat(increaseAmount) || 0).toFixed(2),
                      balance: (balanceFor(increaseDepositToken) ?? 0).toFixed(2),
                    })}
                  </p>
                )}
                {!increaseInsufficient && increaseQuoteLoading && (
                  <p className="mt-2 text-sm text-black/50">{t("vaultDetail.quoteLoadingMsg")}</p>
                )}
                {!increaseInsufficient && increaseQuoteErrored && (
                  <p className="mt-2 text-sm text-red-700">
                    {t("vaultDetail.quoteErrorMsg", { symbol: increaseTokenMeta.displaySymbol })}
                  </p>
                )}
                <button
                  onClick={() => setManageStep("review")}
                  disabled={(Number(increaseAmount) || 0) <= 0 || increaseInsufficient || increaseQuoteLoading || increaseQuoteErrored}
                  className="mt-6 w-full rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {t("vaultDetail.reviewButton")}
                </button>
              </>
            )}
            {manageModal === "add" && manageStep === "review" && (
              <>
                <div className="mt-5 rounded-xl border border-black/10 bg-black/5 p-4 text-sm">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                    {t("vaultDetail.addLiquidityAmount")}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[#050505]">
                    {increaseAmount} {increaseTokenMeta.displaySymbol}
                  </p>
                  <p className="mt-2 text-xs text-black/60">{t("vaultDetail.addLiquidityNote")}</p>
                </div>
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={() => setManageStep("input")}
                    className="flex-1 rounded-full border border-black/25 py-2.5 font-medium text-[#050505] transition-colors hover:bg-black/5"
                  >
                    {t("vaultDetail.backButton")}
                  </button>
                  <button
                    onClick={() => {
                      setManageModal(null);
                      handleIncreasePosition();
                    }}
                    disabled={Boolean(busy)}
                    className="flex-1 rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {t("vaultDetail.withdrawReviewConfirm")}
                  </button>
                </div>
              </>
            )}

            {/* ---- Eliminar liquidez ---- */}
            {manageModal === "remove" && manageStep === "input" && (
              <>
                <p className="mt-1 text-sm text-black/60">{t("vaultDetail.partialWithdrawHint")}</p>
                <div className="mt-5 flex flex-col gap-4">
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-black/60">{t("vaultDetail.fieldPositionPct")}</span>
                    <input
                      className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                      value={withdrawPositionPct}
                      onChange={(e) => setWithdrawPositionPct(e.target.value)}
                      inputMode="decimal"
                    />
                    <LightPctQuickButtons onPick={setWithdrawPositionPct} />
                  </div>
                  {isCompound ? (
                    // 2-column grid instead of stacking all 3 — 4 fields
                    // fully stacked (position + 3 more, each with its own
                    // row of quick-pick buttons) pushed the modal's own
                    // header off-screen with no way to scroll back up to
                    // the close button. See the modal wrapper's own comment
                    // above for the scroll/sticky-header half of that fix.
                    <div className="grid grid-cols-2 gap-x-3 gap-y-4">
                      {/* Once a position exists, investableUsdt can only ever
                          hold transient dust (fix #3 blocks depositing into
                          it directly anymore — see investableUseIncreaseInstead
                          above) that a later sweep/rebalance folds into the
                          position on its own. Showing an input that's almost
                          always "Disponible: 0.000000" is dead-end clutter —
                          only render it when there's actually something to
                          withdraw. */}
                      {investableAvailable > 0 && (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs text-black/60">{t("vaultDetail.fieldInvestableAmount")}</span>
                            <span className="font-mono text-[11px] text-black/40">
                              {t("vaultDetail.availableBalance", { amount: investableAvailable.toFixed(6), symbol: stableSymbol })}
                            </span>
                          </div>
                          <input
                            className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                            value={withdrawInvestableAmount}
                            onChange={(e) => setWithdrawInvestableAmount(e.target.value)}
                            inputMode="decimal"
                          />
                          <LightPctQuickButtons
                            onPick={(pct) => setWithdrawInvestableAmount(amountFromPct(pct, investableAvailable))}
                          />
                        </div>
                      )}
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs text-black/60">{t("vaultDetail.fieldReserveAmount")}</span>
                          <span className="font-mono text-[11px] text-black/40">
                            {t("vaultDetail.availableBalance", { amount: reserveAvailable.toFixed(6), symbol: stableSymbol })}
                          </span>
                        </div>
                        <input
                          className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                          value={withdrawReserveAmount}
                          onChange={(e) => setWithdrawReserveAmount(e.target.value)}
                          inputMode="decimal"
                        />
                        <LightPctQuickButtons
                          onPick={(pct) => setWithdrawReserveAmount(amountFromPct(pct, reserveAvailable))}
                        />
                      </div>
                      {chain.supportsGasReserve && (
                        <div className="flex flex-col gap-1.5">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-xs text-black/60">{t("vaultDetail.fieldGasReserveAmount")}</span>
                            <span className="font-mono text-[11px] text-black/40">
                              {t("vaultDetail.availableBalance", { amount: gasReserveAvailable.toFixed(6), symbol: stableSymbol })}
                            </span>
                          </div>
                          <input
                            className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                            value={withdrawGasReserveAmount}
                            onChange={(e) => setWithdrawGasReserveAmount(e.target.value)}
                            inputMode="decimal"
                          />
                          <LightPctQuickButtons
                            onPick={(pct) => setWithdrawGasReserveAmount(amountFromPct(pct, gasReserveAvailable))}
                          />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs text-black/60">{t("vaultDetail.fieldIdleFundsPct")}</span>
                      <input
                        className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                        value={withdrawFundsPct}
                        onChange={(e) => setWithdrawFundsPct(e.target.value)}
                        inputMode="decimal"
                      />
                      <LightPctQuickButtons onPick={setWithdrawFundsPct} />
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (isCompound) {
                      const positionPct = Number(withdrawPositionPct) || 0;
                      const investableAmt = Number(withdrawInvestableAmount) || 0;
                      const reserveAmt = Number(withdrawReserveAmount) || 0;
                      const gasReserveAmt = Number(withdrawGasReserveAmount) || 0;
                      if (positionPct === 0 && investableAmt === 0 && reserveAmt === 0 && gasReserveAmt === 0) return;
                      if (positionPct > 100) {
                        setError(t("vaultDetail.errPctOver100"));
                        return;
                      }
                      if (investableAmt > investableAvailable || reserveAmt > reserveAvailable || gasReserveAmt > gasReserveAvailable) {
                        setError(t("vaultDetail.errAmountOverAvailable"));
                        return;
                      }
                    } else {
                      const pctFields = [withdrawPositionPct, withdrawFundsPct];
                      if (pctFields.every((pct) => (Number(pct) || 0) === 0)) return;
                      if (pctFields.some((pct) => (Number(pct) || 0) > 100)) {
                        setError(t("vaultDetail.errPctOver100"));
                        return;
                      }
                    }
                    setManageStep("review");
                  }}
                  className="mt-6 w-full rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {t("vaultDetail.reviewButton")}
                </button>
              </>
            )}
            {manageModal === "remove" && manageStep === "review" && (
              <>
                <div className="mt-5 flex flex-col gap-4 text-sm">
                  {withdrawPositionShareBps > 0 && (
                    <div className="rounded-xl border border-black/10 bg-black/5 p-4">
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                        {t("vaultDetail.withdrawReviewPosition", { pct: withdrawPositionPct })}
                      </p>
                      {withdrawConvertToStable ? (
                        // Estimated post-conversion total — everything folded
                        // into {stable} at the live price, same formula a1Usd
                        // above already uses. Real on-chain result can differ
                        // slightly (execution-time price, actual swap slippage).
                        <p className="mt-1 text-lg font-semibold text-[#050505]">
                          {withdrawPreview && currentTick !== undefined
                            ? (
                                withdrawPreview.positionStable +
                                withdrawPreview.positionVolatile *
                                  ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals)
                              ).toFixed(2)
                            : "—"}{" "}
                          {stableSymbol}
                        </p>
                      ) : (
                        <>
                          <p className="mt-1 text-lg font-semibold text-[#050505]">
                            {withdrawPreview ? withdrawPreview.positionVolatile.toFixed(6) : "—"} {volatileSymbol}
                          </p>
                          <p className="text-lg font-semibold text-[#050505]">
                            {withdrawPreview ? withdrawPreview.positionStable.toFixed(2) : "—"} {stableSymbol}
                          </p>
                        </>
                      )}
                      <p className="mt-2 text-xs text-black/60">
                        {withdrawConvertToStable
                          ? t("vaultDetail.withdrawReviewFeesNoteConverted")
                          : t("vaultDetail.withdrawReviewFeesNote")}
                      </p>
                    </div>
                  )}
                  {isCompound && withdrawPositionShareBps > 0 && (
                    <button
                      type="button"
                      onClick={() => setWithdrawConvertToStable((v) => !v)}
                      className={
                        withdrawConvertToStable
                          ? "flex w-full items-center justify-center gap-2 rounded-full border-2 border-[#050505] bg-[#050505] px-4 py-2.5 text-sm font-semibold text-accent-soft transition-opacity hover:opacity-90"
                          : "flex w-full items-center justify-center gap-2 rounded-full border border-black/25 px-4 py-2.5 text-sm font-medium text-[#050505] transition-colors hover:bg-black/5"
                      }
                    >
                      {t("vaultDetail.withdrawConvertToStable", { symbol: stableSymbol })}
                    </button>
                  )}
                  {isCompound ? (
                    <>
                      {withdrawInvestableShareBps > 0 && (
                        <div className="rounded-xl border border-black/10 bg-black/5 p-4">
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                            {t("vaultDetail.withdrawReviewInvestable", { pct: (withdrawInvestableShareBps / 100).toFixed(1) })}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-[#050505]">
                            {withdrawPreview ? withdrawPreview.fundsStable.toFixed(2) : "—"} {stableSymbol}
                          </p>
                        </div>
                      )}
                      {withdrawReserveShareBps > 0 && (
                        <div className="rounded-xl border border-black/10 bg-black/5 p-4">
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                            {t("vaultDetail.withdrawReviewReserve", { pct: (withdrawReserveShareBps / 100).toFixed(1) })}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-[#050505]">
                            {withdrawPreview ? withdrawPreview.reserveStable.toFixed(2) : "—"} {stableSymbol}
                          </p>
                        </div>
                      )}
                      {withdrawGasReserveShareBps > 0 && (
                        <div className="rounded-xl border border-black/10 bg-black/5 p-4">
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                            {t("vaultDetail.withdrawReviewGasReserve", { pct: (withdrawGasReserveShareBps / 100).toFixed(1) })}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-[#050505]">
                            {withdrawPreview ? withdrawPreview.gasReserveStable.toFixed(2) : "—"} {stableSymbol}
                          </p>
                        </div>
                      )}
                    </>
                  ) : (
                    withdrawFundsShareBps > 0 && (
                      <div className="rounded-xl border border-black/10 bg-black/5 p-4">
                        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                          {t("vaultDetail.withdrawReviewFunds", { pct: withdrawFundsPct })}
                        </p>
                        <p className="mt-1 text-lg font-semibold text-[#050505]">
                          {withdrawPreview ? withdrawPreview.fundsStable.toFixed(2) : "—"} {stableSymbol}
                        </p>
                      </div>
                    )
                  )}
                </div>
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={() => setManageStep("input")}
                    className="flex-1 rounded-full border border-black/25 py-2.5 font-medium text-[#050505] transition-colors hover:bg-black/5"
                  >
                    {t("vaultDetail.backButton")}
                  </button>
                  <button
                    onClick={() => {
                      setManageModal(null);
                      handlePartialWithdraw();
                    }}
                    disabled={Boolean(busy)}
                    className="flex-1 rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {t("vaultDetail.withdrawReviewConfirm")}
                  </button>
                </div>
              </>
            )}

            {/* ---- Cobrar comisiones (review only, nothing to input) ---- */}
            {manageModal === "collect" && (
              <>
                <div className="mt-5 rounded-xl border border-black/10 bg-black/5 p-4 text-sm">
                  <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-black/50">
                    {t("vaultDetail.collectFeesReviewLabel")}
                  </p>
                  {isCompound && !autoCompoundFees && collectConvertToStable ? (
                    <p className="mt-1 text-lg font-semibold text-[#050505]">
                      {collectPreview && currentTick !== undefined
                        ? (
                            collectPreview.stable +
                            collectPreview.volatile *
                              ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals)
                          ).toFixed(2)
                        : "—"}{" "}
                      {stableSymbol}
                    </p>
                  ) : (
                    <>
                      <p className="mt-1 text-lg font-semibold text-[#050505]">
                        {collectPreview ? collectPreview.volatile.toFixed(6) : "—"} {volatileSymbol}
                      </p>
                      <p className="text-lg font-semibold text-[#050505]">
                        {collectPreview ? collectPreview.stable.toFixed(2) : "—"} {stableSymbol}
                      </p>
                    </>
                  )}
                  <p className="mt-2 text-xs text-black/60">
                    {isCompound && autoCompoundFees
                      ? t("vaultDetail.collectFeesTooltipCompoundOn")
                      : isCompound && collectConvertToStable
                        ? t("vaultDetail.withdrawReviewFeesNoteConverted")
                        : t("vaultDetail.withdrawReviewFeesNote")}
                  </p>
                </div>
                {isCompound && !autoCompoundFees && (
                  <button
                    type="button"
                    onClick={() => setCollectConvertToStable((v) => !v)}
                    className={
                      collectConvertToStable
                        ? "mt-4 flex w-full items-center justify-center gap-2 rounded-full border-2 border-[#050505] bg-[#050505] px-4 py-2.5 text-sm font-semibold text-accent-soft transition-opacity hover:opacity-90"
                        : "mt-4 flex w-full items-center justify-center gap-2 rounded-full border border-black/25 px-4 py-2.5 text-sm font-medium text-[#050505] transition-colors hover:bg-black/5"
                    }
                  >
                    {t("vaultDetail.withdrawConvertToStable", { symbol: stableSymbol })}
                  </button>
                )}
                <div className="mt-6 flex gap-3">
                  <button
                    onClick={() => setManageModal(null)}
                    className="flex-1 rounded-full border border-black/25 py-2.5 font-medium text-[#050505] transition-colors hover:bg-black/5"
                  >
                    {t("vaultDetail.withdrawReviewCancel")}
                  </button>
                  <button
                    onClick={() => {
                      setManageModal(null);
                      handleCollectFees();
                    }}
                    disabled={Boolean(busy)}
                    className="flex-1 rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {t("vaultDetail.withdrawReviewConfirm")}
                  </button>
                </div>
              </>
            )}

            {/* ---- Depositar (invertible / reserva / gas), single step —
                same fields/validation the inline card used to have, now
                just relocated behind a button. */}
            {manageModal === "deposit" && (
              <>
                <p className="mt-1 text-sm text-black/60">
                  {t("vaultDetail.depositLabel", { symbol: stableSymbol })}
                </p>
                {pendingCreationFee > 0n && (
                  <p className="mt-1 text-xs text-black/50">
                    {t("vaultDetail.pendingFeeNote", {
                      fee: formatUnits(pendingCreationFee, stableDecimals),
                      symbol: stableSymbol,
                    })}
                  </p>
                )}
                {maxDepositUsd > 0n && (
                  <p className="mt-1 text-xs text-black/50">
                    {t("vaultDetail.platformCapNote", {
                      cap: formatUnits(maxDepositUsd, stableDecimals),
                      symbol: stableSymbol,
                      room: formatUnits(
                        maxDepositUsd >
                          ((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance
                          ? maxDepositUsd -
                              (((investableUsdt as bigint) ?? 0n) + ((reserveBalance as bigint) ?? 0n) + gasReserveBalance)
                          : 0n,
                        stableDecimals,
                      ),
                    })}
                  </p>
                )}
                {isCompound && <span className="mt-3 block text-xs text-black/60">{t("vaultDetail.depositTokenLabel")}</span>}
                <div className="mt-2 flex flex-col gap-4">
                  {hasPosition ? (
                    // Once a position exists, capital meant for the position
                    // goes through "Sumar a la posición abierta" instead —
                    // see prevHasPositionForDeposit's own comment above for
                    // why (a Deposited event here would sit uncounted toward
                    // B1 until a later fold-in, while PositionIncreased
                    // always counts immediately).
                    <p className="rounded-xl border border-black/15 bg-white/40 px-3 py-2.5 text-xs text-black/60">
                      {t("vaultDetail.investableUseIncreaseInstead")}
                    </p>
                  ) : (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-black/60">{t("vaultDetail.fieldInvestable")}</span>
                      {isCompound && (
                        <DepositTokenSelector
                          size="mini"
                          variant="light"
                          tokens={depositTokenOptions}
                          selected={investDepositToken}
                          onSelect={setInvestDepositToken}
                          balances={depositTokenBalancesUsd}
                        />
                      )}
                      <input
                        className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                        value={depInvestable}
                        onChange={(e) => setDepInvestable(e.target.value)}
                        inputMode="decimal"
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1.5">
                    <span className="text-xs text-black/60">{t("vaultDetail.fieldReserve")}</span>
                    {isCompound && (
                      <DepositTokenSelector
                        size="mini"
                        variant="light"
                        tokens={depositTokenOptions}
                        selected={reserveDepositToken}
                        onSelect={setReserveDepositToken}
                        balances={depositTokenBalancesUsd}
                      />
                    )}
                    <input
                      className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                      value={depReserve}
                      onChange={(e) => setDepReserve(e.target.value)}
                      inputMode="decimal"
                    />
                  </label>
                  {chain.supportsGasReserve && (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs text-black/60">{t("vaultDetail.fieldGasBudget")}</span>
                      {isCompound && (
                        <DepositTokenSelector
                          size="mini"
                          variant="light"
                          tokens={depositTokenOptions}
                          selected={gasReserveDepositToken}
                          onSelect={setGasReserveDepositToken}
                          balances={depositTokenBalancesUsd}
                        />
                      )}
                      <input
                        className="rounded-xl border border-black/15 bg-white/60 px-3 py-2.5 text-[#050505] outline-none focus:border-black/40"
                        value={depGasReserve}
                        onChange={(e) => setDepGasReserve(e.target.value)}
                        inputMode="decimal"
                      />
                    </label>
                  )}
                </div>
                {depositInsufficientDetails.map((d) => (
                  <p key={d.symbol} className="mt-2 text-sm text-red-700">
                    {t("vaultDetail.insufficientBalanceMsg", {
                      symbol: d.symbol,
                      total: d.needed.toFixed(2),
                      balance: d.balance.toFixed(2),
                    })}
                  </p>
                ))}
                {!depositInsufficientBalance && depositQuoteLoading && (
                  <p className="mt-2 text-sm text-black/50">{t("vaultDetail.quoteLoadingMsg")}</p>
                )}
                {!depositInsufficientBalance && depositQuoteErrored && (
                  <p className="mt-2 text-sm text-red-700">
                    {t("vaultDetail.quoteErrorMsg", { symbol: depositQuoteErrored.meta.displaySymbol })}
                  </p>
                )}
                <button
                  onClick={() => {
                    setManageModal(null);
                    handleDepositMore();
                  }}
                  disabled={Boolean(busy) || depositInsufficientBalance || depositQuoteLoading || Boolean(depositQuoteErrored)}
                  className="mt-6 w-full rounded-full bg-[#050505] py-2.5 font-semibold text-accent-soft transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  {t("vaultDetail.deposit")}
                </button>
              </>
            )}
            </div>
          </div>
        </div>
      )}
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">
            {t("vaultDetail.eyebrow", {
              pair: `${stableSymbol}/${volatileSymbol}`,
              fee: feeTier / 10_000,
            })}
          </span>
          {paused ? (
            <span className="eyebrow !border-negative/40 !text-negative">{t("vaultDetail.paused")}</span>
          ) : (
            <span className="eyebrow !border-positive/40 !text-positive">{t("vaultDetail.active")}</span>
          )}
          {isCompound && !isOwner && (
            <span className="eyebrow !border-accent/40 !text-accent-text">
              {autoCompoundFees ? t("vaultDetail.compoundBadgeOn") : t("vaultDetail.compoundBadgeOff")}
            </span>
          )}
          {hasPosition ? (
            <span className="eyebrow !border-accent/40 !text-accent-text">
              {t("vaultDetail.positionLabel", { id: String(positionTokenId) })}
            </span>
          ) : (
            <span className="eyebrow">{t("vaultDetail.noPositionYet")}</span>
          )}
        </div>

        <h1 className="mt-5 break-all font-mono text-lg text-foreground/90 sm:text-xl">{address}</h1>
        <p className="mt-2 text-sm text-muted">
          {isOwner ? t("vaultDetail.ownerNote") : t("vaultDetail.readOnlyNote")}
        </p>

        {rebalanceAlert && (
          <div className="glass mt-6 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">{t("vaultDetail.rebalanceFailedTitle")}</p>
            <p className="mt-1 text-xs text-negative/80">{rebalanceAlert.message}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-negative/60">
              {new Date(rebalanceAlert.createdAt).toLocaleString()}
            </p>
          </div>
        )}

        {gasReserveAlert && (
          <div className="glass mt-6 rounded-2xl border-negative/40 bg-negative/[0.06] p-5">
            <p className="text-sm font-medium text-negative">{t("vaultDetail.gasReserveDepletedTitle")}</p>
            <p className="mt-1 text-xs text-negative/80">{t("vaultDetail.gasReserveDepletedBody")}</p>
            <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-negative/60">
              {t("vaultDetail.gasReserveDepletedSince", { date: new Date(gasReserveAlert.createdAt).toLocaleString() })}
            </p>
          </div>
        )}

        {!data && (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">{t("vaultDetail.loading")}</p>
          </div>
        )}

        {data && (
          <>
            {/* Stats */}
            <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              <VaultAgeStat createdAt={createdAt} />
              <Stat
                label={t("vaultDetail.statPositionValue")}
                value={a1Usd !== undefined ? `$${a1Usd.toFixed(2)}` : "—"}
                accent
              />
              <Stat
                label={t("vaultDetail.statInvested")}
                value={cumulativeInvestmentUsd !== undefined ? `$${cumulativeInvestmentUsd.toFixed(2)}` : "—"}
                hint={
                  a1Usd !== undefined && cumulativeInvestmentUsd !== undefined && cumulativeInvestmentUsd > 0
                    ? `${a1Usd >= cumulativeInvestmentUsd ? "+" : ""}${(a1Usd - cumulativeInvestmentUsd).toFixed(2)} (${(((a1Usd - cumulativeInvestmentUsd) / cumulativeInvestmentUsd) * 100).toFixed(2)}%)`
                    : undefined
                }
                hintClassName={
                  a1Usd !== undefined && cumulativeInvestmentUsd !== undefined && a1Usd >= cumulativeInvestmentUsd
                    ? "mt-1 text-sm font-semibold text-positive"
                    : "mt-1 text-sm font-semibold text-negative"
                }
              />
              <Stat
                label={t("vaultDetail.statInvestable")}
                value={`${formatUnits((investableUsdt as bigint) ?? 0n, stableDecimals)} ${stableSymbol}`}
                hint={
                  (idleWeth as bigint | undefined) && (idleWeth as bigint) > 0n
                    ? t("vaultDetail.idleWethHint", {
                        amount: Number(formatUnits(idleWeth as bigint, volatileDecimals)).toFixed(6),
                        symbol: volatileSymbol,
                        usdSuffix:
                          currentTick !== undefined
                            ? ` (~$${(Number(idleWeth as bigint) * 10 ** -volatileDecimals * ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals)).toFixed(2)})`
                            : "",
                      })
                    : undefined
                }
              />
              <Stat
                label={t("vaultDetail.statReserve")}
                value={`${formatUnits((reserveBalance as bigint) ?? 0n, stableDecimals)} ${stableSymbol}`}
                hint={t("vaultDetail.reserveHint", {
                  amount: formatUnits((reinjectionAmount as bigint) ?? 0n, stableDecimals),
                  symbol: stableSymbol,
                })}
              />
              {chain.supportsGasReserve && (
                <Stat
                  label={t("vaultDetail.statGasBudget")}
                  value={`${formatUnits(gasReserveBalance, stableDecimals)} ${stableSymbol}`}
                  longHint={t("vaultDetail.gasBudgetHint")}
                  hint2={
                    (feesSummary?.gasReserveAddedRaw ?? 0n) > 0n
                      ? t("vaultDetail.gasBudgetAddedHint", {
                          amount: formatUnits(feesSummary?.gasReserveAddedRaw ?? 0n, stableDecimals),
                          symbol: stableSymbol,
                          count: feesSummary?.gasReserveAddedCount ?? 0,
                        })
                      : undefined
                  }
                />
              )}
              {chain.supportsGasReserve && (
                <Stat
                  label={t("vaultDetail.statGasSpent")}
                  value={`$${Number(formatUnits(feesSummary?.gasReimbursedUsdRaw ?? 0n, stableDecimals)).toFixed(4)}`}
                  hint={t("vaultDetail.gasSpentHint", { count: feesSummary?.gasReimbursedCount ?? 0 })}
                  longHint={t("vaultDetail.gasSpentLongHint")}
                  hint2={
                    (feesSummary?.gasReimbursedCount ?? 0) > 0
                      ? t("vaultDetail.gasSpentAvgHint", {
                          amount: (
                            Number(formatUnits(feesSummary?.gasReimbursedUsdRaw ?? 0n, stableDecimals)) /
                            (feesSummary?.gasReimbursedCount ?? 1)
                          ).toFixed(4),
                        })
                      : undefined
                  }
                />
              )}
              {chain.supportsGasReserve && (
                <Stat
                  label={t("vaultDetail.statNetOperatingProfit")}
                  value={
                    netOperatingProfitPct !== undefined
                      ? `${netOperatingProfitPct >= 0 ? "+" : ""}${netOperatingProfitPct.toFixed(2)}%`
                      : "—"
                  }
                  valueClassName={`mt-1.5 text-base font-semibold tabular-nums ${(netOperatingProfitPct ?? 0) >= 0 ? "text-positive" : "text-negative"}`}
                  longHint={t("vaultDetail.netOperatingProfitHint")}
                  hint2={netOperatingProfitUsd !== undefined ? `$${netOperatingProfitUsd.toFixed(2)}` : undefined}
                  hint2ClassName="mt-1 text-xs text-faint"
                />
              )}
              <Stat
                label={t("vaultDetail.statRebalances")}
                value={`${rebalanceCount ?? 0} / ${maxRebalances ?? 0}`}
                accent
              />
              <Stat
                label={t("vaultDetail.statFees")}
                value={
                  feesUsdTotal !== undefined ? `$${feesUsdTotal.toFixed(2)}` : `${feesUsdtStr} ${stableSymbol}`
                }
                hint={
                  feesWethRaw > 0n
                    ? `${feesUsdtStr} ${stableSymbol} + ${feesWethStr} ${volatileSymbol}`
                    : `${feesUsdtStr} ${stableSymbol}`
                }
                hintClassName="mt-1 text-sm font-semibold text-positive"
                hint2={rentLabel}
                hint2ClassName="mt-1 font-mono text-base font-bold text-accent-text"
                accent
              />
              {isCompound && (
                <Stat
                  label={t("vaultDetail.statFeesReinjected")}
                  value={`$${reinjectedUsd.toFixed(2)}`}
                  hint={
                    feesSummary?.reinjectionCount
                      ? t("vaultDetail.statFeesReinjectedHint", { count: feesSummary.reinjectionCount })
                      : undefined
                  }
                />
              )}
            </div>

            {hasPosition && (
              <PositionNFT
                tokenId={positionTokenId as bigint}
                chain={chain}
                pool={poolAddress}
                belowUniswapLink={compoundToggle}
                investedUsd={cumulativeInvestmentUsd}
              />
            )}

            {/* Uniswap-style liquidity actions, right under the position's own
                range card (PositionNFT above already shows "Rango de precio")
                — each opens its own modal (input, then review) instead of
                living inline in the page. Owner-only, same gating every
                write action in this file already uses. "Depositar" doesn't
                need an open position (it's how a vault gets its first one),
                so it's always shown for the owner while add/remove/collect
                stay gated on hasPosition. */}
            {isOwner && (
              <div className="mt-4 flex flex-wrap justify-center gap-3">
                {hasPosition && (
                  <>
                    <button
                      onClick={() => {
                        setManageModal("add");
                        setManageStep("input");
                      }}
                      disabled={Boolean(busy)}
                      className="btn-secondary !border-[var(--accent-glow-border)] !bg-[var(--accent-glow-bg)] !text-accent-text"
                    >
                      {t("vaultDetail.addLiquidityTitle")}
                    </button>
                    <button
                      onClick={() => {
                        setManageModal("remove");
                        setManageStep("input");
                      }}
                      disabled={Boolean(busy)}
                      className="btn-secondary !border-[var(--accent-glow-border)] !bg-[var(--accent-glow-bg)] !text-accent-text"
                    >
                      {t("vaultDetail.removeLiquidityTitle")}
                    </button>
                    <button
                      onClick={() => setManageModal("collect")}
                      disabled={Boolean(busy)}
                      className="btn-secondary !border-[var(--accent-glow-border)] !bg-[var(--accent-glow-bg)] !text-accent-text"
                      title={
                        isCompound && autoCompoundFees
                          ? t("vaultDetail.collectFeesTooltipCompoundOn")
                          : t("vaultDetail.collectFeesTooltipEnabled")
                      }
                    >
                      {t("vaultDetail.collectFeesTitle")}
                    </button>
                    {isCompound && (
                      <button
                        onClick={handleOwnerRebalance}
                        disabled={Boolean(busy)}
                        className="btn-secondary !border-[var(--accent-glow-border)] !bg-[var(--accent-glow-bg)] !text-accent-text"
                        title={t("vaultDetail.ownerRebalanceHint")}
                      >
                        {t("vaultDetail.ownerRebalanceTitle")}
                      </button>
                    )}
                  </>
                )}
                <button
                  onClick={() => setManageModal("deposit")}
                  disabled={Boolean(busy)}
                  className="btn-secondary !border-[var(--accent-glow-border)] !bg-[var(--accent-glow-bg)] !text-accent-text"
                >
                  {t("vaultDetail.deposit")}
                </button>
              </div>
            )}

            {/* "Rango objetivo" (targetTickLower/targetTickUpper) used to have its
                own card here — removed as redundant now that PositionNFT above
                already shows the position's real, live range. targetConfigured/
                targetTickLower/targetTickUpper are still read and used elsewhere
                (the reconfigure form, the inverted-ticks repair check), just no
                longer displayed as their own stat card. */}
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <RebalanceCountdown
                lastRebalanceTimestamp={(lastRebalanceTimestamp as bigint) ?? 0n}
                periodicRebalanceInterval={(periodicRebalanceInterval as bigint) ?? 0n}
                hasPosition={hasPosition}
                paused={Boolean(paused)}
                atRebalanceLimit={Boolean(
                  rebalanceCount !== undefined &&
                    maxRebalances !== undefined &&
                    (rebalanceCount as bigint) >= (maxRebalances as bigint),
                )}
              />

              <div className="glass rounded-2xl p-5">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
                  {t("vaultDetail.operator")}
                </span>
                <p className="mt-2 break-all font-mono text-sm text-foreground/90">{String(operator)}</p>
              </div>
            </div>

            {/* Vault configuration — what was set at create/reconfigure time */}
            <div className="glass mt-4 rounded-2xl p-5">
              <span className="font-mono text-sm uppercase tracking-[0.16em] text-foreground">
                {t("vaultDetail.agentConfigPre")}
                <span className="text-accent-text">{t("vaultDetail.agentConfigHighlight")}</span>
              </span>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <ConfigRow
                  k={t("vaultDetail.configReinjection")}
                  v={`${formatUnits((reinjectionAmount as bigint) ?? 0n, stableDecimals)} ${stableSymbol}`}
                />
                <ConfigRow
                  k={t("vaultDetail.configPeriodic")}
                  v={
                    periodicRebalanceInterval && (periodicRebalanceInterval as bigint) > 0n
                      ? t("vaultDetail.configPeriodicEvery", { hours: Number(periodicRebalanceInterval) / 3600 })
                      : t("vaultDetail.configOff")
                  }
                />
                <ConfigRow
                  k={t("vaultDetail.configCooldown")}
                  v={
                    minRebalanceInterval && (minRebalanceInterval as bigint) > 0n
                      ? `${Number(minRebalanceInterval) / 3600}h`
                      : t("vaultDetail.configNoFloor")
                  }
                />
                <ConfigRow k={t("vaultDetail.configMaxSlippage")} v={`${Number(maxSlippageBps ?? 0n) / 100}%`} />
                <ConfigRow k={t("vaultDetail.configMaxDeviation")} v={`${maxRangeDeviationBps ?? 0} ticks`} />
                <ConfigRow k={t("vaultDetail.configRecenterMargin")} v={`${Number(recenterMarginBps ?? 0n) / 100}%`} />
                <ConfigRow
                  k={t("vaultDetail.configTopMargin")}
                  v={`${Number(exitTopCeilingMarginBps ?? 0n) / 100}%`}
                />
                <ConfigRow k={t("vaultDetail.configMaxRebalances")} v={`${maxRebalances ?? 0}`} />
                {isCompound && (
                  <>
                    <ConfigRow
                      k={t("vaultDetail.configAutoCompound")}
                      v={autoCompoundFees ? t("vaultDetail.configOnValue") : t("vaultDetail.configOffValue")}
                    />
                    <ConfigRow
                      k={t("vaultDetail.configPayoutStableOnly")}
                      v={payoutFeesInStableOnly ? t("vaultDetail.configOnValue") : t("vaultDetail.configOffValue")}
                    />
                    <ConfigRow
                      k={t("vaultDetail.configFeeClaimThreshold")}
                      v={
                        feeClaimThresholdBps && (feeClaimThresholdBps as bigint) > 0n
                          ? `${Number(feeClaimThresholdBps) / 100}%`
                          : t("vaultDetail.configOff")
                      }
                    />
                    <ConfigRow
                      k={t("vaultDetail.configFeeClaimInterval")}
                      v={
                        feeClaimIntervalSeconds && (feeClaimIntervalSeconds as bigint) > 0n ? (
                          <FeeClaimCountdown
                            lastFeeClaimTimestamp={lastFeeClaimTimestamp as bigint | undefined}
                            feeClaimIntervalSeconds={feeClaimIntervalSeconds as bigint | undefined}
                          />
                        ) : (
                          t("vaultDetail.configOff")
                        )
                      }
                    />
                    <ConfigRow
                      k={t("vaultDetail.configLastFeeClaim")}
                      v={
                        lastFeeClaimTimestamp && (lastFeeClaimTimestamp as bigint) > 0n
                          ? new Date(Number(lastFeeClaimTimestamp) * 1000).toLocaleString()
                          : t("vaultDetail.configNever")
                      }
                    />
                    <ConfigRow
                      k={t("vaultDetail.configHardCeiling")}
                      v={
                        hardCeilingEnabled && hardCeilingTick !== undefined
                          ? `${ethPriceFromTick(Number(hardCeilingTick), stableIsToken0, stableDecimals, volatileDecimals).toFixed(2)} ${stableSymbol}`
                          : t("vaultDetail.configOff")
                      }
                    />
                  </>
                )}
              </dl>
            </div>

            {/* Owner actions */}
            {isOwner && (
              <div className="glass mt-10 rounded-2xl p-6 sm:p-8">
                <h2
                  className="text-2xl font-semibold tracking-tight text-foreground"
                  style={{ fontFamily: "var(--font-display)" }}
                >
                  {t("vaultDetail.managementTitle")}
                </h2>
                <p className="mt-1 text-sm text-muted">{t("vaultDetail.managementSubtitle")}</p>

                {/* Depositar (invertible/reserva/gas) moved to its own
                    button + modal above (see manageModal === "deposit"),
                    right next to Agregar/Eliminar liquidez and Cobrar
                    comisiones. */}

                <div className="mt-8">
                  <span className="font-mono text-sm uppercase tracking-[0.14em] text-foreground">
                    {t("vaultDetail.reconfigureLabelPre")}
                    <span className="text-accent-text">{t("vaultDetail.reconfigureLabelHighlight")}</span>
                  </span>
                  <p className="mt-1 text-xs text-faint">
                    {targetConfigured
                      ? t("vaultDetail.reconfigureHintConfigured")
                      : t("vaultDetail.reconfigureHintUnconfigured")}
                  </p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <MiniField label={t("vaultDetail.fieldMinPriceUsd")} value={cfgPriceMin} onChange={setCfgPriceMin} />
                    <MiniField label={t("vaultDetail.fieldMaxPriceUsd")} value={cfgPriceMax} onChange={setCfgPriceMax} />
                    {currentTick !== undefined && (
                      <span className="pb-3 text-xs text-faint">
                        {t("vaultDetail.fieldPriceCurrentHint", {
                          price: ethPriceFromTick(currentTick, stableIsToken0, stableDecimals, volatileDecimals).toFixed(2),
                        })}
                      </span>
                    )}
                    <MiniField
                      label={t("vaultDetail.fieldMaxRebalancesToday", {
                        n: maxRebalances !== undefined ? String(maxRebalances) : "…",
                      })}
                      value={cfgMaxRebalances}
                      onChange={setCfgMaxRebalances}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldReinjectionSymbol", { symbol: stableSymbol })}
                      value={cfgReinjection}
                      onChange={setCfgReinjection}
                    />
                    <MiniField label={t("vaultDetail.fieldPeriodicHours")} value={cfgPeriodicHours} onChange={setCfgPeriodicHours} />
                    <MiniField
                      label={t("vaultDetail.fieldRecenterMarginToday", { n: Number(recenterMarginBps ?? 500n) / 100 })}
                      value={cfgRecenterMarginPct}
                      onChange={setCfgRecenterMarginPct}
                    />
                    <MiniField
                      label={t("vaultDetail.fieldTopMarginToday", { n: Number(exitTopCeilingMarginBps ?? 300n) / 100 })}
                      value={cfgExitTopCeilingMarginPct}
                      onChange={setCfgExitTopCeilingMarginPct}
                    />
                    <button onClick={handleReconfigure} disabled={Boolean(busy)} className="btn-secondary !py-3">
                      {t("vaultDetail.update")}
                    </button>
                  </div>

                  {isCompound && (
                    <div className="mt-6 rounded-xl border border-accent/25 bg-accent/[0.04] p-4">
                      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-accent-text">
                        {t("vaultDetail.compoundSectionLabel")}
                      </span>
                      <div className="mt-2 flex flex-wrap items-end gap-3">
                        <MiniField
                          label={t("vaultDetail.fieldFeeClaimThresholdToday", {
                            n: Number(feeClaimThresholdBps ?? 0n) / 100,
                          })}
                          value={cfgFeeClaimThresholdPct}
                          onChange={setCfgFeeClaimThresholdPct}
                        />
                        <MiniField
                          label={t("vaultDetail.fieldFeeClaimIntervalToday", {
                            n: Number(feeClaimIntervalSeconds ?? 0n) / 3600,
                          })}
                          value={cfgFeeClaimIntervalHours}
                          onChange={setCfgFeeClaimIntervalHours}
                        />
                        <button onClick={handleReconfigure} disabled={Boolean(busy)} className="btn-secondary !py-3">
                          {t("vaultDetail.update")}
                        </button>
                      </div>
                    </div>
                  )}

                  {isCompound && (
                    <div className="mt-6 rounded-xl border border-negative/25 bg-negative/[0.04] p-4">
                      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                        {t("vaultDetail.hardCeilingSectionLabel")}
                      </span>
                      <p className="mt-1 text-xs text-faint">{t("vaultDetail.hardCeilingHint", { symbol: stableSymbol })}</p>
                      {hardCeilingEnabled ? (
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <span className="text-sm text-foreground">
                            {t("vaultDetail.hardCeilingCurrentValue", {
                              price:
                                hardCeilingTick !== undefined
                                  ? ethPriceFromTick(Number(hardCeilingTick), stableIsToken0, stableDecimals, volatileDecimals).toFixed(2)
                                  : "—",
                              symbol: stableSymbol,
                            })}
                          </span>
                          <button
                            onClick={() => handleSetHardCeiling(false)}
                            disabled={Boolean(busy)}
                            className="btn-secondary !py-2"
                          >
                            {t("vaultDetail.hardCeilingDisable")}
                          </button>
                        </div>
                      ) : (
                        <div className="mt-2 flex flex-wrap items-end gap-3">
                          <MiniField
                            label={t("vaultDetail.fieldHardCeilingPrice", { symbol: stableSymbol })}
                            value={cfgHardCeilingPrice}
                            onChange={setCfgHardCeilingPrice}
                          />
                          <button
                            onClick={() => handleSetHardCeiling(true)}
                            disabled={Boolean(busy)}
                            className="btn-secondary !py-3"
                          >
                            {t("vaultDetail.hardCeilingEnable")}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-8">
                  <button
                    type="button"
                    onClick={() => setShowRiskLimits((v) => !v)}
                    aria-expanded={showRiskLimits}
                    className="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.14em] text-foreground transition-colors hover:text-accent-text"
                  >
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 10 10"
                      fill="none"
                      className={`shrink-0 transition-transform ${showRiskLimits ? "rotate-180" : ""}`}
                    >
                      <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    {t("vaultDetail.riskLimitsLabel")}
                  </button>
                  {showRiskLimits && (
                    <>
                      <p className="mt-1 text-xs text-faint">{t("vaultDetail.riskLimitsHint")}</p>
                      <div className="mt-2 flex flex-wrap items-end gap-3">
                        <MiniField
                          label={t("vaultDetail.fieldMaxSlippageToday", { n: Number(maxSlippageBps ?? 30n) / 100 })}
                          value={riskMaxSlippagePct}
                          onChange={setRiskMaxSlippagePct}
                        />
                        <MiniField
                          label={t("vaultDetail.fieldCooldownToday", { n: Number(minRebalanceInterval ?? 0n) / 3600 })}
                          value={riskMinCooldownHours}
                          onChange={setRiskMinCooldownHours}
                        />
                        <MiniField
                          label={t("vaultDetail.fieldMaxDeviationToday", { n: maxRangeDeviationBps !== undefined ? String(maxRangeDeviationBps) : "5000" })}
                          value={riskMaxRangeDeviationTicks}
                          onChange={setRiskMaxRangeDeviationTicks}
                        />
                        <button onClick={handleUpdateRiskParams} disabled={Boolean(busy)} className="btn-secondary !py-3">
                          {t("vaultDetail.update")}
                        </button>
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-6 flex flex-wrap gap-3">
                  {/* Reclamar comisiones moved to its own modal, opened via
                      the "Cobrar comisiones" button right under the
                      position's own price-range card — see manageModal. */}
                  {isCompound && (
                    <button
                      onClick={handleToggleAutoCompound}
                      disabled={Boolean(busy)}
                      className="btn-secondary"
                      title={t("vaultDetail.autoCompoundToggleHint")}
                    >
                      {autoCompoundFees ? t("vaultDetail.autoCompoundToggleOff") : t("vaultDetail.autoCompoundToggleOn")}
                    </button>
                  )}
                  {isCompound && (
                    <button
                      onClick={handleTogglePayoutFeesInStableOnly}
                      disabled={Boolean(busy)}
                      className="btn-secondary"
                      title={t("vaultDetail.payoutStableToggleHint", { symbol: stableSymbol })}
                    >
                      {payoutFeesInStableOnly
                        ? t("vaultDetail.payoutStableToggleOff", { symbol: stableSymbol })
                        : t("vaultDetail.payoutStableToggleOn", { symbol: stableSymbol })}
                    </button>
                  )}
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txWithdrawing"), () => {
                        // Standard (V1) vaults: no-arg withdrawAll(). Compound
                        // (V3) vaults: 2 SwapInstructions — feeSwapIx always a
                        // no-op (withdrawAll() sweeps whatever payoutFeesInStableOnly
                        // already converted, no separate fee-swap slot), payoutSwapIx
                        // sized against the checkbox, same estimate-and-no-haircut
                        // reasoning as handlePartialWithdraw's own (fees only ever
                        // grow between this read and the tx landing).
                        const noSwap = { token0ToToken1: true, amountIn: 0n, amountOutMinimum: 0n, fee: feeTier };
                        let payoutSwapIx = noSwap;
                        if (
                          withdrawAllConvertToStable &&
                          positionTicks &&
                          positionLiquidity !== undefined &&
                          positionTokensOwedLive &&
                          currentTick !== undefined
                        ) {
                          const { amount0Raw, amount1Raw } = estimatePositionAmounts({
                            liquidity: positionLiquidity,
                            currentTick,
                            tickLower: positionTicks.tickLower,
                            tickUpper: positionTicks.tickUpper,
                          });
                          const total0 = amount0Raw + Number(positionTokensOwedLive.tokensOwed0);
                          const total1 = amount1Raw + Number(positionTokensOwedLive.tokensOwed1);
                          const volatileRawEstimate = Math.floor(stableIsToken0 ? total1 : total0);
                          if (volatileRawEstimate > 0) {
                            payoutSwapIx = {
                              token0ToToken1: !stableIsToken0,
                              amountIn: BigInt(volatileRawEstimate),
                              amountOutMinimum: 0n,
                              fee: feeTier,
                            };
                          }
                        }
                        return writeContractAsync({
                          address,
                          abi: vaultAbi,
                          functionName: "withdrawAll",
                          args: isCompound ? [noSwap, payoutSwapIx] : [],
                          chainId: chain.id,
                        });
                      })
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {t("vaultDetail.withdrawAll")}
                  </button>
                  {isCompound && (
                    <label className="flex w-full items-center gap-2.5 text-sm text-foreground/70">
                      <input
                        type="checkbox"
                        checked={withdrawAllConvertToStable}
                        onChange={(e) => setWithdrawAllConvertToStable(e.target.checked)}
                        className="h-4 w-4 rounded border-foreground/30 accent-accent"
                      />
                      {t("vaultDetail.withdrawConvertToStable", { symbol: stableSymbol })}
                    </label>
                  )}
                  <button
                    onClick={() =>
                      withTx(paused ? t("vaultDetail.txResuming") : t("vaultDetail.txPausing"), () =>
                        writeContractAsync({
                          address,
                          abi: vaultAbi,
                          functionName: paused ? "unpause" : "pause",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {paused ? t("vaultDetail.resume") : t("vaultDetail.pause")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txRevoking"), () =>
                        writeContractAsync({
                          address,
                          abi: vaultAbi,
                          functionName: "setOperator",
                          args: ["0x0000000000000000000000000000000000000000"],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-secondary"
                  >
                    {t("vaultDetail.revokeOperator")}
                  </button>
                  <button
                    onClick={() =>
                      withTx(t("vaultDetail.txEmergency"), () =>
                        writeContractAsync({
                          address,
                          abi: vaultAbi,
                          functionName: "emergencyWithdrawPosition",
                          args: [],
                          chainId: chain.id,
                        }),
                      )
                    }
                    disabled={Boolean(busy)}
                    className="btn-danger"
                  >
                    {t("vaultDetail.emergencyWithdraw")}
                  </button>
                  {!closed && (
                    <button
                      onClick={() =>
                        withTx(t("vaultDetail.txClosing"), () =>
                          writeContractAsync({
                            address,
                            abi: vaultAbi,
                            functionName: "closeVault",
                            args: [],
                            chainId: chain.id,
                          }),
                        )
                      }
                      disabled={Boolean(busy)}
                      className="btn-danger"
                      title={t("vaultDetail.closeVaultTooltip")}
                    >
                      {t("vaultDetail.closeVaultBtn")}
                    </button>
                  )}
                </div>
                {Boolean(closed) && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-negative">
                    {t("vaultDetail.closedNote")}
                  </p>
                )}

                {busy && (
                  <p className="mt-4 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                    {t("vaultDetail.signing", { action: busy })}
                  </p>
                )}
                {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}
              </div>
            )}

            <CapitalLedger address={address} chain={chain} vaultAbi={vaultAbi} a1Usd={a1Usd} b1Usd={cumulativeInvestmentUsd} />
            <GasBreakdown address={address} chain={chain} vaultAbi={vaultAbi} />
            <PositionHistory address={address} chain={chain} vaultAbi={vaultAbi} />
            <ReinjectionHistory address={address} chain={chain} vaultAbi={vaultAbi} />
            <ActivityFeed address={address} chain={chain} vaultAbi={vaultAbi} />
          </>
        )}
      </main>
    </>
  );
}

function ConfigRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-faint">{k}</dt>
      <dd className="mt-0.5 font-medium text-foreground/90">{v}</dd>
    </div>
  );
}

// Live, ticking countdown to the next scheduled auto-claim — same
// nextAt/remaining shape as RebalanceCountdown.tsx, just rendered inline as
// HH:MM:SS instead of a standalone card, since this sits inside a compact
// config row. Freezes at 00:00:00 once the window opens (the countdown
// can't know exactly when the next tick actually fires the claim — the
// vault's own polling refresh picks up the real lastFeeClaimTimestamp once
// it does, which resets this naturally).
function FeeClaimCountdown({
  lastFeeClaimTimestamp,
  feeClaimIntervalSeconds,
}: {
  lastFeeClaimTimestamp: bigint | undefined;
  feeClaimIntervalSeconds: bigint | undefined;
}) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const intervalSeconds = Number(feeClaimIntervalSeconds ?? 0n);
  const nextAt = Number(lastFeeClaimTimestamp ?? 0n) + intervalSeconds;
  const remaining = Math.max(0, nextAt - now);

  return <span className="font-mono tabular-nums">{formatHms(remaining)}</span>;
}

// Uniswap-style quick-pick chips (25/50/75/Max) for a percentage field —
// still lets the user type any other value directly in the field itself,
// decimals included (e.g. 2.5), since this only ever calls onPick with a
// plain string the same way typing would.
// Same quick-pick chips as create/page.tsx's DepositTokenSelector-adjacent
// pattern, but dark-on-light — lives inside the pale-yellow manage modal,
// where the usual dark-page-tuned border-hairline/text-faint would vanish.
function LightPctQuickButtons({ onPick }: { onPick: (pct: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-1.5">
      {[25, 50, 75].map((pct) => (
        <button
          key={pct}
          type="button"
          onClick={() => onPick(String(pct))}
          className="flex-1 rounded-full border border-black/15 py-1 font-mono text-[11px] text-black/60 transition-colors hover:border-black/40 hover:text-black"
        >
          {pct}%
        </button>
      ))}
      <button
        type="button"
        onClick={() => onPick("100")}
        className="flex-1 rounded-full border border-black/15 py-1 font-mono text-[11px] text-black/60 transition-colors hover:border-black/40 hover:text-black"
      >
        {t("vaultDetail.pctMax")}
      </button>
    </div>
  );
}

function MiniField({
  label,
  value,
  onChange,
  topSlot,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  // The deposit-token selector, when present — its own row above the input,
  // same placement as create/page.tsx's Field.
  topSlot?: React.ReactNode;
}) {
  return (
    <label className="flex min-w-36 flex-1 flex-col gap-1.5">
      <span className="text-xs text-faint">{label}</span>
      {topSlot}
      <input
        className="field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
      />
    </label>
  );
}

// Live-ticking "time since creation" — same setInterval-driven pattern as
// RebalanceCountdown.tsx, just counting up from a fixed point instead of
// down to one. createdAt is undefined while useVaultCreatedAt's scan is
// still in flight, null if the VaultCreated event genuinely wasn't found.
function VaultAgeStat({ createdAt }: { createdAt: number | null | undefined }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const { t } = useTranslation();

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const value = createdAt ? formatAge(Math.max(0, now - createdAt)) : createdAt === null ? "—" : "…";

  return <Stat label={t("vaultDetail.statAge")} value={value} />;
}

function formatAge(totalSeconds: number): string {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// Stopwatch-style HH:MM:SS — used for short configured intervals (e.g. the
// compound vault's fee-claim interval) where "0.05h" reads as meaningless
// but "00:03:00" reads instantly.
function formatHms(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function Stat({
  label,
  value,
  hint,
  hint2,
  longHint,
  accent,
  valueClassName,
  hintClassName,
  hint2ClassName,
}: {
  label: string;
  value: string;
  hint?: string;
  hint2?: string;
  /** Explanatory (not data) text — e.g. "how this stat behaves" copy that's
   * the same every time, unlike hint/hint2 which are this vault's actual
   * numbers. Collapsed behind a tap/click-to-open <details> instead of
   * always rendered, since a full sentence in every card was most of why
   * this grid felt oversized. Native <details> needs no JS state and opens
   * identically on tap (mobile) and click (desktop). */
  longHint?: string;
  accent?: boolean;
  /** Overrides the default value styling — e.g. a profit/loss stat wants
   * genuine green/red by sign instead of the generic accent/plain toggle. */
  valueClassName?: string;
  /** Overrides the default hint styling — e.g. the fees card wants its
   * USDT/WETH breakdown in green and larger than the other stats' hints. */
  hintClassName?: string;
  hint2ClassName?: string;
}) {
  return (
    <div
      className={
        accent
          ? "glass rounded-xl border-accent/35 bg-accent/[0.06] p-3.5"
          : "glass rounded-xl p-3.5"
      }
    >
      <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">
        {label}
        {longHint && (
          <details className="group/hint relative">
            <summary
              className="flex h-3.5 w-3.5 shrink-0 cursor-pointer list-none items-center justify-center rounded-full border border-hairline text-[9px] normal-case text-faint marker:hidden hover:border-accent/50 hover:text-accent [&::-webkit-details-marker]:hidden"
              aria-label="info"
            >
              i
            </summary>
            <p className="absolute left-0 top-5 z-10 w-48 rounded-lg border border-hairline bg-background p-2 text-[11px] font-normal normal-case leading-snug text-muted shadow-xl">
              {longHint}
            </p>
          </details>
        )}
      </span>
      <p
        className={
          valueClassName ??
          `mt-1.5 text-base font-semibold tabular-nums ${accent ? "text-accent-text" : "text-foreground/90"}`
        }
        style={{ fontFamily: "var(--font-display)" }}
      >
        {value}
      </p>
      {hint && <p className={hintClassName ?? "mt-1 text-xs text-faint"}>{hint}</p>}
      {hint2 && <p className={hint2ClassName ?? "mt-0.5 font-mono text-xs text-accent-text"}>{hint2}</p>}
    </div>
  );
}
