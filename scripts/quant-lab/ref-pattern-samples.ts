/**
 * Pattern audit of the chart-v1 detector (PR #47, as merged) on the lab coins, at its native 1h timeframe
 * and the same 300-candle window the live read uses. Same episode dedupe and render format as ours, so the
 * two detectors are graded blind on equal terms. Usage: npx tsx scripts/quant-lab/ref-pattern-samples.ts [perKind=6]
 */
import { writeFileSync } from "node:fs";
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { detectPatterns } from "./ref/chart-v1-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

const perKind = Number(process.argv[2] ?? 6);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

async function main() {
  const byKind = new Map<string, unknown[]>();
  const counts: Record<string, number> = {};
  for (const sym of LAB_COINS) {
    const c = fillHourlyGaps(await kucoinHourly(sym));
    const seen = new Set<string>();
    for (let i = 300; i < c.length - 72; i += 4) {
      const win = c.slice(i - 300, i);
      const price = win.at(-1)!.c;
      const at = win.at(-1)!.t + 3600;
      for (const p of detectPatterns(win, "1h", price).candidates) {
        const id = `${p.kind}:${p.pivots[0]?.t ?? 0}`;
        if (seen.has(id)) continue;
        seen.add(id);
        counts[p.kind] = (counts[p.kind] ?? 0) + 1;
        const list = byKind.get(p.kind) ?? [];
        list.push({
          sym,
          at,
          p: { points: p.pivots.map((q) => ({ t: q.t, price: q.price })), target: p.target ?? price, stop: p.invalidation ?? price, trigger: p.trigger ?? price, fit: p.fit },
          bars: c.slice(i - 300, i + 72),
          outcome: `fit ${p.fit.toFixed(2)}`,
        });
        byKind.set(p.kind, list);
      }
    }
  }
  const sample: unknown[] = [];
  for (const [kind, list] of byKind) {
    const pick = list.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).slice(0, perKind).map(([, x]) => x);
    for (const x of pick) sample.push({ kind, ...(x as object) });
  }
  writeFileSync("data/lab/pattern-sample-ref.json", JSON.stringify(sample));
  console.log("distinct detections:", counts, "sampled", sample.length);
}
main();
