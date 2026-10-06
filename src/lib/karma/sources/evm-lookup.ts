import type { KV } from "../cache";
import { fetchJson } from "../http";
import { evmChain, evmChains, evmTokenMeta, evmTotalSupply, type EvmChain } from "./evm";
import type { PumpEvmCoin } from "./pumpfun";

/**
 * Finding an EVM coin pump.fun doesn't know. pump's record is the richest source, but a Robinhood
 * (or Base, BSC…) coin launched anywhere else, or a moment when pump's API refuses Vercel, used to
 * end the scan at "couldn't find this coin" even though the chain, the holder book and the chart all
 * read it fine. This resolves the address to a chain + market from the next-best places, in order of
 * how much they tell us: DexScreener (one call, every chain), GeckoTerminal (one call per chain we
 * read), then the chains themselves (the contract answers totalSupply → it lives there).
 *
 * The result is shaped like pump's record so the scan downstream doesn't branch; pump-only fields
 * (ATH, security verdict, creator) are null and `source` says where the facts came from.
 */

export type EvmCoinSource = "pump.fun" | "dexscreener" | "geckoterminal" | "onchain";
export type EvmCoinRecord = PumpEvmCoin & { source: EvmCoinSource };

const blank = (chain: EvmChain, source: EvmCoinSource): EvmCoinRecord => ({
  name: null, symbol: null, creator: null, created_ms: null, market_cap_usd: null, ath_market_cap_usd: null,
  liquidity_usd: null, protocol: null, chain_id: `eip155:${chain.id}`, pool_address: null, total_supply: null,
  is_banned: false, security_verdict: null, security_reason: null, source,
});

/** DexScreener's chain slugs → our chain rows. Robinhood's slug is matched loosely (it's new). */
function chainFromDexId(dexChain: string): EvmChain | null {
  const k = dexChain.toLowerCase();
  const byKey: Record<string, number> = { bsc: 56, base: 8453, ethereum: 1, hyperevm: 999, hyperliquid: 999 };
  if (byKey[k]) return evmChain(byKey[k]);
  if (k.includes("robinhood")) return evmChain(4663);
  return null;
}

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  pairCreatedAt?: number;
}

async function fromDexScreener(mint: string): Promise<EvmCoinRecord | null> {
  const r = await fetchJson<{ pairs?: DexPair[] | null }>(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, { retries: 1, timeoutMs: 8000 });
  const lc = mint.toLowerCase();
  const pairs = (r.pairs ?? []).filter((p) => chainFromDexId(p.chainId) && (p.baseToken.address.toLowerCase() === lc || p.quoteToken.address.toLowerCase() === lc));
  if (!pairs.length) return null;
  // The chain the coin trades most on, and its deepest pool there.
  const top = pairs.slice().sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const chain = chainFromDexId(top.chainId)!;
  const self = top.baseToken.address.toLowerCase() === lc ? top.baseToken : top.quoteToken;
  const onChain = pairs.filter((p) => p.chainId === top.chainId);
  const born = onChain.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === "number");
  return {
    ...blank(chain, "dexscreener"),
    name: self.name || null,
    symbol: self.symbol || null,
    created_ms: born.length ? Math.min(...born) : null,
    market_cap_usd: top.marketCap ?? top.fdv ?? null,
    liquidity_usd: onChain.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0) || null,
    protocol: top.dexId || null,
    pool_address: top.pairAddress || null,
  };
}

interface GtToken {
  data?: {
    attributes?: { name?: string; symbol?: string; market_cap_usd?: string | null; fdv_usd?: string | null; total_reserve_in_usd?: string | null };
  };
  included?: Array<{ type: string; attributes?: { address?: string; pool_created_at?: string | null; reserve_in_usd?: string | null }; relationships?: { dex?: { data?: { id?: string } } } }>;
}

async function fromGeckoTerminal(mint: string): Promise<EvmCoinRecord | null> {
  const chains = evmChains().filter((c) => c.gt);
  const hits = await Promise.all(
    chains.map(async (chain) => {
      const r = await fetchJson<GtToken>(`https://api.geckoterminal.com/api/v2/networks/${chain.gt}/tokens/${mint}?include=top_pools`, {}, { retries: 0, timeoutMs: 8000 }).catch(() => null);
      return r?.data?.attributes ? { chain, r } : null;
    }),
  );
  const hit = hits.find((h) => h !== null);
  if (!hit) return null;
  const a = hit.r.data!.attributes!;
  const pools = (hit.r.included ?? []).filter((i) => i.type === "pool");
  const num = (v: string | null | undefined) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null);
  const born = pools.map((p) => (p.attributes?.pool_created_at ? Date.parse(p.attributes.pool_created_at) : NaN)).filter(Number.isFinite);
  return {
    ...blank(hit.chain, "geckoterminal"),
    name: a.name ?? null,
    symbol: a.symbol ?? null,
    created_ms: born.length ? Math.min(...born) : null,
    market_cap_usd: num(a.market_cap_usd) ?? num(a.fdv_usd),
    liquidity_usd: num(a.total_reserve_in_usd),
    protocol: pools[0]?.relationships?.dex?.data?.id ?? null,
    pool_address: pools[0]?.attributes?.address ?? null,
  };
}

/** Which chain a contract lives on: the first we read whose RPC answers its totalSupply. */
export async function findEvmChain(mint: string): Promise<{ chain: EvmChain; supply: bigint } | null> {
  const chains = evmChains();
  const supplies = await Promise.all(chains.map((c) => evmTotalSupply(c, mint).catch(() => null)));
  const i = supplies.findIndex((s) => s !== null && s > 0n);
  return i < 0 ? null : { chain: chains[i], supply: supplies[i]! };
}

/** No market anywhere: ask each chain whether this contract exists. */
async function fromChains(mint: string): Promise<EvmCoinRecord | null> {
  const found = await findEvmChain(mint);
  if (!found) return null;
  const meta = await evmTokenMeta(found.chain, mint).catch(() => ({ name: null, symbol: null }));
  return { ...blank(found.chain, "onchain"), ...meta, total_supply: found.supply };
}

/** Resolve an EVM coin pump.fun doesn't carry. Short-cached; null when no chain we read has it. */
export async function findEvmCoin(mint: string, cache: KV): Promise<EvmCoinRecord | null> {
  const key = `evm_find:${mint.toLowerCase()}`;
  const hit = await cache.get<EvmCoinRecord>(key);
  if (hit) return { ...hit, total_supply: hit.total_supply != null ? BigInt(hit.total_supply as unknown as string) : null };
  const coin =
    (await fromDexScreener(mint).catch(() => null)) ??
    (await fromGeckoTerminal(mint).catch(() => null)) ??
    (await fromChains(mint).catch(() => null));
  if (coin) await cache.set(key, { ...coin, total_supply: coin.total_supply?.toString() ?? null } as unknown as EvmCoinRecord, 300);
  return coin;
}
