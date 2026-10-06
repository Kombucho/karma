import type { Rubric } from "./types";

/**
 * The seed rubric. Written as a trader reads a memecoin: chart setup first, then who is holding it. Every
 * graded question names a price event code can check; the thresholds are memecoin-scale on purpose (a
 * 10% move is noise here). Criteria stay literal, one judgment per question.
 */
export const RUBRIC_V1: Rubric = {
  version: "v1",
  parent: null,
  status: "live",
  created_at: "2026-09-25T00:00:00Z",
  notes: "Seed rubric: chart setup + holder structure. Hand-written, ungraded.",
  questions: {
    setup: {
      type: "choice",
      instructions: "Reading `chart` and `holders` together, which setup best describes this coin right now?",
      criteria: {
        accumulation: "Quiet base near the lows, volume building, holders not concentrated in insiders",
        breakout: "Price pushing to new highs on rising volume with a spread-out holder base",
        distribution: "Price near highs while insiders, snipers or connected wallets hold a large bag they can sell into strength",
        dead_cat: "A bounce inside a larger downtrend, well below the high, volume fading",
        chop: "No clear direction, price in the middle of its range",
      },
    },
    dump_24h: {
      type: "noul",
      instructions: "Will this coin trade at least 30% below its current price at some point in the next 24 hours?",
    },
    dump_7d: {
      type: "noul",
      instructions: "Will this coin trade at least 50% below its current price at some point in the next 7 days?",
    },
    pump_7d: {
      type: "noul",
      instructions: "Will this coin trade at least double its current price at some point in the next 7 days?",
    },
    insider_exit: {
      type: "noul",
      instructions: "Are the wallets that control this coin (insiders, snipers, connected wallets, the dev) positioned to sell into buyers right now?",
    },
    trend: {
      type: "score",
      instructions: "How strong and healthy is the trend in `chart`?",
      criteria: ["Collapsing: steep downtrend, no support", "Weak: drifting lower", "Flat: no trend", "Healthy: rising with pullbacks", "Strong: rising fast on rising volume"],
    },
  },
  targets: {
    setup: { kind: "direction", horizon_h: 168, up: ["accumulation", "breakout"], down: ["distribution", "dead_cat"] },
    dump_24h: { kind: "drawdown", horizon_h: 24, threshold: 0.3 },
    dump_7d: { kind: "drawdown", horizon_h: 168, threshold: 0.5 },
    pump_7d: { kind: "pump", horizon_h: 168, threshold: 1.0 },
  },
};
