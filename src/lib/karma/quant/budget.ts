import { askJev, type JevResult } from "./jev";
import type { RubricQuestion } from "./types";

/**
 * Jev spend guard: every Jev call in a cron run goes through one budget with a hard call cap.
 *
 * Budget math (Jev measured at ~$0.00002–0.00003 per call for a full rubric on one coin):
 *   normal day  ≈ 30 coins × (1 live + 0–2 shadow rubrics) = 30–90 calls   × $0.00003 ≈ $0.001–0.003
 *   Sunday      + replay of the held-out slice, ≤ ~300 calls               × $0.00003 ≈ $0.009
 *   hard cap    400 calls/run                                               × $0.00003 = $0.012 per run, max
 * So Jev can never cost more than ~$0.36/month even if every run hit the cap. (Claude's weekly
 * challenger call is separate: ≤ ~$0.12, see evolve.ts.)
 */
export const JEV_CALLS_PER_RUN = 400;

export type AskFn = (state: unknown, questions: Record<string, RubricQuestion>) => Promise<JevResult | null>;

export class JevBudget {
  used = 0;
  failed = 0;
  refused = 0;
  spent_usd = 0;

  constructor(
    readonly cap = JEV_CALLS_PER_RUN,
    private readonly ask: AskFn = askJev,
  ) {}

  get left(): number {
    return Math.max(0, this.cap - this.used);
  }

  /** Ask Jev unless the run's cap is spent (then null, counted as refused). */
  async call(state: unknown, questions: Record<string, RubricQuestion>): Promise<JevResult | null> {
    if (this.used >= this.cap) {
      this.refused++;
      return null;
    }
    this.used++;
    const r = await this.ask(state, questions);
    if (!r) this.failed++;
    else this.spent_usd += r.cost_usd ?? 0.00003;
    return r;
  }

  summary() {
    return { calls: this.used, cap: this.cap, failed: this.failed, refused: this.refused, spent_usd: Math.round(this.spent_usd * 1e6) / 1e6 };
  }
}
