import type { KV } from "../cache";
import { WSOL_MINT } from "../constants";
import { RateLimiter, fetchJson } from "../http";
import type { PoolRef, TokenMeta } from "../types";
import { pumpFunCurveAddress } from "./pumpfun";

// Dexscreener allows 300 requests/min
const limiter = new RateLimiter(250);
const META_TTL = 6 * 3600;

interface DexToken {
  address: string;
  name: string;
  symbol: string;
}

interface DexPair {
  dexId: string;
  pairAddress: string;
  baseToken: DexToken;
  quoteToken: DexToken;
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
  info?: { imageUrl?: string };
}

/** Symbol, supply and SOL-quoted pools for a mint. */
export async function getTokenMeta(mint: string, cache: KV): Promise<TokenMeta> {
  const key = `meta:${mint}`;
  const hit = await cache.get<TokenMeta>(key);
  if (hit) return hit;

  const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, {}, { limiter });
  const meta = metaFromPairs(mint, pairs ?? []);
  // Graduated pump.fun tokens drop their bonding curve from Dexscreener, but that's where early buys happened
  if (mint.endsWith("pump") && !meta.pools.some((p) => p.dexId === "pumpfun"))
    meta.pools.push({ address: await pumpFunCurveAddress(mint), dexId: "pumpfun", createdAt: null, liquidityUsd: 0 });

  await cache.set(key, meta, META_TTL);
  return meta;
}

const SOL_PRICE_TTL = 3600;

/** Current SOL/USD from the deepest wSOL pair. Null on failure — callers degrade to SOL-only display. */
export async function getSolPriceUsd(cache: KV): Promise<number | null> {
  const key = "sol_price_usd";
  const hit = await cache.get<number>(key);
  if (hit) return hit;

  try {
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`, {}, { limiter });
    const best = (pairs ?? [])
      .filter((p) => p.baseToken.address === WSOL_MINT && Number(p.priceUsd) > 0)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const price = best ? Number(best.priceUsd) : null;
    if (price) await cache.set(key, price, SOL_PRICE_TTL);
    return price;
  } catch {
    return null;
  }
}

function metaFromPairs(mint: string, pairs: DexPair[]): TokenMeta {
  const meta: TokenMeta = { mint, symbol: null, name: null, supply: null, logoUrl: null, volume24hUsd: 0, pools: [] };
  for (const p of pairs) {
    const isBase = p.baseToken.address === mint;
    if (!isBase && p.quoteToken.address !== mint) continue;
    const self = isBase ? p.baseToken : p.quoteToken;
    meta.symbol ??= self.symbol;
    meta.name ??= self.name;
    if (isBase && meta.logoUrl === null && p.info?.imageUrl) meta.logoUrl = p.info.imageUrl;
    if (isBase) meta.volume24hUsd += p.volume?.h24 ?? 0;
    const priceUsd = Number(p.priceUsd);
    if (isBase && meta.supply === null && p.fdv && priceUsd > 0) meta.supply = p.fdv / priceUsd;

    const other = isBase ? p.quoteToken.address : p.baseToken.address;
    if (other !== WSOL_MINT) continue;
    const pool: PoolRef = {
      address: p.pairAddress,
      dexId: p.dexId,
      createdAt: p.pairCreatedAt ? Math.floor(p.pairCreatedAt / 1000) : null,
      liquidityUsd: p.liquidity?.usd ?? 0,
    };
    meta.pools.push(pool);
  }
  return meta;
}
