import type { KV } from "../cache";

/**
 * Chart health for coins old enough to have a real chart. Indicators (RSI, MACD, Bollinger), a
 * volume-trend read on 2-hour windows, and descriptive support/resistance levels — all computed
 * from GeckoTerminal OHLCV, the only free keyless candle source. NOT signals to trade on: a
 * lagging-indicator read on a manipulated market, shown so a human can judge and roast it.
 *
 * Hard age gate: indicators need ~50 candles to stabilise, so on 1h candles a coin must be ≥~2 days
 * old before any of this means anything. Below that it's fitting curves to sniper noise — we refuse.
 */

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

const GT = "https://api.geckoterminal.com/api/v2";
/** Minimum candles for indicators to be stable (MACD 26+9 is the binding constraint). */
const MIN_CANDLES = 50;

/**
 * GeckoTerminal OHLCV, normalised oldest-first. The free tier is fragile — 429s on heavy or parallel
 * calls — so keep the limit modest, cache hard (10 min), and never fan these out.
 *
 * `token` must be the coin we're charting: without it GT prices the pool's BASE token, and many pools
 * list our coin as the quote (KNOTS/STONK charted STONK: $0.33 instead of $0.013), so every indicator
 * on the card described the wrong coin.
 *
 * `aggregate` groups candles (GT allows minute 1/5/15, hour 1/4/12, day 1): minute×15 is the chart
 * read's 15m timeframe. Aggregated minute candles move fast, so they're cached 5 min, not 10.
 */
export async function fetchOHLCV(
  network: string,
  pool: string,
  timeframe: "hour" | "day" | "minute",
  limit: number,
  cache: KV,
  token?: string,
  aggregate = 1,
): Promise<Candle[] | null> {
  const agg = aggregate > 1 ? `x${aggregate}` : "";
  const key = `ohlcv2:${network}:${pool}:${timeframe}${agg}:${limit}:${token ?? "base"}`;
  const hit = await cache.get<Candle[]>(key);
  if (hit) return hit;
  try {
    const res = await fetch(`${GT}/networks/${network}/pools/${pool}/ohlcv/${timeframe}?${aggregate > 1 ? `aggregate=${aggregate}&` : ""}limit=${Math.min(limit, 300)}&currency=usd${token ? `&token=${token}` : ""}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = j.data?.attributes?.ohlcv_list ?? [];
    const candles = list
      .filter((r) => r.length >= 6)
      .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
      .sort((a, b) => a.t - b.t); // oldest-first
    // Slow timeframes change slowly: caching them longer keeps a read at ~2 GT calls instead of 5 (GT 429s bursts).
    await cache.set(key, candles, timeframe === "day" ? 6 * 3600 : aggregate >= 4 ? 3600 : timeframe === "minute" ? 300 : 600);
    return candles;
  } catch {
    return null;
  }
}

/** EMA value over the whole series (standard smoothing, seeded on the first `period` mean). */
function ema(xs: number[], period: number): number | null {
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  let e = xs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

/** Full EMA series (one value per input from index period-1 on), for MACD's line difference. */
function emaSeries(xs: number[], period: number): number[] {
  const out: number[] = [];
  if (xs.length < period) return out;
  const k = 2 / (period + 1);
  let e = xs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  out.push(e);
  for (let i = period; i < xs.length; i++) {
    e = xs[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Wilder's RSI over `period` (default 14). 0–100; >70 overbought, <30 oversold. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(0, d)) / period;
    avgL = (avgL * (period - 1) + Math.max(0, -d)) / period;
  }
  if (avgL === 0) return 100;
  const rs = avgG / avgL;
  return 100 - 100 / (1 + rs);
}

/** MACD(12,26,9): the line, its signal, and the histogram (line − signal). */
export function macd(closes: number[], fast = 12, slow = 26, signalP = 9): { macd: number; signal: number; hist: number } | null {
  if (closes.length < slow + signalP) return null;
  const fastS = emaSeries(closes, fast);
  const slowS = emaSeries(closes, slow);
  // Align the two EMA series to the same (slow-length) tail, then take their difference per point.
  const offset = fastS.length - slowS.length;
  const line = slowS.map((s, i) => fastS[i + offset] - s);
  const signalArr = emaSeries(line, signalP);
  const macdLine = line.at(-1)!;
  const signal = signalArr.at(-1)!;
  return { macd: macdLine, signal, hist: macdLine - signal };
}

/** Bollinger(period, k): SMA mid ± k·σ. Returns the bands and where price sits within them (0–1). */
export function bollinger(closes: number[], period = 20, k = 2): { mid: number; upper: number; lower: number; pos: number } | null {
  if (closes.length < period) return null;
  const win = closes.slice(-period);
  const mid = win.reduce((s, x) => s + x, 0) / period;
  const variance = win.reduce((s, x) => s + (x - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const price = closes.at(-1)!;
  const pos = upper > lower ? (price - lower) / (upper - lower) : 0.5;
  return { mid, upper, lower, pos };
}

export interface VolumeTrend {
  /** Volume per 2-hour window, oldest→newest (last 3 windows). */
  windows: number[];
  /** True when all three recent 2h windows carried real volume — a confirmed active trend. */
  confirmed: boolean;
  direction: "rising" | "falling" | "steady";
}

/**
 * Kombucho's test: bucket volume into 2-hour windows and only call it a real trend when the last three
 * consecutive windows all carried volume. Assumes hourly candles (2 candles per window).
 */
export function volumeTrend(candles: Candle[]): VolumeTrend | null {
  if (candles.length < 6) return null;
  const last6 = candles.slice(-6);
  const w = [last6[0].v + last6[1].v, last6[2].v + last6[3].v, last6[4].v + last6[5].v];
  // "Real volume" floor: a window is alive if it's a meaningful fraction of the busiest of the three.
  const floor = Math.max(...w) * 0.15;
  const confirmed = w.every((x) => x > floor && x > 0);
  const direction = w[2] > w[1] && w[1] >= w[0] ? "rising" : w[2] < w[1] && w[1] <= w[0] ? "falling" : "steady";
  return { windows: w, confirmed, direction };
}

export interface Levels {
  /** Most recent swing low that sits below current price — the last floor that held. */
  support: number | null;
  /** The next swing low below support — where price probably finds its next floor. */
  probable_support: number | null;
  /** Nearest swing high above price — the overhead it has to clear. */
  resistance: number | null;
}

/** Pivot lows/highs: a candle whose low (high) is the extreme within ±w neighbours. */
function pivots(candles: Candle[], w = 3): { lows: number[]; highs: number[] } {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let i = w; i < candles.length - w; i++) {
    const lo = candles[i].l;
    const hi = candles[i].h;
    let isLow = true;
    let isHigh = true;
    for (let j = i - w; j <= i + w; j++) {
      if (candles[j].l < lo) isLow = false;
      if (candles[j].h > hi) isHigh = false;
    }
    if (isLow) lows.push(lo);
    if (isHigh) highs.push(hi);
  }
  return { lows, highs };
}

/** Descriptive support/resistance from swing pivots relative to the current price. */
export function levels(candles: Candle[]): Levels {
  const price = candles.at(-1)?.c ?? 0;
  const { lows, highs } = pivots(candles);
  const belows = lows.filter((l) => l < price).sort((a, b) => b - a); // nearest below first
  const aboves = highs.filter((h) => h > price).sort((a, b) => a - b); // nearest above first
  return {
    support: belows[0] ?? null,
    probable_support: belows[1] ?? null,
    resistance: aboves[0] ?? null,
  };
}

/**
 * Resolve a token's best trading pool from GeckoTerminal (highest liquidity). GeckoTerminal OHLCV
 * and the DexScreener embed both key on the POOL address, not the token — passing the token by
 * mistake returns one empty candle, which is exactly the "chart won't load" bug. Cached 1h.
 */
export interface GtPool {
  id?: string;
  attributes?: { reserve_in_usd?: string | number; volume_usd?: { h24?: string | number } };
}

/**
 * The pool to chart: most 24h volume, reserve as the tiebreak. Reserve alone is spoofable — $PARE's
 * top-"reserve" pool was a $2.7M mmETH pair with zero volume and 2 candles — and a pool nobody trades
 * has no chart anyway.
 */
export function pickTopPool(network: string, pools: GtPool[]): string | null {
  let best: string | null = null;
  let bestKey: [number, number] = [-1, -1];
  for (const p of pools) {
    const vol = Number(p.attributes?.volume_usd?.h24 ?? 0) || 0;
    const liq = Number(p.attributes?.reserve_in_usd ?? 0) || 0;
    const id = (p.id ?? "").replace(`${network}_`, "");
    if (id && (vol > bestKey[0] || (vol === bestKey[0] && liq > bestKey[1]))) {
      bestKey = [vol, liq];
      best = id;
    }
  }
  return best;
}

export async function resolveTopPool(network: string, mint: string, cache: KV): Promise<string | null> {
  // v2 key: v1 ranked by reserve alone and cached bait pools (inflated reserve, zero volume).
  const key = `toppool2:${network}:${mint}`;
  const hit = await cache.get<string | null>(key);
  if (hit !== undefined) return hit;
  try {
    const res = await fetch(`${GT}/networks/${network}/tokens/${mint}/pools?page=1`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: GtPool[] };
    const best = pickTopPool(network, j.data ?? []);
    await cache.set(key, best, 3600);
    return best;
  } catch {
    return null;
  }
}

export interface ChartHealth {
  enough: boolean;
  reason?: string;
  /** The pool the read came from — the client builds the DexScreener embed from this, not the token. */
  pool: string | null;
  timeframe: "hour";
  candles: number;
  price: number | null;
  rsi: number | null;
  macd: { macd: number; signal: number; hist: number } | null;
  bollinger: { mid: number; upper: number; lower: number; pos: number } | null;
  volume: VolumeTrend | null;
  levels: Levels | null;
}

/**
 * The full chart-health read from hourly candles. Refuses (enough:false) below ~50 candles, the
 * point where the indicators stop being noise. Everything here is descriptive, never a call.
 */
export function chartHealth(candles: Candle[] | null): ChartHealth {
  const base: ChartHealth = {
    enough: false,
    pool: null,
    timeframe: "hour",
    candles: candles?.length ?? 0,
    price: candles?.at(-1)?.c ?? null,
    rsi: null,
    macd: null,
    bollinger: null,
    volume: null,
    levels: null,
  };
  if (!candles || candles.length < MIN_CANDLES) {
    return { ...base, reason: `too young for a chart read — needs ~${MIN_CANDLES} hourly candles (~2 days), has ${candles?.length ?? 0}` };
  }
  const closes = candles.map((c) => c.c);
  return {
    ...base,
    enough: true,
    rsi: rsi(closes),
    macd: macd(closes),
    bollinger: bollinger(closes),
    volume: volumeTrend(candles),
    levels: levels(candles),
  };
}

/** Resolve the token's pool, pull its candles, compute the read, and carry the pool back for the embed. */
export async function chartForMint(network: string, mint: string, cache: KV): Promise<ChartHealth> {
  const pool = await resolveTopPool(network, mint, cache);
  if (!pool) return { ...chartHealth(null), reason: "no trading pool found for this token yet" };
  const candles = await fetchOHLCV(network, pool, "hour", 300, cache, mint);
  return { ...chartHealth(candles), pool };
}
