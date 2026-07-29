"use client";

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useSwitchChain,
} from "wagmi";
import { decodeEventLog, encodeFunctionData, formatUnits, parseUnits } from "viem";
import SafeAppsSDK, { type GatewayTransactionDetails } from "@safe-global/safe-apps-sdk";
import { Header } from "../components/Header";
import { AlertModal } from "../components/AlertModal";
import { PairIcon } from "../components/TokenIcon";
import { NetworkSelector } from "../components/NetworkSelector";
import { DepositTokenSelector, type DepositTokenOption } from "../components/DepositTokenSelector";
import { erc20Abi, uniswapV3PoolAbi, platformConfigAbi } from "@/lib/contracts";
import { useTaggedWriteContract } from "@/lib/useTaggedWriteContract";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { sizeInitialSwap } from "@/lib/keeper/swapMath";
import { usePoolMetrics } from "@/lib/usePoolMetrics";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";
import { isCompoundBetaWallet } from "@/lib/compoundBeta";
import { useMultiTokenBalances } from "@/lib/useMultiTokenBalances";
import { useThirdPartyDepositQuote } from "@/lib/useThirdPartyDepositQuote";
import { formatUsdCompact } from "@/lib/format";
import { useTranslation } from "@/lib/i18n/useTranslation";

// "batching" only ever happens on the Safe App path (see isSafeApp below) —
// approve/configureTarget/setRiskParams/deposit(/setAutoCompoundFees) collapsed
// into one Safe transaction instead of several separate signature rounds.
// "activatingCompound" only happens for a compound vault on a plain EOA —
// setAutoCompoundFees(true) right after creation, so it's born already
// compounding instead of requiring a separate manual toggle later.
type Step =
  | "idle"
  | "creating"
  | "approving"
  | "configuring"
  | "risk"
  | "depositing"
  | "activatingCompound"
  | "batching"
  | "done"
  | "error";
type T = ReturnType<typeof useTranslation>["t"];

/**
 * Polls Safe's transaction gateway for a proposed Safe transaction until it
 * actually executes on-chain. `safeTxHash` (what `txs.send()`/the wagmi
 * `safe` connector's `eth_sendTransaction` return) is an EIP-712 struct hash
 * of the PROPOSAL, not a real transaction — it's never going to show up via
 * `publicClient.waitForTransactionReceipt(safeTxHash)` against a plain RPC
 * node, no matter how long that's given to time out. A Safe with threshold >
 * 1 only actually executes once enough of the OTHER owners confirm it from
 * their own Safe UI (Transactions > Queue) — that can take anywhere from
 * seconds to days, entirely outside this browser tab.
 */
async function waitForSafeExecution(
  safeSdk: SafeAppsSDK,
  safeTxHash: `0x${string}`,
  onProgress: (details: GatewayTransactionDetails) => void,
  messages: { cancelled: string; failed: string },
): Promise<`0x${string}`> {
  for (;;) {
    const details = await safeSdk.txs.getBySafeTxHash(safeTxHash);
    onProgress(details);
    if (details.txStatus === "SUCCESS" && details.txHash) return details.txHash as `0x${string}`;
    if (details.txStatus === "CANCELLED") throw new Error(messages.cancelled);
    if (details.txStatus === "FAILED") throw new Error(messages.failed);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

function confirmationsFrom(details: GatewayTransactionDetails): { submitted: number; required: number } | null {
  const info = details.detailedExecutionInfo;
  if (!info || info.type !== "MULTISIG") return null;
  return { submitted: info.confirmations.length, required: info.confirmationsRequired };
}

function stepLabelFor(t: T, stableSymbol: string, totalSteps: number): Record<Step, string> {
  const total = String(totalSteps);
  return {
    idle: t("create.stepIdle"),
    creating: t("create.stepCreating", { n: "1", total }),
    approving: t("create.stepApproving", { n: "2", total, symbol: stableSymbol }),
    configuring: t("create.stepConfiguring", { n: "3", total }),
    risk: t("create.stepRisk", { n: "4", total }),
    depositing: t("create.stepDepositing", { n: "5", total }),
    activatingCompound: t("create.stepActivatingCompound", { n: "6", total }),
    batching: t("create.stepBatching"),
    done: t("create.stepDone"),
    error: t("create.stepError"),
  };
}

// The signatures the wallet is going to ask for, in order — shown as a
// checklist so the user knows what each one actually does before signing,
// not just a changing "3/5…" label on the button mid-flow. 5 for a standard
// vault; 6 for compound (the extra setAutoCompoundFees(true) call — see its
// own call site's docstring on why this isn't folded into configureTarget).
function signatureStepsFor(
  t: T,
  stableSymbol: string,
  isCompound: boolean,
): { key: Exclude<Step, "idle" | "done" | "error">; title: string; desc: string }[] {
  return [
    {
      key: "creating",
      title: t("create.sig1Title"),
      desc: t("create.sig1Desc"),
    },
    {
      key: "approving",
      title: t("create.sig2Title", { symbol: stableSymbol }),
      desc: t("create.sig2Desc", { symbol: stableSymbol }),
    },
    {
      key: "configuring",
      title: t("create.sig3Title"),
      desc: t("create.sig3Desc"),
    },
    {
      key: "risk",
      title: t("create.sig4Title"),
      desc: t("create.sig4Desc"),
    },
    {
      key: "depositing",
      title: t("create.sig5Title"),
      desc: t("create.sig5Desc", { symbol: stableSymbol }),
    },
    ...(isCompound
      ? [
          {
            key: "activatingCompound" as const,
            title: t("create.sig6Title"),
            desc: t("create.sig6Desc"),
          },
        ]
      : []),
  ];
}

// Same createVault first step, but approve/configureTarget/setRiskParams/
// deposit collapse into a single Safe transaction — see waitForSafeExecution.
function safeSignatureStepsFor(
  t: T,
  stableSymbol: string,
): { key: Exclude<Step, "idle" | "done" | "error">; title: string; desc: string }[] {
  return [
    {
      key: "creating",
      title: t("create.sig1Title"),
      desc: t("create.sig1Desc"),
    },
    {
      key: "batching",
      title: t("create.sigSafeBatchTitle"),
      desc: t("create.sigSafeBatchDesc", { symbol: stableSymbol }),
    },
  ];
}

export default function CreateVault() {
  const router = useRouter();
  const { address, isConnected, chainId: walletChainId, connector } = useAccount();
  const { selectedChain: chain, setSelectedChainId } = useSelectedChain();
  const availableChains = useAvailableChains();
  const publicClient = usePublicClient({ chainId: chain.id });
  const { writeContractAsync } = useTaggedWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { t } = useTranslation();

  // @reown/appkit-adapter-wagmi auto-adds wagmi's `safe` connector whenever
  // it detects it's running inside a Safe{Wallet} iframe (app.safe.global) —
  // see manifest.json's own comment in next.config.ts. That's what makes
  // this connector id available to check here at all.
  const isSafeApp = connector?.id === "safe";
  const safeSdk = useMemo(() => (isSafeApp ? new SafeAppsSDK() : null), [isSafeApp]);
  const [safeConfirmations, setSafeConfirmations] = useState<{ submitted: number; required: number } | null>(null);

  // Resumability: under a Safe with threshold > 1, createVault() only ever
  // gets PROPOSED the moment you sign it — it doesn't execute until the
  // Safe's other owners confirm it too, which can happen long after this tab
  // closes. Without this check, coming back and clicking "Crear vault" again
  // would create a SECOND vault (and pay the creation fee again), orphaning
  // the first one mid-setup. Only the most recent vault matters here — an
  // older abandoned one, if any, is harmless empty dust.
  const { data: myVaultsData } = useReadContract({
    address: chain.factoryAddress || undefined,
    abi: chain.factoryAbi,
    functionName: "getVaultsByOwner",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: Boolean(isSafeApp && address && chain.factoryAddress) },
  });
  const lastOwnedVault = ((myVaultsData as `0x${string}`[] | undefined) ?? []).at(-1);
  const { data: lastVaultStatusData } = useReadContracts({
    contracts: lastOwnedVault
      ? [
          { address: lastOwnedVault, abi: chain.vaultAbi, functionName: "targetConfigured", chainId: chain.id },
          { address: lastOwnedVault, abi: chain.vaultAbi, functionName: "closed", chainId: chain.id },
        ]
      : [],
    query: { enabled: Boolean(lastOwnedVault) },
  });
  const [lastVaultConfigured, lastVaultClosed] = lastVaultStatusData?.map((d) => d.result) ?? [];
  const resumableVaultAddress =
    lastOwnedVault && lastVaultConfigured === false && lastVaultClosed === false ? lastOwnedVault : undefined;

  // Which fee-tier pool the NEW position itself will live in — independent
  // of pickDeepestSwapFee (server-side, keeper-only: picks where SWAPS
  // route). This is a yield-strategy choice, not a pure cost minimization —
  // see usePoolMetrics's own docstring for why a lower fee tier isn't
  // automatically better. Defaults to the platform's main pool (chain.feeTier).
  const { data: poolMetrics } = usePoolMetrics(chain);
  const [selectedFee, setSelectedFee] = useState<number>(chain.feeTier);
  // useState's initial value only applies on first mount — without this,
  // switching the network picker (chain.id changes, no remount) leaves
  // selectedFee stuck on the PREVIOUS chain's default fee tier, so the
  // wrong pool card can show up pre-selected (e.g. Celo's 0.3% "sticking"
  // after switching to Arbitrum, whose real default is the 0.05% pool).
  // Reset during render (React's documented pattern for this) rather than
  // in an effect — an effect-based setState here would commit the stale
  // value for one extra render first, then cascade into a second one.
  const [prevChainId, setPrevChainId] = useState(chain.id);
  // "Estándar" vs "Interés compuesto" — the latter only exists as a factory on
  // chains that have deployed VaultFactoryArbCompound (Arbitrum today, see
  // chains.ts's ChainDef docstring on compoundFactoryAddress). Reset to
  // "standard" on every chain switch, same reasoning as selectedFee below —
  // without this, switching FROM Arbitrum-with-compound-selected TO Celo would
  // silently keep pointing at fields Celo's ChainDef doesn't have. Computed
  // once, before either reset block runs, since the first one below mutates
  // prevChainId itself.
  const [vaultKind, setVaultKind] = useState<"standard" | "compound">("standard");
  const chainJustChanged = chain.id !== prevChainId;
  if (chainJustChanged) {
    setPrevChainId(chain.id);
    setSelectedFee(chain.feeTier);
    if (vaultKind !== "standard") setVaultKind("standard");
  }
  const compoundAvailable = Boolean(chain.compoundFactoryAddress) && isCompoundBetaWallet(address);
  const isCompound = compoundAvailable && vaultKind === "compound";

  // Which stablecoin the owner actually hands over for EACH of the three
  // deposit-ledger fields — independent per field (a compound vault owner
  // can invest in DAI while funding the gas budget in USDT, say), only ever
  // something other than chain.stableToken for a compound vault
  // (RangeVaultArbCompound's depositToken() is the only thing that can swap
  // a third-party token into the vault's native stable at deposit time;
  // standard vaults/Celo have no such mechanism at all, see chains.ts's
  // compoundDepositTokens docstring). Each resets to the native stable
  // during render (same documented-React pattern selectedFee/vaultKind
  // already use above) whenever the chain changes or compound stops being
  // selected — a standard vault or a different chain must never keep
  // pointing at a token that isn't even offered there.
  const [investDepositToken, setInvestDepositToken] = useState<`0x${string}`>(chain.stableToken);
  const [reserveDepositToken, setReserveDepositToken] = useState<`0x${string}`>(chain.stableToken);
  const [gasReserveDepositToken, setGasReserveDepositToken] = useState<`0x${string}`>(chain.stableToken);
  const [prevIsCompoundForToken, setPrevIsCompoundForToken] = useState(isCompound);
  if (chainJustChanged || prevIsCompoundForToken !== isCompound) {
    setPrevIsCompoundForToken(isCompound);
    if (chainJustChanged || !isCompound) {
      setInvestDepositToken(chain.stableToken);
      setReserveDepositToken(chain.stableToken);
      setGasReserveDepositToken(chain.stableToken);
    }
  }
  const depositTokenOptions: DepositTokenOption[] = [
    { address: chain.stableToken, decimals: chain.stableDecimals, displaySymbol: chain.stableSymbol },
    ...(isCompound ? (chain.compoundDepositTokens ?? []) : []),
  ];
  function depositTokenMetaFor(addr: `0x${string}`): DepositTokenOption {
    return depositTokenOptions.find((tk) => tk.address.toLowerCase() === addr.toLowerCase()) ?? depositTokenOptions[0];
  }
  const isNative = (addr: `0x${string}`) => addr.toLowerCase() === chain.stableToken.toLowerCase();
  const investTokenMeta = depositTokenMetaFor(investDepositToken);
  const reserveTokenMeta = depositTokenMetaFor(reserveDepositToken);
  const gasReserveTokenMeta = depositTokenMetaFor(gasReserveDepositToken);

  const SIGNATURE_STEPS = isSafeApp
    ? safeSignatureStepsFor(t, chain.stableSymbol)
    : signatureStepsFor(t, chain.stableSymbol, isCompound);
  const SIGNATURE_KEYS = SIGNATURE_STEPS.map((s) => s.key);
  // Non-Safe step counter labels ("1/5 · Creando…") need the REAL total —
  // 6 instead of 5 for a compound vault (the extra setAutoCompoundFees
  // call) — otherwise "5/5" would show right before a 6th step still ran.
  const stepLabel = stepLabelFor(t, chain.stableSymbol, isCompound ? 6 : 5);

  const effectiveFactoryAddress = isCompound ? chain.compoundFactoryAddress! : chain.factoryAddress;
  const effectiveFactoryAbi = isCompound ? chain.compoundFactoryAbi! : chain.factoryAbi;
  const effectiveVaultAbi = isCompound ? chain.compoundVaultAbi! : chain.vaultAbi;
  const selectedPoolMeta = poolMetrics?.find((p) => p.fee === selectedFee);
  const selectedPool = (selectedPoolMeta?.pool ?? chain.pool) as `0x${string}`;

  const { data: slot0 } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "slot0",
    chainId: chain.id,
  });
  const { data: tickSpacing } = useReadContract({
    address: selectedPool,
    abi: uniswapV3PoolAbi,
    functionName: "tickSpacing",
    chainId: chain.id,
  });
  const { data: creationFeeUsdtRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "creationFeeUsdt",
    chainId: chain.id,
  });
  const creationFeeUsdt = (creationFeeUsdtRaw as bigint) ?? 0n;
  // 0 == no cap, same convention RangeVault.deposit() itself uses — read live
  // so a later platform change (e.g. raising it) is reflected without a
  // frontend redeploy. New vault, so nothing previously committed to weigh in.
  const { data: maxDepositUsdRaw } = useReadContract({
    address: chain.platformConfigAddress || undefined,
    abi: platformConfigAbi,
    functionName: "maxDepositUsd",
    chainId: chain.id,
  });
  const maxDepositUsd = (maxDepositUsdRaw as bigint) ?? 0n;
  const [capAlert, setCapAlert] = useState<string | null>(null);
  const [balanceAlert, setBalanceAlert] = useState<string | null>(null);

  // The wallet's real balance of the token this vault deposits in — not the
  // wallet's active chain, `chain` (the one being CREATED on, see the
  // network picker above); reads against the wrong chain would silently
  // show a stale/zero balance while the wallet's still elsewhere.
  const { data: stableBalanceRaw } = useReadContract({
    address: chain.stableToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: chain.id,
    query: { enabled: Boolean(address), refetchInterval: 60_000 },
  });
  const stableBalanceUsd =
    stableBalanceRaw !== undefined ? Number(formatUnits(stableBalanceRaw as bigint, 6)) : undefined;

  // Extra candidate tokens' balances (native stable's own read above already
  // covers that one) — empty array when not compound, so this is a genuine
  // no-op (zero extra RPC calls) for every standard/Celo flow.
  const { balances: extraDepositTokenBalances } = useMultiTokenBalances(
    chain,
    isCompound ? (chain.compoundDepositTokens ?? []) : [],
    address,
  );
  const depositTokenBalancesUsd: (number | undefined)[] = [
    stableBalanceUsd,
    ...extraDepositTokenBalances.map((b) => b.formatted),
  ];
  function balanceFor(addr: `0x${string}`): number | undefined {
    return isNative(addr) ? stableBalanceUsd : extraDepositTokenBalances.find((b) => b.address.toLowerCase() === addr.toLowerCase())?.formatted;
  }

  const currentTick = slot0 ? Number((slot0 as readonly unknown[])[1]) : undefined;
  const currentPrice = currentTick !== undefined ? ethPriceFromTick(currentTick, chain.stableIsToken0) : undefined;

  // All fields start empty — nothing is submitted until the user actually
  // types a value. The numbers shown below (as `placeholder`, not `value`)
  // are just worked examples, computed live where it makes sense (min/max
  // price from the pool's current price ±10%) so there's no setState-in-effect
  // prefill trick needed.
  const [investAmount, setInvestAmount] = useState("");
  // Min/max are independent — no forced symmetry; the contract has never
  // required it, only the old UI did.
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  // No forced periodic trigger by default — rebalances only fire when the
  // price actually leaves the range, unless the owner opts into a periodic
  // one later from the vault's own reconfigure panel (VaultDetail.tsx).
  const periodicHours = "0";
  // Only meaningful on chains whose vault has a dedicated gasReserveBalance
  // ledger (RangeVaultArb — see chains.ts's supportsGasReserve) — optional,
  // blank = 0: the keeper gas reimbursement never blocks a rebalance even
  // with zero budget (see RangeVaultArb.sol), it just reimburses nothing
  // until the owner tops this up.
  const [gasReserveAmount, setGasReserveAmount] = useState("");

  // Advanced / risk knobs — these DO have sensible platform defaults (same
  // values this form used to hardcode outright), so leaving any of them
  // blank is a valid choice, not an error. See RangeVault.sol for what each
  // one actually gates. maxSlippagePct/minRebalanceCooldownHours/
  // maxRangeDeviationTicks were dropped from this section entirely — always
  // use the platform default now, not even editable here.
  const [maxRebalances, setMaxRebalances] = useState("");
  // Deposited into reserveBalance at creation — separate from
  // reinjectionAmount below, which only caps how much of that reserve the
  // agent can pull PER CYCLE. Funding zero reserve here means a later
  // reinjectionAmount cap has nothing to actually draw from until a top-up
  // deposit adds some.
  const [reserveAmount, setReserveAmount] = useState("");
  const [reinjectionAmount, setReinjectionAmount] = useState("");
  const [recenterMarginPct, setRecenterMarginPct] = useState("");
  const [exitTopCeilingMarginPct, setExitTopCeilingMarginPct] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedPool, setCopiedPool] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);

  const minPricePlaceholder = currentPrice !== undefined ? (currentPrice * 0.9).toFixed(2) : "1604.18";
  const maxPricePlaceholder = currentPrice !== undefined ? (currentPrice * 1.1).toFixed(2) : "1960.66";

  // Each of the three deposit-ledger fields quotes INDEPENDENTLY against its
  // own selected token and own typed amount — a fixed 3 hook calls
  // regardless of how many distinct tokens are actually in play, each a
  // genuine no-op (see useThirdPartyDepositQuote's own guard) whenever that
  // particular field is on the native stable or empty.
  const investRawAmount = parseUnits(investAmount || "0", investTokenMeta.decimals);
  const reserveRawAmount = parseUnits(reserveAmount || "0", reserveTokenMeta.decimals);
  const gasReserveRawAmount = chain.supportsGasReserve ? parseUnits(gasReserveAmount || "0", gasReserveTokenMeta.decimals) : 0n;
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
    isNative(gasReserveDepositToken) ? undefined : (chain.compoundDepositTokens ?? []).find((tk) => tk.address === gasReserveDepositToken),
    gasReserveRawAmount,
    30n,
  );
  // Each field's own contribution, in the vault's native-stable terms — the
  // raw typed value for a native field, the live quote's output otherwise.
  // Feeds the cap check, the balance checks, the summary display, and
  // handleCreate's actual ledger split below.
  const investFinalUsd = isNative(investDepositToken)
    ? parseFloat(investAmount) || 0
    : Number(formatUnits(investQuote.expectedStableOut, chain.stableDecimals));
  const reserveFinalUsd = isNative(reserveDepositToken)
    ? parseFloat(reserveAmount) || 0
    : Number(formatUnits(reserveQuote.expectedStableOut, chain.stableDecimals));
  const gasReserveFinalUsd = !chain.supportsGasReserve
    ? 0
    : isNative(gasReserveDepositToken)
      ? parseFloat(gasReserveAmount) || 0
      : Number(formatUnits(gasReserveQuote.expectedStableOut, chain.stableDecimals));
  // The one-time creation fee is only ever pulled directly from the
  // depositor when AT LEAST ONE field is native (that field's own approve
  // pads it in — see handleCreate) — for an all-third-party deposit,
  // depositToken() pays it out of the vault's own post-swap stable balance
  // instead, so it never counts against any wallet balance check below.
  const anyFieldNative =
    isNative(investDepositToken) || isNative(reserveDepositToken) || (chain.supportsGasReserve && isNative(gasReserveDepositToken));
  const totalUsdt =
    investFinalUsd + reserveFinalUsd + gasReserveFinalUsd + (anyFieldNative ? Number(formatUnits(creationFeeUsdt, 6)) : 0);

  const lowerPreview = parseFloat(minPrice) || undefined;
  const upperPreview = parseFloat(maxPrice) || undefined;

  const rangeWidthPct =
    lowerPreview !== undefined && upperPreview !== undefined && upperPreview > 0
      ? ((upperPreview - lowerPreview) / upperPreview) * 100
      : undefined;

  // Where this range's width lands on the narrow-to-conservative spectrum —
  // tighter ranges earn more fees per dollar but need more active
  // rebalancing, wider ones are more hands-off but dilute fee density.
  // Shared with the legend rendered below the Tipo de pool badge so both
  // read from the same thresholds/colors.
  const POOL_TYPES = [
    { maxPct: 10, range: "0-10%", labelKey: "create.poolTypeNarrow" as const, color: "#EC4899" },
    { maxPct: 20, range: "10-20%", labelKey: "create.poolTypeMedium" as const, color: "#F97316" },
    { maxPct: 30, range: "20-30%", labelKey: "create.poolTypeWide" as const, color: "#3B82F6" },
    { maxPct: Infinity, range: "30%+", labelKey: "create.poolTypeConservative" as const, color: "#22D3EE" },
  ];
  const poolTypeDef = rangeWidthPct === undefined ? undefined : POOL_TYPES.find((pt) => rangeWidthPct <= pt.maxPct);
  const poolType = poolTypeDef ? { label: t(poolTypeDef.labelKey), color: poolTypeDef.color } : undefined;

  // Estimated token split within the chosen range, at the current price —
  // reuses the exact sizing math the keeper itself uses to balance a fresh
  // position (sizeInitialSwap), just fed with preview values instead of the
  // real on-chain tickSpacing-aligned range. Preview only, not what actually
  // gets submitted on-chain.
  const rangeComposition =
    currentTick !== undefined &&
    currentPrice !== undefined &&
    lowerPreview !== undefined &&
    upperPreview !== undefined &&
    lowerPreview > 0 &&
    upperPreview > lowerPreview &&
    (parseFloat(investAmount) || 0) > 0
      ? (() => {
          const tickA = tickFromEthPrice(lowerPreview, chain.stableIsToken0);
          const tickB = tickFromEthPrice(upperPreview, chain.stableIsToken0);
          const investRaw = parseUnits(investAmount, 6);
          const { amountIn } = sizeInitialSwap({
            currentTick,
            tickLower: Math.min(tickA, tickB),
            tickUpper: Math.max(tickA, tickB),
            availableStableRaw: investRaw,
            ethPriceUsd: currentPrice,
            stableIsToken0: chain.stableIsToken0,
          });
          const volatileUsd = Number(formatUnits(amountIn, 6));
          const stableUsd = Math.max(0, (parseFloat(investAmount) || 0) - volatileUsd);
          const totalUsd = stableUsd + volatileUsd;
          if (totalUsd <= 0) return undefined;
          return {
            stableUsd,
            volatileUsd,
            volatileQty: volatileUsd / currentPrice,
            stablePct: (stableUsd / totalUsd) * 100,
            volatilePct: (volatileUsd / totalUsd) * 100,
          };
        })()
      : undefined;

  // Zoomed to the selected [min, max] itself (plus a thin margin for drag
  // headroom) rather than a fixed window around the current price — keeps
  // the handles pinned near the track's own edges instead of bunched in the
  // middle, and re-fits automatically every time min/max changes.
  const sliderDomain = useMemo(() => {
    if (currentPrice === undefined || currentPrice <= 0) return undefined;
    const lo = lowerPreview ?? currentPrice * 0.9;
    const hi = upperPreview ?? currentPrice * 1.1;
    const span = Math.max(hi - lo, currentPrice * 0.005);
    const pad = span * 0.15;
    return { lo: lo - pad, hi: hi + pad };
  }, [currentPrice, lowerPreview, upperPreview]);

  // Native fields are checked TOGETHER (one combined wallet balance, one
  // combined call — see handleCreate) including the one-time creation fee;
  // each non-native field is checked independently against its OWN token's
  // balance. Only counts once there's an actual balance reading AND the
  // user has typed a real amount for that specific bucket — otherwise every
  // fresh page load would flash the button disabled before either value is
  // meaningful.
  const nativeTypedSum =
    (isNative(investDepositToken) ? parseFloat(investAmount) || 0 : 0) +
    (isNative(reserveDepositToken) ? parseFloat(reserveAmount) || 0 : 0) +
    (chain.supportsGasReserve && isNative(gasReserveDepositToken) ? parseFloat(gasReserveAmount) || 0 : 0);
  const nativeRequirement = nativeTypedSum + (anyFieldNative ? Number(formatUnits(creationFeeUsdt, 6)) : 0);
  const nativeInsufficient = anyFieldNative && stableBalanceUsd !== undefined && nativeRequirement > stableBalanceUsd;
  const investNonNativeInsufficient =
    !isNative(investDepositToken) &&
    Boolean(investAmount) &&
    balanceFor(investDepositToken) !== undefined &&
    (parseFloat(investAmount) || 0) > (balanceFor(investDepositToken) ?? 0);
  const reserveNonNativeInsufficient =
    !isNative(reserveDepositToken) &&
    Boolean(reserveAmount) &&
    balanceFor(reserveDepositToken) !== undefined &&
    (parseFloat(reserveAmount) || 0) > (balanceFor(reserveDepositToken) ?? 0);
  const gasReserveNonNativeInsufficient =
    chain.supportsGasReserve &&
    !isNative(gasReserveDepositToken) &&
    Boolean(gasReserveAmount) &&
    balanceFor(gasReserveDepositToken) !== undefined &&
    (parseFloat(gasReserveAmount) || 0) > (balanceFor(gasReserveDepositToken) ?? 0);
  const insufficientBalance =
    Boolean(investAmount) &&
    (nativeInsufficient || investNonNativeInsufficient || reserveNonNativeInsufficient || gasReserveNonNativeInsufficient);
  // One entry per distinct bucket that's actually short — the native bucket
  // (if any field uses it) reported once, each short non-native field
  // reported on its own, since they're each a different token/balance.
  const insufficientDetails: Array<{ symbol: string; needed: number; balance: number }> = [
    ...(nativeInsufficient ? [{ symbol: chain.stableSymbol, needed: nativeRequirement, balance: stableBalanceUsd ?? 0 }] : []),
    ...(investNonNativeInsufficient
      ? [{ symbol: investTokenMeta.displaySymbol, needed: parseFloat(investAmount) || 0, balance: balanceFor(investDepositToken) ?? 0 }]
      : []),
    ...(reserveNonNativeInsufficient
      ? [{ symbol: reserveTokenMeta.displaySymbol, needed: parseFloat(reserveAmount) || 0, balance: balanceFor(reserveDepositToken) ?? 0 }]
      : []),
    ...(gasReserveNonNativeInsufficient
      ? [
          {
            symbol: gasReserveTokenMeta.displaySymbol,
            needed: parseFloat(gasReserveAmount) || 0,
            balance: balanceFor(gasReserveDepositToken) ?? 0,
          },
        ]
      : []),
  ];
  // Whichever non-native, non-empty field's quote isn't ready yet — feeds
  // the submit button's disabled state and the loading/error hint below.
  const pendingQuoteFields = [
    { token: investDepositToken, amount: investAmount, quote: investQuote, meta: investTokenMeta },
    { token: reserveDepositToken, amount: reserveAmount, quote: reserveQuote, meta: reserveTokenMeta },
    ...(chain.supportsGasReserve
      ? [{ token: gasReserveDepositToken, amount: gasReserveAmount, quote: gasReserveQuote, meta: gasReserveTokenMeta }]
      : []),
  ].filter((f) => !isNative(f.token) && (parseFloat(f.amount) || 0) > 0);
  const quoteLoading = pendingQuoteFields.some((f) => f.quote.isLoading);
  const quoteErrored = pendingQuoteFields.find((f) => f.quote.isError);

  async function handleCreate(resumeVaultAddress?: `0x${string}`) {
    if (!address || !publicClient || currentPrice === undefined || tickSpacing === undefined) return;
    setError(null);
    setFailedAt(null);
    setSafeConfirmations(null);
    let currentPhase: Step = "creating"; // tracked outside React state — setStep() batches, so `step` itself isn't reliable to read back mid-function

    if (!investAmount || !minPrice || !maxPrice) {
      setError(t("create.errMissingFields"));
      setStep("error");
      return;
    }

    // Each non-native, non-empty field needs its own live quote ready before
    // ANY of the amounts below can be trusted — depositToken()'s ledger
    // credits are caller-supplied, not derived from the swap's real output,
    // so submitting against a stale/zero quote would misstate the vault's
    // internal accounting (see useThirdPartyDepositQuote's own docstring).
    const pendingQuotes = [
      { token: investDepositToken, amount: investAmount, quote: investQuote },
      { token: reserveDepositToken, amount: reserveAmount, quote: reserveQuote },
      ...(chain.supportsGasReserve ? [{ token: gasReserveDepositToken, amount: gasReserveAmount, quote: gasReserveQuote }] : []),
    ].filter((f) => !isNative(f.token) && (parseFloat(f.amount) || 0) > 0);
    const notReady = pendingQuotes.find((f) => f.quote.isLoading || f.quote.isError || f.quote.expectedStableOut === 0n);
    if (notReady) {
      setError(t("create.quoteErrorMsg", { symbol: depositTokenMetaFor(notReady.token).displaySymbol }));
      setStep("error");
      return;
    }

    // Everything downstream (the platform-cap check, the balance check, and
    // the actual deposit()/depositToken() calls) needs the FINAL amounts in
    // the vault's own native-stable terms — for a native field that's just
    // the raw typed value; for a third-party field it's that field's OWN
    // live quote output (never the raw typed number directly — see
    // useThirdPartyDepositQuote's own docstring on why).
    const finalInvestableRaw = isNative(investDepositToken) ? investRawAmount : investQuote.expectedStableOut;
    const finalReserveRaw = isNative(reserveDepositToken) ? reserveRawAmount : reserveQuote.expectedStableOut;
    const finalGasReserveRaw = !chain.supportsGasReserve
      ? 0n
      : isNative(gasReserveDepositToken)
        ? gasReserveRawAmount
        : gasReserveQuote.expectedStableOut;

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded) — catch
    // it here so the wallet never even pops up for a deposit that's certain
    // to revert on-chain. Confirmed in production 2026-07-17: a user hit
    // DepositExceedsPlatformCap with no explanation, just a raw revert.
    // Uses the FINAL (quoted, when applicable) amounts — the raw typed
    // numbers in a third-party token aren't in stable terms at all.
    const requestedTotalUsd = Number(formatUnits(finalInvestableRaw + finalReserveRaw + finalGasReserveRaw, chain.stableDecimals));
    if (maxDepositUsd !== 0n && requestedTotalUsd > Number(formatUnits(maxDepositUsd, 6))) {
      setCapAlert(
        t("create.capAlertMsg", {
          cap: formatUnits(maxDepositUsd, 6),
          symbol: chain.stableSymbol,
          requested: requestedTotalUsd.toFixed(2),
        }),
      );
      return;
    }

    // Balance real de la wallet — cada campo no-nativo contra su propio
    // token, los campos nativos combinados contra el stable (+ el fee de
    // creación, que solo se pide de más ahí — ver totalUsdt más arriba). Sin
    // esto, la wallet se abre igual y el usuario se entera de que le faltan
    // fondos recién cuando la tx revierte on-chain.
    if (insufficientBalance) {
      setBalanceAlert(
        t("create.balanceAlertMsg", {
          total: totalUsdt.toFixed(2),
          symbol: chain.stableSymbol,
          gasClause: chain.supportsGasReserve ? t("create.balanceAlertGasClause") : "",
          fee: formatUnits(creationFeeUsdt, 6),
          balance: (stableBalanceUsd ?? 0).toFixed(2),
          chain: chain.name,
        }),
      );
      return;
    }

    // The viewing chain (chain, from useSelectedChain) and the wallet's
    // actual connected chain are independent — see the network picker above.
    // Every write in this flow targets `chain`, so the wallet has to
    // actually be on it before the first signature.
    if (walletChainId !== chain.id) {
      try {
        await switchChainAsync({ chainId: chain.id });
      } catch {
        setError(t("create.switchChainError", { chain: chain.name }));
        setStep("error");
        return;
      }
    }

    try {
      let vaultAddress: `0x${string}` | undefined = resumeVaultAddress;

      if (!vaultAddress) {
        currentPhase = "creating";
        setStep(currentPhase);
        const createHash = await writeContractAsync({
          address: effectiveFactoryAddress || "0x0000000000000000000000000000000000000000",
          abi: effectiveFactoryAbi,
          functionName: "createVault",
          args: [selectedPool, chain.stableToken, chain.volatileToken, selectedFee],
          chainId: chain.id,
        });

        // Under a Safe App, `createHash` is really a safeTxHash (a proposal,
        // not a mined tx yet) — see waitForSafeExecution's docstring.
        const createTxHash =
          isSafeApp && safeSdk
            ? await waitForSafeExecution(safeSdk, createHash, (d) => setSafeConfirmations(confirmationsFrom(d)), {
                cancelled: t("create.safeTxCancelled"),
                failed: t("create.safeTxFailed"),
              })
            : createHash;
        setSafeConfirmations(null);

        const createReceipt = await publicClient.waitForTransactionReceipt({ hash: createTxHash });

        for (const log of createReceipt.logs) {
          try {
            const decoded = decodeEventLog({ abi: effectiveFactoryAbi, data: log.data, topics: log.topics });
            if (decoded.eventName === "VaultCreated") {
              vaultAddress = (decoded.args as unknown as { vault: `0x${string}` }).vault;
              break;
            }
          } catch {
            // not the event we're looking for, ignore
          }
        }
        if (!vaultAddress) throw new Error("VaultCreated event not found in receipt");
      }

      const lowerPrice = Number(minPrice);
      const upperPrice = Number(maxPrice);
      if (!(lowerPrice > 0) || !(upperPrice > lowerPrice)) {
        throw new Error(t("create.priceRangeError"));
      }
      // Whether a HIGHER USD price of ETH maps to a lower or higher tick depends
      // on chain.stableIsToken0 (Celo vs Arbitrum sort WETH/stable oppositely),
      // so converting the two price bounds can yield ticks in either order —
      // sort them, Uniswap requires tickLower < tickUpper or every mint reverts.
      const tickA = alignToTickSpacing(tickFromEthPrice(lowerPrice, chain.stableIsToken0), Number(tickSpacing));
      const tickB = alignToTickSpacing(tickFromEthPrice(upperPrice, chain.stableIsToken0), Number(tickSpacing));
      const targetTickLower = Math.min(tickA, tickB);
      const targetTickUpper = Math.max(tickA, tickB);

      // Blank = platform default, same values this form used to hardcode —
      // see the field hints for what each one does. maxSlippageBps/
      // minRebalanceIntervalSec/maxRangeDeviationBps are no longer editable
      // here at all — always the platform default, not even in Avanzado.
      const maxRebalancesFinal = maxRebalances ? BigInt(maxRebalances) : 1000n;
      const reinjectionCap = parseUnits(reinjectionAmount || "0", 6);
      const recenterMarginBps = recenterMarginPct ? BigInt(Math.round(Number(recenterMarginPct) * 100)) : 500n;
      const exitTopCeilingMarginBps = exitTopCeilingMarginPct
        ? BigInt(Math.round(Number(exitTopCeilingMarginPct) * 100))
        : 300n;
      const maxSlippageBps = 30n;
      const minRebalanceIntervalSec = 0n;
      const maxRangeDeviationBps = 5_000n;
      // Up to 4 deposit-side calls: ONE combined native deposit() (whichever
      // of the 3 fields use the vault's own stable, if any) plus one
      // depositToken() PER third-party field — never merged even if two
      // fields happen to share the same non-native token, since each
      // field's own live quote was sized for exactly that field's own
      // amount (see useThirdPartyDepositQuote calls above); merging two
      // independently-quoted amounts into one swap would need a fresh
      // combined quote instead. The native leg (when present) is always
      // built FIRST and is the only one whose approve pads in the one-time
      // creation fee — for a brand-new vault this is its very first
      // deposit-type call ever, so it's the one that flips
      // creationFeeCharged; every call after it (including any third-party
      // ones) needs no fee padding. If there's no native leg at all, the
      // first third-party call still pays the fee correctly with zero
      // frontend involvement — depositToken() deducts it from the vault's
      // own post-swap stable balance, never from the depositor's tokenIn
      // (see RangeVaultArbCompound.sol).
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
          approveToken: chain.stableToken,
          approveAmount: nativeTotal + creationFeeUsdt,
          functionName: "deposit",
          args: chain.supportsGasReserve
            ? [nativeReserve, nativeInvestable, nativeGasReserve]
            : [nativeReserve, nativeInvestable],
        });
      }
      // swapIx is inert for every one of these — only read by the contract
      // when tokenIn is the VOLATILE leg, which DAI/USDT never are.
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
      // RangeVaultArbCompound's configureTarget() takes 2 extra trailing args
      // (feeClaimThresholdBps/feeClaimIntervalSeconds — the scheduled/threshold
      // fee-auto-claim knobs) that RangeVault.sol/RangeVaultArb.sol don't have.
      // Left at 0 here — autoCompoundFees itself gets turned on right after
      // (see the setAutoCompoundFees call site below), but these two
      // scheduling knobs stay off by default; the owner tunes them later from
      // the vault's own "Reconfigurar agente" panel, same as every other
      // advanced knob this form doesn't ask about upfront.
      const configureTargetArgs: readonly (bigint | number)[] = [
        finalInvestableRaw,
        targetTickLower,
        targetTickUpper,
        maxRebalancesFinal,
        reinjectionCap,
        BigInt(Number(periodicHours) * 3600),
        recenterMarginBps,
        exitTopCeilingMarginBps,
        ...(isCompound ? [0n, 0n] : []),
      ];

      if (isSafeApp && safeSdk) {
        // Safe path: approve + configureTarget + setRiskParams + deposit
        // collapse into ONE Safe transaction instead of 4 separate signature
        // rounds — createVault can't join this batch too since its calldata
        // is precomputed off-chain and can't reference the vault address a
        // PRIOR call in the same batch would return (see waitForSafeExecution).
        currentPhase = "batching";
        setStep(currentPhase);

        const txs = [
          {
            to: vaultAddress,
            value: "0",
            data: encodeFunctionData({
              abi: effectiveVaultAbi,
              functionName: "configureTarget",
              args: configureTargetArgs,
            }),
          },
          {
            to: vaultAddress,
            value: "0",
            data: encodeFunctionData({
              abi: effectiveVaultAbi,
              functionName: "setRiskParams",
              args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
            }),
          },
          // One approve+deposit(Token) pair per distinct token in play — see
          // depositCalls' own docstring above. The common case (one token,
          // e.g. plain USDC) is exactly the 2 calls this always used to be.
          ...depositCalls.flatMap((call) => [
            {
              to: call.approveToken,
              value: "0",
              data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vaultAddress, call.approveAmount] }),
            },
            {
              to: vaultAddress,
              value: "0",
              data: encodeFunctionData({ abi: effectiveVaultAbi, functionName: call.functionName, args: call.args }),
            },
          ]),
          // Same reasoning as the non-Safe path below: born already
          // compounding instead of requiring a separate manual toggle later.
          ...(isCompound
            ? [
                {
                  to: vaultAddress,
                  value: "0",
                  data: encodeFunctionData({ abi: effectiveVaultAbi, functionName: "setAutoCompoundFees", args: [true] }),
                },
              ]
            : []),
        ];

        const { safeTxHash } = await safeSdk.txs.send({ txs });
        const realHash = await waitForSafeExecution(
          safeSdk,
          safeTxHash as `0x${string}`,
          (d) => setSafeConfirmations(confirmationsFrom(d)),
          { cancelled: t("create.safeTxCancelled"), failed: t("create.safeTxFailed") },
        );
        setSafeConfirmations(null);
        await publicClient.waitForTransactionReceipt({ hash: realHash });
      } else {
        currentPhase = "configuring";
        setStep(currentPhase);
        const configureHash = await writeContractAsync({
          address: vaultAddress,
          abi: effectiveVaultAbi,
          functionName: "configureTarget",
          args: configureTargetArgs,
          chainId: chain.id,
        });
        await publicClient.waitForTransactionReceipt({ hash: configureHash });

        // setRiskParams is mandatory, not optional: the vault initializes with
        // maxRangeDeviationBps = 0, and RangeVault._checkRangeNearMarket rejects
        // any range whose center isn't exactly the current tick under that value
        // — so without this call the agent's initPosition() would revert with
        // RangeTooFarFromMarket almost every time.
        //
        // A half-width-of-initial-range heuristic used to live here, but real
        // production data (2026-07-15) showed it's not a reliable estimate: the
        // periodic-rebalance path pins the old floor and lets uni-lab's real RC
        // calculation pick the ceiling, and that real (paid, on-chain-confirmed)
        // answer landed the range's center ~260-290 ticks from market on 3
        // vaults whose half-width was only 135-150 — genuinely blocked, not a
        // keeper-side estimation bug (see rebalancer.ts's own fix the same day,
        // which stopped trusting a local guess and started using uni-lab's real
        // range — the real range still didn't fit). The three values below now
        // come from the form (blank = the same generous defaults this used to
        // hardcode) instead of being fixed for every vault — see field hints.
        currentPhase = "risk";
        setStep(currentPhase);
        const riskHash = await writeContractAsync({
          address: vaultAddress,
          abi: effectiveVaultAbi,
          functionName: "setRiskParams",
          args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
          chainId: chain.id,
        });
        await publicClient.waitForTransactionReceipt({ hash: riskHash });

        // One approve+deposit(Token) pair per distinct token in play — see
        // depositCalls' own docstring above. The common case (one token,
        // e.g. plain USDC) is exactly the 2 calls this always used to be.
        for (const call of depositCalls) {
          currentPhase = "approving";
          setStep(currentPhase);
          const approveHash = await writeContractAsync({
            address: call.approveToken,
            abi: erc20Abi,
            functionName: "approve",
            args: [vaultAddress, call.approveAmount],
            chainId: chain.id,
          });
          await publicClient.waitForTransactionReceipt({ hash: approveHash });

          currentPhase = "depositing";
          setStep(currentPhase);
          const depositHash = await writeContractAsync({
            address: vaultAddress,
            abi: effectiveVaultAbi,
            functionName: call.functionName,
            args: call.args,
            chainId: chain.id,
          });
          await publicClient.waitForTransactionReceipt({ hash: depositHash });
        }

        // Compounding starts OFF at the contract level (autoCompoundFees
        // defaults false) — a compound vault the owner picked here should be
        // born already compounding, not require a separate manual toggle
        // from the vault's own panel afterward. Kept as its own call (not
        // folded into configureTarget's args) since setAutoCompoundFees is a
        // pre-existing, independently-toggleable knob the vault detail page
        // also uses — reusing it here instead of adding a redundant
        // constructor-time flag keeps there being exactly one code path that
        // flips this bit.
        if (isCompound) {
          currentPhase = "activatingCompound";
          setStep(currentPhase);
          const activateHash = await writeContractAsync({
            address: vaultAddress,
            abi: effectiveVaultAbi,
            functionName: "setAutoCompoundFees",
            args: [true],
            chainId: chain.id,
          });
          await publicClient.waitForTransactionReceipt({ hash: activateHash });
        }
      }

      setStep("done");
      // ?kind=compound tells VaultDetail.tsx which ABI to read this vault
      // with (RangeVaultArbCompound vs the standard vault) — see that page's
      // own docstring on vault-kind detection. Fixed forever for this
      // address: whichever factory createVault() above actually hit.
      router.push(isCompound ? `/vault/${vaultAddress}?kind=compound` : `/vault/${vaultAddress}`);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
      setFailedAt(currentPhase);
      setStep("error");
      setSafeConfirmations(null);
    }
  }

  const busy = step !== "idle" && step !== "done" && step !== "error";

  return (
    <>
      {capAlert && (
        <AlertModal title={t("create.capAlertTitle")} message={capAlert} onClose={() => setCapAlert(null)} />
      )}
      {balanceAlert && (
        <AlertModal title={t("create.balanceAlertTitle")} message={balanceAlert} onClose={() => setBalanceAlert(null)} />
      )}
      <Header />
      <main className="section flex-1 pb-24 pt-32">
        <div className="flex flex-wrap items-center gap-3">
          <span className="eyebrow">{t("create.eyebrow")}</span>
        </div>
        <h1
          className="mt-5 text-balance text-3xl font-semibold leading-[1.12] tracking-tight sm:text-4xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          {t("create.title")}
        </h1>
        <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-muted">
          {t("create.subtitle", { pair: `${chain.stableSymbol}/${chain.volatileSymbol}`, chain: chain.name })}
        </p>

        {availableChains.length > 1 && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{t("create.networkLabel")}</span>
            <NetworkSelector chains={availableChains} selectedId={chain.id} onSelect={setSelectedChainId} />
          </div>
        )}

        {compoundAvailable && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("create.vaultKindLabel")}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setVaultKind("standard")}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                  vaultKind === "standard"
                    ? "border-accent bg-accent/[0.08] text-foreground"
                    : "border-hairline text-muted hover:border-accent/50"
                }`}
              >
                {t("create.vaultKindStandard")}
              </button>
              <button
                type="button"
                onClick={() => setVaultKind("compound")}
                className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${
                  vaultKind === "compound"
                    ? "border-accent bg-accent/[0.08] text-foreground"
                    : "border-hairline text-muted hover:border-accent/50"
                }`}
              >
                {t("create.vaultKindCompound")}
              </button>
            </div>
          </div>
        )}
        {isCompound && (
          <p className="mt-2 max-w-xl text-xs text-faint">{t("create.vaultKindCompoundHint")}</p>
        )}

        {isConnected && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <span className="font-mono text-sm uppercase tracking-[0.14em] text-foreground">
              {t("create.choosePoolLabel")}
            </span>
            <p className="mt-1 text-xs text-faint">{t("create.choosePoolHint")}</p>
            <div className="mt-4 flex flex-col gap-2">
              {(poolMetrics ?? []).map((p) => {
                const isSelected = p.fee === selectedFee;
                const disabled = !p.exists || p.liquidity === 0n;
                return (
                  <div
                    key={p.fee}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 transition sm:flex-nowrap ${
                      isSelected
                        ? "border-accent bg-accent/[0.08]"
                        : disabled
                          ? "border-hairline opacity-40"
                          : "border-hairline hover:border-accent/50"
                    }`}
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setSelectedFee(p.fee)}
                      className="flex flex-1 flex-wrap items-center gap-x-4 gap-y-2 text-left disabled:cursor-not-allowed"
                    >
                      <PairIcon volatileSymbol={chain.volatileSymbol} stableSymbol={chain.stableSymbol} />
                      <div className="w-[150px] shrink-0">
                        <p className="text-sm font-semibold">
                          {chain.stableSymbol}/{chain.volatileSymbol}
                        </p>
                        <p className="font-mono text-[11px] text-faint">V3 · {p.fee / 10_000}%</p>
                      </div>

                      {disabled ? (
                        <p className="text-xs text-faint">{t("create.noLiquidity")}</p>
                      ) : (
                        <div className="flex flex-1 flex-wrap items-center gap-x-6 gap-y-1 font-mono text-xs text-muted">
                          <span>
                            {t("create.tvl")} <b className="text-foreground/80">{formatUsdCompact(p.tvlUsd)}</b>
                          </span>
                          <span>
                            {t("create.recentVolume")} <b className="text-foreground/80">{formatUsdCompact(p.volumeStable)}</b>
                          </span>
                          <span>
                            {t("create.recentSwaps")} <b className="text-foreground/80">{p.swapCount}</b>
                          </span>
                          <span>
                            {t("create.feePerLiquidity")}{" "}
                            <b className="text-foreground/80">
                              {p.feeRevenuePerLiquidity !== undefined ? p.feeRevenuePerLiquidity.toExponential(2) : "—"}
                            </b>
                          </span>
                        </div>
                      )}

                      {isSelected && (
                        <span className="shrink-0 font-mono text-[10px] uppercase text-accent-text">{t("create.chosen")}</span>
                      )}
                    </button>

                    {p.exists && (
                      <div className="flex shrink-0 items-center gap-2 border-hairline/50 pl-0 font-mono text-[10px] text-faint sm:border-l sm:pl-4">
                        <button
                          type="button"
                          onClick={async () => {
                            await navigator.clipboard.writeText(p.pool);
                            setCopiedPool(p.pool);
                            setTimeout(() => setCopiedPool((cur) => (cur === p.pool ? null : cur)), 1500);
                          }}
                          className="transition-colors hover:text-accent-text"
                          title={t("create.copyPoolAddress")}
                        >
                          {copiedPool === p.pool ? t("create.copied") : `${p.pool.slice(0, 6)}…${p.pool.slice(-4)}`}
                        </button>
                        <a
                          href={`${chain.explorerBaseUrl}/address/${p.pool}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="transition-colors hover:text-accent-text"
                          title={t("create.viewExplorer")}
                        >
                          ↗
                        </a>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!effectiveFactoryAddress && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            {t("create.contractsNotDeployed", { chain: chain.name })}
          </div>
        )}

        {resumableVaultAddress && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5">
            <p className="text-sm text-foreground/90">
              {t("create.resumeBannerText", { address: resumableVaultAddress })}
            </p>
            <button
              type="button"
              onClick={() => handleCreate(resumableVaultAddress)}
              disabled={busy}
              className="btn-secondary mt-3 !px-4 !py-2"
            >
              {t("create.resumeBannerButton")}
            </button>
          </div>
        )}

        {isConnected ? (
          <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_360px]">
            {/* Form */}
            <div className="glass rounded-2xl p-6 sm:p-8">
              <div className="grid gap-6 sm:grid-cols-2">
                <Field
                  label={t("create.fieldInvestAmount")}
                  suffix={isCompound ? undefined : chain.stableSymbol}
                  topSlot={
                    isCompound ? (
                      <DepositTokenSelector
                        size="field"
                        tokens={depositTokenOptions}
                        selected={investDepositToken}
                        onSelect={setInvestDepositToken}
                        balances={depositTokenBalancesUsd}
                      />
                    ) : undefined
                  }
                  value={investAmount}
                  onChange={setInvestAmount}
                  placeholder={`${t("create.exampleLabel")} 100`}
                  hint={`${t("create.exampleLabel")} 100 ${investTokenMeta.displaySymbol}`}
                />
                <Field
                  label={t("create.fieldMinPrice")}
                  suffix="USD"
                  value={minPrice}
                  onChange={setMinPrice}
                  placeholder={`${t("create.exampleLabel")} ${minPricePlaceholder}`}
                  hint={`${t("create.fieldMinPriceHint")} · ${t("create.exampleLabel")} $${minPricePlaceholder}`}
                />
                <Field
                  label={t("create.fieldMaxPrice")}
                  suffix="USD"
                  value={maxPrice}
                  onChange={setMaxPrice}
                  placeholder={`${t("create.exampleLabel")} ${maxPricePlaceholder}`}
                  hint={`${t("create.fieldMaxPriceHint")} · ${t("create.exampleLabel")} $${maxPricePlaceholder}`}
                />
                {chain.supportsGasReserve && (
                  <Field
                    label={
                      <>
                        {t("create.fieldGasReservePre")}
                        <span className="text-accent-text">{t("create.fieldGasReserveHighlight")}</span>
                      </>
                    }
                    suffix={isCompound ? undefined : chain.stableSymbol}
                    topSlot={
                      isCompound ? (
                        <DepositTokenSelector
                          size="field"
                          tokens={depositTokenOptions}
                          selected={gasReserveDepositToken}
                          onSelect={setGasReserveDepositToken}
                          balances={depositTokenBalancesUsd}
                        />
                      ) : undefined
                    }
                    value={gasReserveAmount}
                    onChange={setGasReserveAmount}
                    placeholder={`${t("create.exampleLabel")} 5`}
                    hint={`${t("create.fieldGasReserveHint")} ${t("create.exampleLabel")} 5 ${gasReserveTokenMeta.displaySymbol}`}
                  />
                )}
              </div>

              {sliderDomain && currentPrice !== undefined && (
                <PriceRangeSlider
                  domainLo={sliderDomain.lo}
                  domainHi={sliderDomain.hi}
                  lower={lowerPreview ?? currentPrice * 0.9}
                  upper={upperPreview ?? currentPrice * 1.1}
                  current={currentPrice}
                  composition={rangeComposition}
                  stableSymbol={chain.stableSymbol}
                  volatileSymbol={chain.volatileSymbol}
                  onChangeLower={(v) => setMinPrice(v.toFixed(2))}
                  onChangeUpper={(v) => setMaxPrice(v.toFixed(2))}
                  t={t}
                />
              )}

              <div className="mt-8">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="flex items-center gap-2 font-mono text-sm uppercase tracking-[0.16em] text-foreground transition-colors hover:text-accent-text"
                >
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    className={`shrink-0 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  >
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  {t("create.advancedToggle")}
                </button>
                {showAdvanced && (
                  <div className="mt-4 grid gap-6 sm:grid-cols-2">
                    <Field
                      label={t("create.fieldRecenterMargin")}
                      suffix="%"
                      value={recenterMarginPct}
                      onChange={setRecenterMarginPct}
                      placeholder="5"
                      hint={t("create.fieldRecenterMarginHint")}
                    />
                    <Field
                      label={t("create.fieldExitTopMargin")}
                      suffix="%"
                      value={exitTopCeilingMarginPct}
                      onChange={setExitTopCeilingMarginPct}
                      placeholder="3"
                      hint={t("create.fieldExitTopMarginHint")}
                    />
                    <Field
                      label={t("create.fieldMaxRebalances")}
                      value={maxRebalances}
                      onChange={setMaxRebalances}
                      placeholder="1000"
                      hint={t("create.fieldMaxRebalancesHint")}
                    />
                    <Field
                      label={t("create.fieldReserve")}
                      suffix={isCompound ? undefined : chain.stableSymbol}
                      topSlot={
                        isCompound ? (
                          <DepositTokenSelector
                            size="field"
                            tokens={depositTokenOptions}
                            selected={reserveDepositToken}
                            onSelect={setReserveDepositToken}
                            balances={depositTokenBalancesUsd}
                          />
                        ) : undefined
                      }
                      value={reserveAmount}
                      onChange={setReserveAmount}
                      placeholder="0"
                      hint={t("create.fieldReserveHint")}
                    />
                    <Field
                      label={t("create.fieldReinjection", { symbol: chain.stableSymbol })}
                      suffix={chain.stableSymbol}
                      value={reinjectionAmount}
                      onChange={setReinjectionAmount}
                      placeholder="0"
                      hint={t("create.fieldReinjectionHint")}
                    />
                  </div>
                )}
              </div>

              <button
                onClick={() => handleCreate()}
                disabled={busy || !effectiveFactoryAddress || insufficientBalance || quoteLoading || Boolean(quoteErrored)}
                className="btn-primary mt-8 w-full"
              >
                {stepLabel[step]}
              </button>

              {insufficientDetails.map((d) => (
                <p key={d.symbol} className="mt-3 text-center text-sm text-negative">
                  {t("create.insufficientBalanceMsg", {
                    missing: (d.needed - d.balance).toFixed(2),
                    symbol: d.symbol,
                    balance: d.balance.toFixed(2),
                    total: d.needed.toFixed(2),
                    fee: formatUnits(creationFeeUsdt, 6),
                  })}
                </p>
              ))}
              {!insufficientBalance && quoteLoading && (
                <p className="mt-3 text-center text-sm text-faint">{t("create.quoteLoadingMsg")}</p>
              )}
              {!insufficientBalance && quoteErrored && (
                <p className="mt-3 text-center text-sm text-negative">
                  {t("create.quoteErrorMsg", { symbol: quoteErrored.meta.displaySymbol })}
                </p>
              )}
              {busy && isSafeApp && safeConfirmations && (
                <p className="mt-3 text-center text-sm text-accent-text">
                  {t("create.safeWaitingMsg", {
                    submitted: String(safeConfirmations.submitted),
                    required: String(safeConfirmations.required),
                  })}
                </p>
              )}
              {busy && !(isSafeApp && safeConfirmations) && (
                <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  {t("create.signEach", { count: String(SIGNATURE_STEPS.length) })}
                </p>
              )}
              {error && <p className="mt-4 break-all text-sm text-negative">{error}</p>}

              <div className="mt-6">
                <SignatureStepper current={step} failedAt={failedAt} steps={SIGNATURE_STEPS} keys={SIGNATURE_KEYS} />
              </div>
            </div>

            {/* Live summary */}
            <aside className="flex flex-col gap-4">
              <div className="glass rounded-2xl border-accent/35 bg-accent/[0.06] p-6">
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent-text">
                  {t("create.summaryTitle")}
                </span>
                <dl className="mt-4 flex flex-col gap-3 text-sm">
                  <SummaryRow k={t("create.summaryPoolChosen")} v={`${selectedFee / 10_000}%`} />
                  <SummaryRow
                    k={t("create.summaryCurrentPrice")}
                    v={currentPrice !== undefined ? `$${currentPrice.toFixed(2)}` : "…"}
                  />
                  <SummaryRow
                    k={t("create.summaryEstRange")}
                    v={
                      lowerPreview !== undefined && upperPreview !== undefined
                        ? `$${lowerPreview.toFixed(0)} – $${upperPreview.toFixed(0)}`
                        : "…"
                    }
                  />
                  <SummaryRow
                    k={t("create.summaryRangeWidth")}
                    v={rangeWidthPct !== undefined ? `${rangeWidthPct.toFixed(1)}%` : "…"}
                  />
                  <SummaryRow
                    k={t("create.summaryPoolType")}
                    v={
                      poolType ? (
                        <span
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold"
                          style={{ backgroundColor: `${poolType.color}26`, color: poolType.color }}
                        >
                          <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: poolType.color }} />
                          {poolType.label}
                        </span>
                      ) : (
                        "…"
                      )
                    }
                  />
                  <div className="-mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {POOL_TYPES.map((pt) => (
                      <span key={pt.labelKey} className="inline-flex items-center gap-1 text-[11px] text-faint">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: pt.color }} />
                        {t(pt.labelKey)} {pt.range}
                      </span>
                    ))}
                  </div>
                  <SummaryRow
                    k={t("create.summaryComposition")}
                    v={
                      rangeComposition
                        ? `${rangeComposition.stablePct.toFixed(0)}% ${chain.stableSymbol} · ${rangeComposition.volatilePct.toFixed(0)}% ${chain.volatileSymbol} (${rangeComposition.volatileQty.toFixed(4)} ${chain.volatileSymbol})`
                        : "…"
                    }
                  />
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k={t("create.summaryInvestable")} v={`${investAmount || "0"} ${chain.stableSymbol}`} />
                  <SummaryRow k={t("create.summaryReserve")} v={`${reserveAmount || "0"} ${chain.stableSymbol}`} />
                  {chain.supportsGasReserve && (
                    <SummaryRow k={t("create.summaryGasBudget")} v={`${gasReserveAmount || "0"} ${chain.stableSymbol}`} />
                  )}
                  {creationFeeUsdt > 0n && (
                    <SummaryRow
                      k={t("create.summaryCreationFee")}
                      v={`${formatUnits(creationFeeUsdt, 6)} ${chain.stableSymbol}`}
                    />
                  )}
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k={t("create.summaryTotal")} v={`${totalUsdt.toFixed(2)} ${chain.stableSymbol}`} strong />
                  {maxDepositUsd > 0n && (
                    <SummaryRow
                      k={t("create.summaryPlatformCap")}
                      v={`${formatUnits(maxDepositUsd, 6)} ${chain.stableSymbol}`}
                    />
                  )}
                </dl>
              </div>
            </aside>
          </div>
        ) : (
          <div className="glass mt-10 rounded-2xl p-10 text-center">
            <p className="text-muted">{t("create.connectWallet")}</p>
          </div>
        )}
      </main>
    </>
  );
}

// Two-handle drag slider over [domainLo, domainHi], bidirectionally wired to
// the Precio mínimo/máximo text fields via onChangeLower/onChangeUpper —
// dragging a handle writes straight into the same state those inputs read
// from, and typing in the inputs moves the handle back (this component has
// no state of its own, it's a pure view over lower/upper/current).
function PriceRangeSlider({
  domainLo,
  domainHi,
  lower,
  upper,
  current,
  composition,
  stableSymbol,
  volatileSymbol,
  onChangeLower,
  onChangeUpper,
  t,
}: {
  domainLo: number;
  domainHi: number;
  lower: number | undefined;
  upper: number | undefined;
  current: number | undefined;
  composition: { stablePct: number; volatilePct: number; volatileQty: number } | undefined;
  stableSymbol: string;
  volatileSymbol: string;
  onChangeLower: (v: number) => void;
  onChangeUpper: (v: number) => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = domainHi - domainLo;
  const rangeWidthPct = upper !== undefined && lower !== undefined && upper > 0 ? ((upper - lower) / upper) * 100 : undefined;

  const priceFromClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track || span <= 0) return domainLo;
    const rect = track.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return domainLo + pct * span;
  };

  const startDrag = (handle: "lower" | "upper") => (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const minGap = span * 0.01;
    const move = (ev: PointerEvent) => {
      const price = priceFromClientX(ev.clientX);
      if (handle === "lower") {
        const cap = upper !== undefined ? upper - minGap : domainHi;
        onChangeLower(Math.max(domainLo, Math.min(price, cap)));
      } else {
        const floor = lower !== undefined ? lower + minGap : domainLo;
        onChangeUpper(Math.min(domainHi, Math.max(price, floor)));
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const toPct = (v: number) => (span > 0 ? Math.min(100, Math.max(0, ((v - domainLo) / span) * 100)) : 0);
  const lowerPct = lower !== undefined ? toPct(lower) : undefined;
  const upperPct = upper !== undefined ? toPct(upper) : undefined;
  const currentPct = current !== undefined ? toPct(current) : undefined;

  const Handle = ({ pct, label, onPointerDown }: { pct: number; label: string; onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void }) => (
    <div
      role="slider"
      aria-label={label}
      tabIndex={0}
      onPointerDown={onPointerDown}
      className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-background bg-accent active:cursor-grabbing"
      style={{ left: `${pct}%` }}
    />
  );

  return (
    <div className="mt-8">
      <div className="flex flex-col items-center text-center">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-foreground">
          {t("positionNft.priceRange")}
        </span>
        {rangeWidthPct !== undefined && (
          <span className="mt-1 font-mono text-[11px] uppercase tracking-[0.16em] text-accent-text">
            {rangeWidthPct.toFixed(2)}% {t("positionNft.rangeWidth")}
          </span>
        )}
      </div>
      <div className="relative mt-9 pt-10" ref={trackRef}>
        {currentPct !== undefined && (
          <div
            className="pointer-events-none absolute top-0 flex -translate-x-1/2 flex-col items-center"
            style={{ left: `${currentPct}%` }}
          >
            <span className="whitespace-nowrap rounded-md bg-foreground/10 px-3 py-1 font-mono text-base font-semibold text-foreground">
              ${current!.toFixed(2)}
            </span>
            <span className="h-2 w-px" style={{ backgroundColor: "var(--positive)" }} />
          </div>
        )}
        <div className="relative h-1.5 w-full rounded-full bg-foreground/10">
          {lowerPct !== undefined && upperPct !== undefined && (
            <div
              className="absolute top-0 h-full rounded-full bg-accent/60"
              style={{ left: `${lowerPct}%`, width: `${Math.max(0, upperPct - lowerPct)}%` }}
            />
          )}
          {lowerPct !== undefined && (
            <Handle pct={lowerPct} label={t("create.fieldMinPrice")} onPointerDown={startDrag("lower")} />
          )}
          {upperPct !== undefined && (
            <Handle pct={upperPct} label={t("create.fieldMaxPrice")} onPointerDown={startDrag("upper")} />
          )}
          {currentPct !== undefined && (
            <div
              className="pointer-events-none absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2"
              style={{ left: `${currentPct}%`, backgroundColor: "var(--positive)", borderColor: "var(--background)" }}
            />
          )}
        </div>
      </div>
      <div className="mt-2 flex items-baseline justify-between text-sm">
        <span className="text-foreground/90">
          {t("positionNft.min")}{" "}
          <span className="font-semibold">{lower !== undefined ? `$${lower.toFixed(2)}` : "…"}</span>
        </span>
        <span className="text-foreground/90">
          {t("positionNft.max")}{" "}
          <span className="font-semibold">{upper !== undefined ? `$${upper.toFixed(2)}` : "…"}</span>
        </span>
      </div>
      {current !== undefined && (
        <p className="mt-2 text-center text-xs text-faint">
          {stableSymbol}/{volatileSymbol}
        </p>
      )}
      <p className="mt-3 whitespace-nowrap text-center text-sm text-foreground/80">
        <span className="text-faint">{t("create.summaryComposition")}: </span>
        {composition
          ? `${composition.stablePct.toFixed(0)}% ${stableSymbol} · ${composition.volatilePct.toFixed(0)}% ${volatileSymbol} (${composition.volatileQty.toFixed(4)} ${volatileSymbol})`
          : "…"}
      </p>
      <p className="mt-4 rounded-xl border border-accent/20 bg-accent/[0.05] px-3 py-2 text-center text-xs leading-relaxed text-foreground/70">
        <span className="font-semibold text-accent-text">{t("create.compositionTipLabel")}</span>{" "}
        {t("create.compositionTipBody", { stableSymbol, volatileSymbol })}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
  placeholder,
  topSlot,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
  placeholder?: string;
  // Rendered between the label and the input itself — the deposit-token
  // selector lives here (above the field, its own row) rather than
  // overlapping the input as a suffix, so its chips have room to breathe and
  // never compete for space/clicks with the typed amount.
  topSlot?: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
      {topSlot}
      <div className="relative">
        <input
          className="field-input"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="decimal"
        />
        {suffix && (
          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center font-mono text-xs text-faint">
            {suffix}
          </span>
        )}
      </div>
      {hint && <span className="text-xs text-faint">{hint}</span>}
    </label>
  );
}

function SummaryRow({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className={strong ? "font-semibold text-accent-text" : "font-medium text-foreground/90"}>{v}</dd>
    </div>
  );
}

/** Shows the 5 signatures the wallet will ask for, what each one does, and —
 * once the flow starts — which one is in progress / done / where it failed.
 * Visible from before the user even clicks "Crear vault", not just mid-flow. */
function SignatureStepper({
  current,
  failedAt,
  steps,
  keys,
}: {
  current: Step;
  failedAt: Step | null;
  steps: ReturnType<typeof signatureStepsFor>;
  keys: Step[];
}) {
  const currentIndex = keys.indexOf(current);
  const isDone = current === "done";
  const isError = current === "error";
  const failedIndex = failedAt ? keys.indexOf(failedAt) : -1;
  const { t } = useTranslation();

  return (
    <div className="glass rounded-2xl p-5">
      <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">
        {t("create.requiredSignatures", { count: String(steps.length) })}
      </span>
      <ol className="mt-4 flex flex-col gap-4">
        {steps.map((s, i) => {
          const done = isDone || i < currentIndex || (isError && i < failedIndex);
          const failed = isError && i === failedIndex;
          const active = !isDone && !isError && i === currentIndex;
          return (
            <li key={s.key} className="flex gap-3">
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
                  failed
                    ? "bg-negative/20 text-negative"
                    : done
                      ? "bg-accent text-black"
                      : active
                        ? "border border-accent text-accent-text"
                        : "border border-hairline text-faint"
                }`}
              >
                {failed ? "!" : done ? "✓" : i + 1}
              </span>
              <div>
                <p className={`text-sm font-medium ${active ? "text-accent-text" : "text-foreground/90"}`}>{s.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{s.desc}</p>
                {failed && <p className="mt-1 text-xs text-negative">{t("create.failedHere")}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
