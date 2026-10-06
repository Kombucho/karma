/**
 * The Jev quant loop, in one picture:
 *
 *   code computes FEATURES (indicators + holder lenses)  →  Jev JUDGES them against a versioned RUBRIC
 *   (typed questions, calibrated probabilities)  →  the cron records OUTCOMES (price at +24h / +7d)  →
 *   GRADES each rubric version (Brier score, calibration, hit rate)  →  Claude proposes a CHALLENGER
 *   rubric from the misses  →  the challenger is replayed on held-out snapshots and only promoted if it
 *   beats the champion out of sample.
 *
 * Numbers are always computed in code; Jev never does arithmetic. The rubric (questions + criteria) is
 * the program Jev runs, so it's versioned and graded like code.
 */

/** Everything code knows about a coin at one instant, flat and small enough to hand Jev as `state`. */
export interface QuantFeatures {
  mint: string;
  /** GeckoTerminal network slug, so outcomes price the snapshot on the right chain. Absent on old rows. */
  network?: string;
  symbol: string | null;
  t: number; // unix seconds the snapshot was taken
  price_usd: number | null;
  mcap_usd: number | null;
  liquidity_usd: number | null;
  age_hours: number | null;
  /** Price / trend / volatility / volume, computed from 1h candles. Null when the chart is too young. */
  chart: {
    candles: number;
    rsi14: number | null;
    macd_hist: number | null; // MACD(12,26,9) histogram / close (scale-free)
    macd_cross: "bull" | "bear" | "none" | null; // histogram changed sign within the last 3 candles
    bb_pos: number | null; // 0 = lower band, 1 = upper band
    bb_width: number | null; // band width / mid
    ema20_vs_ema50: number | null; // (ema20 - ema50) / ema50
    atr_pct: number | null; // ATR14 / close
    roc_24h: number | null; // fractional change over 24 candles (0.1 = +10%)
    roc_6h: number | null;
    drawdown_from_high: number | null; // 0..1 below the window high
    range_pos: number | null; // 0 = window low, 1 = window high
    vol_z: number | null; // last 6h volume vs trailing mean, in std devs
    obv_slope: number | null; // normalised on-balance-volume slope over 24h
    vwap_dist: number | null; // (close - VWAP24h) / VWAP24h
    stoch_rsi: number | null; // 0..1, RSI's position in its last 14 readings
    higher_lows: boolean | null; // last 3 swing lows rising
  } | null;
  /** The holder/market lenses, folded to numbers. Null fields = lens didn't run. */
  holders: {
    verdict: "clean" | "caution" | "coordinated" | "danger" | null;
    top10_pct: number | null;
    holder_count: number | null;
    insider_shaped_pct: number | null;
    sniper_pct: number | null;
    connected_pct: number | null;
    ecosystem_only_pct: number | null;
    reward_only_pct: number | null;
    crowd_manufactured: number | null; // 0..1
    fresh_flow_severity: "alert" | "warn" | "none" | null;
    fresh_net_sol_1h: number | null;
    sibling_verdict: "cabal" | "linked" | "none" | null;
    lp_pullable_share: number | null;
    wash_share: number | null;
    even_share_group_pct: number | null;
    dev_launches: number | null;
    dev_graduated: number | null;
    dev_holds_pct: number | null;
    token_risk: "clean" | "caution" | "danger" | null;
    transfer_fee_bps: number | null;
  };
}

/** One Jev question. Mirrors the Decisions API question shapes. */
export type RubricQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

/**
 * A rubric version. `targets` tells the grader what each question is predicting, so it can be scored
 * against realised outcomes. Questions without a target are descriptive (logged, never graded).
 */
export interface Rubric {
  version: string; // e.g. "v1", "v2-sonnet-2026-10-02"
  parent: string | null;
  status: "live" | "shadow" | "retired";
  created_at: string;
  notes: string;
  questions: Record<string, RubricQuestion>;
  targets: Record<string, QuantTarget>;
}

/** What a graded question predicts, in terms code can check against prices. */
export type QuantTarget =
  | { kind: "drawdown"; horizon_h: number; threshold: number } // noul: low within horizon ≤ price × (1 - threshold)
  | { kind: "pump"; horizon_h: number; threshold: number } // noul: high within horizon ≥ price × (1 + threshold)
  | { kind: "direction"; horizon_h: number; up: string[]; down: string[] }; // choice: which options mean up/down

export interface JevAnswer {
  type: "noul" | "choice" | "score";
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
}

/** A stored judgment: the features Jev saw, the rubric version, and what it answered. */
export interface QuantSnapshot {
  id?: number;
  mint: string;
  t: number;
  price_usd: number | null;
  rubric_version: string;
  features: QuantFeatures;
  answers: Record<string, JevAnswer>;
  source: "cron" | "page" | "replay";
}

/** Realised price path after a snapshot, per horizon. */
export interface QuantOutcome {
  snapshot_id: number;
  horizon_h: number;
  price_usd: number | null;
  low_usd: number | null;
  high_usd: number | null;
  ret: number | null; // price / snapshot price - 1
  max_drawdown: number | null; // 1 - low / snapshot price
  max_runup: number | null; // high / snapshot price - 1
  /**
   * How the path was measured, so odd outcomes can be audited: "ok" = hourly candles cover the window;
   * "dex_price" = candles stop short, horizon price from DexScreener's current price; "partial" = no
   * candles in the window, path from the snapshot and horizon prices only; "dead" = no candles and no
   * live pair/liquidity — scored as a total loss (max_drawdown 1, ret -1, max_runup 0).
   */
  status?: "ok" | "dex_price" | "partial" | "dead";
}
