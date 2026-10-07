import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import type { KV } from "../cache";
import { PUMP_FUN_PROGRAM } from "../constants";

/** The pump.fun bonding curve account for a mint (PDA of ["bonding-curve", mint]). GeckoTerminal uses it as the pool id. */
export async function pumpFunCurveAddress(mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(PUMP_FUN_PROGRAM),
    seeds: [new TextEncoder().encode("bonding-curve"), getAddressEncoder().encode(address(mint))],
  });
  return pda;
}

const PUMP_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
};

/** The coin's core facts straight from pump.fun. `created_ms` lets us age a coin the instant it
 *  launches, before any DEX indexes a pool — the unlock for scanning sub-5-minute mints. */
export interface PumpCoin {
  creator: string | null;
  /** Launch time in unix ms (pump's `created_timestamp`). Null if absent. */
  created_ms: number | null;
  /** True once the bonding curve has graduated to a real AMM pool. */
  complete: boolean;
  market_cap_usd: number | null;
}

/** A pump.fun mint's core facts. Immutable-ish, short-cached (mcap/complete drift). Null off pump.fun or on error. */
export async function pumpFunCoin(mint: string, cache: KV): Promise<PumpCoin | null> {
  if (!mint.endsWith("pump")) return null;
  const key = `pump_coin:${mint}`;
  const hit = await cache.get<PumpCoin>(key);
  if (hit) return hit;
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, { headers: PUMP_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null; // transient — don't cache the miss
    const c = (await res.json()) as { creator?: string; created_timestamp?: number; complete?: boolean; usd_market_cap?: number };
    const coin: PumpCoin = {
      creator: c.creator ?? null,
      created_ms: typeof c.created_timestamp === "number" ? c.created_timestamp : null,
      complete: c.complete ?? false,
      market_cap_usd: typeof c.usd_market_cap === "number" ? c.usd_market_cap : null,
    };
    await cache.set(key, coin, 300);
    return coin;
  } catch {
    return null;
  }
}

/** The wallet that deployed a pump.fun mint (its "dev"). Null off pump.fun or on error. */
export async function pumpFunCreator(mint: string, cache: KV): Promise<string | null> {
  return (await pumpFunCoin(mint, cache))?.creator ?? null;
}

/** The richer facts pump.fun carries for its multichain (EVM) coins — same `/coins/{mint}` route,
 *  a different, fuller shape than the Solana one. This is the backbone of an EVM scan. */
export interface PumpEvmCoin {
  name: string | null;
  symbol: string | null;
  creator: string | null;
  created_ms: number | null;
  market_cap_usd: number | null;
  ath_market_cap_usd: number | null;
  liquidity_usd: number | null;
  protocol: string | null;
  /** CAIP-2 chain id, e.g. "eip155:56" for BNB Chain. */
  chain_id: string | null;
  pool_address: string | null;
  total_supply: bigint | null;
  is_banned: boolean;
  /** pump.fun's own token-trust call: "allow" | "block" | … with a one-word reason. */
  security_verdict: string | null;
  security_reason: string | null;
}

/** A raw-unit supply string as a bigint. pump sometimes sends "1000000000.0", a number or ""; any of
 *  those used to throw and discard the WHOLE record, making a listed coin read as "not found". */
function supplyBigInt(v: unknown): bigint | null {
  const str = typeof v === "number" ? v.toLocaleString("fullwide", { useGrouping: false }) : typeof v === "string" ? v.trim() : "";
  const int = str.split(".")[0];
  return /^\d+$/.test(int) ? BigInt(int) : null;
}

/** GET pump's `/coins/{mint}`, retrying a 429/5xx once and trying the other letter case on a 404
 *  (the address comes in checksummed or lowercase depending on where it was pasted from). */
async function fetchPumpEvm(mint: string): Promise<Record<string, unknown> | null> {
  const variants = [...new Set([mint, mint.toLowerCase()])];
  const why: string[] = [];
  for (const m of variants) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${m}`, { headers: PUMP_HEADERS, signal: AbortSignal.timeout(8000) }).catch(
        (e: unknown) => (why.push(`${m}: ${e instanceof Error ? e.message : "fetch failed"}`), null),
      );
      if (res?.ok) {
        const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        if (body && typeof body === "object" && (body.mint || body.name || body.symbol)) return body;
        why.push(`${m}: empty body`);
        break;
      }
      if (res) why.push(`${m}: http ${res.status}`);
      if (res && res.status !== 429 && res.status < 500) break; // hard answer — try the next variant
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  console.warn(`[pumpfun] EVM coin lookup failed for ${mint} — ${why.join("; ")}`);
  return null;
}

/** Core facts for a pump.fun EVM mint (0x…). Short-cached (mcap drifts). Null off pump.fun / on error. */
export async function pumpFunEvmCoin(mint: string, cache: KV): Promise<PumpEvmCoin | null> {
  if (!mint.startsWith("0x")) return null;
  const key = `pump_evm:${mint.toLowerCase()}`;
  const hit = await cache.get<PumpEvmCoin>(key);
  if (hit) return { ...hit, total_supply: hit.total_supply != null ? BigInt(hit.total_supply as unknown as string) : null };
  const c = await fetchPumpEvm(mint);
  if (!c) return null;
  const sv = (c.security_verdict ?? null) as { verdict?: string; reasons?: string[] } | null;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const coin: PumpEvmCoin = {
    name: str(c.name),
    symbol: str(c.symbol),
    creator: str(c.creator),
    created_ms: num(c.created_timestamp),
    market_cap_usd: num(c.market_cap_usd) ?? num(c.usd_market_cap) ?? num(c.market_cap),
    ath_market_cap_usd: num(c.ath_market_cap),
    liquidity_usd: num(c.canonical_pool_liquidity_usd),
    protocol: str(c.protocol),
    chain_id: typeof c.chain_id === "number" ? `eip155:${c.chain_id}` : str(c.chain_id),
    pool_address: str(c.pool_address),
    total_supply: supplyBigInt(c.total_supply_str ?? c.total_supply),
    is_banned: Boolean(c.is_banned),
    security_verdict: sv?.verdict ?? null,
    security_reason: sv?.reasons?.[0] ?? null,
  };
  // JSON can't hold a bigint — store the supply as a string, rehydrate on read.
  await cache.set(key, { ...coin, total_supply: coin.total_supply?.toString() ?? null } as unknown as PumpEvmCoin, 300);
  return coin;
}

/** A dev's launch record: how many coins they've shipped, and how many actually made it out. */
export interface PumpDevStats {
  /** Coins this wallet has ever created (capped at the page we fetch). */
  launches: number;
  /** True when the count hit our fetch cap — the real number is at least this. */
  capped: boolean;
  /** How many graduated the bonding curve (pump's `complete`). */
  graduated: number;
  /** How many still carry a non-trivial market cap right now. */
  alive: number;
}

/**
 * The single most decisive dev signal on pump.fun: the graveyard. A wallet on its 40th launch with
 * zero graduations is a serial rugger; a first-timer is merely unproven. One paginated call, cached
 * an hour (the count only grows). Null off pump.fun or on error.
 */
export async function pumpFunDevStats(dev: string, cache: KV, aliveMcapUsd = 5000): Promise<PumpDevStats | null> {
  const key = `pump_dev:${dev}`;
  const hit = await cache.get<PumpDevStats>(key);
  if (hit) return hit;
  const LIMIT = 100;
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins?creator=${dev}&limit=${LIMIT}&offset=0`, { headers: PUMP_HEADERS, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const coins = (await res.json()) as Array<{ complete?: boolean; usd_market_cap?: number }>;
    if (!Array.isArray(coins)) return null;
    const stats: PumpDevStats = {
      launches: coins.length,
      capped: coins.length >= LIMIT,
      graduated: coins.filter((c) => c.complete).length,
      alive: coins.filter((c) => (c.usd_market_cap ?? 0) >= aliveMcapUsd).length,
    };
    await cache.set(key, stats, 3600);
    return stats;
  } catch {
    return null;
  }
}
