import { db } from "../db";
import { excludedFunders } from "../registry";

/**
 * Sibling coins: the same wallets turning up in the top holders of coin after coin. A cabal doesn't
 * make fresh wallets for every launch; it rotates one wallet set through a string of coins ($STONK's
 * team across $GP, $ZCAT, $KNOTS). One coin's holder book can't show that. Every scan we have stored
 * can: we look up this coin's top holders in all of them.
 *
 * Costs no RPC calls, only DB reads: 2 queries in parallel on the jsonb fallback, 3 (two round trips)
 * on the narrow `coin_holders` table (db/schema.sql). The table is preferred: an indexed lookup that
 * returns only the matching (mint, wallet) rows instead of the full holder array of every match. It is
 * used automatically once it exists; until then we match directly against `coin_scans.scan` jsonb.
 *
 * The trap is ubiquity. Some wallets sit in a large share of all coins for boring reasons: exchanges,
 * AMM and locker authorities, aggregator vaults, copy-trade and sniper bots, KOLs who buy everything.
 * Sharing those with a sibling proves nothing. So services and infra never enter the lookup, KOLs
 * count as "shared" but never as the cabal core, and any wallet present in a large fraction of ALL
 * stored scans is treated as a bot and set aside. A sibling link that survives those filters, with
 * real supply behind it, is the rotation.
 *
 * The second trap is narrative overlap: the same traders buy every coin in a hot theme (every
 * Hyperliquid cat, every AI agent), so 4-5 shared mid-sized wallets can be organic. The red verdict
 * therefore needs corroboration on the same sibling: the shared wallets were born together (a batch
 * made on one day), the link is heavy (5+ wallets, 8%+ of supply), or the deployer is the same.
 */

/** Holdings under this % of supply are dust: a stray bag isn't a stake, and it doesn't count as shared. */
const MIN_PCT = 0.05;
/** At most this many of the coin's top holders are looked up on the table (one indexed `wallet in (...)`). */
const MAX_WALLETS = 50;
/**
 * The jsonb fallback evaluates one containment per wallet per stored row (~8 ms per wallet at 38 rows,
 * measured), so it looks up only the biggest holders. A rotating cabal holds size; the tail rarely matters.
 */
const JSONB_MAX_WALLETS = 25;
/** A wallet in at least max(UBIQ_MIN_SCANS, UBIQ_FRACTION x corpus) stored scans is a bot/aggregator, not a cabal. */
const UBIQ_MIN_SCANS = 12;
const UBIQ_FRACTION = 0.05;
/** Shared wallets born within this many days of each other were made as a batch. */
const COHORT_WINDOW_DAYS = 7;
const COHORT_MIN = 3;
/** Red ("cabal"): one sibling shares >= 3 core wallets holding >= 5% here, corroborated (cohort, heavy, or same dev). */
const CABAL_MIN_WALLETS = 3;
const CABAL_MIN_PCT = 5;
/** "Heavy" link: corroboration on its own weight. */
const HEAVY_MIN_WALLETS = 5;
const HEAVY_MIN_PCT = 8;
/** Amber ("linked"): one sibling shares >= 2 core wallets holding >= 1.5% here... */
const LINK_MIN_WALLETS = 2;
const LINK_MIN_PCT = 1.5;
/** ...or core wallets spread across siblings add up to >= 3 wallets and >= 3% here. */
const SPREAD_MIN_WALLETS = 3;
const SPREAD_MIN_PCT = 3;
/** Siblings returned, strongest first. */
const MAX_SIBLINGS = 12;
/** Holder kinds that are never people: pools, lockers, the bonding curve. */
const SERVICE_KINDS = new Set(["lp_or_infra", "bonding_curve"]);
/** Base58 Solana address. Also guards the PostgREST filter string (no reserved characters possible). */
const SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** When the table is found missing, re-probe after this long (it appears once the migration runs). */
const TABLE_RECHECK_MS = 10 * 60 * 1000;

/** Launchpads that stamp a vanity suffix on the mint. Informational: pump.fun alone covers most coins. */
const LAUNCHPAD_SUFFIXES: [string, string][] = [
  ["pump", "pump.fun"],
  ["bonk", "letsbonk"],
  ["BAGS", "bags"],
  ["moon", "moonshot"],
  ["boop", "boop"],
];

export type SiblingRole = "core" | "kol" | "ubiquitous";

export interface SiblingWallet {
  wallet: string;
  pct_here: number;
  pct_there: number;
  /** core = counts toward the cabal read; kol = a public caller; ubiquitous = in too many coins to mean anything. */
  role: SiblingRole;
  /** Stored scans (other than this coin) with this wallet in the top holders. */
  seen_in: number;
}

export interface SiblingCoin {
  mint: string;
  symbol: string | null;
  launchpad: string | null;
  same_creator: boolean;
  same_launchpad: boolean;
  /** Unix seconds; null when the stored scan didn't know the coin's age. */
  launched_at: number | null;
  /** Every shared wallet, all roles. */
  shared: number;
  /** Shared wallets that are neither KOLs nor ubiquitous bots: the candidate cabal. */
  core: number;
  /** Supply those core wallets hold here and in the sibling. */
  core_pct_here: number;
  core_pct_there: number;
  /** Largest number of core wallets born within COHORT_WINDOW_DAYS of each other (0 when ages are unknown). */
  cohort: number;
  wallets: SiblingWallet[];
}

export interface SiblingOverlap {
  source: "table" | "jsonb";
  /** Stored scans with a holder book: the population the frequencies are measured against. */
  corpus: number;
  /** Holder wallets of this coin that were looked up. */
  checked: number;
  /** A wallet in at least this many scans is set aside as ubiquitous. */
  ubiquity_cutoff: number;
  siblings: SiblingCoin[];
  /** Distinct core wallets shared with any sibling, and the supply they hold here. */
  core_wallets: number;
  core_pct_here: number;
  /** Largest birth cohort among any one sibling's core wallets. */
  cohort: number;
  /** cabal = red; linked = worth a look; none = nothing beyond ubiquitous wallets. */
  verdict: "cabal" | "linked" | "none";
  signals: string[];
  ms: number;
}

export interface SiblingHolderInput {
  wallet: string;
  pct_supply: number;
  /** CoinHolder fields, used when present: kind drops pools/KOLs, age dates the wallet's birth. */
  kind?: string;
  wallet_age_days?: number | null;
}

export interface SiblingOverlapOpts {
  /** The coin's deployer: also match siblings by the same creator. */
  creator?: string | null;
  /** When the holders were read (unix seconds), to turn wallet_age_days into a birth date. Default: now. */
  checkedAt?: number;
  /** Force a path. Default "auto": the table when it exists, else jsonb. */
  source?: "auto" | "table" | "jsonb";
  /** Extra addresses never to count (added to seed/cex_funders.json + INFRA_OWNERS). */
  exclude?: Set<string>;
}

/** One non-dust top-holder position in another stored coin. */
interface Holding {
  mint: string;
  wallet: string;
  pct: number;
  kind: string | null;
  born_at: number | null;
}

interface ScanMeta {
  mint: string;
  symbol: string | null;
  creator: string | null;
  launched_at: number | null;
}

interface Found {
  holdings: Holding[];
  metas: ScanMeta[];
  corpus: number;
}

interface StoredHolder {
  wallet?: string;
  pct_supply?: number;
  kind?: string;
  wallet_age_days?: number | null;
}

let tableMissingAt = 0;

function launchpadOf(mint: string): string | null {
  for (const [suffix, name] of LAUNCHPAD_SUFFIXES) if (mint.endsWith(suffix)) return name;
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function bornAt(checkedAt: number | null, ageDays: number | null | undefined): number | null {
  return checkedAt !== null && typeof ageDays === "number" && Number.isFinite(ageDays) ? Math.round(checkedAt - ageDays * 86400) : null;
}

/** The migration hasn't run: PostgREST (or Postgres) can't find the function or the table. */
function isTableMissing(code: string | undefined): boolean {
  return code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883";
}

/** Largest number of births falling inside one COHORT_WINDOW_DAYS window. */
function largestCohort(births: number[]): number {
  const t = [...births].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0, j = 0; j < t.length; j++) {
    while (t[j] - t[i] > COHORT_WINDOW_DAYS * 86400) i++;
    best = Math.max(best, j - i + 1);
  }
  return best;
}

const round = (x: number) => Math.round(x * 100) / 100;
const tag = (s: SiblingCoin) => (s.symbol ? `$${s.symbol}` : s.mint.slice(0, 6));

/**
 * Stored scans: the denominator for "how common is this wallet". A plain row count, which never touches
 * the jsonb (filtering to non-empty holder books detoasts every row and doubles the cost). It includes
 * EVM and empty-book scans, so it runs high (38 vs 27 today) and the ubiquity cutoff errs lenient.
 */
async function corpusSize(): Promise<number> {
  const c = db();
  if (!c) return 0;
  const { count, error } = await c.from("coin_scans").select("mint", { count: "exact", head: true });
  return error ? 0 : (count ?? 0);
}

/** Fallback: match the wallets straight inside coin_scans.scan jsonb. Two queries in parallel: matches + corpus size. */
async function viaJsonb(mint: string, wallets: string[], creator: string | null): Promise<Found | null> {
  const c = db();
  if (!c) return null;
  const corpusP = corpusSize();
  // `scan->holders @> [{"wallet": w}]` — indexable by a GIN on (scan->'holders') if one is ever added.
  const clauses = wallets.slice(0, JSONB_MAX_WALLETS).map((w) => `scan->holders.cs.[{"wallet":"${w}"}]`);
  if (creator) clauses.push(`scan->>creator.eq.${creator}`);
  const { data, error } = await c
    .from("coin_scans")
    .select("mint, symbol:scan->>symbol, creator:scan->>creator, checked_at:scan->>checked_at, age_seconds:scan->>age_seconds, holders:scan->holders")
    .neq("mint", mint)
    .or(clauses.join(","));
  if (error || !data) return null;
  const want = new Set(wallets.slice(0, JSONB_MAX_WALLETS));
  const holdings: Holding[] = [];
  const metas: ScanMeta[] = [];
  for (const r of data as Record<string, unknown>[]) {
    const checked = num(r.checked_at);
    const age = num(r.age_seconds);
    metas.push({
      mint: r.mint as string,
      symbol: (r.symbol as string | null) ?? null,
      creator: (r.creator as string | null) ?? null,
      launched_at: checked !== null && age !== null ? checked - age : null,
    });
    for (const h of (Array.isArray(r.holders) ? r.holders : []) as StoredHolder[]) {
      if (!h.wallet || !want.has(h.wallet) || typeof h.pct_supply !== "number" || h.pct_supply < MIN_PCT) continue;
      if (h.kind && SERVICE_KINDS.has(h.kind)) continue;
      holdings.push({ mint: r.mint as string, wallet: h.wallet, pct: h.pct_supply, kind: h.kind ?? null, born_at: bornAt(checked, h.wallet_age_days) });
    }
  }
  return { holdings, metas, corpus: await corpusP };
}

/**
 * Preferred: the narrow coin_holders table through the sibling_holdings() function (db/schema.sql):
 * positions, sibling metadata, same-creator coins and the corpus size in ONE round trip. Null when the
 * migration hasn't run yet (the caller falls back to jsonb) or on any error.
 */
async function viaTable(mint: string, wallets: string[], creator: string | null): Promise<Found | null> {
  const c = db();
  if (!c) return null;
  const { data, error } = await c.rpc("sibling_holdings", { p_mint: mint, p_wallets: wallets, p_creator: creator });
  if (error || !Array.isArray(data)) {
    if (isTableMissing(error?.code)) tableMissingAt = Date.now();
    return null;
  }
  const holdings: Holding[] = [];
  const metas = new Map<string, ScanMeta>();
  let corpus = 0;
  for (const r of data as Record<string, unknown>[]) {
    corpus = num(r.corpus) ?? corpus;
    const m = r.mint as string;
    if (!metas.has(m)) metas.set(m, { mint: m, symbol: (r.symbol as string | null) ?? null, creator: (r.creator as string | null) ?? null, launched_at: num(r.launched_at) });
    const pct = num(r.pct);
    if (typeof r.wallet !== "string" || pct === null || pct < MIN_PCT || SERVICE_KINDS.has((r.kind as string) ?? "")) continue;
    holdings.push({ mint: m, wallet: r.wallet, pct, kind: (r.kind as string | null) ?? null, born_at: num(r.born_at) });
  }
  // No sibling at all: the corpus size didn't come back with a row, and nothing downstream needs it.
  return { holdings, metas: [...metas.values()], corpus };
}

/**
 * Which other stored coins share this coin's top holders, and whether the shared set reads as one
 * operator rotating wallets (cabal) or just the wallets every coin has. Null when there is nothing to
 * check (no DB, no Solana holders) or the lookup failed. Never throws.
 */
export async function readSiblingOverlap(mint: string, holders: SiblingHolderInput[], opts: SiblingOverlapOpts = {}): Promise<SiblingOverlap | null> {
  const t0 = Date.now();
  try {
    if (!db()) return null;
    const exclude = excludedFunders();
    const creator = opts.creator && SOL_ADDRESS.test(opts.creator) ? opts.creator : null;
    const checkedAt = opts.checkedAt ?? Math.floor(Date.now() / 1000);

    const here = new Map<string, SiblingHolderInput>();
    for (const h of [...holders].sort((a, b) => b.pct_supply - a.pct_supply)) {
      if (here.size >= MAX_WALLETS) break;
      if (!SOL_ADDRESS.test(h.wallet) || h.wallet === mint || !(h.pct_supply >= MIN_PCT)) continue;
      if (exclude.has(h.wallet) || opts.exclude?.has(h.wallet) || (h.kind && SERVICE_KINDS.has(h.kind))) continue;
      if (!here.has(h.wallet)) here.set(h.wallet, h);
    }
    if (here.size === 0 && !creator) return null;
    const wallets = [...here.keys()];

    const source = opts.source ?? "auto";
    const tryTable = source === "table" || (source === "auto" && Date.now() - tableMissingAt > TABLE_RECHECK_MS);
    let used: "table" | "jsonb" = "table";
    let found = tryTable ? await viaTable(mint, wallets, creator) : null;
    if (!found && source !== "table") {
      used = "jsonb";
      found = await viaJsonb(mint, wallets, creator);
    }
    if (!found) return null;
    const corpus = found.corpus;

    // How common each wallet is across every stored scan. Any scan holding one of our wallets matched
    // the query, so counting over the matches IS the corpus-wide count for these wallets.
    const seenIn = new Map<string, Set<string>>();
    for (const h of found.holdings) {
      const s = seenIn.get(h.wallet) ?? new Set<string>();
      s.add(h.mint);
      seenIn.set(h.wallet, s);
    }
    const cutoff = Math.max(UBIQ_MIN_SCANS, Math.ceil(UBIQ_FRACTION * corpus));

    const metaBy = new Map(found.metas.map((m) => [m.mint, m]));
    const byMint = new Map<string, Holding[]>();
    for (const h of found.holdings) byMint.set(h.mint, [...(byMint.get(h.mint) ?? []), h]);
    for (const m of found.metas) if (creator && m.creator === creator && !byMint.has(m.mint)) byMint.set(m.mint, []);

    const padHere = launchpadOf(mint);
    const siblings: SiblingCoin[] = [];
    for (const [sib, hs] of byMint) {
      const meta = metaBy.get(sib);
      const ws: SiblingWallet[] = [];
      const births: number[] = [];
      for (const h of hs) {
        const mine = here.get(h.wallet);
        if (!mine) continue;
        const seen = seenIn.get(h.wallet)?.size ?? 1;
        const role: SiblingRole = mine.kind === "kol" || h.kind === "kol" ? "kol" : seen >= cutoff ? "ubiquitous" : "core";
        ws.push({ wallet: h.wallet, pct_here: round(mine.pct_supply), pct_there: round(h.pct), role, seen_in: seen });
        if (role === "core") {
          const b = bornAt(checkedAt, mine.wallet_age_days) ?? h.born_at;
          if (b !== null) births.push(b);
        }
      }
      const core = ws.filter((w) => w.role === "core");
      const pad = launchpadOf(sib);
      siblings.push({
        mint: sib,
        symbol: meta?.symbol ?? null,
        launchpad: pad,
        same_creator: !!creator && meta?.creator === creator,
        same_launchpad: !!pad && pad === padHere,
        launched_at: meta?.launched_at ?? null,
        shared: ws.length,
        core: core.length,
        core_pct_here: round(core.reduce((a, w) => a + w.pct_here, 0)),
        core_pct_there: round(core.reduce((a, w) => a + w.pct_there, 0)),
        cohort: births.length >= 2 ? largestCohort(births) : births.length,
        wallets: ws.sort((a, b) => b.pct_here - a.pct_here),
      });
    }
    siblings.sort((a, b) => Number(b.same_creator) - Number(a.same_creator) || b.core - a.core || b.core_pct_here - a.core_pct_here || b.shared - a.shared);

    const coreSet = new Map<string, number>();
    for (const s of siblings) for (const w of s.wallets) if (w.role === "core") coreSet.set(w.wallet, w.pct_here);
    const coreWallets = coreSet.size;
    const corePctHere = round([...coreSet.values()].reduce((a, b) => a + b, 0));
    const cohort = Math.max(0, ...siblings.map((s) => s.cohort));

    const isCabal = (s: SiblingCoin) =>
      s.core >= CABAL_MIN_WALLETS &&
      s.core_pct_here >= CABAL_MIN_PCT &&
      (s.cohort >= COHORT_MIN || (s.core >= HEAVY_MIN_WALLETS && s.core_pct_here >= HEAVY_MIN_PCT) || s.same_creator);
    const isLinked = (s: SiblingCoin) => (s.core >= LINK_MIN_WALLETS && s.core_pct_here >= LINK_MIN_PCT) || s.same_creator;
    const cabal = siblings.filter(isCabal);
    const linked = siblings.filter(isLinked);
    const verdict: SiblingOverlap["verdict"] =
      cabal.length > 0 ? "cabal" : linked.length > 0 || (coreWallets >= SPREAD_MIN_WALLETS && corePctHere >= SPREAD_MIN_PCT) ? "linked" : "none";

    const signals: string[] = [];
    for (const s of (cabal.length ? cabal : linked).slice(0, 3)) {
      if (s.core > 0)
        signals.push(
          `${s.core} top holder${s.core === 1 ? "" : "s"} holding ${s.core_pct_here.toFixed(1)}% here also hold ${s.core_pct_there.toFixed(1)}% of ${tag(s)}` +
            (s.cohort >= COHORT_MIN ? `, ${s.cohort} of them born within ${COHORT_WINDOW_DAYS} days of each other` : ""),
        );
      if (s.same_creator) signals.push(`Same deployer as ${tag(s)}`);
    }
    if (verdict !== "none" && siblings.filter((s) => s.core > 0).length > 1)
      signals.push(`${coreWallets} shared wallets across ${siblings.filter((s) => s.core > 0).length} sibling coins hold ${corePctHere.toFixed(1)}% here`);
    const ubiq = new Set(siblings.flatMap((s) => s.wallets.filter((w) => w.role === "ubiquitous").map((w) => w.wallet)));
    if (ubiq.size) signals.push(`${ubiq.size} shared wallet${ubiq.size === 1 ? " is" : "s are"} in ${cutoff}+ stored coins: bots or aggregators, ignored`);

    return {
      source: used,
      corpus,
      checked: used === "jsonb" ? Math.min(wallets.length, JSONB_MAX_WALLETS) : wallets.length,
      ubiquity_cutoff: cutoff,
      siblings: siblings.slice(0, MAX_SIBLINGS),
      core_wallets: coreWallets,
      core_pct_here: corePctHere,
      cohort,
      verdict,
      signals,
      ms: Date.now() - t0,
    };
  } catch {
    return null;
  }
}

/**
 * Write a scan's top holders into coin_holders (replacing the mint's previous rows). Call AFTER
 * putStoredScan: rows reference coin_scans(mint) so the 30-day trim cascades to them. Returns rows
 * written; 0 when the DB is off, the table doesn't exist yet, or anything fails. Never throws.
 */
export async function recordHolders(mint: string, holders: SiblingHolderInput[], opts: { checkedAt?: number } = {}): Promise<number> {
  const c = db();
  if (!c || Date.now() - tableMissingAt < TABLE_RECHECK_MS) return 0;
  try {
    const checkedAt = opts.checkedAt ?? Math.floor(Date.now() / 1000);
    const rows = new Map<string, { mint: string; wallet: string; pct: number; kind: string | null; born_at: number | null; updated_at: string }>();
    for (const h of holders) {
      if (!SOL_ADDRESS.test(h.wallet) || !(h.pct_supply >= MIN_PCT) || (h.kind && SERVICE_KINDS.has(h.kind)) || rows.has(h.wallet)) continue;
      rows.set(h.wallet, {
        mint,
        wallet: h.wallet,
        pct: Math.round(h.pct_supply * 1e4) / 1e4,
        kind: h.kind ?? null,
        born_at: bornAt(checkedAt, h.wallet_age_days),
        updated_at: new Date(checkedAt * 1000).toISOString(),
      });
    }
    const del = await c.from("coin_holders").delete().eq("mint", mint);
    if (del.error) {
      if (isTableMissing(del.error.code)) tableMissingAt = Date.now();
      return 0;
    }
    if (rows.size === 0) return 0;
    const ins = await c.from("coin_holders").insert([...rows.values()]);
    return ins.error ? 0 : rows.size;
  } catch {
    return 0;
  }
}
