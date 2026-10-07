import type { CoinScan } from "@/lib/karma/engine/coin";
import type { KV } from "@/lib/karma/cache";
import { getStoredScan } from "@/lib/karma/db";
import { serverCache } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";
import { fetchOHLCV, resolveTopPool, type Candle } from "@/lib/karma/sources/ta";
import { buildFeatures, type MarketNow } from "@/lib/karma/quant/features";
import { askJev, jevState } from "@/lib/karma/quant/jev";
import { gradesFor, liveRubric, recentSnapshot, saveSnapshot, type QuantGrade } from "@/lib/karma/quant/store";
import type { JevAnswer, QuantFeatures, QuantSnapshot } from "@/lib/karma/quant/types";

/**
 * Jev's read of one coin, lazily fetched by the coin page. Reads an EXISTING scan only (never rescans:
 * that's the budgeted /api/coin path), adds 1h candles + live market numbers, builds the features and asks
 * the live rubric's questions. Every page view is a training snapshot, deduped to one per mint+rubric per
 * 6h. Grades travel with the answers so the page can say honestly whether these calls have a record yet.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REUSE_S = 6 * 3600;
const MEMO_S = 300;
/** Graded outcomes a question needs before its track record means anything. */
const MIN_GRADED_N = 40;

export interface JevGradeSummary {
  n: number;
  graded: boolean;
  /** 1 - Brier / Brier(base rate). >0 beats always guessing the base rate. */
  brier_skill: number | null;
  hit_rate: number | null;
  calibration: QuantGrade["calibration"];
}

export interface JevRead {
  mint: string;
  rubric_version: string;
  t: number;
  reused: boolean;
  answers: Record<string, JevAnswer>;
  /** Which questions predict a checkable price event (the rest are descriptive, never graded). */
  targeted: string[];
  market: { price_usd: number | null; mcap_usd: number | null; liquidity_usd: number | null };
  chart: QuantFeatures["chart"];
  grades: Record<string, JevGradeSummary>;
  /** True once every targeted question has ≥ MIN_GRADED_N graded outcomes. */
  graded: boolean;
  min_graded_n: number;
}

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!BASE58_ADDRESS.test(mint) && !EVM_ADDRESS.test(mint)) return Response.json({ error: "not a coin address" }, { status: 400, headers: NO_STORE });
  if (!allow("jev", req, 10, 30)) return tooMany();

  const scan = await loadScan(mint);
  if (!scan) return Response.json({ error: "no scan for this coin yet — open its page first" }, { status: 404, headers: NO_STORE });
  // EVM coins read the same rubric on their own chain's candles + DexScreener pair (holder lenses are thinner there).
  const network = scan.chain === "solana" ? "solana" : scan.chart_ref?.network;
  if (!network) return Response.json({ error: "no chart for this chain yet" }, { status: 404, headers: NO_STORE });

  const rubric = await liveRubric();
  const memoKey = `jev:${mint}:${rubric.version}`;
  const targeted = Object.keys(rubric.targets);

  // Same mint + rubric inside 6h → reuse (memory first, so it still dedupes when the quant tables are missing).
  let snap = (await serverCache.get<QuantSnapshot>(memoKey)) ?? (await recentSnapshot(mint, rubric.version, REUSE_S));
  let reused = !!snap;

  if (!snap) {
    const now = Math.floor(Date.now() / 1000);
    const [candles, market] = await Promise.all([candlesForMint(network, mint, serverCache), marketNow(network, mint, serverCache)]);
    // EVM fallback: pump's own mcap/liquidity when DexScreener has no pair yet.
    const mkt = market ?? (scan.market ? { price_usd: null, mcap_usd: scan.market.mcap_usd, liquidity_usd: scan.market.liquidity_usd } : null);
    const features = buildFeatures(scan, candles, mkt, now);
    const jev = await askJev(jevState(features), rubric.questions);
    if (!jev) return Response.json({ error: "Jev didn't answer — try again in a minute" }, { status: 502, headers: NO_STORE });
    snap = { mint, t: now, price_usd: features.price_usd, rubric_version: rubric.version, features, answers: jev.answers, source: "page" };
    const id = await saveSnapshot(snap);
    if (id !== null) snap.id = id;
    reused = false;
  }
  await serverCache.set(memoKey, snap, MEMO_S);

  const grades = summariseGrades(await gradesFor(rubric.version));
  const body: JevRead = {
    mint,
    rubric_version: rubric.version,
    t: snap.t,
    reused,
    answers: snap.answers,
    targeted,
    market: { price_usd: snap.features.price_usd, mcap_usd: snap.features.mcap_usd, liquidity_usd: snap.features.liquidity_usd },
    chart: snap.features.chart,
    grades,
    graded: targeted.length > 0 && targeted.every((q) => grades[q]?.graded),
    min_graded_n: MIN_GRADED_N,
  };
  return Response.json(body, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=60" } });
}

/** The scan the coin page already paid for: hot cache, else the stored row. Never a fresh scan. */
async function loadScan(mint: string): Promise<CoinScan | null> {
  const hot = await serverCache.get<CoinScan>(`coinscan:${mint}`);
  if (hot) return hot;
  const stored = await getStoredScan<CoinScan>(mint);
  return stored?.scan && !stored.scan.partial ? stored.scan : null;
}

/**
 * ~168 1h candles. Pulls the same 300-candle window the chart panel does so both share one cached
 * GeckoTerminal call, then keeps the last week. Swap for features.fetchCandlesForMint when it lands.
 */
async function candlesForMint(network: string, mint: string, cache: KV): Promise<Candle[] | null> {
  const pool = await resolveTopPool(network, mint, cache);
  if (!pool) return null;
  const candles = await fetchOHLCV(network, pool, "hour", 300, cache, mint);
  return candles ? candles.slice(-168) : null;
}

interface DexPair {
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

/** Price / mcap / liquidity from the deepest DexScreener pair where the mint is the base token. Cached 60s. */
async function marketNow(network: string, mint: string, cache: KV): Promise<MarketNow | null> {
  const key = `jevmarket:${mint}`;
  // GeckoTerminal slugs double as DexScreener chain ids, except Ethereum. EVM addresses compare case-blind.
  const chain = network === "eth" ? "ethereum" : network;
  const same = (a?: string) => a?.toLowerCase() === mint.toLowerCase();
  const hit = await cache.get<MarketNow>(key);
  if (hit) return hit;
  try {
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chain}/${mint}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const pairs = ((await res.json()) as DexPair[] | null) ?? [];
    const best = pairs
      .filter((p) => same(p.baseToken?.address) && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best) return null;
    const m: MarketNow = {
      price_usd: Number(best.priceUsd),
      mcap_usd: best.marketCap ?? best.fdv ?? null,
      liquidity_usd: pairs.filter((p) => same(p.baseToken?.address)).reduce((s, p) => s + Math.round(p.liquidity?.usd ?? 0), 0) || null,
    };
    await cache.set(key, m, 60);
    return m;
  } catch {
    return null;
  }
}

function summariseGrades(rows: QuantGrade[]): Record<string, JevGradeSummary> {
  const out: Record<string, JevGradeSummary> = {};
  for (const g of rows) {
    const skill = g.brier != null && g.brier_baseline != null && g.brier_baseline > 0 ? 1 - g.brier / g.brier_baseline : null;
    out[g.question] = { n: g.n, graded: g.n >= MIN_GRADED_N, brier_skill: skill, hit_rate: g.hit_rate, calibration: g.calibration };
  }
  return out;
}
