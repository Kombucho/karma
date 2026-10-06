import type { Candle } from "../sources/ta";
import CAL from "./level-calibration.json";
import { dailyTrend } from "./swing-patterns";

/**
 * THE LEVEL ODDS the chart read shows: "chance price reaches this level within 4h / 24h / 3 days".
 *
 * Physics (reflection principle, the coin's own volatility) gives the raw number; a small model fitted in the
 * level lab corrects it, then a calibration map turns it into a probability that means what it says. Fit and
 * validation: scripts/quant-lab/level-prod-eval.py on ~1.94M level rows (Binance majors since 2020 + trench
 * coins from their DEX pools / KuCoin), scored on months held out of training:
 *
 *   all coins     4h 0.2 pts · 24h 0.5 · 3d 0.2 average calibration error; calls ≥ 80% hit 85–90%
 *   trenches      4h 1.1 · 24h 0.8 · 3d 1.3 (TROLL, USELESS, BUTTCOIN, LMAO, STONK each checked)
 *   young coins   (< ~60 days) run hot: STONK's odds were ~7 pts high at 24h — the card says so
 *
 * Verified by independent sub-agents: labels re-derived from raw candles (99.9% agree, rest exact ties),
 * a second exchange (Coinbase: 99.6% agree on BTC/ETH/SOL), and a leak audit (no look-ahead; results stable
 * across 5 coin splits × 4 cut dates). What didn't earn a place: market tide direction, level type, pattern
 * ideas — skill moved ≤ 0.001 without them. Karma's coins are the trenches, so the trench calibration applies.
 */

type Knots = { x: number[]; y: number[] };
interface HModel {
  logistic: { coef: number[]; intercept: number };
  iso: Knots;
  trench_iso: Knots;
}
const M = CAL as unknown as Record<"h4" | "h24" | "h72", HModel>;

const logit = (p: number) => {
  const q = Math.min(1 - 1e-4, Math.max(1e-4, p));
  return Math.log(q / (1 - q));
};

/** Piecewise-linear through the isotonic knots, flat beyond the ends. */
function interp(k: Knots, x: number): number {
  const { x: xs, y: ys } = k;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const w = xs[hi] === xs[lo] ? 0 : (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + w * (ys[hi] - ys[lo]);
}

export interface LevelContext {
  /** 1h ATR × √24 ÷ daily σ: how wicky the coin is relative to its closes (thin pools wick harder). */
  volRatio: number;
  /** Last 6h volume vs the 7-day hourly mean, in standard deviations. */
  volZ: number;
  /** UTC hour of the read. */
  hour: number;
  btcTrendNotFlat: boolean;
  coinTrendNotFlat: boolean;
  /** Days of trading history (young coins run hot). */
  ageDays: number;
  /** DEX memecoin (all of Karma's coins): apply the trench calibration. */
  trench: boolean;
}

/** Calibrated probability price reaches a level within `h` hours, from its physics probability. */
export function levelOdds(h: 4 | 24 | 72, phys: number, ctx: LevelContext): number {
  const m = M[`h${h}`];
  const v = Math.min(5, Math.max(0, ctx.volRatio));
  const lp = logit(phys);
  const x =
    h === 4
      ? [lp, +ctx.btcTrendNotFlat, +ctx.coinTrendNotFlat, v, Math.min(5, Math.max(-3, ctx.volZ)), Math.sin((2 * Math.PI * ctx.hour) / 24), Math.cos((2 * Math.PI * ctx.hour) / 24)]
      : [lp, v, Math.log1p(Math.min(2000, Math.max(0, ctx.ageDays))), lp * v];
  const z = m.logistic.intercept + x.reduce((s, xi, i) => s + xi * m.logistic.coef[i], 0);
  const p = interp(m.iso, 1 / (1 + Math.exp(-z)));
  return ctx.trench ? interp(m.trench_iso, p) : p;
}

/** Volume z-score over the last 6 hourly candles vs the window (the lab's vol_z). */
export function volumeZ6(c1h: Candle[]): number {
  if (c1h.length < 24) return 0;
  const w = c1h.slice(-168);
  const mean = w.reduce((s, x) => s + x.v, 0) / w.length;
  const sd = Math.sqrt(w.reduce((s, x) => s + (x.v - mean) ** 2, 0) / w.length);
  const last6 = w.slice(-6).reduce((s, x) => s + x.v, 0) / 6;
  return sd > 0 ? (last6 - mean) / sd : 0;
}

let btcMemo: { at: number; trend: "up" | "down" | "flat" | null } | null = null;
/** BTC's daily trend (the tide flag), from Binance's keyless klines, cached an hour. Null on any failure. */
export async function btcDailyTrend(now: number): Promise<"up" | "down" | "flat" | null> {
  if (btcMemo && Date.now() - btcMemo.at < 3_600_000) return btcMemo.trend;
  try {
    const res = await fetch("https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=60", { signal: AbortSignal.timeout(6000) });
    const rows = (await res.json()) as (string | number)[][];
    const d: Candle[] = rows.map((r) => ({ t: Number(r[0]) / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));
    const trend = dailyTrend(d, now + 1);
    btcMemo = { at: Date.now(), trend };
    return trend;
  } catch {
    return null;
  }
}
