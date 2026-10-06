import type { GradedRow, QuantGrade } from "./store";
import type { JevAnswer, QuantOutcome, QuantTarget, Rubric } from "./types";

/**
 * GRADES: pure scoring of a rubric's answers against realised outcomes. No I/O.
 *
 *  - noul questions (drawdown / pump targets): Brier score of the predicted probability vs the binary
 *    event, the event's base rate, and the Brier of always predicting that base rate (the no-skill
 *    baseline: base × (1 − base)). Brier skill score = 1 − brier / baseline: 0 = no better than knowing
 *    the base rate, 1 = perfect, negative = worse than the base rate.
 *  - choice questions with a direction target: hit rate of the up/down pick vs the sign of the return at
 *    the horizon (neutral picks ignored), plus Brier on the implied P(up) = Σp(up options) / Σp(up+down).
 *  - calibration buckets 0–0.2 … 0.8–1: n, mean predicted, actual rate.
 *
 * Worked example: 100 snapshots, 30 dumped (base 0.3, baseline 0.21). A rubric that says 0.3 for all of
 * them scores Brier 0.21, skill 0. One that says 0.8 on the 30 dumpers and 0.1 on the rest scores
 * (30·0.04 + 70·0.01)/100 = 0.019, skill 1 − 0.019/0.21 ≈ 0.91.
 */

export interface Grade extends QuantGrade {
  /** Brier skill score, 1 − brier / brier_baseline. Null when the baseline is 0 (every outcome the same) or n = 0. */
  bss: number | null;
  /** How many non-neutral direction picks the hit rate is over. */
  hit_n: number | null;
}

export interface Pair {
  p: number; // predicted probability of the event
  y: 0 | 1; // did it happen
}

const BUCKETS = [0, 0.2, 0.4, 0.6, 0.8, 1.0000001];

/** Brier, base rate, baseline, skill and calibration over (prediction, outcome) pairs. */
export function scorePairs(pairs: Pair[]): Pick<Grade, "n" | "brier" | "base_rate" | "brier_baseline" | "bss" | "calibration"> {
  const n = pairs.length;
  if (!n) return { n: 0, brier: null, base_rate: null, brier_baseline: null, bss: null, calibration: null };
  const brier = pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const base = pairs.reduce((s, x) => s + x.y, 0) / n;
  const baseline = base * (1 - base);
  const calibration = [];
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const inB = pairs.filter((x) => x.p >= BUCKETS[i] && x.p < BUCKETS[i + 1]);
    if (!inB.length) continue;
    calibration.push({
      bucket: `${BUCKETS[i].toFixed(1)}-${Math.min(1, BUCKETS[i + 1]).toFixed(1)}`,
      n: inB.length,
      predicted: inB.reduce((s, x) => s + x.p, 0) / inB.length,
      actual: inB.reduce((s, x) => s + x.y, 0) / inB.length,
    });
  }
  return { n, brier, base_rate: base, brier_baseline: baseline, bss: baseline > 0 ? 1 - brier / baseline : null, calibration };
}

/** Did the target's event happen, per the outcome at its horizon? Null when it can't be told. */
export function eventFor(target: QuantTarget, o: QuantOutcome | undefined): 0 | 1 | null {
  if (!o) return null;
  if (target.kind === "drawdown") return o.max_drawdown === null ? null : o.max_drawdown >= target.threshold ? 1 : 0;
  if (target.kind === "pump") return o.max_runup === null ? null : o.max_runup >= target.threshold ? 1 : 0;
  return o.ret === null || o.ret === 0 ? null : o.ret > 0 ? 1 : 0;
}

/** The probability a question's answer puts on its target's event. Null when the answer doesn't carry one. */
export function probFor(target: QuantTarget, a: JevAnswer | undefined): number | null {
  if (!a) return null;
  if (target.kind !== "direction") return typeof a.noul === "number" && Number.isFinite(a.noul) ? Math.min(1, Math.max(0, a.noul)) : null;
  if (a.probabilities) {
    const up = target.up.reduce((s, k) => s + (a.probabilities![k] ?? 0), 0);
    const down = target.down.reduce((s, k) => s + (a.probabilities![k] ?? 0), 0);
    if (up + down > 0) return up / (up + down);
  }
  if (a.choice && target.up.includes(a.choice)) return 1;
  if (a.choice && target.down.includes(a.choice)) return 0;
  return null;
}

/** Grade one question over rows, given the answers to read for each row (defaults to the row's own). */
export function gradeQuestion(
  version: string,
  question: string,
  target: QuantTarget,
  rows: GradedRow[],
  answersOf: (r: GradedRow) => Record<string, JevAnswer> | undefined = (r) => r.snapshot.answers,
): Grade {
  const pairs: Pair[] = [];
  let hits = 0;
  let hitN = 0;
  for (const r of rows) {
    const y = eventFor(target, r.outcomes[target.horizon_h]);
    if (y === null) continue;
    const a = answersOf(r)?.[question];
    const p = probFor(target, a);
    if (p !== null) pairs.push({ p, y });
    if (target.kind === "direction" && a?.choice) {
      const pick = target.up.includes(a.choice) ? 1 : target.down.includes(a.choice) ? 0 : null;
      if (pick !== null) {
        hitN++;
        if (pick === y) hits++;
      }
    }
  }
  return {
    rubric_version: version,
    question,
    ...scorePairs(pairs),
    hit_rate: target.kind === "direction" ? (hitN ? hits / hitN : null) : null,
    hit_n: target.kind === "direction" ? hitN : null,
  };
}

/** Grade every graded question (rubric.targets) of a rubric. */
export function gradeRubric(rubric: Rubric, rows: GradedRow[], answersOf?: (r: GradedRow) => Record<string, JevAnswer> | undefined): Grade[] {
  return Object.entries(rubric.targets)
    .filter(([q]) => rubric.questions[q])
    .map(([q, t]) => gradeQuestion(rubric.version, q, t, rows, answersOf));
}

/** The stored row shape (quant_grades has no bss / hit_n columns: both are derived). */
export function toStored(g: Grade): QuantGrade {
  return { rubric_version: g.rubric_version, question: g.question, n: g.n, brier: g.brier, base_rate: g.base_rate, brier_baseline: g.brier_baseline, hit_rate: g.hit_rate, calibration: g.calibration };
}

/** A target's identity for comparing questions across rubric versions (keys may be renamed). */
export function targetSignature(t: QuantTarget): string {
  return t.kind === "direction" ? `direction@${t.horizon_h}` : `${t.kind}@${t.horizon_h}>=${t.threshold}`;
}

/** Mean Brier skill over grades that have one. Null if none do. */
export function meanSkill(grades: Grade[]): number | null {
  const xs = grades.map((g) => g.bss).filter((x): x is number => x !== null);
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}
