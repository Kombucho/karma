/**
 * The hypothesis funnel: lower timeframes PROPOSE, higher timeframes DISPOSE.
 *
 * Every 12h on each lab coin, collect hypotheses from the 1h and 4h charts (loose pattern candidates from
 * the chart-v1 detector, plus the strict swing detector): a direction, a target, an invalidation, graded
 * over 42 bars of its own timeframe. Then test each against the higher timeframes, all in code:
 *
 *   D1 trend    the daily trend (20-day EMA) points the hypothesis' way
 *   W1 trend    the weekly trend (10-week EMA) points its way
 *   clear path  no daily swing level sits between price and the target (nothing big in the way)
 *   protected   a daily swing level sits between price and the invalidation (structure guards the stop)
 *
 * A hypothesis SURVIVES a test set if it passes every test in it. For each set: survivors vs the rejected,
 * hit rate vs the same-volatility random walk (the only fair yardstick), with a standard error. The funnel
 * earns its place only if survivors beat the random walk and the rejected don't.
 *
 * Usage: npx tsx scripts/quant-lab/funnel.ts  → data/lab/funnel.json + tables
 */
import { writeFileSync } from "node:fs";
import type { Candle } from "../../src/lib/karma/sources/ta";
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { zigzag } from "../../src/lib/karma/quant/patterns";
import { firstPassage, sigmaDaily } from "../../src/lib/karma/quant/physics";
import { dailyTrend, detectPatterns as swing, toBars, weeklyTrend } from "../../src/lib/karma/quant/swing-patterns";
import { detectPatterns as loose } from "./ref/chart-v1-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

const H = 3600;
const STEP = 12 * H;
const HORIZON_BARS = 42;

export interface Hyp {
  sym: string;
  t: number;
  tf: "1h" | "4h";
  src: "loose" | "swing";
  kind: string;
  bull: boolean;
  price: number;
  target: number;
  stop: number;
  tests: { d1: boolean; w1: boolean; clear: boolean; protected: boolean };
  p_rw: number;
  y: 0 | 1;
}

function firstHit(c: Candle[], i0: number, hours: number, bull: boolean, target: number, stop: number): 0 | 1 | null {
  const end = c[i0]?.t + hours * H;
  if (!c[i0] || c.at(-1)!.t < end) return null;
  for (let i = i0; i < c.length && c[i].t < end; i++) {
    if (bull ? c[i].l <= stop : c[i].h >= stop) return 0;
    if (bull ? c[i].h >= target : c[i].l <= target) return 1;
  }
  return 0;
}

async function main() {
  const out: Hyp[] = [];
  for (const sym of LAB_COINS) {
    const c = fillHourlyGaps(await kucoinHourly(sym));
    const seen = new Set<string>();
    let i = 0;
    let n0 = out.length;
    const idx = (t: number) => {
      let lo = 0;
      let hi = i;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (c[m].t < t) lo = m + 1;
        else hi = m;
      }
      return lo;
    };
    for (let at = c[0].t + 60 * 86400; at < c.at(-1)!.t - 8 * 86400; at += STEP) {
      while (i < c.length && c[i].t < at) i++;
      const past = c.slice(idx(at - 210 * 86400), i);
      const price = past.at(-1)!.c;
      const daily = toBars(past, at, 200, 86400);
      const sig = sigmaDaily(daily, past.slice(-24 * 14));
      if (!sig || daily.length < 30) continue;
      const dT = dailyTrend(past, at);
      const wT = weeklyTrend(past, at);
      // Daily swing levels: ATR-scaled zigzag on daily bars (k = 2 ATR), confirmed swings only.
      const dPiv = zigzag(daily, 2).filter((p) => p.confirmed).map((p) => p.price);

      const hyps: { tf: "1h" | "4h"; src: "loose" | "swing"; kind: string; bull: boolean; target: number; stop: number; key: string }[] = [];
      for (const tf of ["1h", "4h"] as const) {
        const bars = tf === "1h" ? past.slice(-300) : toBars(past, at, 300, 4 * H);
        for (const p of loose(bars, "1h", price).candidates) {
          if (p.bias === "neutral" || p.target === null || p.invalidation === null) continue;
          hyps.push({ tf, src: "loose", kind: p.kind, bull: p.bias === "bull", target: p.target, stop: p.invalidation, key: `${tf}:L:${p.kind}:${p.pivots[0]?.t ?? 0}` });
        }
        for (const p of swing(past.slice(-(190 * (tf === "1h" ? 1 : 4))), at, tf))
          hyps.push({ tf, src: "swing", kind: p.kind, bull: p.bias === "up", target: p.target, stop: p.stop, key: `${tf}:S:${p.kind}:${p.points[0].t}` });
      }
      for (const h of hyps) {
        if (seen.has(h.key)) continue;
        seen.add(h.key);
        if (h.bull ? !(h.target > price && h.stop < price) : !(h.target < price && h.stop > price)) continue;
        const hours = (HORIZON_BARS * (h.tf === "1h" ? 1 : 4) * H) / H;
        const y = firstHit(c, i, hours, h.bull, h.target, h.stop);
        if (y === null) continue;
        const between = (a: number, b: number) => dPiv.some((x) => x > Math.min(a, b) && x < Math.max(a, b));
        const tests = {
          d1: dT === (h.bull ? "up" : "down"),
          w1: wT === (h.bull ? "up" : "down"),
          clear: !between(price, h.target),
          protected: between(price, h.stop),
        };
        const p_rw = firstPassage(price, h.target, h.stop, sig, hours / 24, undefined, 300) ?? NaN;
        out.push({ sym, t: at, tf: h.tf, src: h.src, kind: h.kind, bull: h.bull, price, target: h.target, stop: h.stop, tests, p_rw, y });
      }
    }
    console.error(`${sym}: ${out.length - n0} hypotheses`);
    n0 = out.length;
  }
  writeFileSync("data/lab/funnel.json", JSON.stringify(out));

  const row = (label: string, rs: Hyp[]) => {
    if (!rs.length) return `${label.padEnd(34)}     0`;
    const n = rs.length;
    const hit = rs.reduce((s, r) => s + r.y, 0) / n;
    const rw = rs.reduce((s, r) => s + r.p_rw, 0) / n;
    const se = Math.sqrt((hit * (1 - hit)) / n);
    return `${label.padEnd(34)} ${String(n).padStart(6)}  hit ${(hit * 100).toFixed(1).padStart(5)}%  rw ${(rw * 100).toFixed(1).padStart(5)}%  edge ${((hit - rw) * 100).toFixed(1).padStart(5)} ± ${(se * 100).toFixed(1)} pts`;
  };
  const SETS: [string, (t: Hyp["tests"]) => boolean][] = [
    ["D1", (t) => t.d1],
    ["W1", (t) => t.w1],
    ["clear path", (t) => t.clear],
    ["protected stop", (t) => t.protected],
    ["D1 + W1", (t) => t.d1 && t.w1],
    ["D1 + clear", (t) => t.d1 && t.clear],
    ["D1 + W1 + clear", (t) => t.d1 && t.w1 && t.clear],
    ["D1 + W1 + clear + protected", (t) => t.d1 && t.w1 && t.clear && t.protected],
  ];
  for (const tf of ["1h", "4h"] as const) {
    for (const src of ["loose", "swing"] as const) {
      const rs = out.filter((r) => r.tf === tf && r.src === src && Number.isFinite(r.p_rw));
      console.log(`\n── ${tf} · ${src} detector ──`);
      console.log(row("all hypotheses", rs));
      for (const [name, f] of SETS) {
        console.log(row(`  survive ${name}`, rs.filter((r) => f(r.tests))));
        console.log(row(`  rejected by ${name}`, rs.filter((r) => !f(r.tests))));
      }
    }
  }
}

if (require.main === module) main();
