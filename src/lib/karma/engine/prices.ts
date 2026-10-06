import type { Candle } from "../types";

// If the first candle starts this soon after the requested time, use its open
const NEXT_CANDLE_MAX_GAP = 15 * 60;

/**
 * Candle history for one token, merged across pools and resolutions. Prices are SOL per token.
 * Only answers for time ranges that were actually fetched (`coverage`), so missing data
 * surfaces as null instead of a stale carried-forward price.
 */
export class PriceSeries {
  private readonly candles: Candle[];

  constructor(
    candles: Candle[],
    private readonly coverage: Array<[number, number]>,
  ) {
    const unique = new Map<string, Candle>();
    for (const c of candles) unique.set(`${c.pool}:${c.res}:${c.t}`, c);
    const all = [...unique.values()];

    // Where a pool has 1-minute candles, its coarser candles inside that span are redundant
    const finest = all.length ? Math.min(...all.map((c) => c.res)) : 0;
    const fineSpan = new Map<string, [number, number]>();
    for (const c of all) {
      if (c.res !== finest) continue;
      const s = fineSpan.get(c.pool);
      fineSpan.set(c.pool, s ? [Math.min(s[0], c.t), Math.max(s[1], c.t + c.res)] : [c.t, c.t + c.res]);
    }
    this.candles = all
      .filter((c) => {
        if (c.res === finest) return true;
        const s = fineSpan.get(c.pool);
        return !s || c.t < s[0] || c.t + c.res > s[1];
      })
      .sort((a, b) => a.t + a.res - (b.t + b.res)); // by close time
  }

  get size() {
    return this.candles.length;
  }

  /** Close time of the last candle, i.e. roughly the last trade we know about. */
  get lastCloseTime(): number | null {
    const last = this.candles[this.candles.length - 1];
    return last ? last.t + last.res : null;
  }

  priceAt(ts: number): number | null {
    if (!this.coverage.some(([a, b]) => ts >= a && ts <= b)) return null;
    let inside: Candle | undefined;
    let prev: Candle | undefined;
    let next: Candle | undefined;
    for (const c of this.candles) {
      const end = c.t + c.res;
      if (c.t <= ts && ts < end) {
        if (!inside || c.res < inside.res || (c.res === inside.res && c.v > inside.v)) inside = c;
      } else if (end <= ts) {
        prev = c; // sorted by close time, so the last match is the most recent
      } else if (!next || c.t < next.t) {
        next = c;
      }
    }
    if (inside) return inside.o + (inside.c - inside.o) * ((ts - inside.t) / inside.res);
    if (prev) return prev.c; // no trades since: price unchanged
    if (next && next.t - ts <= NEXT_CANDLE_MAX_GAP) return next.o;
    return null;
  }

  /** Price at `from`, then every candle close up to `to`, oldest first. */
  private window(from: number, to: number): number[] {
    const start = this.priceAt(from);
    const closes = this.candles.filter((c) => c.t < to && c.t + c.res > from).map((c) => c.c);
    return start === null ? closes : [start, ...closes];
  }

  minIn(from: number, to: number): number | null {
    const w = this.window(from, to);
    return w.length ? Math.min(...w) : null;
  }

  maxIn(from: number, to: number): number | null {
    const w = this.window(from, to);
    return w.length ? Math.max(...w) : null;
  }

  /** Worst fall from a running peak inside the window, e.g. -0.85 for an 85% crash. */
  maxDropFromPeak(from: number, to: number): number | null {
    const w = this.window(from, to);
    if (!w.length) return null;
    let peak = w[0];
    let worst = 0;
    for (const p of w) {
      peak = Math.max(peak, p);
      worst = Math.min(worst, p / peak - 1);
    }
    return worst;
  }
}
