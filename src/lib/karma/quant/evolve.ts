import type { JevBudget } from "./budget";
import { gradeQuestion, gradeRubric, meanSkill, probFor, eventFor, targetSignature, toStored, type Grade } from "./grade";
import { jevState } from "./jev";
import { HORIZONS_H } from "./outcomes";
import type { GradedRow, QuantGrade } from "./store";
import type { JevAnswer, QuantOutcome, QuantSnapshot, QuantTarget, Rubric, RubricQuestion } from "./types";

/**
 * EVOLVE: the weekly challenger. Out-of-sample by construction:
 *
 *   matured snapshots of the live rubric, sorted by time
 *   ├── OLDER 60%  "training": Claude sees the rubric's grades here + a table of its worst misses
 *   └── NEWER 40%  "held out": Claude never sees it. The challenger is replayed on these snapshots'
 *                  stored features, and both rubrics are graded on exactly the same rows.
 *
 * Promotion rule: mean Brier skill (over the champion's graded targets) must beat the champion's by
 * ≥ PROMOTE_MARGIN with a paired t ≥ MIN_T, and ≥ MIN_HELDOUT_N held-out outcomes on every compared
 * question. Anything else
 * is stored as "retired" with the reason in its notes. The time split matters: a random split would
 * let Claude tune to the same market regime it's tested on.
 *
 * Cost of one run: Claude sonnet-5 at $2/M in, $10/M out; prompt capped at ~30k tokens (≤ $0.06) and
 * output at 8k tokens (≤ $0.08) → ≤ ~$0.14 worst case; measured on the 200-row synthetic set: ~10k in,
 * ~3–5k out, ~$0.05–0.07. Replay ≤ JevBudget.left calls at ~$0.00003.
 */

export const EVOLVE_MIN_MATURED = 80;
export const HOLDOUT_FRACTION = 0.4;
export const PROMOTE_MARGIN = 0.02;
export const MIN_HELDOUT_N = 40;
/**
 * The skill margin alone is not enough at these sample sizes: in the synthetic check, a challenger
 * that changes nothing clears a 0.02 margin in ~15% of worlds on 80 held-out rows (pure noise). So the
 * improvement must also be consistent row by row: a paired t-statistic on the per-snapshot Brier
 * improvement (in skill units) of at least MIN_T (≈ one-sided p < 0.025).
 */
export const MIN_T = 2;
export const CLAUDE_MODEL = "anthropic/claude-sonnet-5";
export const MAX_PROMPT_TOKENS = 30_000;
const MAX_OUTPUT_TOKENS = 8_000;
const MAX_QUESTIONS = 12;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

// ── Data prep ─────────────────────────────────────────────────────────────────────────────────────

/** Horizons a rubric's targets are graded at. */
export function rubricHorizons(r: Rubric): number[] {
  return [...new Set(Object.values(r.targets).map((t) => t.horizon_h))];
}

/** Rows usable for evolving: features stored, and an outcome at every horizon the rubric grades. */
export function maturedRows(rubric: Rubric, rows: GradedRow[]): GradedRow[] {
  const hs = rubricHorizons(rubric);
  return rows.filter((r) => r.snapshot.features && hs.every((h) => r.outcomes[h]));
}

/** Oldest (1 − holdout) for training, newest `holdout` held out. */
export function splitByTime<T extends GradedRow>(rows: T[], holdout = HOLDOUT_FRACTION): { train: T[]; held: T[] } {
  const sorted = [...rows].sort((a, b) => a.snapshot.t - b.snapshot.t || (a.snapshot.id ?? 0) - (b.snapshot.id ?? 0));
  const cut = Math.round(sorted.length * (1 - holdout));
  return { train: sorted.slice(0, cut), held: sorted.slice(cut) };
}

/** Per-row squared error summed over the graded questions: the "how wrong was it" ranking. */
export function rowLoss(rubric: Rubric, row: GradedRow): number {
  let loss = 0;
  for (const [q, t] of Object.entries(rubric.targets)) {
    const y = eventFor(t, row.outcomes[t.horizon_h]);
    const p = probFor(t, row.snapshot.answers[q]);
    if (y !== null && p !== null) loss += (p - y) ** 2;
  }
  return loss;
}

/** Flatten what Jev saw (jevState) to dotted keys: coin.age_hours, chart.rsi14, holders.top10_pct … */
export function flatState(row: GradedRow): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  const walk = (o: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v as Record<string, unknown>, `${prefix}${k}.`);
      else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[`${prefix}${k}`] = v;
    }
  };
  walk(jevState(row.snapshot.features), "");
  delete out["coin.symbol"];
  return out;
}

const fmt = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toPrecision(3)).toString();
  return String(v).replace(/[,\n]/g, " ");
};

/** The misses table: features Jev saw, its answers on graded questions, the realised outcomes. CSV. */
export function missesTable(rubric: Rubric, rows: GradedRow[]): string {
  const flats = rows.map(flatState);
  const counts = new Map<string, number>();
  for (const f of flats) for (const k of Object.keys(f)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const featCols = [...counts.entries()].filter(([, n]) => n >= rows.length * 0.2).map(([k]) => k).sort();
  const qs = Object.keys(rubric.targets).filter((q) => rubric.questions[q]);
  const hs = rubricHorizons(rubric).sort((a, b) => a - b);
  const header = ["loss", ...featCols, ...qs.map((q) => `ans.${q}`), ...hs.flatMap((h) => [`ret_${h}h`, `maxdd_${h}h`, `runup_${h}h`])];
  const lines = [header.join(",")];
  rows.forEach((r, i) => {
    const ans = qs.map((q) => {
      const a = r.snapshot.answers[q];
      const t = rubric.targets[q];
      if (!a) return "";
      if (t.kind === "direction") return `${a.choice ?? ""}${probFor(t, a) !== null ? `:pup=${fmt(probFor(t, a))}` : ""}`;
      return fmt(a.noul);
    });
    const outs = hs.flatMap((h) => {
      const o = r.outcomes[h];
      return [fmt(o?.ret), fmt(o?.max_drawdown), fmt(o?.max_runup)];
    });
    lines.push([fmt(rowLoss(rubric, r)), ...featCols.map((k) => fmt(flats[i][k])), ...ans, ...outs].join(","));
  });
  return lines.join("\n");
}

// ── Prompt ────────────────────────────────────────────────────────────────────────────────────────

const GLOSSARY = `State fields Jev sees (numbers computed in code from 1h candles and on-chain holder scans):
coin: age_hours, mcap_usd, liquidity_usd.
chart (null when <~50 hourly candles): candles, rsi14, macd_hist, macd_cross (bull|bear|none), bb_pos (0=lower band,1=upper), bb_width (band width/mid), ema20_vs_ema50 ((ema20-ema50)/ema50), atr_pct (ATR14/close), roc_24h / roc_6h (% change), drawdown_from_high (0..1 below window high), range_pos (0=window low,1=high), vol_z (last 6h volume vs trailing mean, std devs), obv_slope, vwap_dist ((close-VWAP24h)/VWAP24h), stoch_rsi, higher_lows (last 3 swing lows rising).
holders: verdict (clean|caution|coordinated|danger), top10_pct, holder_count, insider_shaped_pct, sniper_pct, connected_pct (wallets sharing a funder), ecosystem_only_pct, reward_only_pct, crowd_manufactured (0..1), fresh_flow_severity (alert|warn|none), fresh_net_sol_1h, sibling_verdict (cabal|linked|none), lp_pullable_share, wash_share, even_share_group_pct, dev_launches, dev_graduated, dev_holds_pct, token_risk (clean|caution|danger), transfer_fee_bps.
Fields absent from a row were null (lens didn't run).`;

const SYSTEM = `You improve the rubric that a small judgment model ("Jev", TypeSafe jev-1.13) runs on memecoins.
Jev reads a JSON state and answers typed questions: "noul" returns a calibrated probability (0..1) that the instruction is true; "choice" picks one option from criteria (with probabilities); "score" picks a point on an ordered list. Jev does not do arithmetic, only judgment against the literal wording, so thresholds should be stated plainly and criteria must refer to state fields by name. Irrelevant context lowers its accuracy. One judgment per question.
Each graded question has a target that code scores against realised prices (Brier score; skill = 1 - brier/brier_of_base_rate). Your goal: a revised rubric whose graded questions have higher Brier skill out of sample. Prefer instructions that point Jev at the fields that actually separated the misses from the hits; do not overfit single rows.
Reply with ONE JSON object and nothing else: {"notes": string (what you changed and why, <= 800 chars), "questions": {...}, "targets": {...}}.
Question shapes: {"type":"noul","instructions":string,"criteria"?:{"true":string,"false":string}} | {"type":"choice","instructions":string,"criteria":{option_key:string,...}} | {"type":"score","instructions":string,"criteria":[string,...]}.
Target shapes: {"kind":"drawdown","horizon_h":24|168,"threshold":number} (noul: low within horizon <= price*(1-threshold)) | {"kind":"pump","horizon_h":24|168,"threshold":number} (noul: high >= price*(1+threshold)) | {"kind":"direction","horizon_h":24|168,"up":[option keys],"down":[option keys]} (choice).
Rules: keys lowercase snake_case; at most ${MAX_QUESTIONS} questions; you may add, remove or reword questions, but EVERY current target (same kind, horizon_h and threshold) must still exist on some question so the versions stay comparable; the question keys may change.
Be terse: instructions <= 350 characters, each criterion <= 180 characters, the whole JSON under ~2500 tokens. Jev is small; long criteria dilute it.`;

export interface EvolvePrompt {
  system: string;
  user: string;
  est_tokens: number;
  rows_shown: number;
}

const estTokens = (s: string) => Math.ceil(s.length / 3.2); // CSV of numbers tokenizes worse than prose

/** Build the Claude prompt, trimming the misses table until the whole call fits MAX_PROMPT_TOKENS. */
export function buildEvolvePrompt(rubric: Rubric, trainGrades: Grade[], train: GradedRow[], maxTokens = MAX_PROMPT_TOKENS): EvolvePrompt {
  const ranked = train.map((r) => ({ r, loss: rowLoss(rubric, r) })).sort((a, b) => b.loss - a.loss);
  const worst = ranked.slice(0, 60).map((x) => x.r);
  const best = ranked.slice(-20).reverse().map((x) => x.r);
  const gradesText = JSON.stringify(
    trainGrades.map((g) => ({ question: g.question, target: rubric.targets[g.question], n: g.n, brier: r4(g.brier), base_rate: r4(g.base_rate), baseline: r4(g.brier_baseline), skill: r4(g.bss), hit_rate: r4(g.hit_rate), calibration: g.calibration?.map((c) => ({ ...c, predicted: r4(c.predicted), actual: r4(c.actual) })) })),
  );
  const body = (w: GradedRow[], b: GradedRow[]) =>
    [
      `CURRENT RUBRIC (${rubric.version}):`,
      JSON.stringify({ questions: rubric.questions, targets: rubric.targets }),
      `\nGRADES ON THE TRAINING SLICE (${train.length} snapshots):`,
      gradesText,
      `\n${GLOSSARY}`,
      `\nWORST MISSES (${w.length} rows, highest summed squared error first; ans.* = Jev's answers; ret/maxdd/runup = realised path, fractions):`,
      missesTable(rubric, w),
      `\nBEST CALLS for contrast (${b.length} rows):`,
      missesTable(rubric, b),
      `\nWrite the revised rubric JSON now.`,
    ].join("\n");
  let w = worst;
  let b = best;
  let user = body(w, b);
  while (estTokens(SYSTEM + user) > maxTokens && (w.length > 10 || b.length > 0)) {
    if (b.length > 5) b = b.slice(0, b.length - 5);
    else if (w.length > 10) w = w.slice(0, w.length - 5);
    else b = [];
    user = body(w, b);
  }
  return { system: SYSTEM, user, est_tokens: estTokens(SYSTEM + user), rows_shown: w.length + b.length };
}

const r4 = (x: number | null) => (x === null ? null : Math.round(x * 1e4) / 1e4);

// ── Validation ────────────────────────────────────────────────────────────────────────────────────

const str = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

/** Strictly validate a proposed {questions, targets} body. Returns a clean copy or the list of problems. */
export function validateRubricBody(body: unknown, champion: Rubric): { ok: true; questions: Record<string, RubricQuestion>; targets: Record<string, QuantTarget> } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!body || typeof body !== "object") return { ok: false, errors: ["not an object"] };
  const { questions: qIn, targets: tIn } = body as { questions?: unknown; targets?: unknown };
  if (!qIn || typeof qIn !== "object" || Array.isArray(qIn)) return { ok: false, errors: ["questions missing"] };
  if (!tIn || typeof tIn !== "object" || Array.isArray(tIn)) return { ok: false, errors: ["targets missing"] };

  const questions: Record<string, RubricQuestion> = {};
  const qEntries = Object.entries(qIn as Record<string, unknown>);
  if (!qEntries.length || qEntries.length > MAX_QUESTIONS) errors.push(`question count ${qEntries.length} not in 1..${MAX_QUESTIONS}`);
  for (const [k, raw] of qEntries) {
    const q = raw as Record<string, unknown>;
    if (!KEY_RE.test(k)) errors.push(`bad question key "${k}"`);
    if (!q || typeof q !== "object") {
      errors.push(`${k}: not an object`);
      continue;
    }
    if (!str(q.instructions, 800)) errors.push(`${k}: instructions missing or > 800 chars`);
    const instructions = String(q.instructions ?? "").trim();
    if (q.type === "noul") {
      const c = q.criteria as Record<string, unknown> | undefined;
      if (c !== undefined && (!c || !str(c.true, 400) || !str(c.false, 400))) errors.push(`${k}: noul criteria must be {true,false} strings`);
      questions[k] = c ? { type: "noul", instructions, criteria: { true: String(c.true), false: String(c.false) } } : { type: "noul", instructions };
    } else if (q.type === "choice") {
      const c = q.criteria as Record<string, unknown> | undefined;
      const opts = c && typeof c === "object" && !Array.isArray(c) ? Object.entries(c) : [];
      if (opts.length < 2 || opts.length > 8) errors.push(`${k}: choice needs 2..8 options`);
      for (const [ok, ov] of opts) {
        if (!KEY_RE.test(ok)) errors.push(`${k}: bad option key "${ok}"`);
        if (!str(ov, 400)) errors.push(`${k}.${ok}: option text missing or > 400 chars`);
      }
      questions[k] = { type: "choice", instructions, criteria: Object.fromEntries(opts.map(([ok, ov]) => [ok, String(ov)])) };
    } else if (q.type === "score") {
      const c = q.criteria;
      if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every((x) => str(x, 400))) errors.push(`${k}: score criteria must be 2..10 strings`);
      questions[k] = { type: "score", instructions, criteria: Array.isArray(c) ? c.map(String) : [] };
    } else errors.push(`${k}: unknown type ${String(q.type)}`);
  }

  const targets: Record<string, QuantTarget> = {};
  for (const [k, raw] of Object.entries(tIn as Record<string, unknown>)) {
    const t = raw as Record<string, unknown>;
    const q = questions[k];
    if (!q) {
      errors.push(`target ${k}: no such question`);
      continue;
    }
    const h = Number(t?.horizon_h);
    if (!(HORIZONS_H as readonly number[]).includes(h)) errors.push(`target ${k}: horizon_h must be one of ${HORIZONS_H.join("/")}`);
    if (t?.kind === "drawdown" || t?.kind === "pump") {
      const th = Number(t.threshold);
      if (q.type !== "noul") errors.push(`target ${k}: ${t.kind} needs a noul question`);
      if (!(th > 0 && th <= (t.kind === "drawdown" ? 1 : 20))) errors.push(`target ${k}: threshold out of range`);
      targets[k] = { kind: t.kind, horizon_h: h, threshold: th };
    } else if (t?.kind === "direction") {
      const up = Array.isArray(t.up) ? t.up.map(String) : [];
      const down = Array.isArray(t.down) ? t.down.map(String) : [];
      if (q.type !== "choice") errors.push(`target ${k}: direction needs a choice question`);
      else {
        const opts = Object.keys(q.criteria);
        if (!up.length || !down.length) errors.push(`target ${k}: up and down must be non-empty`);
        if ([...up, ...down].some((o) => !opts.includes(o))) errors.push(`target ${k}: up/down must be option keys of ${k}`);
        if (up.some((o) => down.includes(o))) errors.push(`target ${k}: up and down overlap`);
      }
      targets[k] = { kind: "direction", horizon_h: h, up, down };
    } else errors.push(`target ${k}: unknown kind ${String(t?.kind)}`);
  }

  const have = new Set(Object.values(targets).map(targetSignature));
  for (const [q, t] of Object.entries(champion.targets)) if (!have.has(targetSignature(t))) errors.push(`champion target ${q} (${targetSignature(t)}) has no comparable challenger target`);

  return errors.length ? { ok: false, errors } : { ok: true, questions, targets };
}

/** Pull the JSON object out of Claude's reply (tolerates code fences / stray prose around it). */
export function extractJson(text: string): unknown {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** Next version name: v1 → v2-2026-09-27. */
export function nextVersion(champion: Rubric, now: number): string {
  const n = Number(/^v(\d+)/.exec(champion.version)?.[1] ?? 1);
  return `v${n + 1}-${new Date(now * 1000).toISOString().slice(0, 10)}`;
}

// ── Held-out comparison ──────────────────────────────────────────────────────────────────────────

export interface QuestionComparison {
  signature: string;
  champion_q: string;
  challenger_q: string;
  n: number;
  champion: Grade;
  challenger: Grade;
}

export interface Comparison {
  promote: boolean;
  reason: string;
  champion_skill: number | null;
  challenger_skill: number | null;
  delta: number | null;
  /** Paired t-statistic of the per-snapshot improvement (positive = challenger better). */
  t_stat: number | null;
  per_question: QuestionComparison[];
}

/**
 * Grade champion (its stored answers) and challenger (replayed answers) on the same held-out rows:
 * per champion target, only rows where BOTH answered and the outcome is known.
 */
export function compareOnHoldout(
  champion: Rubric,
  challenger: Rubric,
  held: GradedRow[],
  challengerAnswers: Map<number, Record<string, JevAnswer>>,
  opts: { margin?: number; minN?: number; minT?: number } = {},
): Comparison {
  const minT = opts.minT ?? MIN_T;
  const rowsOf = new Map<string, GradedRow[]>();
  const margin = opts.margin ?? PROMOTE_MARGIN;
  const minN = opts.minN ?? MIN_HELDOUT_N;
  const bySig = new Map(Object.entries(challenger.targets).map(([q, t]) => [targetSignature(t), q]));
  const per: QuestionComparison[] = [];
  for (const [cq, ct] of Object.entries(champion.targets)) {
    const sig = targetSignature(ct);
    const xq = bySig.get(sig);
    if (!xq) continue;
    const xt = challenger.targets[xq];
    const rows = held.filter((r) => {
      const ca = probFor(ct, r.snapshot.answers[cq]);
      const xa = probFor(xt, challengerAnswers.get(r.snapshot.id!)?.[xq]);
      return ca !== null && xa !== null && eventFor(ct, r.outcomes[ct.horizon_h]) !== null;
    });
    rowsOf.set(sig, rows);
    per.push({
      signature: sig,
      champion_q: cq,
      challenger_q: xq,
      n: rows.length,
      champion: gradeQuestion(champion.version, cq, ct, rows),
      challenger: gradeQuestion(challenger.version, xq, xt, rows, (r) => challengerAnswers.get(r.snapshot.id!)),
    });
  }
  const both = per.filter((p) => p.champion.bss !== null && p.challenger.bss !== null);
  const cs = meanSkill(both.map((p) => p.champion));
  const xs = meanSkill(both.map((p) => p.challenger));
  const delta = cs !== null && xs !== null ? xs - cs : null;

  // Per-snapshot improvement in skill units, averaged over the compared questions: its mean is the
  // skill delta (exactly, when every row counts for every question), its spread gives the t-stat.
  const contrib = new Map<number, number>();
  for (const p of both) {
    const ct = champion.targets[p.champion_q];
    const xt = challenger.targets[p.challenger_q];
    const b = p.champion.brier_baseline!;
    for (const r of rowsOf.get(p.signature)!) {
      const y = eventFor(ct, r.outcomes[ct.horizon_h])!;
      const pc = probFor(ct, r.snapshot.answers[p.champion_q])!;
      const px = probFor(xt, challengerAnswers.get(r.snapshot.id!)?.[p.challenger_q])!;
      contrib.set(r.snapshot.id!, (contrib.get(r.snapshot.id!) ?? 0) + ((pc - y) ** 2 - (px - y) ** 2) / b / both.length);
    }
  }
  const cv = [...contrib.values()];
  const mean = cv.reduce((s, x) => s + x, 0) / (cv.length || 1);
  const sd = Math.sqrt(cv.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, cv.length - 1));
  const t_stat = cv.length > 2 && sd > 0 ? mean / (sd / Math.sqrt(cv.length)) : null;
  const thin = per.filter((p) => p.n < minN);
  let promote = false;
  let reason: string;
  if (!per.length) reason = "no comparable targets";
  else if (thin.length) reason = `too few held-out outcomes: ${thin.map((p) => `${p.signature} n=${p.n}`).join(", ")} (need ${minN})`;
  else if (delta === null) reason = "skill undefined (held-out outcomes all identical)";
  else if (delta < margin) reason = `mean skill ${fmt(xs)} vs champion ${fmt(cs)}: delta ${fmt(delta)} < margin ${margin} (t ${fmt(t_stat)})`;
  else if (t_stat === null || t_stat < minT) reason = `mean skill ${fmt(xs)} vs champion ${fmt(cs)}: delta ${fmt(delta)} clears the margin but paired t ${fmt(t_stat)} < ${minT} (not consistent enough across snapshots)`;
  else {
    promote = true;
    reason = `mean skill ${fmt(xs)} vs champion ${fmt(cs)}: delta ${fmt(delta)} ≥ margin ${margin}, paired t ${fmt(t_stat)} ≥ ${minT}`;
  }
  return { promote, reason, champion_skill: cs, challenger_skill: xs, delta, t_stat, per_question: per };
}

// ── Claude ────────────────────────────────────────────────────────────────────────────────────────

export interface ClaudeReply {
  text: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}
export type ClaudeFn = (system: string, user: string, timeoutMs: number) => Promise<ClaudeReply | null>;

/** Why the last callClaude returned null (for the run summary / check script). */
export let lastClaudeError: string | null = null;

/** One OpenRouter chat completion (same JEV_API_KEY: it's an OpenRouter key). Null on any failure. */
export const callClaude: ClaudeFn = async (system, user, timeoutMs) => {
  const key = process.env.JEV_API_KEY;
  lastClaudeError = key ? null : "JEV_API_KEY not set";
  if (!key) return null;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Karma" },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: 0.3,
        usage: { include: true },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      lastClaudeError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      return null;
    }
    const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number; prompt_tokens?: number; completion_tokens?: number } };
    const text = j.choices?.[0]?.message?.content;
    if (!text) {
      lastClaudeError = "empty completion";
      return null;
    }
    return { text, cost_usd: j.usage?.cost ?? null, input_tokens: j.usage?.prompt_tokens ?? null, output_tokens: j.usage?.completion_tokens ?? null };
  } catch (e) {
    lastClaudeError = e instanceof Error ? e.message : String(e);
    return null;
  }
};

// ── Orchestration ─────────────────────────────────────────────────────────────────────────────────

export interface EvolveDeps {
  loadRows: (version: string) => Promise<GradedRow[]>;
  budget: JevBudget;
  claude: ClaudeFn;
  childrenSince: (parent: string, since: number) => Promise<string[]>;
  putRubric: (r: Rubric) => Promise<void>;
  putGrades: (g: QuantGrade[]) => Promise<void>;
  saveReplays: (items: { snapshot: QuantSnapshot; outcomes: QuantOutcome[] }[]) => Promise<number>;
}

export interface EvolveSummary {
  status: "not_enough_data" | "already_ran" | "claude_failed" | "invalid_challenger" | "promoted" | "rejected";
  detail: string;
  matured?: number;
  train?: number;
  held?: number;
  challenger?: string;
  prompt_tokens_est?: number;
  claude_cost_usd?: number | null;
  replayed?: number;
  comparison?: Omit<Comparison, "per_question"> & { per_question: { signature: string; n: number; champion_bss: number | null; challenger_bss: number | null; champion_brier: number | null; challenger_brier: number | null }[] };
  errors?: string[];
}

/** Run a pool of async jobs with bounded concurrency, stopping new ones past the deadline. */
async function pool<T>(items: T[], n: number, deadline: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && Date.now() < deadline) await fn(items[i++]);
    }),
  );
}

export async function runEvolve(champion: Rubric, deps: EvolveDeps, opts: { now: number; deadline: number; dryRun?: boolean; force?: boolean }): Promise<EvolveSummary> {
  const { now, deadline } = opts;
  const rows = maturedRows(champion, await deps.loadRows(champion.version));
  if (rows.length < EVOLVE_MIN_MATURED) return { status: "not_enough_data", detail: `${rows.length} matured snapshots of ${champion.version}, need ${EVOLVE_MIN_MATURED}`, matured: rows.length };
  if (!opts.force) {
    const kids = await deps.childrenSince(champion.version, now - 6 * 86400);
    if (kids.length) return { status: "already_ran", detail: `challenger ${kids.join(", ")} already generated from ${champion.version} this week`, matured: rows.length };
  }

  const { train, held } = splitByTime(rows);
  const trainGrades = gradeRubric(champion, train);
  const prompt = buildEvolvePrompt(champion, trainGrades, train);
  const base = { matured: rows.length, train: train.length, held: held.length, prompt_tokens_est: prompt.est_tokens };

  const timeout = Math.min(150_000, deadline - Date.now() - 20_000);
  if (timeout < 30_000) return { ...base, status: "claude_failed", detail: "not enough time left in the run for the Claude call" };
  const reply = await deps.claude(prompt.system, prompt.user, timeout);
  if (!reply) return { ...base, status: "claude_failed", detail: `Claude call failed: ${lastClaudeError ?? "unknown"}` };

  const body = extractJson(reply.text);
  const v = validateRubricBody(body, champion);
  const version = nextVersion(champion, now);
  const claudeNotes = typeof (body as { notes?: unknown })?.notes === "string" ? String((body as { notes: string }).notes).slice(0, 1200) : "";
  if (!v.ok) {
    return { ...base, status: "invalid_challenger", detail: `Claude's rubric failed validation (${v.errors.length} problems)`, errors: v.errors.slice(0, 20), claude_cost_usd: reply.cost_usd };
  }

  const challenger: Rubric = { version, parent: champion.version, status: "shadow", created_at: new Date(now * 1000).toISOString(), notes: claudeNotes, questions: v.questions, targets: v.targets };

  // Replay the challenger on the held-out snapshots' stored features.
  const answers = new Map<number, Record<string, JevAnswer>>();
  await pool(held, 6, deadline - 10_000, async (r) => {
    const res = await deps.budget.call(jevState(r.snapshot.features), challenger.questions);
    if (res) answers.set(r.snapshot.id!, res.answers);
  });

  const cmp = compareOnHoldout(champion, challenger, held, answers);
  const heldGrades = gradeRubric(challenger, held.filter((r) => answers.has(r.snapshot.id!)), (r) => answers.get(r.snapshot.id!));
  const stamp = new Date(now * 1000).toISOString().slice(0, 10);
  const log =
    `[evolve ${stamp}] from ${champion.version}; train ${train.length} / held-out ${held.length} (time split ${1 - HOLDOUT_FRACTION}/${HOLDOUT_FRACTION}); replayed ${answers.size}. ` +
    `${cmp.promote ? "PROMOTED" : "REJECTED"}: ${cmp.reason}. Per target: ` +
    cmp.per_question.map((p) => `${p.signature} n=${p.n} bss ${fmt(p.champion.bss)}→${fmt(p.challenger.bss)}`).join("; ") +
    `. Claude cost $${fmt(reply.cost_usd)}.`;
  challenger.status = cmp.promote ? "live" : "retired";
  challenger.notes = `${claudeNotes}\n\n${log}`.trim();

  if (!opts.dryRun) {
    await deps.putRubric(challenger);
    if (cmp.promote) await deps.putRubric({ ...champion, status: "retired", notes: `${champion.notes}\n\n[retired ${stamp}] beaten by ${version}: ${cmp.reason}` });
    await deps.putGrades(heldGrades.map(toStored));
    await deps.saveReplays(
      held
        .filter((r) => answers.has(r.snapshot.id!))
        .map((r) => ({
          snapshot: { ...r.snapshot, id: undefined, rubric_version: version, answers: answers.get(r.snapshot.id!)!, source: "replay" as const },
          outcomes: Object.values(r.outcomes).map((o) => ({ ...o })),
        })),
    );
  }

  return {
    ...base,
    status: cmp.promote ? "promoted" : "rejected",
    detail: log,
    challenger: version,
    claude_cost_usd: reply.cost_usd,
    replayed: answers.size,
    comparison: {
      promote: cmp.promote,
      reason: cmp.reason,
      champion_skill: cmp.champion_skill,
      challenger_skill: cmp.challenger_skill,
      delta: cmp.delta,
      t_stat: cmp.t_stat,
      per_question: cmp.per_question.map((p) => ({ signature: p.signature, n: p.n, champion_bss: p.champion.bss, challenger_bss: p.challenger.bss, champion_brier: p.champion.brier, challenger_brier: p.challenger.brier })),
    },
  };
}
