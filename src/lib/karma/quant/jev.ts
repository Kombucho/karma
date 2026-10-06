import type { JevAnswer, QuantFeatures, RubricQuestion } from "./types";

/**
 * TypeSafe Jev through OpenRouter's Decisions API (not the chat endpoint: Jev doesn't generate text).
 * Measured 25 Sep 2026: ~1s, ~550 input tokens and $0.00002 for a 2-question call on one coin.
 * Output is free, so asking every question in one request costs only the state + question tokens.
 */
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "typesafe/jev-1.13";

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  cost_usd: number | null;
  input_tokens: number | null;
}

/** Ask Jev every question in `questions` about `state`. Null on any failure (no key, HTTP error, bad shape). */
export async function askJev(state: unknown, questions: Record<string, RubricQuestion>, timeoutMs = 8_000): Promise<JevResult | null> {
  const key = process.env.JEV_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Karma" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { model?: string; answers?: Record<string, JevAnswer>; usage?: { cost?: number; input_tokens?: number } };
    if (!j.answers) return null;
    return { model: j.model ?? JEV_MODEL, answers: j.answers, cost_usd: j.usage?.cost ?? null, input_tokens: j.usage?.input_tokens ?? null };
  } catch {
    return null;
  }
}

/**
 * The state Jev sees. Only the fields a question can use: irrelevant context lowers accuracy (TypeSafe's
 * own guidance). Rounded so the same situation always reads the same, and nulls dropped.
 */
export function jevState(f: QuantFeatures): Record<string, unknown> {
  const round = (v: unknown): unknown =>
    typeof v === "number" ? Math.round(v * 1000) / 1000 : v && typeof v === "object" && !Array.isArray(v) ? prune(v as Record<string, unknown>) : v;
  const prune = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, round(v)]));
  return prune({
    coin: { symbol: f.symbol, age_hours: f.age_hours, mcap_usd: f.mcap_usd, liquidity_usd: f.liquidity_usd },
    chart: f.chart,
    holders: f.holders,
  });
}
