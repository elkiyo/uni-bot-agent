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
  primary key (chain_id, address)
);
alter table keeper_vaults enable row level security;

-- Migration for a table created before reinjection_active existed:
-- alter table keeper_vaults add column if not exists reinjection_active boolean not null default false;

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
