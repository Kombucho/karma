/**
 * Replay the chart read on held-out coins and months, and grade it with its own target functions
 * (chartReadTargets / chartTargetEvent). Ran first on chart-v1 (PR #47, results in replay-chart-v1.jsonl),
 * now on chart-v2. For every level-touch call, also record the
 * physics baseline for the same level — the reflection-principle touch probability with the coin's own
 * volatility — so the two can be scored side by side by eval-chart-read.py.
 *
 * The engine reads Date.now(); the replay pins it to each snapshot time. Candles: KuCoin 15m + 1h, only
 * those before t (look-ahead safe); outcomes from the 1h candles after t.
 *
 * Usage: npx tsx --env-file=.env.local scripts/quant-lab/replay-chart-read.ts [--every=48]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { MemoryCache } from "../../src/lib/karma/cache";
import { chartReadTargets, chartTargetEvent, fillGaps, readChartPatternsAndLevels } from "../../src/lib/karma/quant/chart-read-engine";
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { toBars } from "../../src/lib/karma/quant/swing-patterns";
import type { Candle } from "../../src/lib/karma/sources/ta";
import { kucoin15m, kucoinHourly } from "./data";

const TEST = ["BAN", "GIGA", "MEW", "PENGU", "USELESS", "WEN"];
const CUT = 1756684800 + 14 * 86400; // held-out months start (same split as eval.py)
const OUT = process.env.OUT ?? "data/lab/replay-chart-v2.jsonl";

/** σ_daily blend as in the lab (30d close-to-close vol, 0.75, with hourly ATR·√24, 0.25). */
function sigmaDaily(c1h: Candle[]): number | null {
  const daily: number[] = [];
  for (let k = c1h.length - 1; k - 24 >= 0 && daily.length < 30; k -= 24) daily.push(Math.log(c1h[k].c / c1h[k - 24].c));
  if (daily.length < 10) return null;
  const m = daily.reduce((a, b) => a + b, 0) / daily.length;
  const v30 = Math.sqrt(daily.reduce((a, b) => a + (b - m) ** 2, 0) / (daily.length - 1));
  let tr = 0;
  const n = Math.min(14, c1h.length - 1);
  for (let k = c1h.length - n; k < c1h.length; k++) tr += Math.max(c1h[k].h - c1h[k].l, Math.abs(c1h[k].h - c1h[k - 1].c), Math.abs(c1h[k].l - c1h[k - 1].c));
  const atr = tr / n / c1h.at(-1)!.c;
  return 0.75 * v30 + 0.25 * atr * Math.sqrt(24);
}

/** 2·(1−Φ(z)): P(a driftless walk touches a level `dist` log-units away within `days`). */
function touchP(dist: number, sig: number, days: number, k = 0.85): number {
  const z = Math.abs(dist) / (k * sig * Math.sqrt(days));
  const x = z / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const tail = (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) * Math.exp(-x * x);
  return Math.min(0.9999, Math.max(0.0001, tail));
}

async function main() {
  const every = Number(process.argv.find((a) => a.startsWith("--every="))?.split("=")[1] ?? 48) * 3600;
  const done = new Set<string>(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const realNow = Date.now;
  let cost = 0;
  for (const sym of TEST) {
    const h1 = fillHourlyGaps(await kucoinHourly(sym));
    const end = h1.at(-1)!.t - 2 * 86400;
    const m15 = fillGaps(await kucoin15m(sym, CUT - 5 * 86400, end + 2 * 86400), 900);
    const jobs: number[] = [];
    for (let t = CUT - (CUT % every); t <= end; t += every) if (!done.has(`${sym}:${t}`)) jobs.push(t);
    let n = 0;
    const queue = [...jobs];
    const worker = async () => {
      for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
        const c1h = h1.filter((c) => c.t + 3600 <= t);
        const c15 = m15.filter((c) => c.t + 900 <= t).slice(-384);
        const hist = c1h.slice(-168);
        if (hist.length < 100 || c15.length < 100) continue;
        const price = c15.at(-1)!.c;
        // Pin the engine's clock to the snapshot (its `now` feeds pivot recency and the state).
        Date.now = () => t * 1000;
        // 4h / 12h / 1d as GeckoTerminal would serve them (300 / 300 / 180 bars), built from the 1h history.
        const chart = {
          pool: "replay",
          candles15m: c15,
          candles1h: hist,
          candles4h: toBars(c1h, t, 300, 4 * 3600),
          candles12h: toBars(c1h, t, 300, 12 * 3600),
          candles1d: toBars(c1h, t, 180, 86400),
        };
        const read = await readChartPatternsAndLevels(sym, chart, price, new MemoryCache());
        Date.now = realNow;
        if (!read.jev) continue;
        cost += read.jev.cost_usd ?? 0;
        const sig = sigmaDaily(c1h.slice(-24 * 31));
        const future = h1.filter((c) => c.t >= t - 3600 && c.t < t + 170 * 3600);
        const targets = chartReadTargets({ ...read, week: read.week }).map((tg) => {
          const y = chartTargetEvent(tg, future);
          const phys = tg.claim === "touch" && sig ? touchP(Math.log(tg.level / price), sig, tg.horizon_h / 24) : null;
          return { ...tg, y, phys };
        });
        appendFileSync(OUT, JSON.stringify({ id: `${sym}:${t}`, sym, t, price, sigma: sig, pattern: read.patterns[0]?.kind ?? null, tf: read.patterns[0]?.tf ?? null, targets }) + "\n");
        n++;
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    console.log(`${sym}: ${n} reads (of ${jobs.length}), cost so far $${cost.toFixed(3)}`);
  }
}

main();
