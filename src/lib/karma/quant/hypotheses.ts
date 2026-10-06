import type { Candle } from "../sources/ta";
import { detectPatterns as looseShapes } from "./hypothesis-shapes";
import { zigzag } from "./patterns";
import { firstPassage } from "./physics";
import { dailyTrend, toBars, weeklyTrend } from "./swing-patterns";

/**
 * THE FUNNEL: lower timeframes propose, higher timeframes dispose.
 *
 * 1h and 4h charts propose hypotheses (a direction, a target, an invalidation). Each is tested against the
 * daily and weekly charts: does the daily trend agree, does the weekly, is there a daily swing level in the
 * way of the target, does one guard the invalidation. A hypothesis SURVIVES when the daily trend agrees and
 * the path to its target is clear — the combination that measured best in the quant lab.
 *
 * What the lab found (24 coins, 54k hypotheses, scripts/quant-lab/funnel.ts), and why the odds shown are
 * the random walk's: survivors hit their target far more often (1h: 32% vs 22%), but a random walk with
 * the same volatility, target and invalidation does almost as well (30%). The higher timeframes mostly
 * pick ideas with good geometry; the real edge left is ~+1.5 pts on 1h, ~0 on 4h. Jev judging the same
 * evidence added nothing (AUC 0.60 alone, no gain on top). So: survivors are shown, each with its odds
 * next to what chance alone gives, and every one goes to Jev's ledger to be graded.
 */

export type HypTf = "1h" | "4h";

export interface Hypothesis {
  tf: HypTf;
  kind: string;
  bull: boolean;
  target: number;
  stop: number;
  /** Hours the idea has to play out: 42 bars of its timeframe. */
  window_h: number;
  tests: { daily: boolean; weekly: boolean; clear: boolean; protected: boolean };
  survives: boolean;
  /** Random-walk probability of target before invalidation within the window (the honest odds). */
  p: number | null;
}

const WINDOW_BARS = 42;

/**
 * Hypotheses from the 1h and 4h charts, tested on the daily / weekly. `daily` should be ≥ 30 days of daily
 * candles (the weekly check wants ≥ 20 weeks; younger coins just get a null weekly test = not passed).
 */
export function funnel(c1h: Candle[], c4h: Candle[] | null, daily: Candle[] | null, price: number, sigma: number | null, now: number): Hypothesis[] {
  const d = daily ?? [];
  const dT = d.length >= 30 ? dailyTrend(d, now + 1) : null;
  const wT = d.length >= 140 ? weeklyTrend(d, now + 1) : null;
  const dPiv = d.length >= 30 ? zigzag(d, 2).filter((p) => p.confirmed).map((p) => p.price) : [];
  const between = (a: number, b: number) => dPiv.some((x) => x > Math.min(a, b) && x < Math.max(a, b));

  const raw: { tf: HypTf; kind: string; bull: boolean; target: number; stop: number }[] = [];
  const bars4h = c4h && c4h.length >= 60 ? c4h : c1h.length >= 240 ? toBars(c1h, now + 1, 300, 4 * 3600) : null;
  for (const [tf, bars] of [
    ["1h", c1h.length >= 60 ? c1h.slice(-300) : null],
    ["4h", bars4h],
  ] as [HypTf, Candle[] | null][]) {
    if (!bars) continue;
    for (const p of looseShapes(bars, "1h", price).candidates) {
      if (p.bias === "neutral" || p.target === null || p.invalidation === null) continue;
      const bull = p.bias === "bull";
      if (bull ? !(p.target > price && p.invalidation < price) : !(p.target < price && p.invalidation > price)) continue;
      raw.push({ tf, kind: p.kind, bull, target: p.target, stop: p.invalidation });
    }
  }
  return raw.map((h) => {
    const tests = {
      daily: dT === (h.bull ? "up" : "down"),
      weekly: wT === (h.bull ? "up" : "down"),
      clear: dPiv.length > 0 && !between(price, h.target),
      protected: between(price, h.stop),
    };
    const window_h = WINDOW_BARS * (h.tf === "1h" ? 1 : 4);
    return {
      ...h,
      window_h,
      tests,
      survives: tests.daily && tests.clear,
      p: sigma ? firstPassage(price, h.target, h.stop, sigma, window_h / 24, undefined, 600) : null,
    };
  });
}
