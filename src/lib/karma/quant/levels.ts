import { bollinger, type Candle } from "../sources/ta";
import { fmtPrice, type Pivot } from "./patterns";

/**
 * CANDIDATE PRICE LEVELS, found by code. Pure and deterministic.
 *
 * Every place the market has a reason to react gets proposed with a weight and a named source: pivot
 * clusters (where price turned, more touches and more recent = heavier), the volume profile (POC and
 * high-volume nodes: where most coins changed hands), 24h / 7d VWAP, 1h Bollinger edges, fib retracements
 * of the week's major swing, round numbers, prior-day and 24h / 7d extremes. Candidates within ~0.5 ATR
 * of each other are merged (a pivot cluster sitting on the POC and a fib is ONE level with three reasons),
 * then ~3 supports and ~3 resistances are kept, strongest-near-price first. Jev then judges which ones get
 * touched and which hold; it never proposes a level.
 */

export interface RawLevel {
  price: number;
  source: string;
  weight: number;
}

export interface LevelCandidate {
  price: number;
  side: "support" | "resistance";
  sources: string[];
  /** Summed source weight after merging. */
  score: number;
  /** Pivots that make up the level (0 when it has no pivot cluster behind it). */
  touches: number;
  /** Fraction from price (−0.05 = 5% below). */
  dist: number;
  /** Distance in 1h ATRs (signed). */
  dist_atr: number;
}

export interface LevelInput {
  price: number;
  /** Oldest-first 1h candles (up to a week). May be empty for a coin younger than a few hours. */
  candles1h: Candle[];
  candles15m: Candle[];
  pivots1h: Pivot[];
  pivots15m: Pivot[];
  /** 1h ATR (or 2 × the 15m ATR when there's no 1h series), the merge / distance yardstick. */
  atr: number;
  /** Unix seconds "now", for recency weights and the prior-day window. */
  now: number;
}

const H = 3600;

/** Pivot clusters: pivots from both timeframes within 0.5 ATR, weighted by touches × recency (half-life 48h). */
export function pivotClusters(pivots: { p: Pivot; tf: string }[], atr: number, now: number): RawLevel[] {
  const sorted = [...pivots].sort((a, b) => a.p.price - b.p.price);
  const out: RawLevel[] = [];
  let group: typeof sorted = [];
  const flush = () => {
    if (!group.length) return;
    const w = group.map((g) => Math.pow(0.5, Math.max(0, now - g.p.t) / (48 * H)) * (g.tf === "1h" ? 1 : 0.6));
    const wsum = w.reduce((s, x) => s + x, 0);
    const price = group.reduce((s, g, k) => s + g.p.price * w[k], 0) / wsum;
    const tfs = [...new Set(group.map((g) => g.tf))].join("+");
    const kinds = group.every((g) => g.p.type === "H") ? "highs" : group.every((g) => g.p.type === "L") ? "lows" : "highs+lows";
    out.push({ price, source: `pivot cluster: ${group.length} swing ${kinds} (${tfs})`, weight: Math.min(3.5, 0.6 + wsum) });
    group = [];
  };
  for (const g of sorted) {
    if (group.length && g.p.price - group[0].p.price > 0.5 * atr) flush();
    group.push(g);
  }
  flush();
  return out;
}

/**
 * Volume profile over the candles: each candle's volume spread evenly across its low..high range into
 * log-spaced bins (memecoins move 10× in a week, so linear bins would crowd the lows). Returns the POC
 * (busiest bin) and up to 3 other high-volume nodes (local maxima ≥ 1.5× the mean bin).
 */
export function volumeProfile(candles: Candle[], bins = 48): RawLevel[] {
  const cs = candles.filter((c) => c.v > 0 && c.l > 0 && c.h >= c.l);
  if (cs.length < 12) return [];
  const lo = Math.log(Math.min(...cs.map((c) => c.l)));
  const hi = Math.log(Math.max(...cs.map((c) => c.h)));
  if (!(hi > lo)) return [];
  const step = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  const bin = (x: number) => Math.min(bins - 1, Math.max(0, Math.floor((Math.log(x) - lo) / step)));
  for (const c of cs) {
    const a = bin(c.l);
    const b = bin(c.h);
    for (let k = a; k <= b; k++) vol[k] += c.v / (b - a + 1);
  }
  const center = (k: number) => Math.exp(lo + (k + 0.5) * step);
  const poc = vol.indexOf(Math.max(...vol));
  const meanV = vol.reduce((s, x) => s + x, 0) / bins;
  const out: RawLevel[] = [{ price: center(poc), source: "volume POC (7d)", weight: 2 }];
  const nodes = vol
    .map((v, k) => ({ v, k }))
    .filter(({ v, k }) => k !== poc && v >= 1.5 * meanV && v >= (vol[k - 1] ?? 0) && v >= (vol[k + 1] ?? 0) && Math.abs(k - poc) > 1)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3);
  for (const n of nodes) out.push({ price: center(n.k), source: "high-volume node (7d)", weight: 1.2 });
  return out;
}

/** VWAP on typical price over the candles, null when there's no volume. */
export function vwap(candles: Candle[]): number | null {
  const v = candles.reduce((s, c) => s + c.v, 0);
  if (!(v > 0)) return null;
  return candles.reduce((s, c) => s + ((c.h + c.l + c.c) / 3) * c.v, 0) / v;
}

/**
 * Fib retracements of the week's major swing: from the window's extreme that came first to the one that
 * came last (low→high = a rally, retraced downward; high→low = a dump, retraced upward).
 */
export function fibLevels(candles: Candle[]): RawLevel[] {
  if (candles.length < 24) return [];
  let hiI = 0;
  let loI = 0;
  candles.forEach((c, i) => {
    if (c.h > candles[hiI].h) hiI = i;
    if (c.l < candles[loI].l) loI = i;
  });
  const hi = candles[hiI].h;
  const lo = candles[loI].l;
  if (!(hi > lo)) return [];
  const rally = loI < hiI;
  const swing = `${fmtPrice(rally ? lo : hi)}→${fmtPrice(rally ? hi : lo)}`;
  return [0.382, 0.5, 0.618, 0.786].map((f) => ({
    price: rally ? hi - f * (hi - lo) : lo + f * (hi - lo),
    source: `fib ${f} of ${swing}`,
    weight: f === 0.5 || f === 0.618 ? 0.8 : 0.5,
  }));
}

/** Round numbers within ±30% of price: multiples of the price's order of magnitude (0.006, 0.007 around 0.0065). */
export function roundNumbers(price: number): RawLevel[] {
  if (!(price > 0)) return [];
  const mag = Math.pow(10, Math.floor(Math.log10(price)));
  const out: RawLevel[] = [];
  for (let m = 1; m <= 12; m++) {
    const x = m * mag;
    if (x < price * 0.7 || x > price * 1.3) continue;
    const strong = m === 1 || m === 5 || m === 10;
    out.push({ price: x, source: `round number ${fmtPrice(x)}`, weight: strong ? 0.6 : 0.3 });
  }
  return out;
}

/** Every raw candidate, before merging. */
export function rawLevels(inp: LevelInput): RawLevel[] {
  const { candles1h: c1, candles15m: c15, now } = inp;
  const out: RawLevel[] = [];
  const piv = [...inp.pivots1h.map((p) => ({ p, tf: "1h" })), ...inp.pivots15m.map((p) => ({ p, tf: "15m" }))];
  out.push(...pivotClusters(piv, inp.atr, now));
  // Prefer the 1h week for the profile / fibs / VWAP 7d; fall back to 15m (≈3 days) for young coins.
  const week = c1.length >= 24 ? c1 : c15;
  out.push(...volumeProfile(week));
  out.push(...fibLevels(week));
  const day = c1.length >= 24 ? c1.slice(-24) : c15.slice(-96);
  const v24 = vwap(day);
  if (v24) out.push({ price: v24, source: "VWAP 24h", weight: 1 });
  const v7 = c1.length >= 72 ? vwap(c1) : null;
  if (v7) out.push({ price: v7, source: "VWAP 7d", weight: 1.2 });
  const bb = c1.length >= 20 ? bollinger(c1.map((c) => c.c)) : null;
  if (bb) {
    out.push({ price: bb.upper, source: "1h Bollinger upper", weight: 0.6 });
    out.push({ price: bb.lower, source: "1h Bollinger lower", weight: 0.6 });
  }
  if (day.length) {
    out.push({ price: Math.max(...day.map((c) => c.h)), source: "24h high", weight: 0.9 });
    out.push({ price: Math.min(...day.map((c) => c.l)), source: "24h low", weight: 0.9 });
  }
  if (week.length) {
    out.push({ price: Math.max(...week.map((c) => c.h)), source: `${c1.length >= 24 ? "7d" : "3d"} high`, weight: 1 });
    out.push({ price: Math.min(...week.map((c) => c.l)), source: `${c1.length >= 24 ? "7d" : "3d"} low`, weight: 1 });
  }
  // Prior UTC day's high / low.
  const today = Math.floor(now / 86400) * 86400;
  const prev = [...c1, ...(c1.length ? [] : c15)].filter((c) => c.t >= today - 86400 && c.t < today);
  if (prev.length >= 4) {
    out.push({ price: Math.max(...prev.map((c) => c.h)), source: "prior day high", weight: 0.8 });
    out.push({ price: Math.min(...prev.map((c) => c.l)), source: "prior day low", weight: 0.8 });
  }
  out.push(...roundNumbers(inp.price));
  return out.filter((l) => Number.isFinite(l.price) && l.price > 0);
}

/** Merge raw levels closer than max(0.5 ATR, 0.4% of price) into one weighted level with every source. */
export function mergeLevels(raw: RawLevel[], atr: number, price: number): { price: number; sources: string[]; score: number; touches: number }[] {
  const tol = Math.max(0.5 * atr, 0.004 * price);
  const sorted = [...raw].sort((a, b) => a.price - b.price);
  const out: { price: number; sources: string[]; score: number; touches: number }[] = [];
  let g: RawLevel[] = [];
  const flush = () => {
    if (!g.length) return;
    const w = g.reduce((s, x) => s + x.weight, 0);
    const touches = g.reduce((s, x) => s + (Number(/pivot cluster: (\d+)/.exec(x.source)?.[1]) || 0), 0);
    out.push({ price: g.reduce((s, x) => s + x.price * x.weight, 0) / w, sources: [...new Set(g.map((x) => x.source))], score: w, touches });
    g = [];
  };
  for (const r of sorted) {
    if (g.length && r.price - g[0].price > tol) flush();
    g.push(r);
  }
  flush();
  return out;
}

/**
 * The levels to show and ask Jev about: ~`perSide` supports below price and resistances above, ranked by
 * merged score discounted by distance (a strong level 8 ATR away matters less in the next 24h than a
 * decent one 1 ATR away), then listed nearest-first. Levels hugging price (< 0.15 ATR) are skipped: which
 * side they're on is a coin flip.
 */
export function pickLevels(inp: LevelInput, perSide = 3): { raw: RawLevel[]; picked: LevelCandidate[] } {
  const raw = rawLevels(inp);
  const merged = mergeLevels(raw, inp.atr, inp.price);
  const { price, atr } = inp;
  const all: LevelCandidate[] = merged
    .map((m) => ({
      price: m.price,
      side: (m.price < price ? "support" : "resistance") as LevelCandidate["side"],
      sources: m.sources,
      score: m.score,
      touches: m.touches,
      dist: m.price / price - 1,
      dist_atr: (m.price - price) / atr,
    }))
    .filter((l) => Math.abs(l.dist_atr) >= 0.15 && Math.abs(l.dist) <= 0.6);
  const rank = (l: LevelCandidate) => l.score / (1 + Math.abs(l.dist_atr) / 4);
  const side = (s: LevelCandidate["side"]) =>
    all
      .filter((l) => l.side === s && l.score >= 1) // one weak source alone (a lone fib, a band edge, a round number) isn't a level
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, perSide)
      .sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  return { raw, picked: [...side("support"), ...side("resistance")] };
}
