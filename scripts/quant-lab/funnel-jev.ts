/**
 * Jev as the higher-timeframe judge. For a balanced sample of funnel hypotheses (1h and 4h, loose
 * detector), Jev gets the hypothesis, its random-walk odds, and the higher-timeframe evidence the code
 * tests computed (daily / weekly trend, daily levels in the way or guarding the stop), and answers: does
 * it hit the target before the invalidation? Scored by eval-funnel-jev.py against the random walk.
 *
 * Usage: npx tsx --env-file=.env.local scripts/quant-lab/funnel-jev.ts [n=3000]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { askJev } from "../../src/lib/karma/quant/jev";
import type { Hyp } from "./funnel";

const OUT = "data/lab/funnel-jev.jsonl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const n = Number(process.argv[2] ?? 3000);
  const all = (JSON.parse(readFileSync("data/lab/funnel.json", "utf8")) as Hyp[]).filter((h) => h.src === "loose" && Number.isFinite(h.p_rw));
  // Seeded sample, half 1h half 4h.
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (tf: string) => all.filter((h) => h.tf === tf).map((h) => [rand(), h] as const).sort((a, b) => a[0] - b[0]).slice(0, n / 2).map(([, h]) => h);
  const sample = [...pick("1h"), ...pick("4h")];
  const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const queue = sample.filter((h) => !done.has(`${h.sym}:${h.t}:${h.tf}:${h.kind}:${h.target}`));
  console.log(`${queue.length} to ask`);
  let cost = 0;
  const worker = async () => {
    for (let h = queue.shift(); h; h = queue.shift()) {
      const pct = (x: number) => Math.round((x / h.price - 1) * 1000) / 10;
      const hours = 42 * (h.tf === "1h" ? 1 : 4);
      const state = {
        hypothesis: { timeframe: h.tf, pattern: h.kind.replace(/_/g, " "), direction: h.bull ? "up" : "down", target_from_now_pct: pct(h.target), invalidation_from_now_pct: pct(h.stop), window_hours: hours },
        random_walk_probability: Math.round(h.p_rw * 1000) / 1000,
        higher_timeframes: {
          daily_trend_agrees: h.tests.d1,
          weekly_trend_agrees: h.tests.w1,
          daily_level_between_price_and_target: !h.tests.clear,
          daily_level_guards_the_invalidation: h.tests.protected,
        },
      };
      const q = {
        survives: {
          type: "noul" as const,
          instructions: `A ${h.tf} chart suggests the move in \`hypothesis\`. Checking it against the higher timeframes, will price reach the target before the invalidation within ${hours} hours? \`random_walk_probability\` is what chance alone gives for this target and invalidation — start from it and move it only as far as the higher-timeframe evidence justifies.`,
        },
      };
      let r = null;
      for (let a = 0; a < 3 && !r; a++) {
        r = await askJev(state, q, 15_000);
        if (!r) await sleep(1000 * (a + 1));
      }
      if (!r) continue;
      cost += r.cost_usd ?? 0;
      appendFileSync(OUT, JSON.stringify({ id: `${h.sym}:${h.t}:${h.tf}:${h.kind}:${h.target}`, sym: h.sym, tf: h.tf, p_rw: h.p_rw, p_jev: r.answers.survives?.noul ?? null, tests: h.tests, y: h.y }) + "\n");
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  console.log(`done, $${cost.toFixed(3)}`);
}

main();
