import type { Candle } from "../sources/ta";

/**
 * HYPOTHESIS SHAPES — the loose 1h / 4h pattern finder from chart-v1 (PR #47), kept in a new job.
 *
 * As a verdict it failed a blind audit (12% of its patterns were real). As a GENERATOR it's what the
 * funnel needs: many candidate ideas on the lower timeframes, each with a direction, a target and an
 * invalidation, that the higher timeframes then test (hypotheses.ts). Nothing here reaches the card
 * without passing those tests, and the odds shown come from the random walk, not from this file's "fit".
 */

export type Timeframe = "15m" | "1h";
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

interface Ctx {
  candles: Candle[];
  pivots: Pivot[];
  atr: number;
  price: number;
  tf: Timeframe;
  last: number; // index of the last candle
}

const r2 = (x: number) => Math.round(x * 10) / 10;

/** The pivot index range a pattern may end on: the last two pivots (the forming one included). */
const endsRecent = (ctx: Ctx, pivotIdx: number) => pivotIdx >= ctx.pivots.length - 2;

// ─── double top / bottom ─────────────────────────────────────────────────────────────────────────────

function doubleTopBottom(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, price, tf } = ctx;
  const out: PatternCandidate[] = [];
  for (let j = P.length - 1; j >= 2 && endsRecent(ctx, j); j--) {
    const a = P[j - 2];
    const m = P[j - 1];
    const b = P[j];
    if (a.type !== b.type || b.i - a.i < 4) continue;
    const top = a.type === "H";
    const tol = 0.75 * atr;
    const diff = Math.abs(a.price - b.price);
    const depth = top ? Math.min(a.price, b.price) - m.price : m.price - Math.max(a.price, b.price);
    if (diff > tol || depth < 1.5 * atr) continue;
    const avg = (a.price + b.price) / 2;
    const height = Math.abs(avg - m.price);
    const neck = m.price;
    const target = top ? measuredDown(neck, height) : neck + height;
    const invalidation = top ? Math.max(a.price, b.price) + 0.5 * atr : Math.min(a.price, b.price) - 0.5 * atr;
    const fit = 0.5 * closeness(diff, tol) + 0.3 * clamp01(depth / (3 * atr)) + 0.2 * (b.confirmed ? 1 : 0.5);
    const name = top ? "double_top" : "double_bottom";
    out.push({
      kind: name,
      tf,
      label: `double ${top ? "top" : "bottom"} at ${fmtPrice(avg)}, neckline ${fmtPrice(neck)}`,
      bias: top ? "bear" : "bull",
      fit,
      trigger: neck,
      target,
      invalidation,
      levels: [
        { name: top ? "tops" : "bottoms", price: avg },
        { name: "neckline", price: neck },
        { name: "target", price: target },
        { name: "invalidation", price: invalidation },
      ],
      geometry: `${top ? "tops" : "bottoms"} ${fmtPrice(a.price)}/${fmtPrice(b.price)} (${r2(diff / atr)} ATR apart), ${top ? "trough" : "peak"} ${fmtPrice(neck)} ${r2(depth / atr)} ATR ${top ? "below" : "above"}, ${b.i - a.i} bars wide, price ${price < neck ? "below" : "above"} neckline`,
      pivots: [a, m, b],
    });
    break;
  }
  return out;
}

// ─── head & shoulders (and inverse) ──────────────────────────────────────────────────────────────────

function headShoulders(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, tf, last } = ctx;
  const out: PatternCandidate[] = [];
  for (let j = P.length - 1; j >= 4 && endsRecent(ctx, j); j--) {
    const [s1, n1, hd, n2, s2] = P.slice(j - 4, j + 1);
    if (s1.type !== s2.type || hd.type !== s1.type) continue;
    const top = s1.type === "H";
    const sgn = top ? 1 : -1;
    const prominence = sgn * (hd.price - (top ? Math.max(s1.price, s2.price) : Math.min(s1.price, s2.price)));
    if (prominence < 0.5 * atr) continue;
    const shoulderDiff = Math.abs(s1.price - s2.price);
    const neckDiff = Math.abs(n1.price - n2.price);
    if (shoulderDiff > 1.5 * atr || neckDiff > 1.5 * atr) continue;
    const t1 = hd.i - s1.i;
    const t2 = s2.i - hd.i;
    const timeRatio = Math.min(t1, t2) / Math.max(t1, t2, 1);
    if (timeRatio < 0.35) continue;
    const slope = (n2.price - n1.price) / Math.max(1, n2.i - n1.i);
    const neckAt = (i: number) => n1.price + slope * (i - n1.i);
    const neckNow = neckAt(last);
    const height = Math.abs(hd.price - neckAt(hd.i));
    const target = top ? measuredDown(neckNow, height) : neckNow + height;
    const invalidation = top ? s2.price + 0.5 * atr : s2.price - 0.5 * atr;
    const fit =
      0.35 * closeness(shoulderDiff, 1.5 * atr) + 0.25 * closeness(neckDiff, 1.5 * atr) + 0.2 * timeRatio + 0.2 * clamp01(prominence / (1.5 * atr));
    const kind = top ? "head_shoulders" : "inverse_head_shoulders";
    out.push({
      kind,
      tf,
      label: `${top ? "head & shoulders" : "inverse head & shoulders"}, neckline ${fmtPrice(neckNow)}`,
      bias: top ? "bear" : "bull",
      fit,
      trigger: neckNow,
      target,
      invalidation,
      levels: [
        { name: "head", price: hd.price },
        { name: "neckline", price: neckNow },
        { name: "target", price: target },
        { name: "invalidation", price: invalidation },
      ],
      geometry: `shoulders ${fmtPrice(s1.price)}/${fmtPrice(s2.price)} (${r2(shoulderDiff / atr)} ATR apart), head ${fmtPrice(hd.price)} ${r2(prominence / atr)} ATR beyond, neckline ${fmtPrice(n1.price)}→${fmtPrice(n2.price)}`,
      pivots: [s1, n1, hd, n2, s2],
    });
    break;
  }
  return out;
}

// ─── triangles, wedges, channels (two trendlines through the last 4–6 pivots) ────────────────────────

function lineFamily(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, price, tf, candles, last } = ctx;
  let best: PatternCandidate | null = null;
  for (const n of [6, 5, 4]) {
    if (P.length < n) continue;
    const seg = P.slice(-n);
    const hs = seg.filter((p) => p.type === "H").map((p) => ({ x: p.i, y: p.price }));
    const ls = seg.filter((p) => p.type === "L").map((p) => ({ x: p.i, y: p.price }));
    const U = fitLine(hs);
    const L = fitLine(ls);
    if (!U || !L) continue;
    const x0 = seg[0].i;
    const span = Math.max(1, last - x0);
    const dU = (U.slope * span) / atr; // how far each line travels across the pattern, in ATRs
    const dL = (L.slope * span) / atr;
    const up = (i: number) => U.icpt + U.slope * i;
    const lo = (i: number) => L.icpt + L.slope * i;
    const w0 = up(x0) - lo(x0);
    const w1 = up(last) - lo(last);
    if (w0 <= 0 || w1 <= 0) continue;
    const converging = w1 < 0.75 * w0;
    const parallel = w1 >= 0.75 * w0 && w1 <= 1.33 * w0;
    // price must still be in (or just leaving) the structure; a clean break is the breakout detector's job
    if (price > up(last) + 1.5 * atr || price < lo(last) - 1.5 * atr) continue;
    const flat = (d: number) => Math.abs(d) < 1;
    let kind: string | null = null;
    let bias: Bias = "neutral";
    if (flat(dU) && dL >= 1 && converging) [kind, bias] = ["ascending_triangle", "bull"];
    else if (dU <= -1 && flat(dL) && converging) [kind, bias] = ["descending_triangle", "bear"];
    else if (dU <= -1 && dL >= 1) {
      kind = "symmetric_triangle";
      // continuation: bias follows the trend into the triangle
      const before = candles[Math.max(0, x0 - span)].c;
      bias = candles[x0].c >= before ? "bull" : "bear";
    } else if (dU >= 1 && dL >= 1 && converging) [kind, bias] = ["rising_wedge", "bear"];
    else if (dU <= -1 && dL <= -1 && converging) [kind, bias] = ["falling_wedge", "bull"];
    else if (dU >= 1 && dL >= 1 && parallel) [kind, bias] = ["channel_up", "bull"];
    else if (dU <= -1 && dL <= -1 && parallel) [kind, bias] = ["channel_down", "bear"];
    if (!kind) continue;

    // How well the candles respect the lines: closes more than 0.5 ATR outside count against it.
    let outside = 0;
    for (let i = x0; i <= last; i++) if (candles[i].c > up(i) + 0.5 * atr || candles[i].c < lo(i) - 0.5 * atr) outside++;
    const outsideFrac = outside / (last - x0 + 1);
    if (outsideFrac > 0.2) continue; // the candles don't respect these lines: it's two lines through noise
    const resid = (U.resid * hs.length + L.resid * ls.length) / (hs.length + ls.length);
    const fit = 0.4 * closeness(resid, 0.6 * atr) + 0.3 * clamp01(1 - outsideFrac * 4) + 0.3 * (n === 6 ? 1 : n === 5 ? 0.8 : 0.5);

    const upNow = up(last);
    const loNow = lo(last);
    let trigger: number | null;
    let target: number;
    let invalidation: number;
    if (kind === "rising_wedge") [trigger, target, invalidation] = [loNow, Math.min(loNow, ls[0].y), upNow + 0.5 * atr];
    else if (kind === "falling_wedge") [trigger, target, invalidation] = [upNow, Math.max(upNow, hs[0].y), loNow - 0.5 * atr];
    else if (kind === "channel_up") [trigger, target, invalidation] = [upNow, upNow, loNow - 0.5 * atr];
    else if (kind === "channel_down") [trigger, target, invalidation] = [loNow, loNow, upNow + 0.5 * atr];
    else if (bias === "bull") [trigger, target, invalidation] = [upNow, upNow + w0, loNow - 0.5 * atr];
    else [trigger, target, invalidation] = [loNow, measuredDown(loNow, w0), upNow + 0.5 * atr];
    if (kind.startsWith("channel")) trigger = null; // a channel has no breakout to wait for: it resolves by reaching its far rail

    const words = kind.replace(/_/g, " ");
    const cand: PatternCandidate = {
      kind,
      tf,
      label: `${words}, ${fmtPrice(loNow)}–${fmtPrice(upNow)}${kind === "symmetric_triangle" ? ` (${bias === "bull" ? "up" : "down"}trend continuation)` : ""}`,
      bias,
      fit,
      trigger,
      target,
      invalidation,
      levels: [
        { name: "upper line", price: upNow },
        { name: "lower line", price: loNow },
        { name: "target", price: target },
        { name: "invalidation", price: invalidation },
      ],
      geometry: `${n} pivots over ${span} bars; upper line moves ${r2(dU)} ATR, lower ${r2(dL)} ATR; width ${r2(w0 / atr)}→${r2(w1 / atr)} ATR; ${Math.round(outsideFrac * 100)}% of closes outside`,
      pivots: seg,
    };
    if (!best || cand.fit > best.fit) best = cand;
  }
  return best ? [best] : [];
}

// ─── bull / bear flag ────────────────────────────────────────────────────────────────────────────────

function flags(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, price, tf, candles, last } = ctx;
  for (let j = P.length - 1; j >= 1 && j >= P.length - 3; j--) {
    const a = P[j - 1];
    const b = P[j];
    const bull = b.type === "H";
    const pole = Math.abs(b.price - a.price);
    const poleBars = b.i - a.i;
    if (pole < 4 * atr || poleBars > 16 || poleBars < 1) continue;
    // a pole is a move candles CLOSED through, not one wick: CACKLE's 1-bar spike to 0.000147 and straight
    // back read as a 10-ATR "pole" on highs/lows alone
    if (Math.abs(candles[b.i].c - candles[a.i].o) < 0.5 * pole) continue;
    const cons = candles.slice(b.i + 1, last + 1);
    if (cons.length < 3 || cons.length > 24) continue;
    const cHi = Math.max(...cons.map((c) => c.h));
    const cLo = Math.min(...cons.map((c) => c.l));
    // the flag must not extend the pole
    if (bull ? cHi > b.price + 0.25 * atr : cLo < b.price - 0.25 * atr) continue;
    const retrace = bull ? (b.price - cLo) / pole : (cHi - b.price) / pole;
    if (retrace > 0.5) continue;
    const range = cHi - cLo;
    if (range > 0.5 * pole) continue;
    const drift = fitLine(cons.map((c, k) => ({ x: k, y: c.c })));
    const travel = drift ? drift.slope * cons.length : 0;
    // counter-trend or flat drift: a bull flag drifts down/sideways, a bear flag up/sideways
    if (bull ? travel > 0.5 * atr : travel < -0.5 * atr) continue;
    if (bull ? price < cLo - 0.5 * atr : price > cHi + 0.5 * atr) continue;
    const trigger = bull ? cHi : cLo;
    const target = bull ? trigger + pole : measuredDown(trigger, pole);
    const invalidation = bull ? cLo - 0.25 * atr : cHi + 0.25 * atr;
    const fit = 0.35 * clamp01(pole / (6 * atr)) + 0.35 * clamp01(1 - retrace / 0.5) + 0.3 * clamp01(1 - range / (0.5 * pole));
    return [
      {
        kind: bull ? "bull_flag" : "bear_flag",
        tf,
        label: `${bull ? "bull" : "bear"} flag, ${bull ? "breakout" : "breakdown"} ${fmtPrice(trigger)}`,
        bias: bull ? "bull" : "bear",
        fit,
        trigger,
        target,
        invalidation,
        levels: [
          { name: "flag edge", price: trigger },
          { name: "target", price: target },
          { name: "invalidation", price: invalidation },
        ],
        geometry: `pole ${fmtPrice(a.price)}→${fmtPrice(b.price)} (${r2(pole / atr)} ATR in ${poleBars} bars), flag ${cons.length} bars, retraced ${Math.round(retrace * 100)}% of pole, drift ${r2(travel / atr)} ATR`,
        pivots: [a, b],
      },
    ];
  }
  return [];
}

// ─── breakout / breakdown from a box, volume-confirmed ───────────────────────────────────────────────

function breakouts(ctx: Ctx): PatternCandidate[] {
  const { atr, price, tf, candles, last } = ctx;
  const BOX = 24;
  for (let k = 1; k <= 6; k++) {
    const bi = last - k + 1; // candidate breakout bar
    const boxEnd = bi - 1;
    const boxStart = boxEnd - BOX + 1;
    if (boxStart < 0) break;
    const box = candles.slice(boxStart, boxEnd + 1);
    const hi = Math.max(...box.map((c) => c.h));
    const lo = Math.min(...box.map((c) => c.l));
    const height = hi - lo;
    if (height < 1 * atr || height > 6 * atr) continue;
    const c = candles[bi];
    const up = c.c > hi + 0.25 * atr;
    const down = c.c < lo - 0.25 * atr;
    if (!up && !down) continue;
    // still holding outside the box now
    if (up ? price <= hi : price >= lo) continue;
    const after = candles.slice(bi, last + 1);
    const holding = after.filter((x) => (up ? x.c > hi : x.c < lo)).length / after.length;
    const boxVol = median(box.map((x) => x.v));
    const brkVol = Math.max(...after.slice(0, 2).map((x) => x.v));
    const volRatio = boxVol > 0 ? brkVol / boxVol : brkVol > 0 ? 5 : 0;
    const shape = closeness(height / atr - 3, 3); // a 2–4 ATR box is the classic consolidation
    const fit = 0.4 * clamp01((volRatio - 1) / 2) + 0.3 * shape + 0.3 * holding;
    const mid = (hi + lo) / 2;
    const target = up ? hi + height : measuredDown(lo, height);
    return [
      {
        kind: up ? "breakout" : "breakdown",
        tf,
        label: `${up ? "breakout above" : "breakdown below"} ${fmtPrice(up ? hi : lo)} (${BOX}-bar box)`,
        bias: up ? "bull" : "bear",
        fit,
        trigger: up ? hi : lo,
        target,
        invalidation: mid,
        levels: [
          { name: up ? "box top" : "box bottom", price: up ? hi : lo },
          { name: "target", price: target },
          { name: "invalidation", price: mid },
        ],
        geometry: `box ${fmtPrice(lo)}–${fmtPrice(hi)} (${r2(height / atr)} ATR) for ${BOX} bars, broke ${k} bar(s) ago on ${r2(volRatio)}× box median volume, ${Math.round(holding * 100)}% of closes since held outside`,
        pivots: [],
      },
    ];
  }
  return [];
}

// ─── V-reversal (and inverted V) ─────────────────────────────────────────────────────────────────────

function vReversal(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, price, tf, last } = ctx;
  for (let j = P.length - 1; j >= 1 && j >= P.length - 2; j--) {
    const a = P[j - 1];
    const v = P[j];
    const bull = v.type === "L";
    const drop = Math.abs(a.price - v.price);
    const dropBars = v.i - a.i;
    if (drop < 5 * atr || dropBars > 16) continue;
    const recovered = bull ? (price - v.price) / drop : (v.price - price) / drop;
    const recBars = last - v.i;
    if (recovered < 0.5 || recBars > 2 * Math.max(dropBars, 4)) continue;
    const target = a.price;
    const invalidation = bull ? v.price - 0.25 * atr : v.price + 0.25 * atr;
    const half = (a.price + v.price) / 2;
    const fit = 0.4 * clamp01(drop / (8 * atr)) + 0.3 * clamp01(recovered) + 0.3 * closeness(Math.max(dropBars, recBars), 20);
    return [
      {
        kind: bull ? "v_reversal" : "inverted_v",
        tf,
        label: bull ? `V-reversal off ${fmtPrice(v.price)}` : `inverted V from ${fmtPrice(v.price)}`,
        bias: bull ? "bull" : "bear",
        fit,
        trigger: half,
        target,
        invalidation,
        levels: [
          { name: bull ? "V low" : "spike high", price: v.price },
          { name: "50% retrace", price: half },
          { name: "target", price: target },
          { name: "invalidation", price: invalidation },
        ],
        geometry: `${bull ? "drop" : "spike"} ${fmtPrice(a.price)}→${fmtPrice(v.price)} (${r2(drop / atr)} ATR in ${dropBars} bars), ${Math.round(recovered * 100)}% recovered in ${recBars} bars`,
        pivots: [a, v],
      },
    ];
  }
  return [];
}

// ─── blow-off top ────────────────────────────────────────────────────────────────────────────────────

function blowOff(ctx: Ctx): PatternCandidate[] {
  const { pivots: P, atr, price, tf, candles } = ctx;
  for (let j = P.length - 1; j >= 1 && j >= P.length - 2; j--) {
    const a = P[j - 1];
    const b = P[j];
    if (b.type !== "H") continue;
    const rise = b.price - a.price;
    const bars = b.i - a.i;
    if (rise < 6 * atr || bars < 4) continue;
    // parabolic: the second half of the leg rose faster than the first half
    const mid = a.i + Math.floor(bars / 2);
    const first = candles[mid].c - a.price;
    const second = b.price - candles[mid].c;
    const accel = first > 0 ? second / first : second > 0 ? 3 : 0;
    if (accel < 1.3) continue;
    // volume climax near the top vs the 48 bars before the leg
    const around = candles.slice(Math.max(0, b.i - 3), b.i + 3).map((c) => c.v);
    const base = median(candles.slice(Math.max(0, a.i - 48), a.i + 1).map((c) => c.v));
    const climax = base > 0 ? Math.max(...around) / base : 0;
    if (climax < 2.5) continue;
    if (price > b.price - 1 * atr) continue; // needs a reaction off the top to call it a blow-off
    const target = a.price + 0.5 * rise;
    const invalidation = b.price + 0.5 * atr;
    const fit = 0.3 * clamp01(rise / (10 * atr)) + 0.3 * clamp01((accel - 1) / 2) + 0.4 * clamp01((climax - 1) / 5);
    return [
      {
        kind: "blow_off_top",
        tf,
        label: `blow-off top at ${fmtPrice(b.price)}`,
        bias: "bear",
        fit,
        trigger: b.price - 0.382 * rise,
        target,
        invalidation,
        levels: [
          { name: "top", price: b.price },
          { name: "38% retrace", price: b.price - 0.382 * rise },
          { name: "target", price: target },
          { name: "invalidation", price: invalidation },
        ],
        geometry: `rise ${fmtPrice(a.price)}→${fmtPrice(b.price)} (${r2(rise / atr)} ATR in ${bars} bars), 2nd half ${r2(accel)}× the 1st, top volume ${r2(climax)}× base, price ${r2((b.price - price) / atr)} ATR off the top`,
        pivots: [a, b],
      },
    ];
  }
  return [];
}

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
export const ZIGZAG_K: Record<Timeframe, number> = { "15m": 2.5, "1h": 2 };

/**
 * Every candidate pattern on one timeframe, sorted by fit. Drops candidates already completed (price at or
 * past the target) or invalidated (price past the invalidation), and anything with fit below `minFit`.
 */
export function detectPatterns(candles: Candle[], tf: Timeframe, price: number, minFit = 0.45): { pivots: Pivot[]; atr: number | null; candidates: PatternCandidate[] } {
  if (candles.length < 30) return { pivots: [], atr: null, candidates: [] };
  const atr = atrSeries(candles).at(-1) ?? 0;
  if (!(atr > 0)) return { pivots: [], atr: null, candidates: [] };
  const pivots = zigzag(candles, ZIGZAG_K[tf]);
  const ctx: Ctx = { candles, pivots, atr, price, tf, last: candles.length - 1 };
  const all = [...doubleTopBottom(ctx), ...headShoulders(ctx), ...lineFamily(ctx), ...flags(ctx), ...breakouts(ctx), ...vReversal(ctx), ...blowOff(ctx)];
  const alive = all.filter((c) => {
    if (c.fit < minFit) return false;
    if (c.target !== null && c.invalidation !== null) {
      if (c.bias === "bull" && (price >= c.target || price <= c.invalidation)) return false;
      if (c.bias === "bear" && (price <= c.target || price >= c.invalidation)) return false;
    }
    return true;
  });
  return { pivots, atr, candidates: alive.sort((a, b) => b.fit - a.fit) };
}
