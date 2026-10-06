/**
 * Timeframe scorecard: how much to trust a call depends on the timeframe it was made on and on whether the
 * higher timeframes agree. Measured, not assumed, on the 24 lab coins' full histories (look-ahead safe:
 * every feature from candles before t, every outcome from candles after t).
 *
 *  PATTERNS  on 1h / 4h / 12h / 1d / 3d, first sighting of each shape, graded over 42 bars of its own
 *            timeframe (1h → 42h … 3d → 126 days): did it hit the target before the invalidation? Beside
 *            it, the same-volatility random walk's odds for the same target/stop/window. Cells split by
 *            daily and weekly alignment ("run the 1h through the weekly").
 *  TOUCHES   the level engine's levels, physics touch probability at 4h / 24h / 3d / 7d, graded on the
 *            1h path; split by whether the weekly trend points toward the level.
 *
 * Output: data/lab/tf-scorecard.json (rows for the jev_ledger seed) + the tables printed.
 * Usage: npx tsx scripts/quant-lab/tf-scorecard.ts [--step=12]
 */
import { writeFileSync } from "node:fs";
import type { Candle } from "../../src/lib/karma/sources/ta";
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { pickLevels } from "../../src/lib/karma/quant/levels";
import { pivotsFor } from "../../src/lib/karma/quant/patterns";
import { firstPassage, sigmaDaily, touchProb } from "../../src/lib/karma/quant/physics";
import { alignment, dailyTrend, detectPatterns, TF_S, toBars, weeklyTrend, type SwingTf } from "../../src/lib/karma/quant/swing-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

const H = 3600;
const TFS: SwingTf[] = ["1h", "4h", "12h", "1d", "3d"];
const HORIZON_BARS = 42;
const TOUCH_H = [4, 24, 72, 168];

export interface SeedRow {
  sym: string;
  t: number;
  family: "pattern" | "touch";
  timeframe: string; // pattern tf, or touch horizon ("4h", "24h", "3d", "7d")
  kind: string; // pattern kind, or "support" / "resistance"
  weekly: string; // alignment vs weekly trend
  daily: string; // alignment vs daily trend
  horizon_h: number;
  p_physics: number;
  y: 0 | 1;
}

const hLabel = (h: number) => (h < 24 ? `${h}h` : h === 24 ? "24h" : `${h / 24}d`);

/** Target before stop on the 1h path after `at` within `hours` (a candle crossing both = stop). */
function firstHit(c: Candle[], i0: number, hours: number, bull: boolean, target: number, stop: number): 0 | 1 | null {
  const end = c[i0]?.t + hours * H;
  if (c.at(-1)!.t < end) return null;
  for (let i = i0; i < c.length && c[i].t < end; i++) {
    const inv = bull ? c[i].l <= stop : c[i].h >= stop;
    const tgt = bull ? c[i].h >= target : c[i].l <= target;
    if (inv) return 0;
    if (tgt) return 1;
  }
  return 0;
}

function touched(c: Candle[], i0: number, hours: number, side: "support" | "resistance", level: number): 0 | 1 | null {
  const end = c[i0]?.t + hours * H;
  if (c.at(-1)!.t < end) return null;
  for (let i = i0; i < c.length && c[i].t < end; i++) if (side === "support" ? c[i].l <= level : c[i].h >= level) return 1;
  return 0;
}

async function main() {
  const step = Number(process.argv.find((a) => a.startsWith("--step="))?.split("=")[1] ?? 12) * H;
  const rows: SeedRow[] = [];
  for (const sym of LAB_COINS) {
    const c = fillHourlyGaps(await kucoinHourly(sym));
    const seen = new Set<string>();
    let i = 0;
    for (let at = c[0].t + 45 * 86400; at < c.at(-1)!.t - 8 * 86400; at += step) {
      while (i < c.length && c[i].t < at) i++;
      // Only the window each read needs (the full history per snapshot would be quadratic).
      const from = (secs: number) => {
        let lo = 0;
        let hi = i;
        const t0 = at - secs;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (c[mid].t < t0) lo = mid + 1;
          else hi = mid;
        }
        return c.slice(lo, i);
      };
      const past = from(210 * 86400);
      const price = past.at(-1)!.c;
      const daily = toBars(past, at, 60, 86400);
      const sig = sigmaDaily(daily, past.slice(-24 * 14));
      if (!sig) continue;
      const wk = weeklyTrend(past, at);
      const dy = dailyTrend(past, at);
      // Patterns, first sighting per shape per timeframe.
      for (const tf of TFS) {
        for (const p of detectPatterns(from(190 * TF_S[tf]), at, tf)) {
          const id = `${tf}:${p.kind}:${p.points[0].t}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const hours = (HORIZON_BARS * TF_S[tf]) / H;
          const y = firstHit(c, i, hours, p.bias === "up", p.target, p.stop);
          const rw = firstPassage(price, p.target, p.stop, sig, hours / 24, undefined, 600);
          if (y === null || rw === null) continue;
          rows.push({ sym, t: at, family: "pattern", timeframe: tf, kind: p.kind, weekly: String(alignment(wk, p.bias)), daily: String(alignment(dy, p.bias)), horizon_h: hours, p_physics: rw, y });
        }
      }
      // Level touches every other snapshot (the level engine is the slow part).
      if ((at / step) % 2 === 0) {
        const c1h = past.slice(-168);
        const pv = pivotsFor(c1h, "1h");
        if (!pv.atr) continue;
        const { picked } = pickLevels({ price, candles1h: c1h, candles15m: [], pivots1h: pv.pivots, pivots15m: [], atr: pv.atr, now: at });
        for (const l of picked) {
          const toward = wk === null ? "null" : wk === "flat" ? "flat" : (wk === "up") === (l.side === "resistance") ? "aligned" : "against";
          const dtoward = dy === null ? "null" : dy === "flat" ? "flat" : (dy === "up") === (l.side === "resistance") ? "aligned" : "against";
          for (const h of TOUCH_H) {
            const y = touched(c, i, h, l.side, l.price);
            if (y === null) continue;
            rows.push({ sym, t: at, family: "touch", timeframe: hLabel(h), kind: l.side, weekly: toward, daily: dtoward, horizon_h: h, p_physics: touchProb(price, l.price, sig, h / 24), y });
          }
        }
      }
    }
    console.error(`${sym}: ${rows.length} rows so far`);
  }
  writeFileSync("data/lab/tf-scorecard.json", JSON.stringify(rows));

  // ── tables ──
  const score = (rs: SeedRow[]) => {
    const n = rs.length;
    const y = rs.reduce((s, r) => s + r.y, 0) / n;
    const p = rs.reduce((s, r) => s + r.p_physics, 0) / n;
    const brier = rs.reduce((s, r) => s + (r.p_physics - r.y) ** 2, 0) / n;
    const base = y * (1 - y);
    // ECE over 10 bins
    let ece = 0;
    for (let b = 0; b < 10; b++) {
      const bin = rs.filter((r) => r.p_physics >= b / 10 && (b === 9 ? r.p_physics <= 1 : r.p_physics < (b + 1) / 10));
      if (bin.length) ece += (bin.length / n) * Math.abs(bin.reduce((s, r) => s + r.p_physics, 0) / bin.length - bin.reduce((s, r) => s + r.y, 0) / bin.length);
    }
    return { n, hit: y, rw: p, ece, skill: base > 0 ? 1 - brier / base : 0 };
  };
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
  console.log("\nPATTERNS — hit target before invalidation within 42 bars of their own timeframe");
  console.log("timeframe  weekly    daily     n     hit  random-walk  edge");
  for (const tf of TFS) {
    const cells: [string, (r: SeedRow) => boolean][] = [
      ["all", () => true],
      ["wk aligned", (r) => r.weekly === "aligned"],
      ["wk against", (r) => r.weekly === "against"],
      ["wk+dy aligned", (r) => r.weekly === "aligned" && r.daily === "aligned"],
    ];
    for (const [name, f] of cells) {
      const rs = rows.filter((r) => r.family === "pattern" && r.timeframe === tf && f(r));
      if (!rs.length) continue;
      const s = score(rs);
      console.log(`${tf.padEnd(10)} ${name.padEnd(18)} ${String(s.n).padStart(5)}  ${pct(s.hit)}   ${pct(s.rw)}      ${((s.hit - s.rw) * 100).toFixed(0).padStart(4)} pts`);
    }
  }
  console.log("\nTOUCHES — physics probability a level is reached, by horizon (and weekly trend toward the level)");
  console.log("horizon  cell           n       rate  predicted  calib-err  skill");
  for (const h of TOUCH_H.map(hLabel)) {
    for (const [name, f] of [
      ["all", () => true],
      ["wk toward", (r: SeedRow) => r.weekly === "aligned"],
      ["wk away", (r: SeedRow) => r.weekly === "against"],
    ] as [string, (r: SeedRow) => boolean][]) {
      const rs = rows.filter((r) => r.family === "touch" && r.timeframe === h && f(r));
      if (!rs.length) continue;
      const s = score(rs);
      console.log(`${h.padEnd(8)} ${name.padEnd(12)} ${String(s.n).padStart(6)}   ${pct(s.hit)}   ${pct(s.rw)}      ${(s.ece * 100).toFixed(1).padStart(4)} pts  ${s.skill >= 0 ? "+" : ""}${s.skill.toFixed(2)}`);
    }
  }
}

main();
