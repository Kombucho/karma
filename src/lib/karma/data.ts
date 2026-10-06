import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GRADE_TITLES } from "./scoring.config";
import type { Grade, Label } from "./types";

/**
 * Server-side reader for the on-disk scoring output. The callout-first pivot
 * replaced the planned Supabase layer (PRD §8) with flat files:
 *   - seed/leaderboard.json — the two ranked boards + unproven list
 *   - validation/<wallet>.json — the full per-wallet report (score + token receipts)
 *   - seed/kols.json — handle ↔ wallet ↔ source_url identities
 * All reads are synchronous file reads inside server components / route handlers.
 */

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const LEADERBOARD_PATH = path.join(ROOT, "seed", "leaderboard.json");
const KOLS_PATH = path.join(ROOT, "seed", "kols.json");

export const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** EVM contract / wallet address (0x + 40 hex). pump.fun's multichain coins use these. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface BoardRow {
  handle: string | null;
  wallet: string;
  /** v3 trust score, 0–100. Null = no public record to score. */
  karma: number | null;
  karma_low: number | null;
  karma_high: number | null;
  grade: Grade | null;
  title: string | null;
  n: number;
  dumps: number;
  rugs: number;
  wins: number;
  /** Shrunk rates as a multiple of the market's own. 1.0 = exactly average. */
  dumpVsMarket: number | null;
  rugVsMarket: number | null;
  dumpRate: number | null;
  rugRate: number | null;
  twoXRate: number | null;
  confidence: string;
  /** Grade was capped by an integrity floor, below what the karma band alone would give. */
  floored: boolean;
  unproven: boolean;
  verdict: string;
  computed_at: number | null;
  /** Behavioural bucket for wallets with no callout record. Nothing is ever "unproven". */
  behavior: string | null;
  behaviorVerdict: string | null;
  medianHoldMin: number | null;
  tradesPerDay: number | null;
  sniped: number | null;
  sniperSampled: number | null;
}

export interface Leaderboard {
  generated_at: string | null;
  model?: string;
  priors_version?: string;
  /** Population base rates the board's vs-market multiples are measured against. */
  market?: { dump: number; rug: number; two_x: number };
  pass_line?: number;
  highest: BoardRow[];
  shame: BoardRow[];
  unproven: BoardRow[];
}

/** The v3 trust block written by `npm run rescore`. */
export interface Trust {
  karma: number;
  grade: Grade;
  title: string;
  grade_floored: boolean;
  n: number;
  dump_rate: number;
  rug_rate: number;
  dump_rate_observed: number;
  rug_rate_observed: number;
  dump_vs_market: number;
  rug_vs_market: number;
  karma_low: number;
  karma_high: number;
  evidence_weight: number;
  confidence: string;
  opportunity: { two_x_rate: number; vs_market: number; reliability: number };
  verdict: string;
  model: string;
  priors_version: string;
  as_of: number;
}

export interface Kol {
  handle: string | null;
  display_name?: string;
  wallet_address: string;
  source_url?: string;
  verified?: boolean;
  /** X follower count from the seed, shown as reach beside the grade. */
  followers?: number | null;
}

export interface TokenReceipt {
  mint: string;
  symbol: string | null;
  name: string | null;
  status: string;
  label: Label | null;
  entry_time: number | null;
  entry_price: number | null;
  copy_return_24h: number | null;
  copy_peak_multiple: number | null;
  max_drop_from_peak_24h: number | null;
  price_source?: "geckoterminal" | "pumpfun";
  caller_exited?: boolean;
  caller_pnl_usd?: number | null;
  held_through_rug?: boolean;
  // Opportunity model (recompute.ts --write) tracks integrity as flags, separate from
  // the opportunity `label` (WIN/NEUTRAL/LOSS = did the call offer a reachable 2x shot).
  rugged?: boolean;
  dumped?: boolean;
}

export interface WalletReport {
  handle: string | null;
  wallet: string;
  computed_at: number;
  config_version: string;
  /** Present on every v3-scored file. Absent means the wallet had too thin a record to score. */
  trust?: Trust;
  /** pump.fun profile pulled by enrich-identities. Reach orders the board, never the grade. */
  identity?: { username?: string | null; followers?: number | null } | null;
  scan: Record<string, number | string>;
  score: {
    wallet: string;
    n_tokens: number;
    wins: number;
    losses: number;
    dumps: number;
    rugs: number;
    neutrals: number;
    follower_hit_rate: number | null;
    median_copy_return: number | null;
    dump_rate: number | null;
    rug_rate: number | null;
    wallet_realized_pnl_sol: number;
    longest_win_streak: number;
    unproven: boolean;
    karma_score: number | null;
    grade: Grade | null;
    title: string | null;
    confidence: string;
    verdict: string;
  };
  tokens: TokenReceipt[];
}

let _kols: Kol[] | null = null;
function kols(): Kol[] {
  if (_kols) return _kols;
  try {
    _kols = JSON.parse(readFileSync(KOLS_PATH, "utf8")) as Kol[];
  } catch {
    _kols = [];
  }
  return _kols;
}

/** handle → wallet, case-insensitive, ignoring a leading @. Returns null if unknown. */
export function resolveHandle(input: string): string | null {
  const h = input.replace(/^@/, "").toLowerCase();
  const hit = kols().find((k) => k.handle?.toLowerCase() === h);
  return hit?.wallet_address ?? null;
}

/** The identity (handle / source_url / verified) behind a wallet, from the seed list. */
export function identityFor(wallet: string): Kol | null {
  return kols().find((k) => k.wallet_address === wallet) ?? null;
}

/** A wallet's role in a known Sybil cluster — the scar, carried alongside the score, never inside it. */
export interface SybilMembership {
  role: "deployer" | "funder" | "member";
  cluster_id: string;
  coin: string;
  coin_symbol: string | null;
  evidence: string;
}

interface SybilCluster {
  id: string;
  coin: string;
  coin_symbol: string | null;
  deployer: string | null;
  funder: string | null;
  members: string[];
  evidence: string;
}

let _sybilIndex: Map<string, SybilMembership> | null = null;
/**
 * wallet → its role in a recorded Sybil cluster, built once from seed/sybil_clusters.json
 * (written offline by scripts/enrich-sybil-clusters.ts). This is a SEPARATE axis from the trust
 * grade: a farm puppet has no callouts to dump on, so the calibrated number can't and shouldn't
 * express "this is a manufactured wallet". The flag says it plainly instead.
 */
export function sybilIndex(): Map<string, SybilMembership> {
  if (_sybilIndex) return _sybilIndex;
  const idx = new Map<string, SybilMembership>();
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, "seed", "sybil_clusters.json"), "utf8")) as { clusters?: SybilCluster[] };
    for (const c of raw.clusters ?? []) {
      const tag = (role: SybilMembership["role"]): SybilMembership => ({ role, cluster_id: c.id, coin: c.coin, coin_symbol: c.coin_symbol, evidence: c.evidence });
      // Deployer/funder outrank member if a wallet appears twice — the more damning role wins.
      if (c.deployer) idx.set(c.deployer, tag("deployer"));
      if (c.funder && !idx.has(c.funder)) idx.set(c.funder, tag("funder"));
      for (const m of c.members) if (!idx.has(m)) idx.set(m, tag("member"));
    }
  } catch {}
  _sybilIndex = idx;
  return idx;
}

/** Is this wallet a known Sybil-farm deployer, funder, or puppet? Null if clean. */
export function sybilFor(wallet: string): SybilMembership | null {
  return sybilIndex().get(wallet) ?? null;
}

export function getLeaderboard(): Leaderboard {
  try {
    return JSON.parse(readFileSync(LEADERBOARD_PATH, "utf8")) as Leaderboard;
  } catch {
    return { generated_at: null, highest: [], shame: [], unproven: [] };
  }
}

export function getWalletReport(wallet: string): WalletReport | null {
  const file = path.join(VALIDATION_DIR, `${wallet}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WalletReport;
  } catch {
    return null;
  }
}

let _gradeIndex: Map<string, { grade: Grade | null; title: string | null }> | null = null;
/** wallet → grade/title, built in one readdir pass. Board rows only carry a karma
 *  number, so this backfills the letter grade + title for the mini-cards. */
export function gradeIndex(): Map<string, { grade: Grade | null; title: string | null }> {
  if (_gradeIndex) return _gradeIndex;
  const idx = new Map<string, { grade: Grade | null; title: string | null }>();
  try {
    for (const f of readdirSync(VALIDATION_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(VALIDATION_DIR, f), "utf8"));
        // Title is a pure function of grade, so derive it — the stored string can be a stale
        // taxonomy (e.g. an old "Saint" before the Chad/Larper rename); grade is the source of truth.
        const grade: Grade | null = r.trust?.grade ?? r.score?.grade ?? null;
        idx.set(r.wallet, { grade, title: grade ? GRADE_TITLES[grade] : null });
      } catch {}
    }
  } catch {}
  _gradeIndex = idx;
  return idx;
}

/**
 * Corpus size, for honest coverage copy. `graded` counts v3 trust blocks specifically, not
 * any stored grade — a few legacy files still carry an old-model letter and counting those
 * would overstate what the current model actually covers.
 */
let _coverage: { scored: number; graded: number; seed: number; calls: number; coins: number } | null = null;
export function coverageStats() {
  if (_coverage) return _coverage;
  let scored = 0;
  let graded = 0;
  let calls = 0;
  const coins = new Set<string>();
  try {
    for (const f of readdirSync(VALIDATION_DIR)) {
      if (!f.endsWith(".json")) continue;
      scored++;
      try {
        const r = JSON.parse(readFileSync(path.join(VALIDATION_DIR, f), "utf8"));
        if (r.trust) graded++;
        for (const t of r.tokens ?? []) {
          if (t.status !== "scored") continue;
          calls++;
          coins.add(t.mint);
        }
      } catch {}
    }
  } catch {}
  _coverage = { scored, graded, seed: kols().length, calls, coins: coins.size };
  return _coverage;
}

/** Same as shortWallet, re-exported for the OG route so it never imports the Tailwind UI module. */
export const shortWalletOG = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** Community fortune-cookie lines, proven by the same claim post that binds the handle. */
export function getQuotes(): Array<{ text: string; handle: string }> {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, "seed", "quotes.json"), "utf8"));
  } catch {
    return [];
  }
}
