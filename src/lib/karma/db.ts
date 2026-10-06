import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Persistent store (Supabase Postgres, free tier). Coin scans accumulate here from the daily cron
 * and from every user who opens a coin, so the set is always fresh and always has data; trimmed at
 * 30 days. Schema in db/schema.sql.
 *
 * Every call is defensive: a DB hiccup returns null / no-ops and NEVER breaks a scan. Absent env
 * vars (local dev without keys) → the whole thing is inert and the app falls back to its in-process
 * cache, exactly as before.
 */
let _client: SupabaseClient | null | undefined;

/** The shared client, for modules that query their own tables (sources/sibling-overlap.ts). Null when unconfigured. */
export function db(): SupabaseClient | null {
  if (_client !== undefined) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  _client = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  return _client;
}

export function dbEnabled(): boolean {
  return db() !== null;
}

/** The stored scan and how old it is, or null on miss / any error. */
export async function getStoredScan<T>(mint: string): Promise<{ scan: T; ageSeconds: number } | null> {
  const c = db();
  if (!c) return null;
  try {
    const { data, error } = await c.from("coin_scans").select("scan, updated_at").eq("mint", mint).maybeSingle();
    if (error || !data) return null;
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(new Date(data.updated_at as string).getTime() / 1000));
    return { scan: data.scan as T, ageSeconds };
  } catch {
    return null;
  }
}

/** Upsert a scan. Fire-and-forget friendly, but await it in SSR so serverless doesn't cut the write. */
export async function putStoredScan<T>(mint: string, scan: T, eligible: boolean): Promise<void> {
  const c = db();
  if (!c) return;
  try {
    await c.from("coin_scans").upsert({ mint, scan, eligible, updated_at: new Date().toISOString() }, { onConflict: "mint" });
  } catch {
    // a failed write just means the next visitor re-scans — never surface it
  }
}

/** Delete scans older than `days`. Returns rows removed (0 on no-op/error). Run by the daily cron. */
export async function trimStoredScans(days = 30): Promise<number> {
  const c = db();
  if (!c) return 0;
  try {
    const cutoff = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const { count } = await c.from("coin_scans").delete({ count: "exact" }).lt("updated_at", cutoff);
    return count ?? 0;
  } catch {
    return 0;
  }
}
