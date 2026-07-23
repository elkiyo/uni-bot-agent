"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useSwitchChain,
} from "wagmi";
import { decodeEventLog, encodeFunctionData, formatUnits, parseUnits } from "viem";
import SafeAppsSDK, { type GatewayTransactionDetails } from "@safe-global/safe-apps-sdk";
import { Header } from "../components/Header";
import { AlertModal } from "../components/AlertModal";
import { erc20Abi, uniswapV3PoolAbi, platformConfigAbi } from "@/lib/contracts";
import { ethPriceFromTick, tickFromEthPrice, alignToTickSpacing } from "@/lib/priceMath";
import { usePoolMetrics } from "@/lib/usePoolMetrics";
import { useSelectedChain, useAvailableChains } from "@/lib/useSelectedChain";
import { formatUsdCompact } from "@/lib/format";
import { useTranslation } from "@/lib/i18n/useTranslation";

// "batching" only ever happens on the Safe App path (see isSafeApp below) —
// approve/configureTarget/setRiskParams/deposit collapsed into one Safe
// transaction instead of 4 separate signature rounds.
type Step = "idle" | "creating" | "approving" | "configuring" | "risk" | "depositing" | "batching" | "done" | "error";
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

function stepLabelFor(t: T, stableSymbol: string): Record<Step, string> {
  return {
    idle: t("create.stepIdle"),
    creating: t("create.stepCreating"),
    approving: t("create.stepApproving", { symbol: stableSymbol }),
    configuring: t("create.stepConfiguring"),
    risk: t("create.stepRisk"),
    depositing: t("create.stepDepositing"),
    batching: t("create.stepBatching"),
    done: t("create.stepDone"),
    error: t("create.stepError"),
  };
}

// The 5 signatures the wallet is going to ask for, in order — shown as a
// checklist so the user knows what each one actually does before signing,
// not just a changing "3/5…" label on the button mid-flow.
function signatureStepsFor(
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
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { t } = useTranslation();

  // @reown/appkit-adapter-wagmi auto-adds wagmi's `safe` connector whenever
  // it detects it's running inside a Safe{Wallet} iframe (app.safe.global) —
  // see manifest.json's own comment in next.config.ts. That's what makes
  // this connector id available to check here at all.
  const isSafeApp = connector?.id === "safe";
  const safeSdk = useMemo(() => (isSafeApp ? new SafeAppsSDK() : null), [isSafeApp]);
  const [safeConfirmations, setSafeConfirmations] = useState<{ submitted: number; required: number } | null>(null);

  const stepLabel = stepLabelFor(t, chain.stableSymbol);
  const SIGNATURE_STEPS = isSafeApp
    ? safeSignatureStepsFor(t, chain.stableSymbol)
    : signatureStepsFor(t, chain.stableSymbol);
  const SIGNATURE_KEYS = SIGNATURE_STEPS.map((s) => s.key);

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
  useEffect(() => {
    setSelectedFee(chain.feeTier);
  }, [chain.id]);
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
    query: { enabled: Boolean(address), refetchInterval: 15_000 },
  });
  const stableBalanceUsd =
    stableBalanceRaw !== undefined ? Number(formatUnits(stableBalanceRaw as bigint, 6)) : undefined;

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
  const [maxRebalances, setMaxRebalances] = useState("");
  const [reinjectionAmount, setReinjectionAmount] = useState("");
  const [periodicHours, setPeriodicHours] = useState("");
  // Only meaningful on chains whose vault has a dedicated gasReserveBalance
  // ledger (RangeVaultArb — see chains.ts's supportsGasReserve) — optional,
  // blank = 0: the keeper gas reimbursement never blocks a rebalance even
  // with zero budget (see RangeVaultArb.sol), it just reimburses nothing
  // until the owner tops this up.
  const [gasReserveAmount, setGasReserveAmount] = useState("");

  // Advanced / risk knobs — unlike the fields above, these DO have sensible
  // platform defaults (same values that used to be hardcoded here), so
  // leaving them blank is a valid choice, not an error. See RangeVault.sol
  // for what each one actually gates.
  const [maxSlippagePct, setMaxSlippagePct] = useState("");
  const [minRebalanceCooldownHours, setMinRebalanceCooldownHours] = useState("");
  const [maxRangeDeviationTicks, setMaxRangeDeviationTicks] = useState("");
  const [recenterMarginPct, setRecenterMarginPct] = useState("");
  const [exitTopCeilingMarginPct, setExitTopCeilingMarginPct] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [copiedPool, setCopiedPool] = useState<string | null>(null);

  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [failedAt, setFailedAt] = useState<Step | null>(null);

  const minPricePlaceholder = currentPrice !== undefined ? (currentPrice * 0.9).toFixed(2) : "1604.18";
  const maxPricePlaceholder = currentPrice !== undefined ? (currentPrice * 1.1).toFixed(2) : "1960.66";

  const totalUsdt =
    (parseFloat(investAmount) || 0) +
    (parseFloat(reinjectionAmount) || 0) +
    (chain.supportsGasReserve ? parseFloat(gasReserveAmount) || 0 : 0) +
    Number(formatUnits(creationFeeUsdt, 6));
  const lowerPreview = parseFloat(minPrice) || undefined;
  const upperPreview = parseFloat(maxPrice) || undefined;

  // Only a real "insufficient funds" once there's an actual balance reading
  // AND the user has typed a real amount — otherwise every fresh page load
  // (totalUsdt === creationFeeUsdt only, balance still loading) would flash
  // the button disabled before either value is meaningful.
  const insufficientBalance =
    Boolean(investAmount) && stableBalanceUsd !== undefined && totalUsdt > stableBalanceUsd;

  async function handleCreate(resumeVaultAddress?: `0x${string}`) {
    if (!address || !publicClient || currentPrice === undefined || tickSpacing === undefined) return;
    setError(null);
    setFailedAt(null);
    setSafeConfirmations(null);
    let currentPhase: Step = "creating"; // tracked outside React state — setStep() batches, so `step` itself isn't reliable to read back mid-function

    if (!investAmount || !minPrice || !maxPrice || !maxRebalances || !reinjectionAmount || !periodicHours) {
      setError(t("create.errMissingFields"));
      setStep("error");
      return;
    }

    // Same check RangeVault.deposit() itself makes (reserveAmount +
    // investableAmount vs PlatformConfig.maxDepositUsd, fee excluded) — catch
    // it here so the wallet never even pops up for a deposit that's certain
    // to revert on-chain. Confirmed in production 2026-07-17: a user hit
    // DepositExceedsPlatformCap with no explanation, just a raw revert.
    const requestedTotalUsd =
      (parseFloat(investAmount) || 0) +
      (parseFloat(reinjectionAmount) || 0) +
      (chain.supportsGasReserve ? parseFloat(gasReserveAmount) || 0 : 0);
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

    // Balance real de la wallet en el token con el que se crea el vault —
    // capital invertible + reserva + presupuesto de gas + el fee de creación
    // (se cobra una sola vez, al primer depósito, pero la aprobación tiene
    // que cubrirlo igual — ver el approve() más abajo). Sin esto, la wallet
    // se abre igual y el usuario se entera de que le faltan fondos recién
    // cuando el deposit() revierte on-chain.
    if (stableBalanceUsd !== undefined && totalUsdt > stableBalanceUsd) {
      setBalanceAlert(
        t("create.balanceAlertMsg", {
          total: totalUsdt.toFixed(2),
          symbol: chain.stableSymbol,
          gasClause: chain.supportsGasReserve ? t("create.balanceAlertGasClause") : "",
          fee: formatUnits(creationFeeUsdt, 6),
          balance: stableBalanceUsd.toFixed(2),
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
          address: chain.factoryAddress || "0x0000000000000000000000000000000000000000",
          abi: chain.factoryAbi,
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
            const decoded = decodeEventLog({ abi: chain.factoryAbi, data: log.data, topics: log.topics });
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

      const investable = parseUnits(investAmount, 6);
      const reserve = parseUnits(reinjectionAmount, 6);
      const gasReserve = chain.supportsGasReserve ? parseUnits(gasReserveAmount || "0", 6) : 0n;
      const total = investable + reserve + gasReserve;

      // Blank = platform default, same values this form used to hardcode —
      // see the field hints for what each one does.
      const recenterMarginBps = recenterMarginPct ? BigInt(Math.round(Number(recenterMarginPct) * 100)) : 500n;
      const exitTopCeilingMarginBps = exitTopCeilingMarginPct
        ? BigInt(Math.round(Number(exitTopCeilingMarginPct) * 100))
        : 300n;
      const maxSlippageBps = maxSlippagePct ? BigInt(Math.round(Number(maxSlippagePct) * 100)) : 30n;
      const minRebalanceIntervalSec = minRebalanceCooldownHours
        ? BigInt(Math.round(Number(minRebalanceCooldownHours) * 3600))
        : 0n;
      const maxRangeDeviationBps = maxRangeDeviationTicks ? BigInt(maxRangeDeviationTicks) : 5_000n;
      const depositArgs: readonly bigint[] = chain.supportsGasReserve
        ? [reserve, investable, gasReserve]
        : [reserve, investable];

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
            to: chain.stableToken,
            value: "0",
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [vaultAddress, total + creationFeeUsdt],
            }),
          },
          {
            to: vaultAddress,
            value: "0",
            data: encodeFunctionData({
              abi: chain.vaultAbi,
              functionName: "configureTarget",
              args: [
                parseUnits(investAmount, 6),
                targetTickLower,
                targetTickUpper,
                BigInt(maxRebalances),
                reserve,
                BigInt(Number(periodicHours) * 3600),
                recenterMarginBps,
                exitTopCeilingMarginBps,
              ],
            }),
          },
          {
            to: vaultAddress,
            value: "0",
            data: encodeFunctionData({
              abi: chain.vaultAbi,
              functionName: "setRiskParams",
              args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
            }),
          },
          {
            to: vaultAddress,
            value: "0",
            data: encodeFunctionData({ abi: chain.vaultAbi, functionName: "deposit", args: depositArgs }),
          },
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
        currentPhase = "approving";
        setStep(currentPhase);
        // Approve total + creationFeeUsdt — deposit() pulls the one-time creation
        // fee on top of investable+reserve on a vault's first deposit (see
        // RangeVault.sol), so the approval has to cover it too or that call reverts.
        const approveHash = await writeContractAsync({
          address: chain.stableToken,
          abi: erc20Abi,
          functionName: "approve",
          args: [vaultAddress, total + creationFeeUsdt],
          chainId: chain.id,
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        currentPhase = "configuring";
        setStep(currentPhase);
        const configureHash = await writeContractAsync({
          address: vaultAddress,
          abi: chain.vaultAbi,
          functionName: "configureTarget",
          args: [
            parseUnits(investAmount, 6),
            targetTickLower,
            targetTickUpper,
            BigInt(maxRebalances),
            reserve,
            BigInt(Number(periodicHours) * 3600),
            recenterMarginBps,
            exitTopCeilingMarginBps,
          ],
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
          abi: chain.vaultAbi,
          functionName: "setRiskParams",
          args: [maxSlippageBps, minRebalanceIntervalSec, maxRangeDeviationBps],
          chainId: chain.id,
        });
        await publicClient.waitForTransactionReceipt({ hash: riskHash });

        currentPhase = "depositing";
        setStep(currentPhase);
        const depositHash = await writeContractAsync({
          address: vaultAddress,
          abi: chain.vaultAbi,
          functionName: "deposit",
          // RangeVaultArb's deposit() takes a 3rd gasReserveAmount arg that the
          // original RangeVault.sol doesn't have — chain.vaultAbi already
          // reflects whichever contract this chain actually runs (see
          // chains.ts), so the arg count has to match it exactly.
          args: depositArgs,
          chainId: chain.id,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositHash });
      }

      setStep("done");
      router.push(`/vault/${vaultAddress}`);
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
            {availableChains.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedChainId(c.id)}
                className={
                  c.id === chain.id
                    ? "rounded-full border border-accent bg-accent/[0.08] px-3 py-1.5 text-sm font-medium text-accent"
                    : "rounded-full border border-hairline px-3 py-1.5 text-sm text-white/70 transition-colors hover:border-accent/50 hover:text-white"
                }
              >
                {c.name}
              </button>
            ))}
          </div>
        )}

        {isConnected && (
          <div className="glass mt-8 rounded-2xl p-6 sm:p-8">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
              {t("create.choosePoolLabel")}
            </span>
            <p className="mt-1 text-xs text-faint">{t("create.choosePoolHint")}</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {(poolMetrics ?? []).map((p) => {
                const isSelected = p.fee === selectedFee;
                const disabled = !p.exists || p.liquidity === 0n;
                return (
                  <div
                    key={p.fee}
                    className={`rounded-xl border p-4 transition ${
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
                      className="w-full text-left"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-sm font-semibold">{p.fee / 10_000}%</span>
                        {isSelected && <span className="font-mono text-[10px] uppercase text-accent">{t("create.chosen")}</span>}
                      </div>
                      {disabled ? (
                        <p className="mt-2 text-xs text-faint">{t("create.noLiquidity")}</p>
                      ) : (
                        <dl className="mt-2 flex flex-col gap-1 text-xs text-muted">
                          <div className="flex justify-between">
                            <dt>{t("create.tvl")}</dt>
                            <dd className="font-mono">{formatUsdCompact(p.tvlUsd)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>{t("create.liquidity")}</dt>
                            <dd className="font-mono" title={p.liquidity.toString()}>
                              {Number(p.liquidity).toExponential(2)}
                            </dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>{t("create.recentVolume")}</dt>
                            <dd className="font-mono">{formatUsdCompact(p.volumeStable)}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>{t("create.recentSwaps")}</dt>
                            <dd className="font-mono">{p.swapCount}</dd>
                          </div>
                          <div className="flex justify-between">
                            <dt>{t("create.feePerLiquidity")}</dt>
                            <dd className="font-mono">
                              {p.feeRevenuePerLiquidity !== undefined
                                ? p.feeRevenuePerLiquidity.toExponential(2)
                                : "—"}
                            </dd>
                          </div>
                        </dl>
                      )}
                    </button>

                    {p.exists && (
                      <div className="mt-3 flex items-center justify-between border-t border-hairline/50 pt-3">
                        <span className="eyebrow !px-2 !py-0.5 !text-[9px]">V3</span>
                        <div className="flex items-center gap-2 font-mono text-[10px] text-faint">
                          <button
                            type="button"
                            onClick={async () => {
                              await navigator.clipboard.writeText(p.pool);
                              setCopiedPool(p.pool);
                              setTimeout(() => setCopiedPool((cur) => (cur === p.pool ? null : cur)), 1500);
                            }}
                            className="transition-colors hover:text-accent"
                            title={t("create.copyPoolAddress")}
                          >
                            {copiedPool === p.pool
                              ? t("create.copied")
                              : `${p.pool.slice(0, 6)}…${p.pool.slice(-4)}`}
                          </button>
                          <a
                            href={`${chain.explorerBaseUrl}/address/${p.pool}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="transition-colors hover:text-accent"
                            title={t("create.viewExplorer")}
                          >
                            ↗
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!chain.factoryAddress && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5 text-sm text-muted">
            {t("create.contractsNotDeployed", { chain: chain.name })}
          </div>
        )}

        {resumableVaultAddress && (
          <div className="glass mt-8 rounded-2xl border-accent/35 bg-accent/[0.06] p-5">
            <p className="text-sm text-white/90">
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
                  suffix={chain.stableSymbol}
                  value={investAmount}
                  onChange={setInvestAmount}
                  placeholder="100"
                />
                <Field
                  label={t("create.fieldMinPrice")}
                  suffix="USD"
                  value={minPrice}
                  onChange={setMinPrice}
                  placeholder={minPricePlaceholder}
                  hint={t("create.fieldMinPriceHint")}
                />
                <Field
                  label={t("create.fieldMaxPrice")}
                  suffix="USD"
                  value={maxPrice}
                  onChange={setMaxPrice}
                  placeholder={maxPricePlaceholder}
                  hint={t("create.fieldMaxPriceHint")}
                />
                <Field
                  label={t("create.fieldMaxRebalances")}
                  value={maxRebalances}
                  onChange={setMaxRebalances}
                  placeholder="10"
                  hint={t("create.fieldMaxRebalancesHint")}
                />
                <Field
                  label={t("create.fieldReinjection")}
                  suffix={chain.stableSymbol}
                  value={reinjectionAmount}
                  onChange={setReinjectionAmount}
                  placeholder="10"
                  hint={t("create.fieldReinjectionHint")}
                />
                <Field
                  label={t("create.fieldPeriodic")}
                  suffix={t("create.hoursSuffix")}
                  value={periodicHours}
                  onChange={setPeriodicHours}
                  placeholder="24"
                />
                {chain.supportsGasReserve && (
                  <Field
                    label={
                      <>
                        {t("create.fieldGasReservePre")}
                        <span className="text-accent">{t("create.fieldGasReserveHighlight")}</span>
                      </>
                    }
                    suffix={chain.stableSymbol}
                    value={gasReserveAmount}
                    onChange={setGasReserveAmount}
                    placeholder="5"
                    hint={t("create.fieldGasReserveHint")}
                  />
                )}
              </div>

              <div className="mt-8">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted transition-colors hover:text-white"
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
                      label={t("create.fieldMaxSlippage")}
                      suffix="%"
                      value={maxSlippagePct}
                      onChange={setMaxSlippagePct}
                      placeholder="0.3"
                    />
                    <Field
                      label={t("create.fieldCooldown")}
                      suffix={t("create.hoursSuffix")}
                      value={minRebalanceCooldownHours}
                      onChange={setMinRebalanceCooldownHours}
                      placeholder="0"
                      hint={t("create.fieldCooldownHint")}
                    />
                    <Field
                      label={t("create.fieldMaxDeviation")}
                      suffix="ticks"
                      value={maxRangeDeviationTicks}
                      onChange={setMaxRangeDeviationTicks}
                      placeholder="5000"
                      hint={t("create.fieldMaxDeviationHint")}
                    />
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
                  </div>
                )}
              </div>

              <button
                onClick={() => handleCreate()}
                disabled={busy || !chain.factoryAddress || insufficientBalance}
                className="btn-primary mt-8 w-full"
              >
                {stepLabel[step]}
              </button>

              {insufficientBalance && (
                <p className="mt-3 text-center text-sm text-negative">
                  {t("create.insufficientBalanceMsg", {
                    missing: (totalUsdt - (stableBalanceUsd ?? 0)).toFixed(2),
                    symbol: chain.stableSymbol,
                    balance: (stableBalanceUsd ?? 0).toFixed(2),
                    total: totalUsdt.toFixed(2),
                    fee: formatUnits(creationFeeUsdt, 6),
                  })}
                </p>
              )}
              {busy && isSafeApp && safeConfirmations && (
                <p className="mt-3 text-center text-sm text-accent">
                  {t("create.safeWaitingMsg", {
                    submitted: String(safeConfirmations.submitted),
                    required: String(safeConfirmations.required),
                  })}
                </p>
              )}
              {busy && !(isSafeApp && safeConfirmations) && (
                <p className="mt-3 text-center font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
                  {t("create.signEach")}
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
                <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-accent">
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
                  <div className="my-1 border-t border-hairline" />
                  <SummaryRow k={t("create.summaryInvestable")} v={`${investAmount || "0"} ${chain.stableSymbol}`} />
                  <SummaryRow k={t("create.summaryReserve")} v={`${reinjectionAmount || "0"} ${chain.stableSymbol}`} />
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

              <div className="glass rounded-2xl p-5">
                <p className="text-[13px] leading-relaxed text-muted">{t("create.feeNote")}</p>
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

function Field({
  label,
  value,
  onChange,
  suffix,
  hint,
  placeholder,
}: {
  label: React.ReactNode;
  value: string;
  onChange: (v: string) => void;
  suffix?: string;
  hint?: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{label}</span>
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

function SummaryRow({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className={strong ? "font-semibold text-accent" : "font-medium text-white/90"}>{v}</dd>
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
        {t("create.requiredSignatures")}
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
                        ? "border border-accent text-accent"
                        : "border border-hairline text-faint"
                }`}
              >
                {failed ? "!" : done ? "✓" : i + 1}
              </span>
              <div>
                <p className={`text-sm font-medium ${active ? "text-accent" : "text-white/90"}`}>{s.title}</p>
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
