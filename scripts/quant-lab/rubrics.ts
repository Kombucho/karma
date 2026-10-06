/**
 * Lab rubrics: the questions Jev answers per dataset row, how each is scored against the row's outcomes, and
 * the state Jev sees. A rubric graduates to src/lib/karma/quant once it clears the lab bar.
 */
import type { RubricQuestion } from "../../src/lib/karma/quant/types";
import type { LabRow } from "./build-dataset";

export interface LabQuestion {
  q: RubricQuestion;
  /** 1 = the event happened, 0 = it didn't, null = can't tell / not asked for this row. */
  y: (r: LabRow) => 0 | 1 | null;
  /** Ask only on rows where this holds (e.g. a pattern is present). */
  when?: (r: LabRow) => boolean;
}

export interface LabRubric {
  version: string;
  questions: Record<string, LabQuestion>;
  state: (r: LabRow) => Record<string, unknown>;
}

const r3 = (v: unknown): unknown =>
  typeof v === "number" ? Math.round(v * 1000) / 1000 : v && typeof v === "object" && !Array.isArray(v) ? prune(v as Record<string, unknown>) : v;
const prune = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, r3(v)]));

/** The strongest pattern on the chart: confirmed first, then quality. */
export function topPattern(r: LabRow): { i: number; p: LabRow["f"]["patterns"][number] } | null {
  let best: { i: number; p: LabRow["f"]["patterns"][number] } | null = null;
  r.f.patterns.forEach((p, i) => {
    const score = (p.confirmed ? 1 : 0) + Number(p.quality);
    const bs = best ? (best.p.confirmed ? 1 : 0) + Number(best.p.quality) : -1;
    if (score > bs) best = { i, p };
  });
  return best;
}

const noul = (instructions: string, criteria?: { true: string; false: string }): RubricQuestion => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });

/** v1 as the live loop asks it (chart + nothing else in the lab), for the baseline row. */
export const LAB_V1: LabRubric = {
  version: "lab-v1",
  state: (r) => prune({ coin: { age_hours: r.f.coin.age_days !== null ? Number(r.f.coin.age_days) * 24 : null }, chart: r.f.chart, holders: {} }),
  questions: {
    dump_24h: { q: noul("Will this coin trade at least 30% below its current price at some point in the next 24 hours?"), y: (r) => (r.y.h24.dd >= 0.3 ? 1 : 0) },
    dump_7d: { q: noul("Will this coin trade at least 50% below its current price at some point in the next 7 days?"), y: (r) => (r.y.h168.dd >= 0.5 ? 1 : 0) },
    pump_7d: { q: noul("Will this coin trade at least double its current price at some point in the next 7 days?"), y: (r) => (r.y.h168.up >= 1 ? 1 : 0) },
  },
};

/**
 * v2: context the backtest showed was missing — where the coin is in its life (age, distance from its
 * all-time high) and the market tide — plus the code-detected chart pattern with its levels.
 */
export const LAB_V2: LabRubric = {
  version: "lab-v2",
  state: (r) => {
    const tp = topPattern(r);
    const c = r.f.chart;
    return prune({
      coin: r.f.coin,
      chart: c
        ? { rsi14: c.rsi14, macd_cross: c.macd_cross, bb_pos: c.bb_pos, bb_width: c.bb_width, ema20_vs_ema50: c.ema20_vs_ema50, atr_pct: c.atr_pct, vol_z: c.vol_z, obv_slope: c.obv_slope, vwap_dist: c.vwap_dist, higher_lows: c.higher_lows, drawdown_from_week_high: c.drawdown_from_high }
        : null,
      market_tide: r.f.tide,
      pattern: tp ? tp.p : null,
    });
  },
  questions: {
    up25_7d: {
      q: noul("Will the price trade at least 25% ABOVE its current price at any point in the next 7 days?", {
        true: "A +25% high inside 7 days: typical after a fresh breakout on rising volume, or a violent squeeze off a deep base",
        false: "No +25% print within 7 days: the common case for an established coin drifting or ranging",
      }),
      y: (r) => (r.y.h168.up >= 0.25 ? 1 : 0),
    },
    down25_7d: {
      q: noul("Will the price trade at least 25% BELOW its current price at any point in the next 7 days?", {
        true: "A −25% low inside 7 days: typical after a blow-off top, fading volume, or a risk-off market tide",
        false: "No −25% print within 7 days: the common case when the coin is ranging or trending up",
      }),
      y: (r) => (r.y.h168.dd >= 0.25 ? 1 : 0),
    },
    higher_7d: { q: noul("Will the price be HIGHER 7 days from now than it is right now?"), y: (r) => (r.y.h168.ret > 0 ? 1 : 0) },
    dump_24h: { q: noul("Will this coin trade at least 30% below its current price at some point in the next 24 hours?"), y: (r) => (r.y.h24.dd >= 0.3 ? 1 : 0) },
    dump_7d: { q: noul("Will this coin trade at least 50% below its current price at some point in the next 7 days?"), y: (r) => (r.y.h168.dd >= 0.5 ? 1 : 0) },
    pump_7d: { q: noul("Will this coin trade at least double its current price at some point in the next 7 days?"), y: (r) => (r.y.h168.up >= 1 ? 1 : 0) },
    pattern_works: {
      q: noul(
        "The chart shows the classical pattern in `pattern` (kind, bias up/down, to_target and to_stop as fractions from the current price). Will price reach the pattern's TARGET before its STOP within the next 14 days?",
      ),
      when: (r) => topPattern(r) !== null,
      y: (r) => {
        const tp = topPattern(r);
        const o = tp ? r.y.patterns[tp.i] : null;
        return o === "target" ? 1 : o === "stop" || o === "neither" ? 0 : null;
      },
    },
  },
};

/**
 * Reflection-principle touch probability for a driftless random walk in log price: the physics baseline
 * for "will it trade X% away within T days". σ blends 30-day daily vol with the hourly ATR (vol clusters);
 * the scale k is fitted on train coins in the lab (memecoin tails are fatter than a Gaussian).
 */
export function touchProb(r: LabRow, dir: 1 | -1, level: number, days: number, k = 0.85, w = 0.75): number | null {
  const v = r.f.coin.vol_30d;
  if (!v) return null;
  const a = r.f.chart?.atr_pct;
  const sig = w * Number(v) + (1 - w) * (a ? a * Math.sqrt(24) : Number(v));
  const dist = Math.abs(dir > 0 ? Math.log(1 + level) : Math.log(1 - level));
  const z = dist / (k * sig * Math.sqrt(days));
  // 2·(1 − Φ(z)) with Φ via erf (Abramowitz–Stegun 7.1.26, |error| < 1.5e-7).
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-(z * z) / 2);
  return Math.min(0.9999, Math.max(0.0001, 1 - erf));
}

/**
 * v3: Jev adjusts a physics baseline instead of guessing from scratch. The state carries, per question, the
 * probability a random walk with this coin's own volatility would give; Jev is asked what the context
 * (pattern, tide, life stage) does to it.
 */
export const LAB_V3: LabRubric = {
  version: "lab-v3",
  state: (r) => ({
    ...LAB_V2.state(r),
    volatility_baseline: prune({
      touch_up25_7d: touchProb(r, 1, 0.25, 7),
      touch_down25_7d: touchProb(r, -1, 0.25, 7),
      touch_down30_24h: touchProb(r, -1, 0.3, 1),
      touch_down50_7d: touchProb(r, -1, 0.5, 7),
      touch_up100_7d: touchProb(r, 1, 1.0, 7),
    }),
  }),
  questions: {
    ...Object.fromEntries(
      (
        [
          ["up25_7d", "touch_up25_7d", "trade at least 25% ABOVE its current price at any point in the next 7 days", (r: LabRow) => (r.y.h168.up >= 0.25 ? 1 : 0)],
          ["down25_7d", "touch_down25_7d", "trade at least 25% BELOW its current price at any point in the next 7 days", (r: LabRow) => (r.y.h168.dd >= 0.25 ? 1 : 0)],
          ["dump_24h", "touch_down30_24h", "trade at least 30% below its current price at some point in the next 24 hours", (r: LabRow) => (r.y.h24.dd >= 0.3 ? 1 : 0)],
          ["dump_7d", "touch_down50_7d", "trade at least 50% below its current price at some point in the next 7 days", (r: LabRow) => (r.y.h168.dd >= 0.5 ? 1 : 0)],
          ["pump_7d", "touch_up100_7d", "trade at least double its current price at some point in the next 7 days", (r: LabRow) => (r.y.h168.up >= 1 ? 1 : 0)],
        ] as const
      ).map(([k, base, text, y]) => [
        k,
        {
          q: noul(
            `Will this coin ${text}? \`volatility_baseline.${base}\` is the probability a random walk with this coin's own volatility gives — start from it, then raise or lower it only as far as the pattern, market tide and the coin's life stage justify.`,
          ),
          y,
        } satisfies LabQuestion,
      ]),
    ),
    higher_7d: LAB_V2.questions.higher_7d,
    pattern_works: LAB_V2.questions.pattern_works,
  },
};

export const RUBRICS: Record<string, LabRubric> = { "lab-v1": LAB_V1, "lab-v2": LAB_V2, "lab-v3": LAB_V3 };
