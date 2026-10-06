/**
 * Seed Jev's ledger with the lab backtests, so its scorecard starts with a record instead of empty cells.
 * Rows are source = "replay", mint = "lab:<SYM>", network = "lab" — kept apart from live calls, and every
 * one already resolved (y set), since the lab knew what happened next.
 *
 *   data/lab/tf-scorecard.json  level touches at 4h / 24h / 3d / 7d (physics), audited patterns by timeframe
 *   data/lab/funnel.json        1h / 4h hypotheses, survivors and rejected (loose detector)
 *
 * Needs the jev_ledger / jev_scorecard tables (db/schema.sql). Then run the cron's ledger step (or
 * `--rescore`) to fill the scorecard.
 * Usage: npx tsx --env-file=.env.local scripts/quant-lab/seed-ledger.ts [--rescore]
 */
import { readFileSync } from "node:fs";
import { db } from "../../src/lib/karma/db";
import { runLedger, writeLedger, type LedgerRow } from "../../src/lib/karma/quant/ledger";
import { CandleBook } from "../../src/lib/karma/quant/market";
import type { Hyp } from "./funnel";
import type { SeedRow } from "./tf-scorecard";

async function main() {
  const c = db();
  if (!c) throw new Error("no Supabase client (SUPABASE_URL / SUPABASE_SECRET_KEY)");
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const done = iso(Math.floor(Date.now() / 1000));
  const rows: LedgerRow[] = [];

  const tf = JSON.parse(readFileSync("data/lab/tf-scorecard.json", "utf8")) as SeedRow[];
  for (const r of tf) {
    if (r.family === "touch") {
      rows.push({ mint: `lab:${r.sym}`, network: "lab", t: iso(r.t), source: "replay", family: "touch", timeframe: r.timeframe, kind: r.kind, context: "", horizon_h: r.horizon_h, p_shown: null, p_physics: r.p_physics, p_jev: null, target: { side: r.kind as "support" | "resistance", level: r.p_physics }, price: null, y: r.y, resolved_at: done });
    } else {
      rows.push({ mint: `lab:${r.sym}`, network: "lab", t: iso(r.t), source: "replay", family: "pattern", timeframe: r.timeframe, kind: r.kind, context: `wk:${r.weekly}`, horizon_h: r.horizon_h, p_shown: null, p_physics: r.p_physics, p_jev: null, target: { bull: true, target: r.p_physics, stop: 0 }, price: null, y: r.y, resolved_at: done });
    }
  }
  const fn = JSON.parse(readFileSync("data/lab/funnel.json", "utf8")) as Hyp[];
  for (const h of fn) {
    if (h.src !== "loose" || !Number.isFinite(h.p_rw)) continue;
    const survives = h.tests.d1 && h.tests.clear;
    rows.push({ mint: `lab:${h.sym}`, network: "lab", t: iso(h.t), source: "replay", family: "hypothesis", timeframe: h.tf, kind: h.kind, context: survives ? "survives" : "rejected", horizon_h: 42 * (h.tf === "1h" ? 1 : 4), p_shown: null, p_physics: h.p_rw, p_jev: null, target: { bull: h.bull, target: h.target, stop: h.stop }, price: h.price, y: h.y, resolved_at: done });
  }
  // The lab's touch rows don't carry the level price (only its odds), so the target json holds the odds as a
  // stand-in: unique per row, never resolved again (y is already set).
  console.log(`seeding ${rows.length} rows…`);
  const n = await writeLedger(rows, c);
  console.log(`inserted ${n}`);
  if (process.argv.includes("--rescore")) {
    const s = await runLedger({ now: Math.floor(Date.now() / 1000), deadline: Date.now() + 240_000, book: new CandleBook() });
    console.log("scorecard cells:", s.cells);
  }
}

main();
