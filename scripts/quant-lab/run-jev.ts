/**
 * Ask Jev a lab rubric over the dataset. Answers are cached per rubric version in
 * data/lab/answers-<version>.jsonl (one line per row id), so a rerun only pays for rows it hasn't asked.
 *
 * Usage: npx tsx --env-file=.env.local scripts/quant-lab/run-jev.ts <rubric> [--every=24] [--conc=12] [--limit=N]
 *   --every: only rows whose t is a multiple of this many hours (subsample for fast iterations)
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { askJev } from "../../src/lib/karma/quant/jev";
import type { RubricQuestion } from "../../src/lib/karma/quant/types";
import type { LabRow } from "./build-dataset";
import { RUBRICS } from "./rubrics";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function loadRows(every?: number): LabRow[] {
  const rows = readFileSync("data/lab/dataset.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l) as LabRow);
  return every ? rows.filter((r) => r.t % (every * 3600) === 0) : rows;
}

async function main() {
  const args = process.argv.slice(2);
  const name = args[0];
  const rubric = RUBRICS[name];
  if (!rubric) throw new Error(`unknown rubric ${name}; have ${Object.keys(RUBRICS).join(", ")}`);
  const opt = (k: string, d?: number) => {
    const v = args.find((a) => a.startsWith(`--${k}=`));
    return v ? Number(v.split("=")[1]) : d;
  };
  const rows = loadRows(opt("every")).slice(0, opt("limit"));
  const file = `data/lab/answers-${rubric.version}.jsonl`;
  const done = new Set<string>(existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);
  const todo = rows.filter((r) => !done.has(r.id));
  console.log(`${rubric.version}: ${rows.length} rows, ${todo.length} to ask`);

  let cost = 0;
  let asked = 0;
  let failed = 0;
  const t0 = Date.now();
  const queue = [...todo];
  const worker = async () => {
    for (let r = queue.shift(); r; r = queue.shift()) {
      const qs: Record<string, RubricQuestion> = {};
      for (const [k, lq] of Object.entries(rubric.questions)) if (!lq.when || lq.when(r)) qs[k] = lq.q;
      let res = null;
      for (let a = 0; a < 4 && !res; a++) {
        res = await askJev(rubric.state(r), qs, 20_000);
        if (!res) await sleep(1500 * (a + 1));
      }
      if (!res) {
        failed++;
        continue;
      }
      cost += res.cost_usd ?? 0;
      appendFileSync(file, JSON.stringify({ id: r.id, answers: res.answers }) + "\n");
      if (++asked % 500 === 0) console.log(`  ${asked}/${todo.length}  $${cost.toFixed(3)}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
  };
  await Promise.all(Array.from({ length: opt("conc", 12)! }, worker));
  console.log(`done: asked ${asked}, failed ${failed}, cost $${cost.toFixed(3)}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

if (require.main === module) main();
