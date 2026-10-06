import type { Candle } from "../sources/ta";

/**
 * The physics baseline for "will price reach X by T": a driftless random walk in log price with the coin's
 * own volatility. No fitting, nothing to overfit, and on held-out coins and months it beat both the
 * 60-feature tree model and Jev's raw probabilities (quant lab, scripts/quant-lab):
 *
 *   level touches in 24h (6,070 chart-v1 calls): calibration error 2.8 pts, skill +0.25, AUC 0.79
 *   ±25% within 7 days (2,148 held-out rows):     calibration error 4.5–6.9 pts, skill +0.05–0.08
 *
 * The card's level odds calibrate this further (level-odds.ts, fitted in the level lab); Jev competes as a
 * graded challenger in its ledger (ledger.ts challenge()).
 */

/** Scale on σ fitted on train coins in the lab (memecoin tails are fatter than a Gaussian's). */
export const K_SCALE = 0.85;

/**
 * Daily log-volatility: 30-day close-to-close (daily candles, or 24h-spaced hourly closes) blended 3:1 with
 * the recent hourly ATR scaled to a day — volatility clusters, so the last day matters more than its 1/30th.
 */
export function sigmaDaily(daily: Candle[] | null, hourly: Candle[] | null, coarse?: { candles: Candle[] | null; stepS: number }[]): number | null {
  const rets: number[] = [];
  // Daily closes: native 1d candles, else resampled from the coarsest intraday series we have (12h, 4h),
  // else 24h-spaced hourly closes. GT's day endpoint 429s on bursts; the physics must not vanish with it.
  let d: Candle[] | null = daily && daily.length >= 11 ? daily : null;
  for (const c of coarse ?? []) {
    if (d || !c.candles || c.stepS >= 86400) continue;
    const every = Math.round(86400 / c.stepS);
    const picked: Candle[] = [];
    for (let k = c.candles.length - 1; k >= 0 && picked.length < 31; k -= every) picked.unshift(c.candles[k]);
    if (picked.length >= 11) d = picked;
  }
  if (d) {
    d = d.slice(-31);
    for (let i = 1; i < d.length; i++) if (d[i - 1].c > 0 && d[i].c > 0) rets.push(Math.log(d[i].c / d[i - 1].c));
  } else if (hourly && hourly.length >= 24 * 11) {
    for (let k = hourly.length - 1; k - 24 >= 0 && rets.length < 30; k -= 24) rets.push(Math.log(hourly[k].c / hourly[k - 24].c));
  }
  if (rets.length < 10) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v30 = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  if (!hourly || hourly.length < 15) return v30;
  let tr = 0;
  for (let k = hourly.length - 14; k < hourly.length; k++) {
    const c = hourly[k];
    const p = hourly[k - 1].c;
    tr += Math.max(c.h - c.l, Math.abs(c.h - p), Math.abs(c.l - p));
  }
  const atrDay = (tr / 14 / hourly.at(-1)!.c) * Math.sqrt(24);
  return 0.75 * v30 + 0.25 * atrDay;
}

/** The two-sided tail 2·(1 − Φ(z)) = erfc(z/√2), via Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7). */
function erfcHalf(z: number): number {
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  return (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
}

/**
 * P(price trades at `level` at any point within `days`), reflection principle: 2·(1 − Φ(|ln(level/price)| / (kσ√T))).
 * Worked example: σ = 10%/day, a level 15% below, 1 day → z = 0.1625/0.085 = 1.91 → 5.6%.
 */
export function touchProb(price: number, level: number, sigma: number, days: number, k = K_SCALE): number {
  if (!(price > 0) || !(level > 0) || !(sigma > 0) || !(days > 0)) return 0;
  const z = Math.abs(Math.log(level / price)) / (k * sigma * Math.sqrt(days));
  return Math.min(0.9999, Math.max(0.0001, erfcHalf(z)));
}

/** Small seeded PRNG so a read is reproducible (same candles → same number). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * P(a pattern reaches its target before its stop within `days`) for a random walk with the coin's own
 * volatility — the honest number to show next to a textbook pattern. In the lab, real patterns did NOT beat
 * it (double bottoms 18% vs 25%, double tops 12% vs 28%), so it's the upper bound, not the floor.
 * Monte Carlo on hourly steps, 2,000 seeded paths.
 */
export function firstPassage(price: number, target: number, stop: number, sigma: number, days: number, k = K_SCALE, paths = 2000): number | null {
  if (!(price > 0 && target > 0 && stop > 0 && sigma > 0)) return null;
  const up = target > price;
  const a = Math.log(target / price);
  const b = Math.log(stop / price);
  if (up ? !(b < 0 && a > 0) : !(a < 0 && b > 0)) return null;
  const steps = Math.round(days * 24);
  const sd = (k * sigma) / Math.sqrt(24);
  const rnd = mulberry32(Math.round(price * 1e9) ^ steps);
  let hits = 0;
  for (let p = 0; p < paths; p++) {
    let x = 0;
    for (let s = 0; s < steps; s++) {
      // Box–Muller
      const u = 1 - rnd();
      x += sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
      if (up ? x >= a : x <= a) {
        hits++;
        break;
      }
      if (up ? x <= b : x >= b) break;
    }
  }
  return hits / paths;
}
