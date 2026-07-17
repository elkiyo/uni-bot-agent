import { celo, arbitrum } from "viem/chains";
import type { Chain } from "viem";

// Per-chain config — the single source of truth every page/hook/keeper file
// should read from instead of hardcoding an address. Each chain's own
// addresses/pool/fee-tier choice is independent: RangeVault.sol treats
// token0 as "the pool's stablecoin leg" generically, never assuming USDT
// specifically, so different chains can pair the volatile leg (WETH on both,
// so far) against whatever stablecoin actually has the deepest pool there.
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
}

// Verified in PLAN.md — cross-checked against Celopedia, CoinGecko, DefiLlama, and
// direct RPC calls before being trusted here. Keep in sync with agent/src/addresses.ts
// and contracts/script/Deploy.s.sol.
const CELO: ChainDef = {
  id: celo.id,
  viemChain: celo,
  name: "Celo",
  rpcUrl: process.env.CELO_RPC_URL ?? "https://forno.celo.org",
  stableToken: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  stableSymbol: "USDT",
  volatileToken: "0xD221812de1BD094f35587EE8E174B07B6167D9Af",
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
};

// Verified 2026-07-17: bytecode-checked directly on-chain (not doc-scraped),
// and USDC/WETH's 0.05% pool confirmed as the pair's deepest liquidity on
// Arbitrum (~2.70e18, ~5x the next-deepest tier, ~190x Celo's own USDT/WETH
// 0.3% pool) — USDT is a secondary pair here, unlike on Celo.
const ARBITRUM: ChainDef = {
  id: arbitrum.id,
  viemChain: arbitrum,
  name: "Arbitrum",
  rpcUrl: process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
  stableToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  stableSymbol: "USDC",
  volatileToken: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
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
