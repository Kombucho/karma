import type { ChartRead } from "./chart-read";

/**
 * A realistic ChartRead for building and screenshotting the JEV · CHART READ panel without the engine,
 * Jev or the post feeds. Served when CHART_READ_FIXTURE=1, and by the STUB engine/sentiment modules until
 * the real ones land. Numbers are shaped like a mid-cap pump.fun graduate on 1h candles: a double bottom
 * forming at 0.00648 with a 0.00736 neckline, price just above the middle of the range.
 */

const PRICE = 0.00692;
const at = (price: number) => (price - PRICE) / PRICE;

export function fixtureChart(): Pick<ChartRead, "price" | "timeframe" | "patterns" | "levels" | "headline"> {
  return {
    price: PRICE,
    timeframe: "1h",
    headline: "likely retest $0.00648 support (62%) before $0.00736",
    patterns: [
      {
        kind: "double_bottom",
        label: "double bottom at 0.00648, neckline 0.00736",
        bias: "bull",
        levels: [
          { name: "bottoms", price: 0.00648 },
          { name: "neckline", price: 0.00736 },
          { name: "measured move", price: 0.00824 },
        ],
        p_in_play: 0.58,
        p_resolves: 0.34,
      },
      {
        kind: "range",
        label: "range 0.00648 – 0.00736 since yesterday",
        bias: "neutral",
        levels: [
          { name: "range low", price: 0.00648 },
          { name: "range high", price: 0.00736 },
        ],
        p_in_play: 0.29,
        p_resolves: null,
      },
      {
        kind: "descending_triangle",
        label: "descending triangle, flat base 0.00648",
        bias: "bear",
        levels: [
          { name: "base", price: 0.00648 },
          { name: "breakdown target", price: 0.0054 },
        ],
        p_in_play: 0.13,
        p_resolves: 0.21,
      },
    ].map((p) => ({ ...p, bias: p.bias as "bull" | "bear" | "neutral" })),
    levels: [
      { price: 0.00736, side: "resistance", sources: ["pivot cluster ×3", "neckline", "upper band"], dist: at(0.00736), p_touch_24h: 0.44, p_hold: 0.61 },
      { price: 0.0081, side: "resistance", sources: ["volume node", "fib 0.618"], dist: at(0.0081), p_touch_24h: 0.17, p_hold: 0.7 },
      { price: 0.00902, side: "resistance", sources: ["prior high", "round number"], dist: at(0.00902), p_touch_24h: 0.06, p_hold: 0.78 },
      { price: 0.00648, side: "support", sources: ["pivot cluster ×2", "double-bottom lows", "VWAP 24h"], dist: at(0.00648), p_touch_24h: 0.62, p_hold: 0.66 },
      { price: 0.00601, side: "support", sources: ["volume node", "lower band"], dist: at(0.00601), p_touch_24h: 0.24, p_hold: 0.55 },
      { price: 0.0054, side: "support", sources: ["launch-day base", "fib 0.786"], dist: at(0.0054), p_touch_24h: 0.08, p_hold: 0.47 },
    ].map((l) => ({ ...l, side: l.side as "support" | "resistance" })),
  };
}
