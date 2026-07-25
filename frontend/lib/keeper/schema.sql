-- Run once in the Supabase project's SQL Editor (Project → SQL Editor → New
-- query) after connecting the Supabase integration to this Vercel project.
-- Replaces the old agent/data/store.json (see SCALING.md) now that the
-- keeper runs as a stateless Vercel serverless function.
--
-- RLS is enabled with NO policies on every table: by design, only a client
-- authenticated with the service_role key (server-only, see
-- lib/keeper/supabaseClient.ts) can read/write these — the anon key some
-- other part of the project might use client-side gets nothing.

create table if not exists keeper_vaults (
  -- 42220 = Celo mainnet, matches CHAINS[celo.id].id in lib/chains.ts — the
  -- default keeps a fresh install correct even before anyone edits this
  -- file for a second chain. Part of the primary key (not just address)
  -- since a vault address could in principle exist on two different chains
  -- (each has its own factory/deployer nonce) — address alone stopped being
  -- a safe uniqueness guarantee once the keeper went multichain.
  chain_id integer not null default 42220,
  address text not null,
  owner text not null,
  uni_lab_api_key text,
  position_initialized boolean not null default false,
  created_at_block text not null,
  updated_at timestamptz not null default now(),
  -- Whether the keeper reinjected reserveBalance into the position on its most
  -- recent rebalance for this vault. The contract no longer tracks or forces
  -- an alternating pattern (see PLAN.md) — the keeper decides E1 freely each
  -- cycle, informed by uni-lab's live simulation; this column is purely the
  -- keeper's own bookkeeping of what it last chose, not a contract guarantee.
  reinjection_active boolean not null default false,
  -- 'standard' | 'compound' — which factory this vault was cloned from
  -- (VaultFactory[Arb] vs VaultFactoryArbCompound). Arbitrum-only distinction
  -- today (see lib/chains.ts's ChainDef docstring on compoundFactoryAddress);
  -- fixed forever per vault, stamped once by discovery.ts. Defaults to
  -- 'standard' for every row that predates this column.
  kind text not null default 'standard',
  -- Set the first time the keeper detects gasReserveBalance can't cover an
  -- action it's about to take as operator (init/rebalance/claimFees/sweep) —
  -- see hasEnoughOperatorGas() in rebalancer.ts. Cleared back to null the
  -- next time the reserve is found sufficient again. The vault itself never
  -- blocks or reverts on this (protecting the owner's capital wins over
  -- reimbursing the operator), so without this column the depletion was
  -- completely invisible — no event, no alert, nothing distinguishing a $0
  -- reimbursement from a normal one. Null means "not currently depleted" or
  -- "never checked yet" (same meaning, both read as healthy).
  gas_reserve_empty_since timestamptz,
  -- This vault's own stable/volatile pair, resolved once (either at
  -- discovery.ts's registration time for a new vault, or lazily by
  -- pairInfo.ts's resolveVaultPair() the first time an existing row is read)
  -- and cached here forever — a vault's pair never changes after creation.
  -- Needed so the keeper stops assuming every vault trades the chain's
  -- single default pair (see wild-exploring-bumblebee.md's multi-pair Fase
  -- 1) — nullable together (never partially null) since every row that
  -- predates this column starts as null until the lazy backfill runs.
  stable_token text,
  volatile_token text,
  stable_is_token0 boolean,
  stable_decimals integer,
  volatile_decimals integer,
  primary key (chain_id, address)
);
alter table keeper_vaults enable row level security;

-- Migration for a table created before the pair-info columns existed
-- (2026-07-25) — run once in the Supabase SQL Editor. Idempotent. New rows
-- get these populated at discovery time; existing rows self-heal the first
-- time pairInfo.ts's resolveVaultPair() reads them (no backfill script
-- needed, though you could pre-populate every existing row here with the
-- chain's own default pair address/decimals directly, since every vault
-- created before multi-pair support existed IS on that default pair).
-- alter table keeper_vaults add column if not exists stable_token text;
-- alter table keeper_vaults add column if not exists volatile_token text;
-- alter table keeper_vaults add column if not exists stable_is_token0 boolean;
-- alter table keeper_vaults add column if not exists stable_decimals integer;
-- alter table keeper_vaults add column if not exists volatile_decimals integer;

-- Migration for a table created before gas_reserve_empty_since existed
-- (2026-07-25) — run once in the Supabase SQL Editor. Idempotent.
-- alter table keeper_vaults add column if not exists gas_reserve_empty_since timestamptz;

-- Migration for a table created before reinjection_active existed:
-- alter table keeper_vaults add column if not exists reinjection_active boolean not null default false;

-- Migration for a table created before the compound-vault kind column
-- existed (2026-07-25) — run once in the Supabase SQL Editor before
-- deploying the interest-compounding keeper support. Idempotent.
-- alter table keeper_vaults add column if not exists kind text not null default 'standard';

-- Migration for a table created before multichain support (2026-07-17) — run
-- this in the Supabase SQL Editor once, before deploying the multichain
-- keeper. Safe to run even if chain_id already exists (idempotent).
-- alter table keeper_vaults add column if not exists chain_id integer not null default 42220;
-- alter table keeper_vaults drop constraint if exists keeper_vaults_pkey;
-- alter table keeper_vaults add primary key (chain_id, address);
-- alter table keeper_unilab_calls add column if not exists chain_id integer not null default 42220;

-- Generic key/value for keeper bookkeeping (currently just lastProcessedBlock).
create table if not exists keeper_state (
  key text primary key,
  value text not null
);
alter table keeper_state enable row level security;

-- Full audit trail of every uni-lab.xyz query — request, response, status,
-- latency. See PLAN.md: the paid API the agent's design revolves around.
create table if not exists keeper_unilab_calls (
  id bigint generated always as identity primary key,
  chain_id integer not null default 42220,
  vault text not null,
  endpoint text not null,
  request jsonb not null,
  http_status int not null,
  response jsonb,
  ok boolean not null,
  duration_ms int not null,
  error text,
  created_at timestamptz not null default now()
);
alter table keeper_unilab_calls enable row level security;
create index if not exists keeper_unilab_calls_vault_idx on keeper_unilab_calls (vault, created_at desc);

-- Single-row lock preventing two overlapping tick() runs from racing on the
-- operator wallet's nonce (see SCALING.md "no correr dos keepers con la
-- misma wallet a la vez") — needed because ticks are now triggered
-- externally (GitHub Actions every 5 min) instead of by one in-process
-- scheduler, so a slow tick could still be running when the next one fires.
create table if not exists keeper_lock (
  id int primary key default 1,
  expires_at timestamptz not null default to_timestamp(0),
  constraint keeper_lock_single_row check (id = 1)
);
alter table keeper_lock enable row level security;
insert into keeper_lock (id, expires_at) values (1, to_timestamp(0))
  on conflict (id) do nothing;

create or replace function acquire_tick_lock(ttl_seconds int)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  rows_updated int;
begin
  update keeper_lock
  set expires_at = now() + make_interval(secs => ttl_seconds)
  where id = 1 and expires_at < now();
  get diagnostics rows_updated = row_count;
  return rows_updated > 0;
end;
$$;

create or replace function release_tick_lock()
returns void
language sql
security definer
set search_path = public
as $$
  update keeper_lock set expires_at = to_timestamp(0) where id = 1;
$$;

-- ============================================================
-- Dashboard read-cache (indexer) — added 2026-07-24
-- ============================================================
-- Server-side cache of on-chain vault/event history, refreshed once per
-- keeper tick (see lib/dashboard/indexer.ts, called from
-- app/api/cron/tick/route.ts right after runTick()). Exists so the Vault
-- detail and Dashboard pages can render from a single fast Postgres query
-- instead of every visitor's browser re-scanning full chain history via
-- public RPC eth_getLogs on every cold load — that RPC scan (bloques de
-- 5000 desde factoryDeployBlock) was the dominant cost on those two pages.
--
-- Deliberately separate from keeper_vaults/keeper_state (the keeper's own
-- trading-critical bookkeeping): this indexer is purely read-only from the
-- chain's perspective — it never signs or sends a transaction — so a bug
-- here can never affect the live trading loop, and the two can be reasoned
-- about independently.

create table if not exists indexed_vaults (
  chain_id integer not null,
  address text not null,
  owner text not null,
  pool text not null,
  token0 text not null,
  token1 text not null,
  fee integer not null,
  created_at_block text not null,
  created_at timestamptz not null,
  tx_hash text,
  -- Which of token0/token1 is the stable leg, plus each leg's real decimals —
  -- NOT derivable from token0/token1 alone (that's just Uniswap's raw address
  -- sort order, unrelated to which token is "the stablecoin"), so this is
  -- read once directly from the vault's own stableIsToken0()/each token's
  -- decimals() at indexVaultDirectory time and cached here forever (see
  -- indexer.ts and lib/keeper/pairInfo.ts's identical pattern on the keeper
  -- side) — needed so cheapUsdValue/backfillMintUsd price each vault's
  -- events using ITS OWN pair instead of the chain's single default one
  -- (wild-exploring-bumblebee.md's multi-pair Fase 2). Nullable since a row
  -- indexed before this column existed hasn't been backfilled yet.
  stable_is_token0 boolean,
  stable_decimals integer,
  volatile_decimals integer,
  primary key (chain_id, address)
);
alter table indexed_vaults enable row level security;

-- Migration for a table created before the pair-info columns existed
-- (2026-07-25) — run once in the Supabase SQL Editor. Idempotent. New rows
-- get these populated at indexVaultDirectory time; existing rows are
-- backfilled lazily the next time indexer.ts's runIndexer() processes them
-- (see indexer.ts's own resolveIndexedVaultPair).
-- alter table indexed_vaults add column if not exists stable_is_token0 boolean;
-- alter table indexed_vaults add column if not exists stable_decimals integer;
-- alter table indexed_vaults add column if not exists volatile_decimals integer;

create table if not exists indexed_events (
  id bigint generated always as identity primary key,
  chain_id integer not null,
  address text not null,
  event_name text not null,
  -- Every bigint value in the raw event args gets stringified before this is
  -- written (JSON can't hold a bigint) — see lib/eventArgsCodec.ts. Readers
  -- convert the relevant fields back using the same event's ABI definition.
  args jsonb not null,
  block_number text not null,
  log_index integer not null,
  tx_hash text not null,
  block_timestamp timestamptz not null,
  -- Precomputed USD value for events whose value is worth showing without a
  -- second round-trip: Deposited/LpFeesPaidToOwner/FeesCollected/
  -- PerformanceFeeCollected/KeeperGasReimbursed convert at CURRENT price the
  -- moment they're indexed (cheap, same approximation the old client-side
  -- version used); PositionInitialized/Rebalanced (a fresh mint) need a
  -- historical position+pool read at that exact block, done ONCE here
  -- instead of on every dashboard page load (see mintVolume.ts). Null
  -- immediately after insert for those two event types — backfilled by a
  -- capped batch every indexer run (see indexer.ts's backfillMintUsd) — and
  -- permanently null for event types with no natural USD value
  -- (TargetConfigured, OperatorUpdated, ...).
  usd_value numeric,
  unique (chain_id, tx_hash, log_index)
);
alter table indexed_events enable row level security;
create index if not exists indexed_events_address_idx on indexed_events (chain_id, address, block_number);
create index if not exists indexed_events_chain_idx on indexed_events (chain_id, block_number);
create index if not exists indexed_events_mint_backfill_idx on indexed_events (chain_id, event_name)
  where usd_value is null;

-- Generic key/value for the indexer's own scan checkpoints (fromBlock per
-- chain, one key for the vault directory scan and one for the event scan) —
-- same pattern as keeper_state, kept in its own table so the two subsystems
-- never share a key namespace by accident.
create table if not exists indexer_state (
  key text primary key,
  value text not null
);
alter table indexer_state enable row level security;
