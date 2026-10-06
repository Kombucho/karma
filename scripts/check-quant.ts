/**
 * Prove the Jev quant loop end to end without touching production tables.
 *
 *   npx tsx scripts/check-quant.ts              synthetic grade/evolve tests + real 3-coin snapshot dry run
 *   npx tsx scripts/check-quant.ts --synthetic  synthetic tests only (no network)
 *   npx tsx scripts/check-quant.ts --real       real 3-coin dry run only
 *   add --claude  to also run ONE real Claude challenger proposal on the synthetic training slice (~$0.05–0.1)
 *   add --write   to let the real run save snapshots (only if the quant tables exist; default is a dry run)
 *
 * Synthetic world: 200 snapshots over 60 days. One feature, holders.insider_shaped_pct (x ∈ 0..60), truly
 * drives every outcome (P(dump24) = 0.1 + 0.8·x/60, etc.). A fake Jev answers from the instructions it
 * is given: questions that name insider_shaped_pct get the true probability (+ noise), "contrarian"
 * questions get its mirror image, anything else gets the base rate + noise (no skill). The champion is
 * the real seed rubric v1 (no mention of the feature → no skill). The pipeline must PROMOTE a challenger
 * that points Jev at the feature, and REJECT one that inverts it and one that changes nothing.
 */
import { db } from "../src/lib/karma/db";
import { JevBudget } from "../src/lib/karma/quant/budget";
import { buildEvolvePrompt, callClaude, extractJson, lastClaudeError, runEvolve, splitByTime, validateRubricBody, type ClaudeFn, type EvolveDeps } from "../src/lib/karma/quant/evolve";
import { gradeRubric } from "../src/lib/karma/quant/grade";
import type { JevResult } from "../src/lib/karma/quant/jev";
import { CandleBook } from "../src/lib/karma/quant/market";
import { measureOutcome } from "../src/lib/karma/quant/outcomes";
import { RUBRIC_V1 } from "../src/lib/karma/quant/rubric-v1";
import { runSnapshots } from "../src/lib/karma/quant/snapshot";
import { quantTablesReady, recentScanMints, type GradedRow } from "../src/lib/karma/quant/store";
import type { JevAnswer, QuantFeatures, QuantOutcome, Rubric, RubricQuestion } from "../src/lib/karma/quant/types";

for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {}
}
const args = process.argv.slice(2);
const only = args.includes("--synthetic") ? "synthetic" : args.includes("--real") ? "real" : "both";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

// ── Synthetic world ──────────────────────────────────────────────────────────────────────────────

/** Deterministic PRNG (mulberry32) so every run is the same world. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The true event probabilities as a function of the one informative feature. */
const truth = (x: number) => ({
  "drawdown@24>=0.3": 0.1 + 0.8 * (x / 60),
  "drawdown@168>=0.5": 0.05 + 0.75 * (x / 60),
  "pump@168>=1": 0.35 - 0.3 * (x / 60),
  "direction@168": 0.75 - 0.5 * (x / 60), // P(up)
});
type Sig = keyof ReturnType<typeof truth>;
const BASE: Record<Sig, number> = { "drawdown@24>=0.3": 0.5, "drawdown@168>=0.5": 0.425, "pump@168>=1": 0.2, "direction@168": 0.5 };

function synthFeatures(mint: string, t: number, x: number, noise: number): QuantFeatures {
  return {
    mint, symbol: mint.slice(0, 4), t, price_usd: 0.001, mcap_usd: 50_000 + noise * 1e5, liquidity_usd: 15_000, age_hours: 48 + noise * 100,
    chart: null,
    holders: {
      verdict: "caution", top10_pct: 20 + noise * 30, holder_count: Math.round(300 + noise * 500), insider_shaped_pct: Math.round(x * 10) / 10,
      sniper_pct: Math.round(noise * 15), connected_pct: null, ecosystem_only_pct: null, reward_only_pct: null, crowd_manufactured: null,
      fresh_flow_severity: "none", fresh_net_sol_1h: null, sibling_verdict: "none", lp_pullable_share: null, wash_share: null, even_share_group_pct: null,
      dev_launches: null, dev_graduated: null, dev_holds_pct: null, token_risk: "clean", transfer_fee_bps: null,
    },
  };
}

/** Map instructions → the target they predict, for the fake Jev (it only sees the question text). */
function sigOf(instr: string): Sig | "setup" | null {
  const s = instr.toLowerCase();
  // Most specific phrase first: an appended hint may mention "pump" or "dump" in passing.
  if (s.includes("setup") || s.includes("direction")) return "direction@168";
  if (/30% (below|lower|drop)|drop 30%|24 ?h/.test(s)) return "drawdown@24>=0.3";
  if (/50% (below|lower|drop)|drop 50%|halve/.test(s)) return "drawdown@168>=0.5";
  if (/double|2x|100%/.test(s)) return "pump@168>=1";
  return null;
}

function fakeJev(seed: number): (state: unknown, qs: Record<string, RubricQuestion>) => Promise<JevResult> {
  const r = rng(seed);
  return async (state, qs) => {
    const x = Number((state as { holders?: { insider_shaped_pct?: number } }).holders?.insider_shaped_pct ?? 30);
    const answers: Record<string, JevAnswer> = {};
    for (const [k, q] of Object.entries(qs)) {
      const sig = sigOf(q.instructions);
      const mode = /insider_shaped_pct/.test(q.instructions) ? "informed" : /contrarian/i.test(q.instructions) ? "inverted" : "blind";
      const tp = sig && sig !== "setup" ? truth(x)[sig] : 0.5;
      const bp = sig && sig !== "setup" ? BASE[sig] : 0.5;
      const noise = (r() - 0.5) * 0.2;
      const p = Math.min(0.98, Math.max(0.02, (mode === "informed" ? tp : mode === "inverted" ? 1 - tp : bp) + noise));
      if (q.type === "noul") answers[k] = { type: "noul", noul: p };
      else if (q.type === "choice") {
        const opts = Object.keys(q.criteria);
        // Direction-shaped choices: put p on the first "up" option and 1-p on the first "down" one.
        const up = opts.find((o) => ["accumulation", "breakout", "up", "bullish"].includes(o)) ?? opts[0];
        const down = opts.find((o) => ["distribution", "dead_cat", "down", "bearish"].includes(o)) ?? opts[1];
        const probabilities = Object.fromEntries(opts.map((o) => [o, o === up ? p : o === down ? 1 - p : 0]));
        answers[k] = { type: "choice", choice: p >= 0.5 ? up : down, probabilities, confidence: Math.max(p, 1 - p) };
      } else answers[k] = { type: "score", score: 2 };
    }
    return { model: "fake-jev", answers, cost_usd: 0.00002, input_tokens: 400 };
  };
}

/** 200 snapshots over 60 days under the champion, with outcomes drawn from the true model. */
async function synthRows(n: number, champion: Rubric, seed = 42): Promise<GradedRow[]> {
  const r = rng(seed);
  const ask = fakeJev(seed * 7 + 1);
  const rows: GradedRow[] = [];
  const t0 = 1_780_000_000;
  for (let i = 0; i < n; i++) {
    const x = r() * 60;
    const t = t0 + Math.floor((i / n) * 60 * 86400);
    const features = synthFeatures(`mint${i}`, t, x, r());
    const p = truth(x);
    const dd24 = r() < p["drawdown@24>=0.3"];
    const dd168 = r() < p["drawdown@168>=0.5"] || (dd24 && r() < 0.5);
    const pump = r() < p["pump@168>=1"];
    const up = r() < p["direction@168"];
    const o = (h: number, ret: number, dd: number, ru: number): QuantOutcome => ({ snapshot_id: i + 1, horizon_h: h, price_usd: 0.001 * (1 + ret), low_usd: 0.001 * (1 - dd), high_usd: 0.001 * (1 + ru), ret, max_drawdown: dd, max_runup: ru, status: "ok" });
    const ans = (await ask({ holders: features.holders }, champion.questions)).answers;
    rows.push({
      snapshot: { id: i + 1, mint: features.mint, t, price_usd: 0.001, rubric_version: champion.version, features, answers: ans, source: "cron" },
      outcomes: {
        24: o(24, dd24 ? -0.35 : 0.05, dd24 ? 0.35 : 0.1, 0.2),
        168: o(168, up ? 0.3 : -0.4, Math.max(dd168 ? 0.55 : 0.2, dd24 ? 0.35 : 0.1), pump ? 1.2 : 0.3),
      },
    });
  }
  return rows;
}

/** A challenger = v1 with every graded question's instructions rewritten by `edit`. */
function variant(edit: (instr: string) => string, notes: string): string {
  const questions = Object.fromEntries(Object.entries(RUBRIC_V1.questions).map(([k, q]) => [k, RUBRIC_V1.targets[k] ? { ...q, instructions: edit(q.instructions) } : q]));
  return "Here is the revised rubric:\n```json\n" + JSON.stringify({ notes, questions, targets: RUBRIC_V1.targets }, null, 1) + "\n```";
}

function memDeps(rows: GradedRow[], claude: ClaudeFn, seed = 99) {
  const saved = { rubrics: [] as Rubric[], grades: 0, replays: 0 };
  const deps: EvolveDeps = {
    loadRows: async () => rows,
    budget: new JevBudget(400, fakeJev(seed)),
    claude,
    childrenSince: async () => [],
    putRubric: async (r) => void saved.rubrics.push(r),
    putGrades: async (g) => void (saved.grades += g.length),
    saveReplays: async (items) => (saved.replays += items.length),
  };
  return { deps, saved };
}

const fixedClaude = (text: string): ClaudeFn => async () => ({ text, cost_usd: 0, input_tokens: 0, output_tokens: 0 });

async function synthetic() {
  console.log("\n=== outcome measurement (pure) ===");
  const snap = { id: 1, t: 1_000_000 * 3600, price_usd: 1 };
  const h = (k: number, o: number, hi: number, l: number, c: number) => ({ t: snap.t + k * 3600, o, h: hi, l, c, v: 1 });
  const path = Array.from({ length: 30 }, (_, k) => h(k - 1, 1, k === 5 ? 1.8 : 1.1, k === 10 ? 0.6 : 0.9, 1.05));
  const now = snap.t + 30 * 3600;
  const ok = measureOutcome(snap, 24, path, { price_usd: 1, mcap_usd: 1, liquidity_usd: 1e4, pair: "p" }, now);
  check("ok path: low/high from candles after the snapshot", ok?.status === "ok" && Math.abs(ok.max_drawdown! - 0.4) < 1e-9 && Math.abs(ok.max_runup! - 0.8) < 1e-9, JSON.stringify(ok));
  const dead = measureOutcome(snap, 24, [], null, now);
  check("dead coin: no candles + no pair = total loss, flagged", dead?.status === "dead" && dead.max_drawdown === 1 && dead.ret === -1);
  const short = measureOutcome(snap, 24, path.slice(0, 5), { price_usd: 0.5, mcap_usd: 1, liquidity_usd: 1e4, pair: "p" }, snap.t + 24 * 3600 + 60);
  check("candles stop short of a current horizon: DexScreener price closes it", short?.status === "dex_price" && short.price_usd === 0.5 && Math.abs(short.max_drawdown! - 0.5) < 1e-9);
  check("failed fetch (null candles) writes nothing", measureOutcome(snap, 24, null, null, now) === null);
  check("horizon not yet elapsed writes nothing", measureOutcome(snap, 168, path, null, now) === null);

  console.log("\n=== synthetic grade (200 snapshots, known-informative feature) ===");
  const rows = await synthRows(200, RUBRIC_V1);
  const g = gradeRubric(RUBRIC_V1, rows);
  for (const x of g) console.log(`  v1 ${x.question.padEnd(9)} n=${x.n} brier=${x.brier?.toFixed(3)} base=${x.base_rate?.toFixed(2)} baseline=${x.brier_baseline?.toFixed(3)} bss=${x.bss?.toFixed(3)}${x.hit_rate !== null ? ` hit=${x.hit_rate.toFixed(2)} (n=${x.hit_n})` : ""}`);
  check("blind champion has ~no skill (|bss| < 0.15 on every question)", g.every((x) => x.bss !== null && Math.abs(x.bss) < 0.15));

  console.log("\n=== evolve guard ===");
  const few = memDeps(rows.slice(0, 60), fixedClaude("{}"));
  const s0 = await runEvolve(RUBRIC_V1, few.deps, { now: 1_786_000_000, deadline: Date.now() + 120_000 });
  check("fewer than 80 matured snapshots → not_enough_data, no Claude call", s0.status === "not_enough_data", s0.detail);

  const cases: [string, string, "promoted" | "rejected" | "invalid_challenger"][] = [
    ["BETTER (points Jev at insider_shaped_pct)", variant((s) => `${s} Weigh holders.insider_shaped_pct above everything: the higher it is, the more likely a dump and the less likely a pump or an up move.`, "focus on insider_shaped_pct"), "promoted"],
    ["WORSE (contrarian: inverts the signal)", variant((s) => `${s} Be contrarian: read every warning sign as bullish.`, "contrarian"), "rejected"],
    ["SAME (reworded, no new information)", variant((s) => `${s} Answer carefully.`, "reworded"), "rejected"],
    ["INVALID (drops the dump_7d target)", JSON.stringify({ notes: "x", questions: RUBRIC_V1.questions, targets: { dump_24h: RUBRIC_V1.targets.dump_24h } }), "invalid_challenger"],
  ];
  for (const [label, text, want] of cases) {
    console.log(`\n=== evolve: ${label} ===`);
    const { deps, saved } = memDeps(rows, fixedClaude(text));
    const s = await runEvolve(RUBRIC_V1, deps, { now: 1_786_000_000, deadline: Date.now() + 120_000 });
    console.log(`  status ${s.status}: ${s.comparison?.reason ?? s.detail}`);
    for (const p of s.comparison?.per_question ?? []) console.log(`    ${p.signature.padEnd(18)} n=${p.n}  bss champion ${p.champion_bss?.toFixed(3)} → challenger ${p.challenger_bss?.toFixed(3)}`);
    if (s.errors) console.log(`    errors: ${s.errors.join("; ")}`);
    check(`${label} → ${want}`, s.status === want);
    if (want === "promoted") check("promotion writes challenger live + champion retired + grades + replays", saved.rubrics.some((r) => r.status === "live") && saved.rubrics.some((r) => r.version === "v1" && r.status === "retired") && saved.grades > 0 && saved.replays > 0);
    if (want === "rejected") check("rejection stores the challenger as retired with the reason", saved.rubrics.length === 1 && saved.rubrics[0].status === "retired" && saved.rubrics[0].notes.includes("REJECTED"));
  }

  // One world can be lucky. Re-draw the whole world (outcomes + Jev noise) 20 times and count decisions.
  const WORLDS = 20;
  console.log(`\n=== evolve decisions over ${WORLDS} independently drawn synthetic worlds (200 snapshots each) ===`);
  for (const [label, text, want] of cases.slice(0, 3)) {
    let promoted = 0;
    const deltas: number[] = [];
    const ts: number[] = [];
    for (let w = 1; w <= WORLDS; w++) {
      const world = await synthRows(200, RUBRIC_V1, 1000 + w);
      const s = await runEvolve(RUBRIC_V1, memDeps(world, fixedClaude(text), 5000 + w).deps, { now: 1_786_000_000, deadline: Date.now() + 120_000 });
      if (s.status === "promoted") promoted++;
      if (s.comparison?.delta != null) deltas.push(s.comparison.delta);
      if (s.comparison?.t_stat != null) ts.push(s.comparison.t_stat);
    }
    deltas.sort((a, b) => a - b);
    console.log(`  ${label.padEnd(44)} promoted ${promoted}/${WORLDS}  skill delta median ${deltas[Math.floor(deltas.length / 2)].toFixed(3)} [min ${deltas[0].toFixed(3)}, max ${deltas.at(-1)!.toFixed(3)}]  paired t median ${ts.sort((a, b) => a - b)[Math.floor(ts.length / 2)].toFixed(1)}`);
    const ok = want === "promoted" ? promoted >= WORLDS * 0.9 : want === "rejected" && label.startsWith("WORSE") ? promoted === 0 : promoted <= WORLDS * 0.1;
    check(`${label}: ${want} in ${want === "promoted" ? "≥90%" : label.startsWith("WORSE") ? "100%" : "≥90%"} of worlds`, ok);
  }

  const { train } = splitByTime(rows);
  const prompt = buildEvolvePrompt(RUBRIC_V1, gradeRubric(RUBRIC_V1, train), train);
  console.log(`\nprompt size: ~${prompt.est_tokens} tokens (cap 30000), ${prompt.rows_shown} rows shown`);
  check("prompt fits the 30k-token cap", prompt.est_tokens <= 30_000);

  if (args.includes("--claude")) {
    console.log("\n=== REAL Claude proposal on the synthetic training slice ===");
    const tc = Date.now();
    const reply = await callClaude(prompt.system, prompt.user, 150_000);
    console.log(`  latency ${((Date.now() - tc) / 1000).toFixed(1)}s`);
    if (!reply) return check("Claude replied", false, lastClaudeError ?? "");
    console.log(`  cost $${reply.cost_usd} · in ${reply.input_tokens} tok · out ${reply.output_tokens} tok`);
    const v = validateRubricBody(extractJson(reply.text), RUBRIC_V1);
    check("Claude's rubric passes strict validation", v.ok, v.ok ? "" : v.errors.join("; "));
    if (!v.ok) console.log(`  reply head: ${reply.text.slice(0, 800)}\n  ...\n  reply tail: ${reply.text.slice(-300)}`);
    const body = extractJson(reply.text) as { notes?: string };
    console.log(`  notes: ${body?.notes}`);
    if (v.ok) {
      console.log(`  mentions insider_shaped_pct: ${JSON.stringify(v.questions).includes("insider_shaped_pct")}`);
      const { deps } = memDeps(rows, fixedClaude(reply.text));
      const s = await runEvolve(RUBRIC_V1, deps, { now: 1_786_000_000, deadline: Date.now() + 120_000 });
      console.log(`  replayed through the fake Jev: ${s.status}: ${s.comparison?.reason ?? s.detail}`);
    }
  }
}

// ── Real 3-coin dry run ──────────────────────────────────────────────────────────────────────────

async function real() {
  console.log("\n=== REAL snapshot step, 3 coins ===");
  if (!db()) return check("SUPABASE env present", false);
  const ready = await quantTablesReady();
  const dryRun = !(ready.tables && args.includes("--write"));
  console.log(`quant tables ${ready.tables ? `exist${ready.status_column ? "" : " (quant_outcomes.status missing: re-run schema.sql)"}` : "MISSING (schema.sql not run)"} → ${dryRun ? "DRY RUN, nothing written" : "writing"}`);
  const now = Math.floor(Date.now() / 1000);
  const mints = (await recentScanMints(now - 3 * 86400, 60)).filter((m) => !m.startsWith("0x"));
  const book = new CandleBook();
  const budget = new JevBudget();
  const t0 = Date.now();
  const s = await runSnapshots({ now, deadline: Date.now() + 90_000, book, budget, rubrics: [RUBRIC_V1], mints, maxCoins: 3, dryRun });
  const { previews, ...rest } = s;
  console.log(`summary: ${JSON.stringify(rest)}  (${Date.now() - t0}ms)`);
  console.log(`jev: ${JSON.stringify(budget.summary())}`);
  for (const p of previews) {
    console.log(`\n  $${p.symbol} ${p.mint}\n    price $${p.price_usd}  candles ${p.candles}  chart ${p.chart ? "yes" : "null (stub or too young)"}  → would store under ${p.rubric}${p.id ? ` as #${p.id}` : ""}`);
    for (const [q, a] of Object.entries(p.answers)) console.log(`    ${q.padEnd(13)} ${a.type === "noul" ? `P=${a.noul}` : a.type === "choice" ? `${a.choice} ${JSON.stringify(a.probabilities)}` : `score ${a.score}`}`);
    // What the outcome step would measure, pretending this coin had been snapshotted 24h ago at that hour's close.
    const candles = await book.candles("solana", p.mint, null);
    const past = candles?.filter((c) => c.t <= now - 24 * 3600).at(-1);
    if (past) {
      const o = measureOutcome({ id: 0, t: past.t + 3600, price_usd: past.c }, 24, candles, { price_usd: p.price_usd, mcap_usd: null, liquidity_usd: 1e5, pair: null }, now);
      console.log(`    outcome if snapshotted 24h ago @ $${past.c}: ${o ? `ret ${(o.ret! * 100).toFixed(1)}%  maxDD ${(o.max_drawdown! * 100).toFixed(1)}%  runup ${(o.max_runup! * 100).toFixed(1)}%  [${o.status}]` : "n/a"}`);
    }
  }
  check("3 coins judged by Jev", previews.length === 3);
  console.log(`GeckoTerminal calls: ${book.gtCalls}`);

}

(async () => {
  if (only !== "real") await synthetic();
  if (only !== "synthetic") await real();
  console.log(`\n${failures ? `${failures} FAILED` : "all checks passed"}`);
  process.exit(failures ? 1 : 0);
})();
