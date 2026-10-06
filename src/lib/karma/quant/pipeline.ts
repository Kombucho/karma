import { JevBudget } from "./budget";
import { callClaude, runEvolve, type EvolveSummary } from "./evolve";
import { runLedger, type LedgerRunSummary } from "./ledger";
import { gradeRubric, toStored } from "./grade";
import { CandleBook } from "./market";
import { runOutcomes, type OutcomeRunSummary } from "./outcomes";
import { runSnapshots, type SnapshotRunSummary } from "./snapshot";
import { childrenSince, ensureSeedRubric, loadGradedRows, putGrades, putRubric, rubricsByStatus, saveReplays } from "./store";
import type { Rubric } from "./types";

/**
 * The daily quant run, step by step (what /api/cron/quant calls):
 *   a. seed v1 if the rubric table is empty
 *   b. snapshot ~30 coins under the live rubric and every shadow rubric
 *   c. measure outcomes for elapsed horizons
 *   d. grade live + shadow rubrics
 *   e. Sundays (UTC) only: evolve a challenger from the live rubric
 *
 * Wall-clock phases keep the whole run under Vercel's 300s ceiling. GeckoTerminal pacing (~2.1s per
 * call) is the binding constraint, so snapshots and outcomes each get a fixed slice. The evolve step
 * uses no GeckoTerminal at all (DB + Claude + Jev), so on Sundays it runs CONCURRENTLY with b–d from
 * the start: the ~1–2 min Claude call overlaps the paced candle fetches instead of queueing behind
 * them. It works on outcomes measured up to yesterday, which is what "held out" needs anyway.
 * Candles fetched by the snapshot step are reused by the outcome step (same CandleBook).
 */

export const DEADLINE_MS = 260_000;
const PHASE = { snapshot: 120_000, outcomes: 245_000 };

export interface GradeRunSummary {
  version: string;
  status: Rubric["status"];
  snapshots: number;
  questions: { question: string; n: number; brier: number | null; bss: number | null; hit_rate: number | null }[];
}

/** d. Grade every live and shadow rubric on all its snapshots with outcomes, and store the grades. */
export async function runGrades(opts: { dryRun?: boolean } = {}): Promise<GradeRunSummary[]> {
  const rubrics = [...(await rubricsByStatus("live")), ...(await rubricsByStatus("shadow"))];
  const out: GradeRunSummary[] = [];
  for (const r of rubrics) {
    const rows = await loadGradedRows(r.version);
    const grades = gradeRubric(r, rows);
    if (!opts.dryRun) await putGrades(grades.filter((g) => g.n > 0).map(toStored));
    out.push({
      version: r.version,
      status: r.status,
      snapshots: rows.length,
      questions: grades.map((g) => ({ question: g.question, n: g.n, brier: round(g.brier), bss: round(g.bss), hit_rate: round(g.hit_rate) })),
    });
  }
  return out;
}

const round = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

export interface QuantRunSummary {
  started_at: string;
  sunday: boolean;
  live: string;
  shadows: string[];
  snapshot: Omit<SnapshotRunSummary, "previews"> | { error: string };
  outcomes: OutcomeRunSummary | { error: string };
  grades: GradeRunSummary[] | { error: string };
  /** Jev's ledger: chart-read calls resolved against price, scorecard rescored. */
  ledger: LedgerRunSummary | { error: string };
  evolve: EvolveSummary | { status: "skipped"; detail: string } | { error: string };
  jev: ReturnType<JevBudget["summary"]>;
  gt_calls: number;
  elapsed_ms: number;
  deadline_hit: boolean;
}

async function step<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function runQuant(opts: { forceEvolve?: boolean; skipEvolve?: boolean } = {}): Promise<QuantRunSummary> {
  const t0 = Date.now();
  const now = Math.floor(t0 / 1000);
  const deadline = t0 + DEADLINE_MS;
  const sunday = new Date(t0).getUTCDay() === 0;
  const evolveToday = !opts.skipEvolve && (sunday || !!opts.forceEvolve);
  const book = new CandleBook();
  const budget = new JevBudget();

  await ensureSeedRubric();
  const live = (await rubricsByStatus("live"))[0];
  const shadows = await rubricsByStatus("shadow");

  const evolving = evolveToday
    ? step(() =>
        runEvolve(live, { loadRows: (v) => loadGradedRows(v, { features: true, excludeReplay: true }), budget, claude: callClaude, childrenSince, putRubric, putGrades, saveReplays }, { now, deadline, force: opts.forceEvolve }),
      )
    : Promise.resolve({ status: "skipped" as const, detail: "evolve runs on Sundays (UTC)" });

  const snapshot = await step(async () => {
    const { previews, ...rest } = await runSnapshots({ now, deadline: t0 + PHASE.snapshot, book, budget, rubrics: [live, ...shadows] });
    void previews;
    return rest;
  });
  const outcomes = await step(() => runOutcomes({ now, deadline: t0 + PHASE.outcomes, book }));
  const grades = await step(() => runGrades());
  const ledger = await step(() => runLedger({ now, deadline, book }));
  const evolve = await evolving;

  return {
    started_at: new Date(t0).toISOString(),
    sunday,
    live: live.version,
    shadows: shadows.map((s) => s.version),
    snapshot,
    outcomes,
    grades,
    ledger,
    evolve,
    jev: budget.summary(),
    gt_calls: book.gtCalls,
    elapsed_ms: Date.now() - t0,
    deadline_hit: Date.now() > deadline,
  };
}
