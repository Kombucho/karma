-- Karma persistent store · Supabase Postgres (free tier)
-- Run this once in the Supabase SQL editor (Dashboard → SQL → New query → paste → Run).
--
-- Coin scans accumulate here: written by the daily cron AND by every user who opens a coin, so
-- the set is always fresh and always has data. Trimmed at 30 days to stay inside the free tier.

create table if not exists coin_scans (
  mint        text primary key,
  scan        jsonb        not null,   -- the full CoinScan object
  eligible    boolean      not null default false,
  updated_at  timestamptz  not null default now()
);

-- Fast "is this fresh / trim the old" lookups.
create index if not exists coin_scans_updated_at_idx on coin_scans (updated_at);

-- The 30-day trim the daily cron runs (kept here as the reference statement):
--   delete from coin_scans where updated_at < now() - interval '30 days';

-- Writes come from the server with the service_role key (bypasses RLS), so no row-level policies
-- are needed. Keep RLS ON with no public policies so the anon key can never read or write.
alter table coin_scans enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-25 · sibling overlap (src/lib/karma/sources/sibling-overlap.ts)
-- Re-running this whole file is the migration: every statement is idempotent. Not yet applied to
-- production; until it is, the detector matches wallets straight inside coin_scans.scan jsonb.
--
-- Why a narrow table, not jsonb containment: "which stored coins hold any of these 50 wallets" is
-- an OR of 50 containment tests over every row's full scan JSON (~8 ms per wallet at 38 rows, linear
-- in rows, and it ships each match's whole holder array back). One row per (coin, top holder) with an
-- index on wallet turns it into a single indexed `wallet = any(...)`: ~50 rows per scan, ~100k rows
-- at a full 30-day window, returning only the matching positions.
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

-- Every stored scan's top holders, one row each. Written by recordHolders() right after putStoredScan;
-- dust (<0.05%) and pools/curves are never written. Cascades with the coin_scans 30-day trim.
create table if not exists coin_holders (
  mint        text         not null references coin_scans (mint) on delete cascade,
  wallet      text         not null,
  pct         real         not null,   -- % of supply at scan time
  kind        text,                    -- CoinHolder.kind ("kol" is kept apart from the cabal core)
  born_at     bigint,                  -- unix seconds of the wallet's first tx, when the scan knew it
  updated_at  timestamptz  not null default now(),
  primary key (mint, wallet)
);

-- The lookup: every stored coin a wallet sits in.
create index if not exists coin_holders_wallet_idx on coin_holders (wallet);

-- Same-deployer siblings without detoasting every scan.
create index if not exists coin_scans_creator_idx on coin_scans ((scan->>'creator'));

alter table coin_holders enable row level security;

-- One round trip: the sibling positions of these wallets, each sibling's symbol / creator / launch
-- time, same-creator coins with no shared wallet (wallet null), and the corpus size.
create or replace function sibling_holdings(p_mint text, p_wallets text[], p_creator text default null)
returns table (mint text, wallet text, pct real, kind text, born_at bigint, symbol text, creator text, launched_at bigint, corpus bigint)
language sql stable
as $$
  with hits as (
    select h.mint, h.wallet, h.pct, h.kind, h.born_at
    from coin_holders h
    where h.wallet = any (p_wallets) and h.mint <> p_mint
  ), sibs as (
    select hits.mint from hits
    union
    select s.mint from coin_scans s
    where p_creator is not null and s.scan->>'creator' = p_creator and s.mint <> p_mint
  )
  select sibs.mint, x.wallet, x.pct, x.kind, x.born_at,
         s.scan->>'symbol', s.scan->>'creator',
         ((s.scan->>'checked_at')::numeric - (s.scan->>'age_seconds')::numeric)::bigint,
         (select count(*) from coin_scans)
  from sibs
  join coin_scans s on s.mint = sibs.mint
  left join hits x on x.mint = sibs.mint
$$;

-- Server-only, like the tables: the anon/authenticated keys can't call it.
revoke execute on function sibling_holdings(text, text[], text) from public, anon, authenticated;
grant execute on function sibling_holdings(text, text[], text) to service_role;

-- Make PostgREST see the new function/table now rather than on its next schema poll.
notify pgrst, 'reload schema';

-- Backfill from the scans already stored (idempotent: existing rows are left alone).
insert into coin_holders (mint, wallet, pct, kind, born_at, updated_at)
select s.mint, h->>'wallet', (h->>'pct_supply')::real, h->>'kind',
       case when jsonb_typeof(h->'wallet_age_days') = 'number'
            then ((s.scan->>'checked_at')::numeric - (h->>'wallet_age_days')::numeric * 86400)::bigint end,
       s.updated_at
from coin_scans s, jsonb_array_elements(case when jsonb_typeof(s.scan->'holders') = 'array' then s.scan->'holders' else '[]'::jsonb end) h
where (h->>'pct_supply')::numeric >= 0.05
  and coalesce(h->>'kind', '') not in ('lp_or_infra', 'bonding_curve')
  and h->>'wallet' ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
on conflict (mint, wallet) do nothing;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-25 · Jev quant loop (src/lib/karma/quant/*). Idempotent; re-run the whole file.
--
-- quant_rubrics   the versioned question sets Jev runs (the "program"): live / shadow / retired.
-- quant_snapshots one judgment: the features Jev saw, the rubric version, its answers.
-- quant_outcomes  the realised price path after a snapshot at each horizon (24h, 168h).
-- quant_grades    per rubric version × question: Brier score, calibration buckets, hit rate, n.

create table if not exists quant_rubrics (
  version     text primary key,
  parent      text,
  status      text not null default 'shadow',     -- live | shadow | retired
  rubric      jsonb not null,                     -- the full Rubric object
  created_at  timestamptz not null default now()
);
alter table quant_rubrics enable row level security;

create table if not exists quant_snapshots (
  id              bigserial primary key,
  mint            text not null,
  t               timestamptz not null,
  price_usd       double precision,
  rubric_version  text not null,
  features        jsonb not null,
  answers         jsonb not null,
  source          text not null default 'cron',   -- cron | page | replay
  created_at      timestamptz not null default now()
);
create index if not exists quant_snapshots_mint_t_idx on quant_snapshots (mint, t desc);
create index if not exists quant_snapshots_version_idx on quant_snapshots (rubric_version, t);
alter table quant_snapshots enable row level security;

create table if not exists quant_outcomes (
  snapshot_id   bigint not null references quant_snapshots(id) on delete cascade,
  horizon_h     int not null,
  price_usd     double precision,
  low_usd       double precision,
  high_usd      double precision,
  ret           double precision,
  max_drawdown  double precision,
  max_runup     double precision,
  status        text not null default 'ok',     -- ok | dex_price | partial | dead (see QuantOutcome.status)
  measured_at   timestamptz not null default now(),
  primary key (snapshot_id, horizon_h)
);
alter table quant_outcomes add column if not exists status text not null default 'ok';
alter table quant_outcomes enable row level security;

create table if not exists quant_grades (
  rubric_version  text not null,
  question        text not null,
  n               int not null,
  brier           double precision,             -- lower is better; 0.25 = coin flip for a 50/50 event
  base_rate       double precision,             -- how often the event actually happened
  brier_baseline  double precision,             -- Brier of always predicting the base rate
  hit_rate        double precision,             -- choice/direction questions
  calibration     jsonb,                        -- [{bucket, n, predicted, actual}]
  graded_at       timestamptz not null default now(),
  primary key (rubric_version, question)
);
alter table quant_grades enable row level security;
-- Migration 2026-09-25 · hold-to-scan (src/lib/karma/access.ts)
-- One row per (who, UTC day): how many *fresh* coin scans they ran. subject is "ip:<addr>" for the
-- free tier or "w:<wallet>" for $KARMA holders. Until this exists the counters live in per-instance
-- memory (still gates, just leakier). Trim with: delete from scan_usage where day < current_date - 7;
-- ─────────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists scan_usage (
  subject  text     not null,
  day      date     not null,
  count    integer  not null default 0,
  primary key (subject, day)
);

alter table scan_usage enable row level security;

-- Atomic +1, so two fresh scans racing on different instances both count.
create or replace function bump_scan_usage(p_subject text, p_day date)
returns integer
language sql
as $$
  insert into scan_usage (subject, day, count) values (p_subject, p_day, 1)
  on conflict (subject, day) do update set count = scan_usage.count + 1
  returning count
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-25 · wallet history (src/lib/karma/history.ts). Idempotent; re-run the whole file.
--
-- coin_scans keeps only the LATEST scan per coin, so a wallet's past is lost the moment a coin is
-- rescanned. These two tables are append-only: every scan run, and every wallet it saw with the role
-- it played (top holder, sniper, born-to-buy, routed-in, cluster member/purse, bundle, launchpad
-- insider, reward-only, cabal, fresh last-hour buyer, dev). A wallet's history is a query over them.
--
-- Size: ~60 sightings x ~200 B per run; one run per coin per hour at most; trimmed at 90 days
-- (select trim_wallet_history(90);) so it stays well inside the 500 MB free tier.

create table if not exists scan_runs (
  id          bigserial primary key,
  mint        text not null,
  chain       text not null default 'solana',
  symbol      text,
  t           timestamptz not null default now(),
  source      text not null,                -- page | api | cron | backfill
  verdict     text,                         -- clean | caution | coordinated | danger
  summary     jsonb                         -- headline numbers only (not the full scan)
);
create index if not exists scan_runs_mint_t_idx on scan_runs (mint, t desc);
create index if not exists scan_runs_t_idx on scan_runs (t);
alter table scan_runs enable row level security;

create table if not exists wallet_sightings (
  run_id      bigint not null references scan_runs(id) on delete cascade,
  wallet      text not null,
  mint        text not null,
  t           timestamptz not null,
  rank        int,                          -- position in the top-holder book (null = not a top holder)
  pct         double precision,             -- % of supply held at this run
  roles       text[] not null default '{}', -- e.g. {holder,sniper,born_to_buy,routed_in,cluster_member}
  detail      jsonb,                        -- role context: funder, entry_t, routed_from, cluster purse, grade…
  primary key (run_id, wallet)
);
create index if not exists wallet_sightings_wallet_t_idx on wallet_sightings (wallet, t desc);
create index if not exists wallet_sightings_roles_idx on wallet_sightings using gin (roles);
alter table wallet_sightings enable row level security;

create or replace function trim_wallet_history(p_days int default 90)
returns int
language sql
as $$
  with d as (delete from scan_runs where t < now() - make_interval(days => p_days) returning 1)
  select count(*)::int from d
$$;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Migration 2026-09-25 · coin sentiment (src/lib/karma/quant/sentiment.ts). Idempotent.
--
-- X is only searched by the cron, for pump.fun's top movers (a visitor opening a coin can never spend
-- X reads). Each cron read is stored here, append-only; the coin page shows the newest row ≤ 24h old
-- beside its live pump.fun callouts ("X read 3h ago"). source = 'x' rows are also the X spend ledger:
-- the monthly cap in sentiment.ts counts them. ~10 rows/day × ~15 KB. Trim with:
--   delete from coin_sentiment where t < now() - interval '30 days';

create table if not exists coin_sentiment (
  id      bigserial primary key,
  mint    text not null,
  t       timestamptz not null default now(),
  source  text not null,                 -- x (cron read that searched X)
  read    jsonb not null                 -- { sentiment: SentimentRead, x_posts: PostRead[], x_cost_usd, ... }
);
create index if not exists coin_sentiment_mint_t_idx on coin_sentiment (mint, t desc);
create index if not exists coin_sentiment_source_t_idx on coin_sentiment (source, t);
alter table coin_sentiment enable row level security;

-- ─── Jev's ledger (chart read): every call it makes, resolved against price, scored by itself ───────────
-- jev_ledger     one row per published probability: the claim (family / timeframe / kind), the higher-
--                timeframe verdict it was made under (context), the physics / Jev / shown numbers, the exact
--                target, and — once the window has passed — what happened (y). Written by the chart-read
--                route; resolved nightly by the quant cron from 1h candles.
-- jev_scorecard  Jev's running record per family × timeframe × context (and '*' pooled): hit rate, mean
--                prediction, Brier, calibration error, skill vs the base rate, calibration buckets. The
--                chart read shows these as the track record and leans shown odds toward the buckets' actual
--                rates once they hold enough calls.
create table if not exists jev_ledger (
  id          bigserial primary key,
  mint        text not null,
  network     text not null default 'solana',
  t           timestamptz not null,
  source      text not null default 'page',           -- page | cron | replay (lab backtests)
  family      text not null,                           -- touch | move | hypothesis | pattern
  timeframe   text not null,                           -- touch/move: horizon (4h 24h 3d 7d); hypothesis/pattern: bar size
  kind        text not null,                           -- support | resistance | up25 | down25 | pattern kind
  context     text not null default '',                -- e.g. 'survives' | 'rejected' | 'wk:aligned'
  horizon_h   integer not null,
  p_shown     real,
  p_physics   real,
  p_jev       real,
  target      jsonb not null,                          -- {side, level} or {bull, target, stop}
  price       double precision,
  y           smallint,                                -- 1 happened, 0 didn't, null = not resolved yet
  resolved_at timestamptz,
  unique (mint, t, family, timeframe, kind, target)
);
create index if not exists jev_ledger_pending_idx on jev_ledger (t) where y is null;
create index if not exists jev_ledger_cell_idx on jev_ledger (family, timeframe, context) where y is not null;
alter table jev_ledger enable row level security;

create table if not exists jev_scorecard (
  family      text not null,
  timeframe   text not null,
  context     text not null,
  n           integer not null,
  hit         real,
  predicted   real,
  brier       real,
  brier_base  real,
  ece         real,
  skill       real,
  calibration jsonb,
  updated_at  timestamptz not null default now(),
  primary key (family, timeframe, context)
);
alter table jev_scorecard enable row level security;
