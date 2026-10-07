import type { KV } from "./cache";
import { MemoryCache } from "./cache";
import { db } from "./db";

/**
 * The engine's cache with a durable tier for facts that never change once known: when a wallet was born,
 * who funded it, what a finalized transaction did. Those are the expensive reads (history at ~1 call/s on a
 * keyless RPC) and the same wallets recur across coins, so a scan that runs out of time leaves its work here
 * and the next pass, cron or visitor, starts from it. Everything else (prices, pools, balances) stays
 * in-process, where staleness is bounded by its TTL.
 *
 * Table: wallet_facts (db/schema.sql). Missing table or any DB error turns the durable tier off for the
 * process and the cache behaves exactly like MemoryCache.
 */
const DURABLE = /^(origin|funder|clfunder|entrytx|hbledger1|delta2):/;

export class FactCache implements KV {
  private readonly mem = new MemoryCache();
  private off = false;

  async get<T>(key: string): Promise<T | undefined> {
    const hit = await this.mem.get<T>(key);
    if (hit !== undefined || this.off || !DURABLE.test(key)) return hit;
    const c = db();
    if (!c) return undefined;
    try {
      const { data, error } = await c.from("wallet_facts").select("v, exp").eq("key", key).maybeSingle();
      if (error) return this.disable(error.message);
      if (!data || (data.exp && new Date(data.exp as string).getTime() < Date.now())) return undefined;
      await this.mem.set(key, data.v as T);
      return data.v as T;
    } catch (e) {
      return this.disable(String(e));
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.mem.set(key, value, ttlSeconds);
    if (this.off || !DURABLE.test(key)) return;
    const c = db();
    if (!c) return;
    try {
      const exp = ttlSeconds ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null;
      const { error } = await c.from("wallet_facts").upsert({ key, v: value, exp, updated_at: new Date().toISOString() }, { onConflict: "key" });
      if (error) this.disable(error.message);
    } catch (e) {
      this.disable(String(e));
    }
  }

  private disable(why: string): undefined {
    if (!this.off) console.warn(`[fact-cache] durable tier off: ${why.slice(0, 120)}`);
    this.off = true;
    return undefined;
  }
}

/** Drop facts not touched in `days` (the cron runs it). 0 on no-op/error. */
export async function trimWalletFacts(days = 60): Promise<number> {
  const c = db();
  if (!c) return 0;
  try {
    const { count } = await c
      .from("wallet_facts")
      .delete({ count: "exact" })
      .lt("updated_at", new Date(Date.now() - days * 86400_000).toISOString());
    return count ?? 0;
  } catch {
    return 0;
  }
}
