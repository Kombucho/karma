/**
 * JEV · CHART READ — the contract between the engine and the panel.
 *
 * Division of labour, always: CODE finds candidates (pivots, candidate patterns, candidate price levels,
 * posts), JEV judges among them (which pattern is really playing out, which level most likely holds,
 * how each post reads) with calibrated probabilities, and the quant loop GRADES those judgments
 * against what price did next. Jev never computes a number and never invents a level.
 */

/** A candidate chart pattern code detected from pivots, and Jev's read of it. */
export interface PatternRead {
  /** Stable id, e.g. "double_bottom", "bull_flag", "descending_triangle", "breakdown", "range". */
  kind: string;
  /** Plain words for the card: "double bottom at 0.00648, neckline 0.00736". */
  label: string;
  /** Bullish / bearish / neutral implication if it completes. */
  bias: "bull" | "bear" | "neutral";
  /** Key prices the pattern defines (neckline, breakout line, measured-move target). */
  levels: { name: string; price: number }[];
  /** chart-v1 only (Jev's pick among many candidates); chart-v2 detections are audited, so null. */
  p_in_play: number | null;
  /**
   * P(target before invalidation within 7 days) for a random walk with the coin's own volatility (chart-v2).
   * An upper bound, not a signal: in the lab, real patterns hit their target LESS often than this.
   */
  p_resolves: number | null;
  /** chart-v2: the bar size the pattern was drawn on. */
  tf?: "1h" | "4h" | "12h" | "1d" | "3d";
  /** chart-v2: does the weekly trend agree with the pattern's direction? null = under 20 weeks of history. */
  weekly?: "aligned" | "against" | "flat" | null;
  /** chart-v2: has price already crossed the trigger (neckline / range edge) in the pattern's direction? */
  confirmed?: boolean;
}

/** A candidate price level and Jev's read of it. */
export interface LevelRead {
  price: number;
  side: "support" | "resistance";
  /** Where the level came from, for the "why": pivot cluster, volume node, VWAP, band, fib, round number. */
  sources: string[];
  /** Distance from current price, as a fraction (−0.05 = 5% below). */
  dist: number;
  /** P(price reaches this level within 24h): physics blended with Jev (chart-v2), Jev alone (chart-v1). */
  p_touch_24h: number | null;
  /** chart-v2: P(reach within 7 days), physics. */
  p_touch_7d?: number | null;
  /** chart-v2: P(reach within 4h / 3 days), physics — tracked in Jev's ledger per horizon, not all shown. */
  p_touch_4h?: number | null;
  p_touch_3d?: number | null;
  /** chart-v2: the two ingredients of p_touch_24h, kept for the ledger. */
  p_touch_24h_physics?: number | null;
  p_touch_24h_jev?: number | null;
  /** chart-v1 only. Jev's "does it hold" had no skill on held-out coins (AUC 0.49), so chart-v2 leaves it null. */
  p_hold: number | null;
}

/** A lower-timeframe idea that survived the higher-timeframe tests (hypotheses.ts). */
export interface HypothesisRead {
  tf: "1h" | "4h";
  kind: string;
  bias: "bull" | "bear";
  target: number;
  stop: number;
  window_h: number;
  /** Odds shown: the random walk's, leaned by Jev's ledger once it has a record. */
  p: number | null;
  /** What chance alone gives for the same target / invalidation / window. */
  p_chance: number | null;
  tests: { daily: boolean; weekly: boolean; clear: boolean; protected: boolean };
}

/** Jev's graded record for one claim family on this card (from jev_scorecard). */
export interface TrackRecord {
  n: number;
  ece: number;
  skill: number | null;
  hit: number;
}

/** chart-v2: the week's range odds, physics (Jev's own read is stored beside it, ungraded, as `jev`). */
export interface WeekRead {
  up25: number | null;
  down25: number | null;
  /** Daily volatility the odds came from, as a fraction (0.12 = 12%/day). */
  sigma_daily: number | null;
  /** Jev's own read of the same two moves, anchored on the physics number: SHADOW, graded, not shown. */
  jev?: { up25: number | null; down25: number | null } | null;
}

export interface ChartRead {
  mint: string;
  t: number;
  price: number | null;
  timeframe: "15m" | "1h" | "4h" | "12h" | "1d" | "3d";
  /** chart-v2: 7-day ±25% odds. */
  week?: WeekRead | null;
  /** Under ~60 days of history: the level lab found young coins' odds run hot (STONK ~7 pts high at 24h). */
  young?: boolean;
  /** chart-v2: 1h / 4h ideas that survived the daily + weekly tests, best first (max 3). */
  hypotheses?: HypothesisRead[];
  /** chart-v2: Jev's graded record per claim shown (null until a cell has 30+ resolved calls). */
  record?: { touch_24h: TrackRecord | null; move_7d: TrackRecord | null; hypotheses: TrackRecord | null } | null;
  patterns: PatternRead[]; // sorted by p_in_play desc
  levels: LevelRead[]; // nearest first on each side
  /** Last ~72 1h candles (OHLC) for the panel's chart; display-only, stripped from stored snapshots. */
  candles?: { t: number; o: number; h: number; l: number; c: number }[];
  /** Jev's single best call, for the headline: e.g. "likely retest 0.00648 support (62%) before 0.00736". */
  headline: string | null;
  /** Rubric version + graded track record, same as Jev's read. */
  rubric_version: string;
  graded: boolean;
}
