import { bollinger, macd, rsi, type Candle } from "../sources/ta";

/**
 * The quant indicator library over 1h candles (oldest-first). Pure and deterministic: same candles in,
 * same numbers out. Every function returns null when there isn't enough data or the answer would be
 * undefined (zero price, zero volume, flat series), so NaN / Infinity never reach a feature snapshot.
 *
 * Scale-free on purpose: memecoin prices sit at 1e-5, so anything price-denominated is divided by the
 * close (or its own mean) before it leaves here. Ratios are fractions (0.1 = 10%), not percentages.
 */

/** The number, or null when it isn't a finite number. The single gate everything returns through. */
export function finite(x: number | null | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** EMA series seeded on the SMA of the first `period` values: one value per input from index period-1 on. */
export function emaSeries(xs: number[], period: number): number[] {
  if (period < 1 || xs.length < period) return [];
  const k = 2 / (period + 1);
  let e = mean(xs.slice(0, period));
  const out = [e];
  for (let i = period; i < xs.length; i++) {
    e = xs[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

/** Latest EMA value, null below `period` points. */
export function ema(xs: number[], period: number): number | null {
  return finite(emaSeries(xs, period).at(-1));
}

/** (EMA fast − EMA slow) / EMA slow: the trend spread, e.g. 0.05 = fast average 5% above slow. */
export function emaSpread(closes: number[], fast = 20, slow = 50): number | null {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  if (f === null || s === null || s <= 0) return null;
  return finite((f - s) / s);
}

/** True range of candle i (needs the previous close). */
function trueRange(c: Candle, prevClose: number): number {
  return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
}

/** Wilder's ATR(period): seeded on the mean of the first `period` true ranges, then smoothed. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) trs.push(trueRange(candles[i], candles[i - 1].c));
  let a = mean(trs.slice(0, period));
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return finite(a);
}

/** ATR as a fraction of the last close: the typical hourly swing, e.g. 0.08 = 8% an hour. */
export function atrPct(candles: Candle[], period = 14): number | null {
  const a = atr(candles, period);
  const c = candles.at(-1)?.c ?? 0;
  if (a === null || c <= 0) return null;
  return finite(a / c);
}

/** Rate of change over `n` candles, as a fraction: close / close n candles ago − 1. */
export function roc(closes: number[], n: number): number | null {
  if (n < 1 || closes.length < n + 1) return null;
  const then = closes[closes.length - 1 - n];
  if (then <= 0) return null;
  return finite(closes[closes.length - 1] / then - 1);
}

/** Least-squares slope of ys against 0..n-1. */
function slope(ys: number[]): number | null {
  const n = ys.length;
  if (n < 2) return null;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (ys[i] - my);
    den += (i - mx) ** 2;
  }
  return den > 0 ? num / den : null;
}

/**
 * On-balance-volume slope over the last `window` candles, normalised by the window's mean volume per
 * candle. Dimensionless, typically within [−1, 1]: +1 = every candle closed up on steady volume (all of
 * it accumulating), −1 = every candle closed down, ~0 = volume split evenly between up and down closes.
 * A late volume spike in one direction can push it past ±1.
 */
export function obvSlope(candles: Candle[], window = 24): number | null {
  if (candles.length < window + 1) return null;
  const tail = candles.slice(-(window + 1));
  const obv = [0];
  for (let i = 1; i < tail.length; i++) {
    const d = tail[i].c - tail[i - 1].c;
    obv.push(obv[i - 1] + (d > 0 ? tail[i].v : d < 0 ? -tail[i].v : 0));
  }
  const vbar = mean(tail.slice(1).map((c) => c.v));
  const s = slope(obv);
  if (s === null || vbar <= 0) return null;
  return finite(s / vbar);
}

/** (close − VWAP) / VWAP over the last `window` candles, VWAP on the typical price (h+l+c)/3. */
export function vwapDist(candles: Candle[], window = 24): number | null {
  if (candles.length < window) return null;
  const tail = candles.slice(-window);
  const vol = sum(tail.map((c) => c.v));
  if (vol <= 0) return null;
  const vwap = sum(tail.map((c) => ((c.h + c.l + c.c) / 3) * c.v)) / vol;
  if (vwap <= 0) return null;
  return finite(tail[tail.length - 1].c / vwap - 1);
}

/** Wilder's RSI at every point from index `period` on (the last value equals ta.ts's rsi()). */
export function rsiSeries(closes: number[], period = 14): number[] {
  if (closes.length < period + 1) return [];
  const val = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  let g = 0;
  let l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) g += d;
    else l -= d;
  }
  g /= period;
  l /= period;
  const out = [val(g, l)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(0, d)) / period;
    l = (l * (period - 1) + Math.max(0, -d)) / period;
    out.push(val(g, l));
  }
  return out;
}

/** RSI(14) via ta.ts, gated to a finite 0..100. */
export function rsi14(closes: number[]): number | null {
  return finite(rsi(closes, 14));
}

/**
 * Stochastic RSI: where the latest RSI sits in its own range over the last `stochPeriod` readings, 0..1
 * (1 = RSI at its window high). A flat RSI (no range) reads 0.5.
 */
export function stochRsi(closes: number[], rsiPeriod = 14, stochPeriod = 14): number | null {
  const r = rsiSeries(closes, rsiPeriod);
  if (r.length < stochPeriod) return null;
  const win = r.slice(-stochPeriod);
  const lo = Math.min(...win);
  const hi = Math.max(...win);
  return finite(hi > lo ? (win[win.length - 1] - lo) / (hi - lo) : 0.5);
}

/** Bollinger(20, 2) position of the close: 0 = lower band, 1 = upper band (can overshoot either side). */
export function bbPos(closes: number[]): number | null {
  return finite(bollinger(closes)?.pos);
}

/** Bollinger(20, 2) width as a fraction of the mid: (upper − lower) / mid. Low = a squeeze. */
export function bbWidth(closes: number[]): number | null {
  const b = bollinger(closes);
  if (!b || b.mid <= 0) return null;
  return finite((b.upper - b.lower) / b.mid);
}

/** MACD(12,26,9) histogram as a fraction of the close, so it compares across price scales. */
export function macdHistPct(closes: number[]): number | null {
  const m = macd(closes);
  const c = closes.at(-1) ?? 0;
  if (!m || c <= 0) return null;
  return finite(m.hist / c);
}

/**
 * MACD cross state: "bull" when the histogram turned from ≤0 to >0 within the last `lookback` candles
 * and is still positive, "bear" for the mirror, "none" otherwise.
 */
export function macdCross(closes: number[], lookback = 3): "bull" | "bear" | "none" | null {
  const hist: number[] = [];
  for (let k = lookback; k >= 0; k--) {
    const m = macd(k ? closes.slice(0, -k) : closes);
    if (!m || !Number.isFinite(m.hist)) return null;
    hist.push(m.hist); // oldest → newest
  }
  const now = hist[hist.length - 1];
  for (let i = 1; i < hist.length; i++) {
    if (now > 0 && hist[i - 1] <= 0 && hist[i] > 0) return "bull";
    if (now < 0 && hist[i - 1] >= 0 && hist[i] < 0) return "bear";
  }
  return "none";
}

/**
 * Volume z-score: the last `recent` candles' total volume against the trailing blocks of the same size
 * (non-overlapping, up to `maxBlocks` of them), in standard deviations. Needs 4+ trailing blocks.
 *
 * Measured in log space, ln(1 + USD volume): memecoin volume is heavy-tailed, and a dead coin trading
 * $5 an hour that suddenly does $45k scored z ≈ 530 in linear space (CACKLE, 25 Sep 2026). In log space
 * the same spike reads ≈ 5, and "3" means the same thing on a $1k coin and a $10M one.
 */
export function volumeZ(candles: Candle[], recent = 6, maxBlocks = 24): number | null {
  const blocks: number[] = [];
  for (let end = candles.length - recent; end - recent >= 0 && blocks.length < maxBlocks; end -= recent) {
    blocks.push(Math.log1p(Math.max(0, sum(candles.slice(end - recent, end).map((c) => c.v)))));
  }
  if (candles.length < recent || blocks.length < 4) return null;
  const sd = std(blocks);
  if (sd <= 0) return null;
  const last = Math.log1p(Math.max(0, sum(candles.slice(-recent).map((c) => c.v))));
  return finite((last - mean(blocks)) / sd);
}

/** How far the close sits below the window's highest high, 0..1 (0 = at the high). */
export function drawdownFromHigh(candles: Candle[]): number | null {
  if (!candles.length) return null;
  const hi = Math.max(...candles.map((c) => c.h));
  if (hi <= 0) return null;
  return finite(Math.max(0, 1 - candles[candles.length - 1].c / hi));
}

/** Where the close sits in the window's low..high range, 0..1. */
export function rangePos(candles: Candle[]): number | null {
  if (!candles.length) return null;
  const hi = Math.max(...candles.map((c) => c.h));
  const lo = Math.min(...candles.map((c) => c.l));
  if (!(hi > lo)) return null;
  return finite(Math.min(1, Math.max(0, (candles[candles.length - 1].c - lo) / (hi - lo))));
}

/** Swing lows: candles whose low is the strict minimum within ±w neighbours (ties don't count twice). */
export function swingLows(candles: Candle[], w = 3): { i: number; low: number }[] {
  const out: { i: number; low: number }[] = [];
  for (let i = w; i < candles.length - w; i++) {
    const lo = candles[i].l;
    let ok = true;
    for (let j = i - w; j <= i + w && ok; j++) {
      if (j === i) continue;
      // strictly lower on the left, lower-or-equal on the right: a flat bottom yields one pivot, not several
      if (j < i ? candles[j].l <= lo : candles[j].l < lo) ok = false;
    }
    if (ok) out.push({ i, low: lo });
  }
  return out;
}

/** True when the last `n` swing lows are strictly rising; null with fewer than `n` swings. */
export function higherLows(candles: Candle[], n = 3, w = 3): boolean | null {
  const lows = swingLows(candles, w);
  if (lows.length < n) return null;
  const last = lows.slice(-n);
  return last.every((p, k) => k === 0 || p.low > last[k - 1].low);
}
