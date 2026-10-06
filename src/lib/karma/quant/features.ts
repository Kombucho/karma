import type { KV } from "../cache";
import type { CoinScan } from "../engine/coin";
import { coinVerdict } from "../engine/verdict";
import { fetchOHLCV, resolveTopPool, type Candle } from "../sources/ta";
import {
  atrPct, bbPos, bbWidth, drawdownFromHigh, emaSpread, finite, higherLows, macdCross, macdHistPct, obvSlope, rangePos, roc,
  rsi14, stochRsi, volumeZ, vwapDist,
} from "./indicators";
import type { QuantFeatures } from "./types";

/** Live market numbers for the snapshot (DexScreener). */
export interface MarketNow {
  price_usd: number | null;
  mcap_usd: number | null;
  liquidity_usd: number | null;
}

/** Below this many 1h candles the indicators are noise (MACD 26+9 warm-up is the binding constraint). */
export const CHART_MIN_CANDLES = 50;
/** The window the features read: one week of hourly candles. */
export const CHART_WINDOW = 168;

/**
 * Build the flat feature snapshot Jev judges. Pure and deterministic (no I/O): every number is computed
 * in code from the scan, the candles and the market read. Candles after `t` are ignored, so replaying an
 * old snapshot with today's candle history can't peek at the future. `chart` is null below 50 candles.
 */
export function buildFeatures(scan: CoinScan, candles: Candle[] | null, market: MarketNow | null, t: number): QuantFeatures {
  const seen = snapshotCandles(candles, t);
  const lastClose = seen.at(-1)?.c ?? null;
  const ageAtScan = scan.age_seconds;
  const s = scan.summary;
  const en = scan.holder_entry ?? null;
  const hb = scan.holder_behavior ?? null;
  const ms = scan.market_structure ?? null;
  const ff = scan.fresh_flow ?? null;
  const hs = scan.holder_sample;
  const dev = scan.dev;
  const ts = scan.token_safety;
  const clusterPct = (scan.holder_clusters ?? []).reduce((x, c) => x + c.pct_total, 0);

  return {
    mint: scan.mint,
    network: scan.chain === "solana" ? "solana" : (scan.chart_ref?.network ?? undefined),
    symbol: scan.symbol,
    t,
    price_usd: finite(market?.price_usd) ?? finite(lastClose),
    mcap_usd: finite(market?.mcap_usd) ?? finite(ms?.lp?.mcap_usd),
    liquidity_usd: finite(market?.liquidity_usd) ?? finite(ms?.lp?.liquidity_usd),
    // The scan's age is as of checked_at; carry it forward to the snapshot time.
    age_hours: ageAtScan !== null ? finite((ageAtScan + Math.max(0, t - scan.checked_at)) / 3600) : null,
    chart: chartFeatures(seen),
    holders: {
      verdict: coinVerdict(scan),
      top10_pct: finite(s?.top10_pct),
      holder_count: finite(s?.holder_count),
      insider_shaped_pct: finite(en?.cohort_pct),
      // A Blockscout-sourced book has balances but no entry history: its sniper share is unknown, not 0.
      sniper_pct: finite(en?.sniper_pct ?? (scan.evm_holder_book?.source === "blockscout" ? null : scan.evm_holder_book?.snipers.pct)),
      connected_pct: s ? finite(clusterPct + s.pct_bundled) : null,
      ecosystem_only_pct: finite(hb?.ecosystem_only_pct),
      reward_only_pct: finite(hb?.reward_only_pct),
      crowd_manufactured: hs && hs.sampled > 0 ? finite(hs.manufactured_pct) : null,
      fresh_flow_severity: ff?.severity ?? null,
      fresh_net_sol_1h: finite(ff?.fresh_net_sol),
      sibling_verdict: scan.sibling_overlap?.verdict ?? null,
      lp_pullable_share: finite(ms?.lp?.pullable_share),
      wash_share: finite(ms?.wash?.wash_share),
      even_share_group_pct: finite(ms?.even?.group_pct),
      dev_launches: finite(dev?.launches),
      dev_graduated: finite(dev?.graduated),
      dev_holds_pct: finite(dev?.holds_pct),
      token_risk: ts?.severity ?? null,
      transfer_fee_bps: finite(ts?.transfer_fee_bps),
    },
  };
}

/** The candles a snapshot at `t` reads: only what was knowable at t, carried flat up to t's hour (a coin
 * nobody trades still has a price), last week only. */
export function snapshotCandles(candles: Candle[] | null, t: number): Candle[] {
  return fillHourlyGaps((candles ?? []).filter((c) => c.t <= t), t).slice(-CHART_WINDOW);
}

/** The chart block from oldest-first 1h candles, or null when there are too few to be stable. */
export function chartFeatures(candles: Candle[]): QuantFeatures["chart"] {
  if (candles.length < CHART_MIN_CANDLES) return null;
  const closes = candles.map((c) => c.c);
  return {
    candles: candles.length,
    rsi14: rsi14(closes),
    macd_hist: macdHistPct(closes),
    macd_cross: macdCross(closes),
    bb_pos: bbPos(closes),
    bb_width: bbWidth(closes),
    ema20_vs_ema50: emaSpread(closes, 20, 50),
    atr_pct: atrPct(candles, 14),
    roc_24h: roc(closes, 24),
    roc_6h: roc(closes, 6),
    drawdown_from_high: drawdownFromHigh(candles),
    range_pos: rangePos(candles),
    vol_z: volumeZ(candles, 6),
    obv_slope: obvSlope(candles, 24),
    vwap_dist: vwapDist(candles, 24),
    stoch_rsi: stochRsi(closes),
    higher_lows: higherLows(candles),
  };
}

/**
 * GeckoTerminal omits hours with no trades. Indicators assume one candle per hour, so fill each gap with
 * a flat zero-volume candle at the previous close (a quiet hour is a real observation, not missing data).
 * With `until` (unix s), also extend flat candles up to the hour containing it.
 */
export function fillHourlyGaps(candles: Candle[], until?: number): Candle[] {
  const H = 3600;
  const out: Candle[] = [];
  const flat = (t: number, c: number): Candle => ({ t, o: c, h: c, l: c, c, v: 0 });
  for (const c of candles) {
    const prev = out.at(-1);
    if (prev) for (let t = prev.t + H; t < c.t && out.length < 10_000; t += H) out.push(flat(t, prev.c));
    out.push(c);
  }
  const last = out.at(-1);
  if (last && until !== undefined) for (let t = last.t + H; t <= until && out.length < 10_000; t += H) out.push(flat(t, last.c));
  return out;
}

export interface MintCandles {
  pool: string | null;
  /** Oldest-first 1h candles (gap-filled), at most CHART_WINDOW of them. Null when GeckoTerminal failed or has no pool. */
  candles: Candle[] | null;
}

/**
 * ~One week of 1h candles for a mint, through the same GeckoTerminal path (and cache keys) as the coin
 * page's chart panel: resolve the top pool, pull 300 hourly candles, gap-fill, keep the last 168.
 *
 * GeckoTerminal's free tier 429s after a handful of calls a minute and ta.ts reads a 429 as null, so a
 * null is retried with backoff. A genuine "no pool" is cached by resolveTopPool, so its retries are free.
 */
export async function fetchCandlesForMint(network: string, mint: string, cache: KV, retries = 2): Promise<MintCandles> {
  let pool: string | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 5_000 * attempt));
    pool = pool ?? (await resolveTopPool(network, mint, cache));
    if (!pool) {
      if ((await cache.get(`toppool2:${network}:${mint}`)) !== undefined) return { pool: null, candles: null }; // cached: truly none
      continue;
    }
    const raw = await fetchOHLCV(network, pool, "hour", 300, cache, mint);
    if (raw) return { pool, candles: fillHourlyGaps(raw).slice(-CHART_WINDOW) };
  }
  return { pool, candles: null };
}

/** Live price / market cap / liquidity from DexScreener's deepest pair where the mint is the base token. */
export async function fetchMarketNow(mint: string, chain = "solana"): Promise<MarketNow | null> {
  try {
    // GeckoTerminal slugs double as DexScreener chain ids except Ethereum; EVM addresses compare case-blind.
    const dexChain = chain === "eth" ? "ethereum" : chain;
    const res = await fetch(`https://api.dexscreener.com/token-pairs/v1/${dexChain}/${mint}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const pairs = (await res.json()) as Array<{
      baseToken?: { address?: string };
      priceUsd?: string;
      marketCap?: number;
      fdv?: number;
      liquidity?: { usd?: number };
    }>;
    const mine = (Array.isArray(pairs) ? pairs : []).filter((p) => p.baseToken?.address?.toLowerCase() === mint.toLowerCase());
    if (!mine.length) return null;
    const top = mine.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    return {
      price_usd: finite(Number(top.priceUsd)),
      mcap_usd: finite(top.marketCap ?? top.fdv),
      liquidity_usd: finite(mine.reduce((x, p) => x + (p.liquidity?.usd ?? 0), 0)),
    };
  } catch {
    return null;
  }
}
