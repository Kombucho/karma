import type { Candle } from "../sources/ta";

/**
 * Classical chart patterns, detected in code (Jev never sees raw candles; geometry is arithmetic).
 *
 * Method, as a trader draws it: resample to 4h bars, find the swings with a zigzag whose reversal size
 * scales with the coin's own volatility (a 10% wiggle is noise on a memecoin, signal on BTC), then match
 * the textbook shapes against the last few swings. Every detection carries its measured-move TARGET and
 * its invalidation STOP, so "does the pattern work" is a checkable question: target before stop?
 *
 * Look-ahead safe: only candles with t < `at` are read. The last swing is TENTATIVE (the running extreme
 * since the last confirmed pivot) — that's what makes a pattern "forming now" rather than "was, last week".
 */

export type PatternKind =
  | "double_top"
  | "double_bottom"
  | "head_shoulders"
  | "inv_head_shoulders"
  | "bull_flag"
  | "bear_flag"
  | "accumulation"
  | "distribution"
  | "asc_triangle"
  | "desc_triangle";

export const PATTERN_BIAS: Record<PatternKind, "up" | "down"> = {
  double_top: "down",
  double_bottom: "up",
  head_shoulders: "down",
  inv_head_shoulders: "up",
  bull_flag: "up",
  bear_flag: "down",
  accumulation: "up",
  distribution: "down",
  asc_triangle: "up",
  desc_triangle: "down",
};

export interface Pivot {
  i: number; // bar index
  t: number;
  price: number;
  kind: "H" | "L";
  tentative?: boolean;
}

/** The timeframes a trader reads memecoins on; weekly is the confirmation, not a detection timeframe. */
export type SwingTf = "1h" | "4h" | "12h" | "1d" | "3d";
export const TF_S: Record<SwingTf, number> = { "1h": 3600, "4h": 4 * 3600, "12h": 12 * 3600, "1d": 86400, "3d": 3 * 86400 };

export interface Pattern {
  kind: PatternKind;
  /** Bar size the shape was found on. Every rule counts bars, so the same shape reads on any timeframe. */
  tf: SwingTf;
  bias: "up" | "down";
  /** First and last time the shape spans. */
  start_t: number;
  end_t: number;
  /** The line that confirms it (neckline / range edge / flag edge). */
  trigger: number;
  /** Measured-move target and invalidation level, in price. */
  target: number;
  stop: number;
  /** Has price already crossed the trigger in the pattern's direction? */
  confirmed: boolean;
  /** The swings the shape was drawn from — for charts and for dedupe. */
  points: Array<{ t: number; price: number }>;
  /** Shape quality 0..1 (symmetry / tightness), for ranking overlapping detections. */
  quality: number;
}

export const BAR_S = 4 * 3600;

/** 1h → 4h bars aligned to UTC 00/04/08…, only from candles before `at`. */
export function toBars(candles: Candle[], at: number, lookbackBars = 180, barS = BAR_S): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    if (c.t >= at) break;
    const bt = c.t - (c.t % barS);
    const last = out.at(-1);
    if (last && last.t === bt) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else out.push({ ...c, t: bt });
  }
  return out.slice(-lookbackBars);
}

/** ATR(14) / close on bars — the coin's own noise floor. */
function atrPct(bars: Candle[]): number {
  if (bars.length < 15) return 0.1;
  let s = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const p = bars[i - 1].c;
    s += Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - p), Math.abs(bars[i].l - p));
  }
  return s / 14 / bars.at(-1)!.c;
}

/**
 * Zigzag on highs/lows. A pivot high is confirmed once price falls `th` below the running max since the
 * last low (and vice versa). The final running extreme is returned as a tentative pivot.
 */
export function zigzag(bars: Candle[], th: number): Pivot[] {
  if (bars.length < 3) return [];
  const piv: Pivot[] = [];
  let dir: "up" | "down" | null = null;
  let extI = 0;
  let extP = bars[0].c;
  let hiI = 0;
  let loI = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    if (dir === null) {
      if (b.h > bars[hiI].h) hiI = i;
      if (b.l < bars[loI].l) loI = i;
      if (bars[hiI].h / bars[loI].l - 1 >= th) {
        // First leg: whichever extreme came first is the first pivot.
        if (loI < hiI) {
          piv.push({ i: loI, t: bars[loI].t, price: bars[loI].l, kind: "L" });
          dir = "up";
          extI = hiI;
          extP = bars[hiI].h;
        } else {
          piv.push({ i: hiI, t: bars[hiI].t, price: bars[hiI].h, kind: "H" });
          dir = "down";
          extI = loI;
          extP = bars[loI].l;
        }
      }
      continue;
    }
    if (dir === "up") {
      if (b.h >= extP) {
        extP = b.h;
        extI = i;
      } else if (b.l <= extP * (1 - th)) {
        piv.push({ i: extI, t: bars[extI].t, price: extP, kind: "H" });
        dir = "down";
        extP = b.l;
        extI = i;
      }
    } else {
      if (b.l <= extP) {
        extP = b.l;
        extI = i;
      } else if (b.h >= extP * (1 + th)) {
        piv.push({ i: extI, t: bars[extI].t, price: extP, kind: "L" });
        dir = "up";
        extP = b.h;
        extI = i;
      }
    }
  }
  if (dir) piv.push({ i: extI, t: bars[extI].t, price: extP, kind: dir === "up" ? "H" : "L", tentative: true });
  return piv;
}

const near = (a: number, b: number, tol: number) => Math.abs(a / b - 1) <= tol;

/**
 * Every pattern forming or just completed at `at`. "Just completed" = its last swing is one of the last
 * two pivots, so a shape from last month isn't re-reported as live.
 */
export function detectPatterns(candles: Candle[], at: number, tf: SwingTf = "4h"): Pattern[] {
  const bars = toBars(candles, at, 180, TF_S[tf]);
  if (bars.length < 42) return [];
  const last = bars.at(-1)!;
  const px = last.c;
  const noise = atrPct(bars);
  // Swing size: 12% floor (memecoin 4h bars wiggle 8–10% as noise), 4× the coin's own ATR above that.
  const th = Math.min(0.4, Math.max(0.12, 4 * noise));
  // Swings from closes: one wick spike isn't a swing a trader would draw (the audit's double-bottom misses).
  // 3-bar median of closes first: a single-bar spike can't become a swing point (audit round 5).
  const med = bars.map((b, i) => {
    const w = [bars[Math.max(0, i - 1)].c, b.c, bars[Math.min(bars.length - 1, i + 1)].c].sort((x, y) => x - y);
    return i === bars.length - 1 ? b.c : w[1];
  });
  const P = zigzag(bars.map((b, i) => ({ ...b, h: med[i], l: med[i] })), th);
  const out: Pattern[] = [];
  const tol = Math.min(0.06, Math.max(0.03, noise)); // "equal" highs/lows tolerance
  const n = P.length;
  /** Is pivot `p` the extreme of its neighbourhood (the `back` bars before it through `upto`)? A double top's
   *  peaks must be THE highs of the move, not a wiggle inside it. */
  // A pattern must be a meaningful share of the coin's recent swing, not a ripple inside a bigger move.
  // Swing checks read the same smoothed closes the swings came from (raw wicks always poke above them).
  const range30 = Math.log(Math.max(...med.slice(-180)) / Math.min(...med.slice(-180)));
  const significant = (hi: number, lo: number) => Math.log(hi / lo) >= 0.4 * range30;
  /** Reversal patterns need a trend to reverse: price `back` bars before `p` sat at least one swing away. */
  const approached = (p: Pivot, back = 42) => {
    // A real prior move: somewhere in the last `back` bars price sat 1.5 swings away (audit: "no prior decline").
    const seg = med.slice(Math.max(0, p.i - back), p.i + 1);
    return p.kind === "H" ? Math.min(...seg) <= p.price * (1 - 1.5 * th) : Math.max(...seg) >= p.price * (1 + 1.5 * th);
  };
  const dominates = (p: Pivot, back: number, upto = bars.length - 1) => {
    // Against the RAW closes a reader sees: no close in the window may beat the pivot by more than tol
    // (catches "a lower low between the troughs" and peaks sitting next to a higher close).
    const seg = bars.slice(Math.max(0, p.i - back), upto + 1).map((b) => b.c);
    return p.kind === "H" ? Math.max(...seg) <= p.price * (1 + tol) : Math.min(...seg) >= p.price * (1 - tol);
  };

  // ---- double top / bottom: X1 · valley · X2 (X2 = one of the last two pivots) ----
  for (const endAt of [n - 1, n - 2]) {
    if (endAt < 2) continue;
    const [a, m, b] = [P[endAt - 2], P[endAt - 1], P[endAt]];
    const sep = b.i - a.i;
    // The second peak must have turned (confirmed pivot) and both must be the extremes of the move.
    if (b.tentative || sep < 18 || !dominates(a, 60) || !dominates(b, b.i - a.i + 60)) continue;
    // On 12h/1d a bar is half a day or more: "spike off the low, then a slow grind back to it" reads as a
    // W to the rules but not to a trader. The return leg can't take more than 3x the first (audit, 12h/1d).
    if (TF_S[tf] >= TF_S["12h"] && b.i - m.i > 3 * (m.i - a.i)) continue;
    // The first extreme must be FRESH: nothing in the prior 10 days closed within tol of it. Two equal lows
    // at a range's floor, or a pump that fell back to its base, aren't a double bottom (full audit, round 7).
    {
      const prior = bars.slice(Math.max(0, a.i - 60), Math.max(0, a.i - 6)).map((x) => x.c);
      if (prior.length && (a.kind === "L" ? Math.min(...prior) < a.price * (1 + tol) : Math.max(...prior) > a.price * (1 - tol))) continue;
    }
    // The middle swing clears 1.5 swings (a ~10% bounce is chop), and the two extremes match on the RAW
    // closes a reader sees, not just on the smoothed line.
    if (Math.abs(Math.log(m.price / ((a.price + b.price) / 2))) < Math.log(1 + 1.5 * th)) continue;
    {
      const raw = (p: Pivot) => {
        const w = bars.slice(Math.max(0, p.i - 1), p.i + 2).map((x) => x.c);
        return p.kind === "L" ? Math.min(...w) : Math.max(...w);
      };
      if (!near(raw(a), raw(b), tol * 1.5)) continue;
    }
    // The middle swing must be a rebound, not a one-bar spike: the raw closes either side of it hold half the move.
    {
      const nb = [bars[m.i - 1]?.c, bars[m.i + 1]?.c].filter((x): x is number => x !== undefined);
      const half = (m.price + (a.price + b.price) / 2) / 2;
      if (nb.some((c) => (m.kind === "H" ? c < half : c > half))) continue;
    }
    if (!significant(Math.max(a.price, b.price, m.price), Math.min(a.price, b.price, m.price)) || !approached(a)) continue;
    if (a.kind === "H" && b.kind === "H" && m.kind === "L" && near(a.price, b.price, tol) && sep >= 6) {
      const top = Math.max(a.price, b.price);
      const depth = 1 - m.price / top;
      if (depth >= th) {
        const h = top - m.price;
        out.push({
          tf,
          kind: "double_top", bias: "down", start_t: a.t, end_t: b.t, trigger: m.price,
          target: Math.max(m.price - h, m.price * 0.5), stop: top * (1 + tol), confirmed: px < m.price,
          points: [a, m, b].map(({ t, price }) => ({ t, price })), quality: 1 - Math.abs(a.price / b.price - 1) / tol,
        });
      }
    }
    if (a.kind === "L" && b.kind === "L" && m.kind === "H" && near(a.price, b.price, tol) && sep >= 6) {
      const bot = Math.min(a.price, b.price);
      const height = m.price / bot - 1;
      if (height >= th) {
        const h = m.price - bot;
        out.push({
          tf,
          kind: "double_bottom", bias: "up", start_t: a.t, end_t: b.t, trigger: m.price,
          target: m.price + h, stop: bot * (1 - tol), confirmed: px > m.price,
          points: [a, m, b].map(({ t, price }) => ({ t, price })), quality: 1 - Math.abs(a.price / b.price - 1) / tol,
        });
      }
    }
  }

  // ---- head & shoulders: LS · n1 · Head · n2 · RS (RS = one of the last two pivots) ----
  for (const endAt of [n - 1, n - 2]) {
    if (endAt < 4) continue;
    const [ls, n1, hd, n2, rs] = P.slice(endAt - 4, endAt + 1);
    if (rs.tentative || !dominates(hd, hd.i - ls.i + 30, rs.i)) continue;
    if (!significant(Math.max(ls.price, hd.price, rs.price), Math.min(n1.price, n2.price, hd.price)) || !approached(ls)) continue;
    if (ls.kind === "H" && hd.kind === "H" && rs.kind === "H") {
      const shoulders = Math.max(ls.price, rs.price);
      // Head clearly above BOTH shoulders; shoulders clearly above the neckline (audit: "head barely above").
      // Shoulders roughly equidistant in time from the head (a blip on the rally isn't a shoulder).
      const sym = (hd.i - ls.i) / Math.max(1, rs.i - hd.i);
      if (sym < 0.4 || sym > 2.5) continue;
      // Head a full swing above both shoulders; neckline roughly level (a crash-and-V isn't a shoulder).
      if (hd.price >= shoulders * (1 + Math.max(2 * tol, th)) && near(ls.price, rs.price, tol * 2) && near(n1.price, n2.price, th) && Math.min(ls.price, rs.price) >= Math.max(n1.price, n2.price) * (1 + th / 2)) {
        const neck = (n1.price + n2.price) / 2;
        out.push({
          tf,
          kind: "head_shoulders", bias: "down", start_t: ls.t, end_t: rs.t, trigger: Math.min(n1.price, n2.price),
          target: Math.max(neck - (hd.price - neck), neck * 0.5), stop: hd.price, confirmed: px < Math.min(n1.price, n2.price),
          points: [ls, n1, hd, n2, rs].map(({ t, price }) => ({ t, price })), quality: 1 - Math.abs(ls.price / rs.price - 1) / (tol * 2),
        });
      }
    }
    if (ls.kind === "L" && hd.kind === "L" && rs.kind === "L") {
      const shoulders = Math.min(ls.price, rs.price);
      if ((hd.i - ls.i) / Math.max(1, rs.i - hd.i) < 0.4 || (hd.i - ls.i) / Math.max(1, rs.i - hd.i) > 2.5) continue;
      if (hd.price <= shoulders * (1 - Math.max(2 * tol, th)) && near(ls.price, rs.price, tol * 2) && near(n1.price, n2.price, th) && Math.max(ls.price, rs.price) <= Math.min(n1.price, n2.price) * (1 - th / 2)) {
        const neck = (n1.price + n2.price) / 2;
        out.push({
          tf,
          kind: "inv_head_shoulders", bias: "up", start_t: ls.t, end_t: rs.t, trigger: Math.max(n1.price, n2.price),
          target: neck + (neck - hd.price), stop: hd.price, confirmed: px > Math.max(n1.price, n2.price),
          points: [ls, n1, hd, n2, rs].map(({ t, price }) => ({ t, price })), quality: 1 - Math.abs(ls.price / rs.price - 1) / (tol * 2),
        });
      }
    }
  }

  // ---- flags: a sharp pole into the last confirmed pivot, then a shallow counter-drift since ----
  {
    const lastConf = [...P].reverse().find((p) => !p.tentative);
    const before = lastConf ? P[P.indexOf(lastConf) - 1] : undefined;
    if (lastConf && before) {
      const poleBars = lastConf.i - before.i;
      const flagBars = bars.length - 1 - lastConf.i;
      const since = bars.slice(lastConf.i + 1);
      if (poleBars <= 18 && flagBars >= 3 && flagBars <= Math.max(6, poleBars * 2) && since.length) {
        const fHi = Math.max(...since.map((b) => b.h));
        const fLo = Math.min(...since.map((b) => b.l));
        if (lastConf.kind === "H" && before.kind === "L") {
          const pole = lastConf.price - before.price;
          const rise = lastConf.price / before.price - 1;
          const retrace = (lastConf.price - fLo) / pole;
          if (rise >= Math.max(0.3, 3 * th) && retrace <= 0.5 && fHi <= lastConf.price * (1 + tol)) {
            out.push({
              tf,
              kind: "bull_flag", bias: "up", start_t: before.t, end_t: last.t, trigger: fHi,
              target: fHi + pole * 0.6, stop: fLo * (1 - tol), confirmed: px > lastConf.price,
              points: [before, lastConf].map(({ t, price }) => ({ t, price })).concat([{ t: last.t, price: px }]), quality: 1 - retrace,
            });
          }
        }
        if (lastConf.kind === "L" && before.kind === "H") {
          const pole = before.price - lastConf.price;
          const drop = 1 - lastConf.price / before.price;
          const retrace = (fHi - lastConf.price) / pole;
          if (drop >= Math.max(0.25, 2.5 * th) && retrace <= 0.5 && fLo >= lastConf.price * (1 - tol)) {
            out.push({
              tf,
              kind: "bear_flag", bias: "down", start_t: before.t, end_t: last.t, trigger: fLo,
              target: Math.max(fLo - pole * 0.6, fLo * 0.5), stop: fHi * (1 + tol), confirmed: px < lastConf.price,
              points: [before, lastConf].map(({ t, price }) => ({ t, price })).concat([{ t: last.t, price: px }]), quality: 1 - retrace,
            });
          }
        }
      }
    }
  }

  // ---- ranges (Wyckoff): ≥14 days sideways after a big move. Accumulation = the climax low came early in
  //      the range and price has held above it since (sellers exhausted, at the lows of a ≥50% decline);
  //      distribution = the mirror at the highs of a ≥100% advance. A pause mid-trend is neither. ----
  {
    const RANGE_BARS = 84; // 14 days on 4h bars, 6 weeks on 12h, 12 weeks on 1d
    const win = bars.slice(-RANGE_BARS);
    const closes = win.map((b) => b.c).sort((x, y) => x - y);
    // Band on closes' 5th–95th percentile, so one wick doesn't break the range.
    const lo = closes[Math.floor(closes.length * 0.05)];
    const hi = closes[Math.floor(closes.length * 0.95)];
    const width = hi / lo - 1;
    const prior = bars.slice(0, -RANGE_BARS);
    if (prior.length >= 30 && win.length === RANGE_BARS && width <= Math.max(0.35, 5 * noise) && px >= lo * 0.97 && px <= hi * 1.03) {
      const priorHi = Math.max(...prior.map((b) => b.c));
      const priorLo = Math.min(...prior.map((b) => b.c));
      const minI = win.reduce((m, b, i) => (b.c < win[m].c ? i : m), 0);
      const maxI = win.reduce((m, b, i) => (b.c > win[m].c ? i : m), 0);
      // After the climax bar, no wick may retest it (audit: "late-band spike undercuts the early low").
      const lateLow = Math.min(...win.slice(minI + 3).map((b) => b.l), Infinity);
      const lateHigh = Math.max(...win.slice(maxI + 3).map((b) => b.h), -Infinity);
      // Sideways, not a staircase: the band's two halves sit at about the same level.
      const mean = (xs: Candle[]) => xs.reduce((a, b) => a + b.c, 0) / xs.length;
      const drift = mean(win.slice(RANGE_BARS / 2)) / mean(win.slice(0, RANGE_BARS / 2)) - 1;
      const sideways = Math.abs(drift) <= width / 3;
      const volA = win.slice(0, RANGE_BARS / 2).reduce((s, b) => s + b.v, 0);
      const volB = win.slice(RANGE_BARS / 2).reduce((s, b) => s + b.v, 0);
      const h = hi - lo;
      if (sideways && drift >= 0 && hi <= priorHi * 0.5 && minI < RANGE_BARS * 0.4 && lateLow >= win[minI].l * (1 + 2 * tol) && px >= (lo + hi) / 2) {
        out.push({
          tf,
          kind: "accumulation", bias: "up", start_t: win[0].t, end_t: last.t, trigger: hi,
          target: hi + Math.max(h, hi * 0.3), stop: win[minI].c * (1 - tol), confirmed: px > hi,
          points: [{ t: win[0].t, price: hi }, { t: last.t, price: hi }, { t: win[0].t, price: lo }, { t: last.t, price: lo }],
          quality: Math.min(1, volB / Math.max(volA, 1e-9) / 2),
        });
      }
      if (sideways && drift <= 0 && lo >= priorLo * 2 && maxI < RANGE_BARS * 0.4 && lateHigh <= win[maxI].h * (1 - 2 * tol) && hi >= priorHi * 0.7 && px <= (lo + hi) / 2) {
        out.push({
          tf,
          kind: "distribution", bias: "down", start_t: win[0].t, end_t: last.t, trigger: lo,
          target: Math.max(lo - Math.max(h, lo * 0.3), lo * 0.5), stop: win[maxI].c * (1 + tol), confirmed: px < lo,
          points: [{ t: win[0].t, price: hi }, { t: last.t, price: hi }, { t: win[0].t, price: lo }, { t: last.t, price: lo }],
          quality: Math.min(1, volA / Math.max(volB, 1e-9) / 2),
        });
      }
    }
  }

  // ---- triangles: five CONFIRMED swings (3 touches on the flat side, 2 on the sloped side) bounding a
  //      narrowing wedge price stayed inside. Ascending = flat resistance + rising support; descending = flat
  //      support + falling resistance. The moving present is never a touch (audit: "last point just price"). ----
  {
    const conf = P.filter((p) => !p.tentative);
    if (conf.length >= 5) {
      const sw = conf.slice(-5);
      const H = sw.filter((p) => p.kind === "H");
      const L = sw.filter((p) => p.kind === "L");
      const span = sw[4].i - sw[0].i;
      const flat = (xs: Pivot[]) => Math.max(...xs.map((p) => p.price)) / Math.min(...xs.map((p) => p.price)) - 1 <= tol;
      const rising = (xs: Pivot[]) => xs.every((p, k) => k === 0 || p.price >= xs[k - 1].price * (1 + tol));
      const falling = (xs: Pivot[]) => xs.every((p, k) => k === 0 || p.price <= xs[k - 1].price * (1 - tol));
      const fitLine = (xs: Pivot[]) => {
        const a = xs[0];
        const b = xs[xs.length - 1];
        const m = (Math.log(b.price) - Math.log(a.price)) / (b.i - a.i);
        return (i: number) => Math.exp(Math.log(a.price) + m * (i - a.i));
      };
      // The first leg can't be the impulse that started the move (audit: "first low is rally origin").
      const legs = sw.slice(1).map((p, k) => Math.abs(Math.log(p.price / sw[k].price)));
      if (span >= 24 && legs[0] <= 2 * legs[1]) {
        const up = fitLine(H);
        const dn = fitLine(L);
        const i0 = sw[0].i;
        const iN = bars.length - 1;
        let inside = true;
        for (let i = i0; i <= iN && inside; i++) inside = bars[i].c <= up(i) * (1 + tol) && bars[i].c >= dn(i) * (1 - tol);
        const widthNow = up(iN) / dn(iN) - 1;
        const widthStart = up(i0) / dn(i0) - 1;
        const narrowing = widthNow > 0 && widthNow < widthStart * 0.75;
        const res = Math.max(...H.map((p) => p.price));
        const sup = Math.min(...L.map((p) => p.price));
        if (inside && narrowing && flat(H) && rising(L) && H.length >= 2 && L.length >= 2) {
          out.push({
            tf,
            kind: "asc_triangle", bias: "up", start_t: sw[0].t, end_t: last.t, trigger: res,
            target: res * (1 + widthStart), stop: dn(iN) * (1 - tol), confirmed: px > res,
            points: sw.map(({ t, price }) => ({ t, price })), quality: Math.min(1, (H.length + L.length - 3) / 3),
          });
        }
        if (inside && narrowing && flat(L) && falling(H) && H.length >= 2 && L.length >= 2) {
          out.push({
            tf,
            kind: "desc_triangle", bias: "down", start_t: sw[0].t, end_t: last.t, trigger: sup,
            target: Math.max(sup / (1 + widthStart), sup * 0.5), stop: up(iN) * (1 + tol), confirmed: px < sup,
            points: sw.map(({ t, price }) => ({ t, price })), quality: Math.min(1, (H.length + L.length - 3) / 3),
          });
        }
      }
    }
  }

  return out;
}

/**
 * Did the pattern work? Walk the 1h path after `at` for `horizonH` hours: "target" if price reaches the
 * target before the stop, "stop" if the stop first, "neither" if the clock ran out. A candle touching both
 * counts as stop (conservative — we can't see the order inside an hour).
 */
export function followThrough(candles: Candle[], at: number, p: Pattern, horizonH = (84 * TF_S[p.tf]) / 3600): "target" | "stop" | "neither" | null {
  const end = at + horizonH * 3600;
  const path = candles.filter((c) => c.t >= at && c.t < end);
  if (!path.length || path.at(-1)!.t < end - 6 * 3600) return null; // not enough future to judge
  for (const c of path) {
    const hitT = p.bias === "up" ? c.h >= p.target : c.l <= p.target;
    const hitS = p.bias === "up" ? c.l <= p.stop : c.h >= p.stop;
    if (hitS) return "stop";
    if (hitT) return "target";
  }
  return "neither";
}

/** Bars of `barS` seconds (aligned to `offset`) from any finer candles before `at`. */
function resample(candles: Candle[], at: number, barS: number, offset = 0): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    if (c.t >= at) break;
    const bt = c.t - ((c.t - offset) % barS);
    const last = out.at(-1);
    if (last && last.t === bt) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
    } else out.push({ ...c, t: bt });
  }
  return out;
}

/** "up"/"down" when the close sits 3% beyond a rising/falling EMA, "flat" otherwise, null without `minBars`. */
function trendOf(bars: Candle[], emaN: number, minBars: number): "up" | "down" | "flat" | null {
  if (bars.length < minBars) return null;
  const k = 2 / (emaN + 1);
  const ema: number[] = [];
  bars.forEach((w, i) => ema.push(i === 0 ? w.c : ema[i - 1] + k * (w.c - ema[i - 1])));
  const now = bars.at(-1)!.c;
  const e = ema.at(-1)!;
  const slope = e / ema[ema.length - 5] - 1;
  if (now > e * 1.03 && slope > 0) return "up";
  if (now < e * 0.97 && slope < 0) return "down";
  return "flat";
}

/**
 * The weekly check a trader does before trusting a lower-timeframe pattern: weekly bars (Monday 00:00 UTC),
 * 10-week EMA; null under 20 weeks of history (young coins can't say).
 */
export function weeklyTrend(candles: Candle[], at: number): "up" | "down" | "flat" | null {
  return trendOf(resample(candles, at, 7 * 86400, 4 * 86400), 10, 20); // epoch was a Thursday: +4 days = Monday
}

/** The daily check: daily bars, 20-day EMA; null under 30 days. */
export function dailyTrend(candles: Candle[], at: number): "up" | "down" | "flat" | null {
  return trendOf(resample(candles, at, 86400), 20, 30);
}

export type Alignment = "aligned" | "against" | "flat" | null;
/** How a higher-timeframe trend sits against a pattern's direction. */
export function alignment(trend: "up" | "down" | "flat" | null, bias: "up" | "down"): Alignment {
  return trend === null ? null : trend === "flat" ? "flat" : (trend === "up") === (bias === "up") ? "aligned" : "against";
}

export interface MultiTfPattern extends Pattern {
  /** Does the weekly trend agree with the pattern's direction? null when the coin is too young to say. */
  weekly: Alignment;
  /** Does the daily trend agree? */
  daily: Alignment;
}

/**
 * Patterns across 4h, 12h and 1d, each checked against the weekly trend. `candles` can be 1h (lab) or
 * any finer-than-4h series; pass the longest history available so the 1d read and the weekly check see
 * enough bars. Duplicate shapes found on two timeframes are kept once, on the higher timeframe.
 */
export function detectMultiTf(candles: Candle[], at: number, tfs: SwingTf[] = ["1h", "4h", "12h", "1d", "3d"]): MultiTfPattern[] {
  const wk = weeklyTrend(candles, at);
  const dy = dailyTrend(candles, at);
  const out: MultiTfPattern[] = [];
  for (const tf of [...tfs].reverse()) {
    for (const p of detectPatterns(candles, at, tf)) {
      // Same kind already found on a higher timeframe over an overlapping span = the same shape.
      if (out.some((q) => q.kind === p.kind && p.start_t < q.end_t && p.end_t > q.start_t)) continue;
      out.push({ ...p, weekly: alignment(wk, p.bias), daily: alignment(dy, p.bias) });
    }
  }
  return out;
}
