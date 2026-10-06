/**
 * Pattern recognition audit, step 1: run the detector across coins, keep each distinct detection once (its
 * first sighting), and export a random sample per kind with the bars around it for rendering by
 * render-patterns.py. Usage: npx tsx scripts/quant-lab/pattern-samples.ts [perKind=12] [SYM ...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { detectPatterns, followThrough, TF_S, toBars, type Pattern, type PatternKind, type SwingTf } from "../../src/lib/karma/quant/swing-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

const args = process.argv.slice(2);
const perKind = Number(args[0] ?? 12);
const coins = args.slice(1).length ? args.slice(1) : LAB_COINS;
/** TF=12h or TF=1d audits the higher timeframes (same rules, counted in bars). */
const TF = (process.env.TF ?? "4h") as SwingTf;

// Seeded shuffle so the audit sample is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function main() {
  const byKind = new Map<PatternKind, Array<{ sym: string; at: number; p: Pattern; bars: unknown[]; outcome: string | null }>>();
  const counts: Record<string, number> = {};
  for (const sym of coins) {
    const candles = await kucoinHourly(sym);
    // One episode per pattern: a kind seen at consecutive 4h steps is the same shape still on the chart.
    const lastSeen = new Map<PatternKind, number>();
    const episodes = new Map<PatternKind, Array<{ start: number; end: number }>>();
    const STEP = TF_S[TF];
    for (let at = candles[0].t + 45 * 86400; at < candles.at(-1)!.t; at += STEP) {
      for (const p of detectPatterns(candles, at, TF)) {
        // Swing patterns are identified by their swings; ranges (no fixed swings) by staying on the chart.
        const prev = lastSeen.get(p.kind);
        lastSeen.set(p.kind, at);
        // Same kind whose span overlaps an earlier episode's = the same shape re-drawn (pivots shift a bar or two).
        const ep = episodes.get(p.kind) ?? [];
        const overlaps = ep.some((e) => p.start_t < e.end && p.end_t > e.start && Math.min(p.end_t, e.end) - Math.max(p.start_t, e.start) >= 0.5 * (p.end_t - p.start_t));
        const fresh = !overlaps && prev !== at - STEP;
        ep.push({ start: p.start_t, end: p.end_t });
        episodes.set(p.kind, ep);
        if (!fresh) continue;
        counts[p.kind] = (counts[p.kind] ?? 0) + 1;
        const list = byKind.get(p.kind) ?? [];
        list.push({ sym, at, p, bars: toBars(candles, at + 84 * TF_S[TF], 180 + 84, TF_S[TF]), outcome: followThrough(candles, at, p) });
        byKind.set(p.kind, list);
      }
    }
  }
  const sample: unknown[] = [];
  for (const [kind, list] of byKind) {
    const pick = list.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).slice(0, perKind).map(([, x]) => x);
    for (const x of pick) sample.push({ kind, ...x });
  }
  mkdirSync("data/lab", { recursive: true });
  writeFileSync(process.env.OUT ?? "data/lab/pattern-sample.json", JSON.stringify(sample));
  console.log("distinct detections:", counts);
  console.log(`sampled ${sample.length}`);
}
main();
