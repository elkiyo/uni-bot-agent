import { celo, arbitrum } from "viem/chains";
import type { Abi, Chain } from "viem";
import { rangeVaultAbi, vaultFactoryAbi, rangeVaultArbAbi, vaultFactoryArbAbi } from "./contracts";

// Per-chain config — the single source of truth every page/hook/keeper file
// should read from instead of hardcoding an address. Each chain's own
// addresses/pool/fee-tier choice is independent: RangeVault.sol treats
// token0 as "the pool's stablecoin leg" generically, never assuming USDT
// specifically, so different chains can pair the volatile leg (WETH on both,
// so far) against whatever stablecoin actually has the deepest pool there.
function computeStableIsToken0(stableToken: `0x${string}`, volatileToken: `0x${string}`): boolean {
  return BigInt(stableToken) < BigInt(volatileToken);
}

export interface ChainDef {
  id: number;
  viemChain: Chain;
  name: string;
  rpcUrl: string;
  stableToken: `0x${string}`;
  stableSymbol: string; // USDT on Celo, USDC on Arbitrum — for display copy
  volatileToken: `0x${string}`;
  volatileSymbol: string;
  pool: `0x${string}`; // the vault position's home pool
  feeTier: number;
  positionManager: `0x${string}`;
  swapRouter02: `0x${string}`;
  uniswapV3Factory: `0x${string}`;
  candidateSwapFeeTiers: readonly number[];
  factoryDeployBlock: bigint;
  factoryAddress: `0x${string}` | "";
  platformConfigAddress: `0x${string}` | "";
  explorerBaseUrl: string;
  // Uniswap V3 decides token0/token1 by raw address sort order, not by which
  // one is the stablecoin — true on Celo (USDT < WETH) but false on Arbitrum
  // (WETH < USDC). Every tick<->price conversion and every swap-direction
  // calculation needs this to know which side of a pool's token0/token1 is
  // actually the dollar leg. Computed below from the two addresses instead
  // of hand-typed, so it can never silently drift out of sync with them.
  // Confirmed in production 2026-07-17: code that assumed Celo's order
  // everywhere produced a target range on the opposite side of the real
  // price on Arbitrum, and passed token0/token1 out of order to
  // VaultFactory.createVault(), which made positionManager.mint() resolve to
  // the wrong pool address entirely — see RangeVault.sol's class docstring.
  stableIsToken0: boolean;
  // Below this many native tokens, the admin panel warns the operator is low
  // on gas — chain-relative, not a universal constant: 1 CELO (~$0.5-1) is a
  // sane buffer on Celo, but 1 ETH (~$3000+) on Arbitrum would never
  // realistically sit in a hot operator wallet and Arbitrum's gas is ~3
  // orders of magnitude cheaper per tx anyway. Confirmed 2026-07-17: the
  // operator's real 0.0043 ETH on Arbitrum is plenty for many rebalance
  // cycles, but a flat "< 1" threshold flagged it as critically low.
  lowGasThreshold: number;
  // Celo reads/writes against rangeVaultAbi/vaultFactoryAbi (RangeVault.sol/
  // VaultFactory.sol, unmodified); Arbitrum reads/writes against
  // rangeVaultArbAbi/vaultFactoryArbAbi (RangeVaultArb.sol/VaultFactoryArb.sol —
  // a deliberately separate contract, never merged into the Celo original —
  // see that file's class docstring). Every component should read the ABI off
  // the chain it's actually targeting instead of importing rangeVaultAbi directly.
  vaultAbi: Abi;
  factoryAbi: Abi;
  // Only RangeVaultArb has the dedicated gasReserveBalance ledger + 3-arg
  // deposit() — RangeVault.sol (Celo) still takes deposit(reserveAmount,
  // investableAmount), 2 args, no separate gas budget. Gates the extra
  // field in /create and VaultDetail.tsx so the deposit() call encodes the
  // right argument count for whichever contract this chain actually runs.
  supportsGasReserve: boolean;
}

// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls before being trusted here. Keep in sync with agent/src/addresses.ts
// and contracts/script/Deploy.s.sol.
const CELO_STABLE = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as const;
const CELO_VOLATILE = "0xD221812de1BD094f35587EE8E174B07B6167D9Af" as const;

const CELO: ChainDef = {
  id: celo.id,
  viemChain: celo,
  name: "Celo",
  rpcUrl: process.env.CELO_RPC_URL ?? "https://forno.celo.org",
  stableToken: CELO_STABLE,
  stableSymbol: "USDT",
  volatileToken: CELO_VOLATILE,
  volatileSymbol: "WETH",
  pool: "0x6F42B9D2085a0dEb711C00A460a98B9863ae4897", // USDT/WETH 0.3%
  feeTier: 3000,
  positionManager: "0x3d79EdAaBC0EaB6F08ED885C05Fc0B014290D95A",
  swapRouter02: "0x5615CDAb10dc425a742d643d949a7F474C01abc4",
  // Read from POOL.factory() and confirmed live 2026-07-17.
  uniswapV3Factory: "0xAfE208a311B21f13EF87E33A90049fC17A7acDEc",
  // Every USDT/WETH fee tier confirmed to exist on Celo mainnet (checked via
  // factory.getPool 2026-07-17): 0.01%, 0.05% (deployed but empty — 0
  // liquidity), 0.3% (POOL itself). No 1% pool exists for this pair.
  candidateSwapFeeTiers: [100, 500, 3000],
  // Block the current factory was deployed in (2026-07-16 — added
  // sweepIdleDust()). No vault event from THIS factory can precede it.
  factoryDeployBlock: 72269264n,
  factoryAddress: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS_CELO || "") as `0x${string}` | "",
  platformConfigAddress: (process.env.NEXT_PUBLIC_PLATFORM_CONFIG_ADDRESS_CELO || "") as `0x${string}` | "",
  explorerBaseUrl: "https://celoscan.io",
  lowGasThreshold: 1,
  stableIsToken0: computeStableIsToken0(CELO_STABLE, CELO_VOLATILE),
  vaultAbi: rangeVaultAbi,
  factoryAbi: vaultFactoryAbi,
  supportsGasReserve: false,
};

// Verified 2026-07-17: bytecode-checked directly on-chain (not doc-scraped),
// and USDC/WETH's 0.05% pool confirmed as the pair's deepest liquidity on
// Arbitrum (~2.70e18, ~5x the next-deepest tier, ~190x Celo's own USDT/WETH
// 0.3% pool) — USDT is a secondary pair here, unlike on Celo.
const ARBITRUM_STABLE = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const ARBITRUM_VOLATILE = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1" as const;

const ARBITRUM: ChainDef = {
  id: arbitrum.id,
  viemChain: arbitrum,
  name: "Arbitrum",
  rpcUrl: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
  stableToken: ARBITRUM_STABLE,
  stableSymbol: "USDC",
  volatileToken: ARBITRUM_VOLATILE,
  volatileSymbol: "WETH",
  pool: "0xC6962004f452bE9203591991D15f6b388e09E8D0", // USDC/WETH 0.05%
  feeTier: 500,
  positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  // All 4 standard tiers confirmed to exist for USDC/WETH on Arbitrum
  // 2026-07-17 (unlike Celo, which has no 1% pool for its pair).
  candidateSwapFeeTiers: [100, 500, 3000, 10000],
  // Factory deployed 2026-07-17 — tx
  // 0xdfe8c7337725ac0e1d0a1b3f2fede738b331ff6546daad1a4a1411ff308a4b17.
  factoryDeployBlock: 484906602n,
  factoryAddress: (process.env.NEXT_PUBLIC_FACTORY_ADDRESS_ARBITRUM || "") as `0x${string}` | "",
  platformConfigAddress: (process.env.NEXT_PUBLIC_PLATFORM_CONFIG_ADDRESS_ARBITRUM || "") as `0x${string}` | "",
  explorerBaseUrl: "https://arbiscan.io",
  // ~$15-20 at typical ETH prices — comfortably covers dozens of rebalance
  // cycles at Arbitrum's real gas prices (~0.04 gwei observed 2026-07-17),
  // while still catching a genuinely empty wallet.
  lowGasThreshold: 0.005,
  stableIsToken0: computeStableIsToken0(ARBITRUM_STABLE, ARBITRUM_VOLATILE),
  vaultAbi: rangeVaultArbAbi,
  factoryAbi: vaultFactoryArbAbi,
  supportsGasReserve: true,
};

export const CHAINS: Record<number, ChainDef> = {
  [CELO.id]: CELO,
  [ARBITRUM.id]: ARBITRUM,
};

export const DEFAULT_CHAIN_ID = CELO.id;

export function getChain(id: number): ChainDef {
  return CHAINS[id] ?? CHAINS[DEFAULT_CHAIN_ID];
}

// Narrowed variant for callers (the keeper's tick loop) that need to pass
// factoryAddress on to something expecting a real `0x${string}`, not the
// union with "" — deployedChains()'s filter guarantees this at runtime, this
// just makes the type system aware of it too.
export interface DeployedChainDef extends ChainDef {
  factoryAddress: `0x${string}`;
}

// Only chains whose factory has actually been deployed — used to build the
// frontend's chain selector and the keeper's per-tick chain loop, so an
// undeployed chain (Arbitrum, until its Deploy.s.sol run lands) doesn't show
// up as a broken option anywhere.
export function deployedChains(): DeployedChainDef[] {
  return Object.values(CHAINS).filter((c): c is DeployedChainDef => Boolean(c.factoryAddress));
}
