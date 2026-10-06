import { sleep } from "../http";
import { pickTopPool, type Candle, type GtPool } from "../sources/ta";

/**
 * The two market reads the quant loop needs, shaped for its budget:
 *
 *  - DexScreener, batched: one call returns price / mcap / liquidity / top pair for up to 30 tokens.
 *  - GeckoTerminal 1h OHLCV, paced: the free tier advertises ~30 calls/min but in practice 429s well
 *    below that when the IP is shared (measured 25 Sep 2026: 13 of 20 calls at a 2.1s pace refused).
 *    So every call goes through one shared ADAPTIVE pacer, never in parallel: it starts at one call
 *    per 2.1s, backs off ×1.6 (up to 10s) on each 429, and eases back toward 2.1s on success. The pool comes from
 *    DexScreener's top pair, so a coin costs ONE GeckoTerminal call, not two (resolveTopPool + OHLCV).
 *    Candles are memoised per run: the snapshot step and the outcome step share one fetch per mint.
 */

const GT = "https://api.geckoterminal.com/api/v2";
const DEX = "https://api.dexscreener.com/tokens/v1";
/** Adaptive pacer: the gap between calls grows ×1.6 on a 429 and shrinks 250ms per success. */
class Pacer {
  private next = 0;
  constructor(
    private gap: number,
    private readonly minGap: number,
    private readonly maxGap: number,
  ) {}
  async take(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.gap;
    if (slot > now) await sleep(slot - now);
  }
  refused(): void {
    this.gap = Math.min(this.maxGap, this.gap * 1.6);
    this.next = Math.max(this.next, Date.now() + this.gap);
  }
  ok(): void {
    this.gap = Math.max(this.minGap, this.gap - 250);
  }
  get gapMs(): number {
    return this.gap;
  }
}
/** ~28 calls/min at best: under the free tier's ~30 with a little slack. */
export const gtPacer = new Pacer(2_100, 2_100, 10_000);
/** 300 hourly candles = 12.5 days: covers the 7-day horizon for any snapshot measured within ~5 days of maturing. */
export const CANDLE_LIMIT = 300;

export interface DexNow {
  price_usd: number | null;
  mcap_usd: number | null;
  liquidity_usd: number | null;
  /** The deepest pair's address — GeckoTerminal keys OHLCV on the pool, not the token. */
  pair: string | null;
}

/** GeckoTerminal network → DexScreener chain id. Null for chains the loop doesn't cover. */
export function dexChain(network: string): string | null {
  // GeckoTerminal slugs double as DexScreener chain ids, except Ethereum.
  const ids: Record<string, string> = { solana: "solana", bsc: "bsc", base: "base", eth: "ethereum", robinhood: "robinhood", hyperevm: "hyperevm" };
  return ids[network] ?? null;
}

interface DexPair {
  pairAddress?: string;
  baseToken?: { address?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
}

/**
 * Current price/mcap/liquidity for many tokens on one chain, 30 per call. A token missing from the
 * result map had no pair at all (delisted, or never listed) — the outcome step reads that as "gone".
 * A chunk whose call fails is simply absent too, so callers must treat absence as "unknown" unless
 * `ok` says the call succeeded.
 */
export async function dexBatch(network: string, mints: string[]): Promise<{ ok: Set<string>; data: Map<string, DexNow> }> {
  const chain = dexChain(network);
  const data = new Map<string, DexNow>();
  const ok = new Set<string>();
  if (!chain) return { ok, data };
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const res = await fetch(`${DEX}/${chain}/${chunk.join(",")}`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const pairs = (await res.json()) as DexPair[];
      for (const m of chunk) ok.add(m);
      for (const p of pairs ?? []) {
        // EVM addresses come back checksummed; key by the mint as the caller spelled it.
        const base = chunk.find((m) => m.toLowerCase() === p.baseToken?.address?.toLowerCase());
        if (!base) continue;
        const liq = p.liquidity?.usd ?? 0;
        const prev = data.get(base);
        if (prev && (prev.liquidity_usd ?? 0) >= liq) continue;
        const price = Number(p.priceUsd);
        data.set(base, {
          price_usd: price > 0 ? price : null,
          mcap_usd: p.marketCap ?? p.fdv ?? null,
          liquidity_usd: p.liquidity?.usd ?? null,
          pair: p.pairAddress ?? null,
        });
      }
    } catch {
      // unknown for this chunk; ok stays unset so nothing is misread as "delisted"
    }
  }
  return { ok, data };
}

/**
 * One paced GeckoTerminal GET. Returns the JSON, "missing" for a 404 (unknown pool/token), or null on
 * any other failure. Up to two retries after a 429, each behind a longer gap.
 */
async function gtGet<T>(path: string): Promise<T | "missing" | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await gtPacer.take();
    try {
      const res = await fetch(`${GT}${path}`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/json" } });
      if (res.status === 404) return "missing";
      if (res.status === 429) {
        gtPacer.refused();
        continue;
      }
      if (!res.ok) return null;
      gtPacer.ok();
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  return null;
}

/** GeckoTerminal trending Solana pools → base-token mints. */
export async function gtTrendingMints(network = "solana", duration = "24h"): Promise<string[]> {
  const j = await gtGet<{ data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> }>(`/networks/${network}/trending_pools?duration=${duration}`);
  if (!j || j === "missing") return [];
  const out: string[] = [];
  for (const p of j.data ?? []) {
    const id = p.relationships?.base_token?.data?.id ?? "";
    if (id.startsWith(`${network}_`)) out.push(id.slice(network.length + 1));
  }
  return [...new Set(out)];
}

/** The most-traded pool's address; null when the token has none, undefined when the call failed. */
async function gtTopPool(network: string, mint: string): Promise<string | null | undefined> {
  const j = await gtGet<{ data?: GtPool[] }>(`/networks/${network}/tokens/${mint}/pools?page=1`);
  if (j === null) return undefined;
  if (j === "missing") return null;
  return pickTopPool(network, j.data ?? []);
}

/**
 * Hourly OHLCV priced in USD per unit of `mint`. The `token` parameter matters: without it GeckoTerminal
 * prices the pool's BASE token, and many pools list our coin as the quote (the STONK/KNOTS pool priced
 * at STONK's $0.33 instead of KNOTS's $0.013).
 */
async function gtOhlcv(network: string, pool: string, mint: string): Promise<Candle[] | "missing" | null> {
  const j = await gtGet<{ data?: { attributes?: { ohlcv_list?: number[][] } } }>(`/networks/${network}/pools/${pool}/ohlcv/hour?limit=${CANDLE_LIMIT}&currency=usd&token=${mint}`);
  if (!j || j === "missing") return j;
  return (j.data?.attributes?.ohlcv_list ?? [])
    .filter((r) => r.length >= 6)
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Per-run candle source: memoised by mint, counts GeckoTerminal calls. `candles(...)` returns the
 * hourly series oldest-first, [] when GeckoTerminal has no pool/candles for the coin (a real "nothing
 * traded" answer), or null when the call failed (unknown — retry another day, never grade on it).
 */
export class CandleBook {
  private memo = new Map<string, Promise<Candle[] | null>>();
  gtCalls = 0;

  /** Already fetched (or in flight) this run: free to read again. */
  has(network: string, mint: string): boolean {
    return this.memo.has(`${network}:${mint}`);
  }

  candles(network: string, mint: string, dexPair: string | null): Promise<Candle[] | null> {
    const key = `${network}:${mint}`;
    let p = this.memo.get(key);
    if (!p) {
      p = this.load(network, mint, dexPair);
      this.memo.set(key, p);
    }
    return p;
  }

  private async load(network: string, mint: string, dexPair: string | null): Promise<Candle[] | null> {
    if (dexPair) {
      this.gtCalls++;
      const r = await gtOhlcv(network, dexPair, mint);
      if (r === null) return null;
      if (r !== "missing" && r.length) return r;
    }
    // No DexScreener pair, or GeckoTerminal doesn't index that pair: ask GeckoTerminal for its own pool.
    this.gtCalls++;
    const pool = await gtTopPool(network, mint);
    if (pool === undefined) return null;
    if (!pool) return [];
    this.gtCalls++;
    const r = await gtOhlcv(network, pool, mint);
    return r === "missing" ? [] : r;
  }
}
