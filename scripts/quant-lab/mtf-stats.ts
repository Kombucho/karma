/**
 * Multi-timeframe pattern census on the lab coins: distinct patterns per timeframe, and how each resolves
 * (target before stop, over 84 bars of its own timeframe) split by weekly alignment — does the weekly
 * check a trader does actually separate the patterns that work from the ones that don't?
 */
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { detectMultiTf, followThrough } from "../../src/lib/karma/quant/swing-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

async function main() {
  const seen = new Set<string>();
  const stat: Record<string, { n: number; target: number; stop: number; neither: number; open: number }> = {};
  const bump = (k: string, o: string | null) => {
    const s = (stat[k] ??= { n: 0, target: 0, stop: 0, neither: 0, open: 0 });
    s.n++;
    if (o === null) s.open++;
    else s[o as "target" | "stop" | "neither"]++;
  };
  for (const sym of LAB_COINS) {
    const c = fillHourlyGaps(await kucoinHourly(sym));
    for (let at = c[0].t + 60 * 86400; at < c.at(-1)!.t; at += 12 * 3600) {
      for (const p of detectMultiTf(c, at)) {
        const id = `${sym}:${p.tf}:${p.kind}:${p.points[0].t}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const o = followThrough(c, at, p);
        bump(`tf ${p.tf}`, o);
        bump(`weekly ${p.weekly}`, o);
        bump(`${p.tf} ${p.weekly}`, o);
      }
    }
  }
  for (const [k, s] of Object.entries(stat).sort()) {
    const done = s.n - s.open;
    console.log(`${k.padEnd(18)} n=${String(s.n).padStart(4)}  resolved ${done}: target ${((s.target / Math.max(1, done)) * 100).toFixed(0)}%  stop ${((s.stop / Math.max(1, done)) * 100).toFixed(0)}%  neither ${((s.neither / Math.max(1, done)) * 100).toFixed(0)}%`);
  }
}
main();
