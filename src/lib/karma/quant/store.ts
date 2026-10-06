import { db } from "../db";
import { RUBRIC_V1 } from "./rubric-v1";
import type { QuantFeatures, QuantOutcome, QuantSnapshot, Rubric } from "./types";

/**
 * Persistence for the Jev quant loop (tables in db/schema.sql). Every call is defensive: a missing table
 * (migration not run yet) or any DB error returns null / [] / no-op and never breaks a scan or a page.
 */

/** The live rubric, falling back to the seed v1 when the table is empty or missing. */
export async function liveRubric(): Promise<Rubric> {
  const c = db();
  if (!c) return RUBRIC_V1;
  try {
    const { data, error } = await c.from("quant_rubrics").select("rubric").eq("status", "live").order("created_at", { ascending: false }).limit(1);
    if (error || !data?.length) return RUBRIC_V1;
    return data[0].rubric as Rubric;
  } catch {
    return RUBRIC_V1;
  }
}

/** Every rubric with a given status (shadow challengers the cron runs beside the champion). */
export async function rubricsByStatus(status: Rubric["status"]): Promise<Rubric[]> {
  const c = db();
  if (!c) return status === "live" ? [RUBRIC_V1] : [];
  try {
    const { data, error } = await c.from("quant_rubrics").select("rubric").eq("status", status).order("created_at");
    if (error) return status === "live" ? [RUBRIC_V1] : [];
    const out = (data ?? []).map((r) => r.rubric as Rubric);
    return out.length || status !== "live" ? out : [RUBRIC_V1];
  } catch {
    return status === "live" ? [RUBRIC_V1] : [];
  }
}

export async function putRubric(r: Rubric): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("quant_rubrics").upsert({ version: r.version, parent: r.parent, status: r.status, rubric: r, created_at: r.created_at }, { onConflict: "version" });
  } catch {}
}

/** Seed v1 into the table once, so the live rubric is always a real row. */
export async function ensureSeedRubric(): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    const { data } = await c.from("quant_rubrics").select("version").limit(1);
    if (!data?.length) await putRubric(RUBRIC_V1);
  } catch {}
}

export async function saveSnapshot(s: QuantSnapshot): Promise<number | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c
      .from("quant_snapshots")
      .insert({ mint: s.mint, t: new Date(s.t * 1000).toISOString(), price_usd: s.price_usd, rubric_version: s.rubric_version, features: s.features, answers: s.answers, source: s.source })
      .select("id")
      .single();
    return error ? null : (data.id as number);
  } catch {
    return null;
  }
}

/** The newest snapshot of a mint under a rubric version, if taken within `maxAgeSeconds`. */
export async function recentSnapshot(mint: string, rubricVersion: string, maxAgeSeconds: number): Promise<QuantSnapshot | null> {
  const c = db();
  if (!c) return null;
  try {
    const since = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
    const { data, error } = await c
      .from("quant_snapshots")
      .select("id, mint, t, price_usd, rubric_version, features, answers, source")
      .eq("mint", mint)
      .eq("rubric_version", rubricVersion)
      .gte("t", since)
      .order("t", { ascending: false })
      .limit(1);
    if (error || !data?.length) return null;
    const r = data[0];
    return { ...r, t: Math.floor(new Date(r.t as string).getTime() / 1000) } as QuantSnapshot;
  } catch {
    return null;
  }
}

export async function saveOutcome(o: QuantOutcome): Promise<void> {
  await upsertOutcomes([o]);
}

/**
 * Upsert outcome rows. quant_outcomes.status arrived in a later revision of schema.sql; on a database
 * created before it, the write is retried without `status` so outcomes still land (the audit flag is
 * lost until the file is re-run, which adds the column).
 */
async function upsertOutcomes(rows: QuantOutcome[]): Promise<void> {
  const c = db();
  if (!c || !rows.length) return;
  try {
    const { error } = await c.from("quant_outcomes").upsert(rows, { onConflict: "snapshot_id,horizon_h" });
    if (error && /status/.test(error.message)) {
      await c.from("quant_outcomes").upsert(rows.map(({ status, ...o }) => (void status, o)), { onConflict: "snapshot_id,horizon_h" });
    }
  } catch {}
}

export interface QuantGrade {
  rubric_version: string;
  question: string;
  n: number;
  brier: number | null;
  base_rate: number | null;
  brier_baseline: number | null;
  hit_rate: number | null;
  calibration: { bucket: string; n: number; predicted: number; actual: number }[] | null;
}

export async function gradesFor(rubricVersion: string): Promise<QuantGrade[]> {
  const c = db();
  if (!c) return [];
  try {
    const { data, error } = await c.from("quant_grades").select("*").eq("rubric_version", rubricVersion);
    return error ? [] : ((data ?? []) as QuantGrade[]);
  } catch {
    return [];
  }
}

export async function putGrades(g: QuantGrade[]): Promise<void> {
  const c = db();
  if (!c || !g.length) return;
  try {
    await c.from("quant_grades").upsert(g.map((x) => ({ ...x, graded_at: new Date().toISOString() })), { onConflict: "rubric_version,question" });
  } catch {}
}

// ── Loaders for the cron's outcome / grade / evolve steps ────────────────────────────────────────

/** Whether the quant tables exist, and whether quant_outcomes has the newer `status` column. */
export async function quantTablesReady(): Promise<{ tables: boolean; status_column: boolean }> {
  const c = db();
  if (!c) return { tables: false, status_column: false };
  try {
    const t = await c.from("quant_snapshots").select("id").limit(1);
    const s = await c.from("quant_outcomes").select("status").limit(1);
    return { tables: !t.error, status_column: !s.error };
  } catch {
    return { tables: false, status_column: false };
  }
}

/** GeckoTerminal network for a stored mint: the warm cron only stores Solana and BSC coins. */
export function networkOf(mint: string): string {
  return mint.startsWith("0x") ? "bsc" : "solana";
}

type PagedQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }> };

/** Page through a query 1000 rows at a time (PostgREST's default cap). */
async function paged<T>(build: () => PagedQuery, max = 20_000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error || !data) break;
    out.push(...(data as T[]));
    if (data.length < 1000) break;
  }
  return out;
}

const toUnix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/**
 * Snapshots (not replays) taken in [since, now - shortest horizon + slack] that still miss an outcome
 * at some horizon whose time has come.
 */
export async function pendingOutcomeSnapshots(
  since: number,
  now: number,
  horizons: readonly number[],
  slackS: number,
): Promise<{ id: number; mint: string; network: string; t: number; price_usd: number; horizons: number[] }[]> {
  const c = db();
  if (!c) return [];
  try {
    const until = now - Math.min(...horizons) * 3600 + slackS;
    const rows = await paged<{ id: number; mint: string; network: string | null; t: string; price_usd: number | null; quant_outcomes: { horizon_h: number }[] }>(
      () =>
        c
          .from("quant_snapshots")
          .select("id, mint, network:features->>network, t, price_usd, quant_outcomes(horizon_h)")
          .neq("source", "replay")
          .not("price_usd", "is", null)
          .gte("t", new Date(since * 1000).toISOString())
          .lte("t", new Date(until * 1000).toISOString())
          .order("id") as unknown as PagedQuery,
    );
    const out = [];
    for (const r of rows) {
      const t = toUnix(r.t);
      const have = new Set((r.quant_outcomes ?? []).map((o) => o.horizon_h));
      const due = horizons.filter((h) => !have.has(h) && t + h * 3600 <= now + slackS);
      if (due.length && r.price_usd && r.price_usd > 0) out.push({ id: r.id, mint: r.mint, network: r.network ?? networkOf(r.mint), t, price_usd: r.price_usd, horizons: due });
    }
    return out;
  } catch {
    return [];
  }
}

/** A snapshot with its outcomes keyed by horizon — the unit every grader works on. */
export interface GradedRow {
  snapshot: QuantSnapshot;
  outcomes: Record<number, QuantOutcome>;
}

/**
 * Every snapshot of a rubric version with its outcomes. `features` only when asked (evolve needs them,
 * the daily grade doesn't: they're the heavy column). Replays included unless `excludeReplay`.
 */
export async function loadGradedRows(rubricVersion: string, opts: { features?: boolean; excludeReplay?: boolean } = {}): Promise<GradedRow[]> {
  const c = db();
  if (!c) return [];
  try {
    const cols = `id, mint, t, price_usd, rubric_version, answers, source${opts.features ? ", features" : ""}, quant_outcomes(*)`;
    const rows = await paged<Record<string, unknown>>(() => {
      let q = c.from("quant_snapshots").select(cols).eq("rubric_version", rubricVersion);
      if (opts.excludeReplay) q = q.neq("source", "replay");
      return q.order("id") as unknown as PagedQuery;
    });
    return rows.map(({ quant_outcomes, ...r }) => {
      const outs = (quant_outcomes as QuantOutcome[] | null) ?? [];
      const snapshot = { ...r, t: toUnix(r.t as string), features: (r.features ?? null) as QuantFeatures } as unknown as QuantSnapshot;
      return { snapshot, outcomes: Object.fromEntries(outs.map((o) => [o.horizon_h, o])) };
    });
  } catch {
    return [];
  }
}

/** Mints already snapshotted under a rubric version since `since` (the 20h dedupe). */
export async function recentSnapshotMints(rubricVersion: string, since: number): Promise<Set<string>> {
  const c = db();
  if (!c) return new Set();
  try {
    const { data, error } = await c
      .from("quant_snapshots")
      .select("mint")
      .eq("rubric_version", rubricVersion)
      .neq("source", "replay")
      .gte("t", new Date(since * 1000).toISOString())
      .limit(5000);
    return error ? new Set() : new Set((data ?? []).map((r) => r.mint as string));
  } catch {
    return new Set();
  }
}

/** Eligible mints scanned (stored) since `since`, newest first. */
export async function recentScanMints(since: number, limit = 200): Promise<string[]> {
  const c = db();
  if (!c) return [];
  try {
    const { data, error } = await c
      .from("coin_scans")
      .select("mint")
      .eq("eligible", true)
      .gte("updated_at", new Date(since * 1000).toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);
    return error ? [] : (data ?? []).map((r) => r.mint as string);
  } catch {
    return [];
  }
}

/**
 * Store replayed judgments (source "replay") in bulk, each with a copy of its original snapshot's
 * outcomes, so the replayed version grades on exactly the paths the champion was graded on and the
 * outcome step never re-measures them. Returns how many snapshots were written.
 */
export async function saveReplays(items: { snapshot: QuantSnapshot; outcomes: QuantOutcome[] }[]): Promise<number> {
  const c = db();
  if (!c || !items.length) return 0;
  let written = 0;
  try {
    for (let i = 0; i < items.length; i += 200) {
      const chunk = items.slice(i, i + 200);
      const { data, error } = await c
        .from("quant_snapshots")
        .insert(chunk.map(({ snapshot: s }) => ({ mint: s.mint, t: new Date(s.t * 1000).toISOString(), price_usd: s.price_usd, rubric_version: s.rubric_version, features: s.features, answers: s.answers, source: "replay" })))
        .select("id");
      if (error || !data) continue;
      written += data.length;
      // PostgREST returns inserted rows in insert order.
      const outs = chunk.flatMap(({ outcomes }, j) => outcomes.map((o) => ({ ...o, snapshot_id: data[j].id as number })));
      await upsertOutcomes(outs);
    }
  } catch {}
  return written;
}

/** Rubrics created from `parent` since `since`: the evolve step's once-a-week idempotency check. */
export async function childrenSince(parent: string, since: number): Promise<string[]> {
  const c = db();
  if (!c) return [];
  try {
    const { data, error } = await c.from("quant_rubrics").select("version").eq("parent", parent).gte("created_at", new Date(since * 1000).toISOString());
    return error ? [] : (data ?? []).map((r) => r.version as string);
  } catch {
    return [];
  }
}

