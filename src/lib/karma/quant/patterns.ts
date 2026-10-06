import type { Candle } from "../sources/ta";

/**
 * Short-timeframe pivots (15m / 1h ATR-scaled zigzag) and the candidate shape the chart read publishes.
 *
 * Pattern DETECTION lives in swing-patterns.ts (4h / 12h / 1d, weekly check), which a blind three-grader
 * audit put at 92% valid against 12% for the 15m/1h detectors this file used to hold (chart-v1, PR #47):
 * those were cut. What stays here is what the level engine needs: pivots, ATR, the price formatter, and
 * the always-present "range / no clear pattern" candidate.
 */

export type Timeframe = "15m" | "1h" | "4h" | "12h" | "1d";
export type Bias = "bull" | "bear" | "neutral";

export interface Pivot {
  /** Index into the candle array the pivot was found on. */
  i: number;
  t: number;
  price: number;
  type: "H" | "L";
  /** False for the last, still-forming swing (price hasn't reversed far enough to confirm it yet). */
  confirmed: boolean;
}

export interface PatternCandidate {
  /** Stable id, e.g. "double_bottom". */
  kind: string;
  tf: Timeframe;
  label: string;
  bias: Bias;
  /** 0..1: how cleanly the pivots match the textbook geometry (code's judgment, not Jev's). */
  fit: number;
  /** The price whose break confirms the pattern (neckline / breakout line), when it has one. */
  trigger: number | null;
  /** Measured-move target, computed in code. */
  target: number | null;
  /** The price that kills the pattern. */
  invalidation: number | null;
  /** Every key price, named, for the card and for Jev's state. */
  levels: { name: string; price: number }[];
  /** Short geometry note in plain words for Jev ("tops 0.0071/0.0072, 0.2 ATR apart, trough 2.4 ATR deep"). */
  geometry: string;
  pivots: Pivot[];
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** 1 at diff 0, falling linearly to 0 at diff = tol. */
const closeness = (diff: number, tol: number) => (tol > 0 ? clamp01(1 - Math.abs(diff) / tol) : 0);

/** Price with 3 significant figures, as plain decimal (0.00648, not 6.48e-3). */
export function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return String(p);
  const digits = Math.max(0, Math.min(14, 2 - Math.floor(Math.log10(p))));
  return p.toFixed(digits);
}

/**
 * A down-move of `height` below `from`, never below zero: linear when it fits, otherwise the same move
 * in log space (from × from / (from + height)). A double top at 0.010 with neckline 0.004 would target
 * −0.002 linearly; on a memecoin the honest reading is "another leg the same size in % terms".
 */
export function measuredDown(from: number, height: number): number {
  const lin = from - height;
  return lin > from * 0.25 ? lin : (from * from) / (from + height);
}

/** Wilder ATR at every candle (index-aligned). Warm-up uses the mean of the true ranges so far. */
export function atrSeries(candles: Candle[], period = 14): number[] {
  const n = candles.length;
  if (!n) return [];
  const tr = candles.map((c, i) => (i ? Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c)) : c.h - c.l));
  const out: number[] = new Array(n);
  out[0] = tr[0];
  let sum = 0;
  for (let i = 1; i < n; i++) {
    if (i <= period) {
      sum += tr[i];
      out[i] = sum / i;
    } else {
      out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return out;
}

/**
 * Zigzag swing pivots: a swing high is confirmed once price falls `k` ATRs from it (and a swing low once it
 * rises `k` ATRs), so a pivot is a turn the market actually made, not a one-candle wiggle. Highs use candle
 * highs, lows use candle lows. The last, still-forming extreme is appended with confirmed: false.
 */
export function zigzag(candles: Candle[], k: number): Pivot[] {
  const n = candles.length;
  if (n < 3) return [];
  const atrs = atrSeries(candles);
  // Floors: GT gap-fill candles are flat, so a quiet stretch drags ATR toward zero and the zigzag would
  // then pivot on every tick. Never below half the series' median ATR, nor below 1% of price.
  const medAtr = median(atrs.filter((x) => x > 0));
  const thr = (i: number) => k * Math.max(atrs[i], 0.5 * medAtr, 0.01 * candles[i].c, 1e-300);
  const out: Pivot[] = [];
  // Pushing a confirmed pivot also confirms the one before it (a pivot moved to a fresh extreme is
  // unconfirmed until price swings k ATR away from it, which is exactly this push).
  const push = (i: number, type: "H" | "L", confirmed: boolean) => {
    if (confirmed && out.length) out[out.length - 1].confirmed = true;
    out.push({ i, t: candles[i].t, price: type === "H" ? candles[i].h : candles[i].l, type, confirmed });
  };
  /** The lowest low (or highest high) in (from, to]: where the new swing's extreme already is when the
   * reversal confirms. Not simply `to`: PURR's H at bar 59 confirmed on bar 64, but bar 61 had the lower low. */
  const extremeSince = (from: number, to: number, type: "H" | "L") => {
    let best = to;
    for (let j = from + 1; j <= to; j++) if (type === "L" ? candles[j].l < candles[best].l : candles[j].h > candles[best].h) best = j;
    return best;
  };

  // Phase 1: no direction yet. Track the running high and low until one moves k ATR off the other.
  let hi = 0;
  let lo = 0;
  let dir: 1 | -1 | 0 = 0;
  let cand = 0;
  let i = 1;
  for (; i < n && dir === 0; i++) {
    if (candles[i].h > candles[hi].h) hi = i;
    if (candles[i].l < candles[lo].l) lo = i;
    if (hi === lo || candles[hi].h - candles[lo].l < thr(i)) continue; // one wide candle isn't a swing
    if (lo < hi) {
      push(lo, "L", true);
      [dir, cand] = [1, hi];
    } else {
      push(hi, "H", true);
      [dir, cand] = [-1, lo];
    }
  }
  // Phase 2: follow the swing; confirm the extreme once price reverses k ATR from it. If price instead
  // runs past the last confirmed pivot without confirming a swing (the threshold is per-candle, so this
  // happens after a quiet spell), that pivot wasn't the turn: move it to the new extreme.
  for (; i < n; i++) {
    const c = candles[i];
    const lastP = out[out.length - 1];
    if (dir === 1) {
      if (c.h >= candles[cand].h) cand = i;
      else if (candles[cand].h - c.l >= thr(i)) {
        push(cand, "H", true);
        [dir, cand] = [-1, extremeSince(cand, i, "L")];
      } else if (c.l < lastP.price) {
        out[out.length - 1] = { i, t: c.t, price: c.l, type: "L", confirmed: false };
        cand = i;
      }
    } else if (c.l <= candles[cand].l) cand = i;
    else if (c.h - candles[cand].l >= thr(i)) {
      push(cand, "L", true);
      [dir, cand] = [1, extremeSince(cand, i, "H")];
    } else if (c.h > lastP.price) {
      out[out.length - 1] = { i, t: c.t, price: c.h, type: "H", confirmed: false };
      cand = i;
    }
  }
  // the forming swing, unless the last pivot was just moved onto this same candle
  if (dir !== 0 && cand !== out[out.length - 1].i) push(cand, dir === 1 ? "H" : "L", false);
  return out;
}

/** Least-squares line through (x, y) points; with 2 points it's exact. */
function fitLine(pts: { x: number; y: number }[]): { slope: number; icpt: number; resid: number } | null {
  if (pts.length < 2) return null;
  const mx = mean(pts.map((p) => p.x));
  const my = mean(pts.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  if (den <= 0) return null;
  const slope = num / den;
  const icpt = my - slope * mx;
  const resid = mean(pts.map((p) => Math.abs(p.y - (icpt + slope * p.x))));
  return { slope, icpt, resid };
}


const r2 = (x: number) => Math.round(x * 10) / 10;

// ─── range (always offered) ──────────────────────────────────────────────────────────────────────────

/** The "range / no clear pattern" option over the last `bars` candles. Always returned; fit says how range-like it is. */
export function rangeCandidate(candles: Candle[], pivots: Pivot[], atr: number, tf: Timeframe, bars: number): PatternCandidate {
  const win = candles.slice(-bars);
  const start = candles.length - win.length;
  const hi = Math.max(...win.map((c) => c.h));
  const lo = Math.min(...win.map((c) => c.l));
  const width = hi - lo;
  const inWin = pivots.filter((p) => p.i >= start);
  const tol = 1 * atr;
  const touches = inWin.filter((p) => (p.type === "H" ? hi - p.price <= tol : p.price - lo <= tol)).length;
  const drift = fitLine(win.map((c, k) => ({ x: k, y: c.c })));
  const travel = drift ? Math.abs(drift.slope * win.length) : 0;
  const fit = 0.4 * clamp01(touches / 4) + 0.3 * clamp01(1 - travel / Math.max(width, 1e-300)) + 0.3 * closeness(width / atr - 4, 4);
  const mid = (hi + lo) / 2;
  return {
    kind: "range",
    tf,
    label: `range ${fmtPrice(lo)}–${fmtPrice(hi)} (no clear pattern)`,
    bias: "neutral",
    fit,
    trigger: null,
    target: null,
    invalidation: null,
    levels: [
      { name: "range high", price: hi },
      { name: "range mid", price: mid },
      { name: "range low", price: lo },
    ],
    geometry: `${win.length} bars between ${fmtPrice(lo)} and ${fmtPrice(hi)} (${r2(width / atr)} ATR), ${touches} pivots at the edges, net drift ${r2(travel / atr)} ATR`,
    pivots: inWin,
  };
}

/** Zigzag reversal size per timeframe, in ATRs: 15m candles are noisier relative to their ATR. */
export const ZIGZAG_K: Record<"15m" | "1h", number> = { "15m": 2.5, "1h": 2 };

/** Pivots + ATR on one short timeframe: the raw material the level engine clusters into support/resistance. */
export function pivotsFor(candles: Candle[], tf: "15m" | "1h"): { pivots: Pivot[]; atr: number | null } {
  if (candles.length < 30) return { pivots: [], atr: null };
  const atr = atrSeries(candles).at(-1) ?? 0;
  if (!(atr > 0)) return { pivots: [], atr: null };
  return { pivots: zigzag(candles, ZIGZAG_K[tf]), atr };
}
