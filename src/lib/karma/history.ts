import { db } from "./db";
import type { CoinScan } from "./engine/coin";
import { coinVerdict } from "./engine/verdict";
import { excludedFunders } from "./registry";
import { SCORING } from "./scoring.config";

/**
 * Wallet history: the append-only memory behind every scan (tables scan_runs + wallet_sightings in
 * db/schema.sql). coin_scans holds only the LATEST scan per coin, so without this a wallet that sniped
 * five coins over three weeks leaves no trail. Here every scan run is kept, with every wallet it saw
 * and the role it played there, so a wallet's record is one indexed query.
 *
 * Defensive like db.ts: missing tables or any DB error is a silent no-op, never a broken scan.
 */

export type WalletRole =
  | "holder" // in the top-holder book
  | "kol" // a known caller from the registry
  | "sniper" // got its bag within entrySniperSeconds of launch
  | "launch_window" // …within the first hour
  | "born_to_buy" // wallet born within entryFreshSeconds of its first acquisition
  | "routed_in" // its bag arrived by token transfer, not a buy
  | "router" // it moved tokens into a top holder
  | "cluster_member" // shares a first funder with other holders
  | "cluster_purse" // the funder of such a cluster
  | "bundle_member" // fresh-wallet Sybil bundle member
  | "bundle_purse"
  | "ecosystem_only" // trades only this coin's launch family
  | "reward_only" // never sells the coin, only its rewards
  | "cabal" // shared core wallet with a sibling coin we've scanned
  | "fresh_buyer_1h" // fresh wallet net-buying in the last hour
  | "dev";

interface Sighting {
  wallet: string;
  rank: number | null;
  pct: number | null;
  roles: Set<WalletRole>;
  detail: Record<string, unknown>;
}

/** Minimum gap between two recorded runs of the same coin — keeps the tables inside the free tier. */
const MIN_RUN_GAP_SECONDS = 3600;

/**
 * Fold one scan into per-wallet sightings. Pure apart from the service list. Clusters whose purse is a
 * known exchange/bridge are dropped: scans stored before the 25 Sep service gate flagged Coinbase and the
 * Relay bridge as "purses", and history must not carry that forward as a wallet's record.
 */
export function sightingsFromScan(scan: CoinScan, services: Set<string> = excludedFunders()): Sighting[] {
  const by = new Map<string, Sighting>();
  const get = (w: string) => {
    let s = by.get(w);
    if (!s) by.set(w, (s = { wallet: w, rank: null, pct: null, roles: new Set(), detail: {} }));
    return s;
  };

  scan.holders.forEach((h, i) => {
    const s = get(h.wallet);
    s.rank = i + 1;
    s.pct = h.pct_supply;
    s.roles.add("holder");
    if (h.kind === "kol") s.roles.add("kol");
    if (h.grade) s.detail.grade = h.grade;
    if (h.handle) s.detail.handle = h.handle;
    if (h.funder && !services.has(h.funder)) s.detail.funder = h.funder;
    if (h.wallet_age_days !== null) s.detail.age_days = Math.round(h.wallet_age_days * 10) / 10;
  });

  for (const e of scan.holder_entry?.entries ?? []) {
    const s = get(e.wallet);
    if (e.entry_t !== null) s.detail.entry_t = e.entry_t;
    if (e.after_launch_s !== null) {
      s.detail.after_launch_s = e.after_launch_s;
      if (e.after_launch_s <= SCORING.coin.entrySniperSeconds) s.roles.add("sniper");
      if (e.after_launch_s <= SCORING.coin.entryLaunchWindowSeconds) s.roles.add("launch_window");
    }
    if (e.fresh_at_entry) s.roles.add("born_to_buy");
  }
  for (const r of scan.holder_entry?.routers ?? []) {
    const router = get(r.from);
    router.roles.add("router");
    router.detail.routed_to = r.members;
    for (const m of r.members) {
      const s = get(m);
      s.roles.add("routed_in");
      s.detail.routed_from = r.from;
    }
  }

  // Cluster reads from scans older than the service gate (they predate holder_entry, which shipped in
  // the same release) can't be trusted: the purse may be an exchange the old gate waved through.
  const gated = scan.holder_entry !== undefined;
  for (const c of gated ? (scan.holder_clusters ?? []) : []) {
    if (services.has(c.funder)) continue;
    const purse = get(c.funder);
    purse.roles.add("cluster_purse");
    purse.detail.funded_holders = c.members;
    for (const m of c.members) {
      const s = get(m);
      s.roles.add("cluster_member");
      s.detail.cluster_purse = c.funder;
    }
  }
  for (const b of scan.bundles ?? []) {
    if (!b.funder || services.has(b.funder)) continue;
    get(b.funder).roles.add("bundle_purse");
  }
  for (const h of scan.holders) if (h.bundle_id !== null) get(h.wallet).roles.add("bundle_member");

  for (const w of scan.holder_behavior?.ecosystem_only ?? []) get(w).roles.add("ecosystem_only");
  for (const w of scan.holder_behavior?.reward_only ?? []) get(w).roles.add("reward_only");

  for (const sib of scan.sibling_overlap?.siblings ?? []) {
    for (const w of sib.wallets) {
      if (w.role !== "core") continue;
      const s = get(w.wallet);
      if (scan.sibling_overlap?.verdict === "cabal") s.roles.add("cabal");
      const seen = (s.detail.also_in as string[] | undefined) ?? [];
      s.detail.also_in = [...new Set([...seen, sib.symbol ?? sib.mint])];
    }
  }

  for (const b of scan.fresh_flow?.fresh_buyers ?? []) {
    if (!b.fresh) continue;
    const s = get(b.wallet);
    s.roles.add("fresh_buyer_1h");
    s.detail.fresh_net_sol = Math.round(b.net_sol * 100) / 100;
    if (b.funder) s.detail.funder ??= b.funder;
  }

  if (scan.creator) {
    const s = get(scan.creator);
    s.roles.add("dev");
    if (scan.dev) s.detail.dev = { launches: scan.dev.launches, graduated: scan.dev.graduated, holds_pct: scan.dev.holds_pct };
  }

  return [...by.values()];
}

/**
 * Append one scan run and its wallet sightings. At most one run per coin per hour (a page refresh isn't
 * new history). Returns the run id, or null when skipped / disabled / failed.
 */
export async function recordScanRun(scan: CoinScan, source: "page" | "api" | "cron" | "backfill", at?: number): Promise<number | null> {
  const c = db();
  if (!c || !scan.eligible) return null;
  // EVM addresses are case-insensitive; one coin must not split into two histories (0xBf8C… vs 0xbf8c…).
  const mint = scan.mint.startsWith("0x") ? scan.mint.toLowerCase() : scan.mint;
  try {
    const t = at ?? scan.checked_at;
    const since = new Date((t - MIN_RUN_GAP_SECONDS) * 1000).toISOString();
    const { data: recent } = await c.from("scan_runs").select("id").eq("mint", mint).gte("t", since).limit(1);
    if (recent?.length) return null;

    const s = scan.summary;
    const { data: run, error } = await c
      .from("scan_runs")
      .insert({
        mint,
        chain: scan.chain,
        symbol: scan.symbol,
        t: new Date(t * 1000).toISOString(),
        source,
        verdict: coinVerdict(scan),
        summary: s
          ? {
              top10_pct: s.top10_pct,
              holder_count: s.holder_count,
              insider_shaped_pct: scan.holder_entry?.cohort_pct ?? null,
              sniper_pct: scan.holder_entry?.sniper_pct ?? null,
              clusters: scan.holder_clusters?.length ?? 0,
              mcap_usd: scan.market?.mcap_usd ?? null,
              readout: s.readout?.[0] ?? null,
            }
          : null,
      })
      .select("id")
      .single();
    if (error || !run) return null;

    const rows = sightingsFromScan(scan).map((x) => ({
      run_id: run.id,
      wallet: x.wallet,
      mint,
      t: new Date(t * 1000).toISOString(),
      rank: x.rank,
      pct: x.pct,
      roles: [...x.roles],
      detail: Object.keys(x.detail).length ? x.detail : null,
    }));
    for (let i = 0; i < rows.length; i += 500) await c.from("wallet_sightings").insert(rows.slice(i, i + 500));
    return run.id as number;
  } catch {
    return null;
  }
}

export interface WalletHistory {
  wallet: string;
  coins: number; // distinct coins seen in
  runs: number;
  first_seen: string | null;
  last_seen: string | null;
  role_counts: Partial<Record<WalletRole, number>>; // distinct coins per role
  recent: { mint: string; symbol: string | null; t: string; rank: number | null; pct: number | null; roles: string[]; verdict: string | null }[];
}

/** A wallet's record across every scan we've run: which coins, which roles, how recently. */
export async function walletHistory(wallet: string, limit = 400): Promise<WalletHistory | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c
      .from("wallet_sightings")
      .select("mint, t, rank, pct, roles, run_id, scan_runs(symbol, verdict)")
      .eq("wallet", wallet)
      .order("t", { ascending: false })
      .limit(limit);
    if (error || !data) return null;
    type Row = { mint: string; t: string; rank: number | null; pct: number | null; roles: string[]; scan_runs: { symbol: string | null; verdict: string | null } | null };
    const rows = data as unknown as Row[];
    const coinsByRole = new Map<string, Set<string>>();
    for (const r of rows) for (const role of r.roles) (coinsByRole.get(role) ?? coinsByRole.set(role, new Set()).get(role)!).add(r.mint);
    // Latest sighting per coin for the "recent" list.
    const latest = new Map<string, Row>();
    for (const r of rows) if (!latest.has(r.mint)) latest.set(r.mint, r);
    return {
      wallet,
      coins: latest.size,
      runs: rows.length,
      first_seen: rows.at(-1)?.t ?? null,
      last_seen: rows[0]?.t ?? null,
      role_counts: Object.fromEntries([...coinsByRole].map(([k, v]) => [k, v.size])) as WalletHistory["role_counts"],
      recent: [...latest.values()].slice(0, 20).map((r) => ({
        mint: r.mint,
        symbol: r.scan_runs?.symbol ?? null,
        t: r.t,
        rank: r.rank,
        pct: r.pct,
        roles: r.roles,
        verdict: r.scan_runs?.verdict ?? null,
      })),
    };
  } catch {
    return null;
  }
}

/** Delete history older than `days` (cascades to sightings). Run by the daily warm cron. */
export async function trimWalletHistory(days = 90): Promise<number> {
  const c = db();
  if (!c) return 0;
  try {
    const { data } = await c.rpc("trim_wallet_history", { p_days: days });
    return typeof data === "number" ? data : 0;
  } catch {
    return 0;
  }
}
