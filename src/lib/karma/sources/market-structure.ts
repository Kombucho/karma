import { address, isOffCurveAddress } from "@solana/kit";
import type { KV } from "../cache";
import { WSOL_MINT } from "../constants";
import { RateLimiter, fetchJson } from "../http";
import type { SolanaRpc } from "./solana";

/**
 * Market structure: the three ways a coin's chart can lie to you that the holder book doesn't show.
 *
 *   1. LP pull risk — who can take the liquidity out. Burned or locked LP can't be rugged; LP sitting in
 *      a normal wallet can be pulled in one transaction, and the chart goes to zero with it.
 *   2. Fake volume — how much of the "24h volume" is one operator trading with himself (buy+sell in the
 *      same transaction, or seconds apart) or bump bots spraying tiny identical buys to stay trending.
 *   3. Even shares — manufactured books carry suspiciously uniform bags; real ones are power-law.
 *
 * Budget: ≤ ~8 calls (1 DexScreener + ≤5 RPC + ≤2 Enhanced Transactions), all fired as early as their
 * inputs allow. Dependency-free past @solana/kit, defensive, never throws: every sub-read may be null.
 *
 * Layouts were verified on mainnet 25 Sep 2026 against live pools (KNOTS, GP, CACKLE, PEPENOM, MET):
 *   Raydium CPMM  lp_mint@136, lp_supply u64@333 (pool-tracked; SPL burns don't lower it)
 *   Raydium AMMv4 lp_mint@464, lp_reserve u64@720
 *   PumpSwap      lp_mint@107, lp_supply u64@203
 *   Meteora DAMM v1 lp_mint@8 (lock escrows are PDAs of the DAMM program)
 *   Meteora DAMM v2 liquidity u128@360, permanent_lock_liquidity u128@552 (position-based, no LP mint)
 *   Meteora DLMM  positions: owner@40, lb_pair@8 (getProgramAccounts memcmp, owner slice only)
 */

// ─── Programs ────────────────────────────────────────────────────────────────────────────────────
const RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAYDIUM_CLMM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const RAYDIUM_LAUNCHLAB = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const PUMP_SWAP = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const PUMP_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const METEORA_DAMM_V1 = "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB";
const METEORA_DAMM_V2 = "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
const METEORA_DLMM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const METEORA_DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const ORCA_WHIRLPOOL = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Where fungible LP lives in each pool account: the LP mint, and the pool's own count of LP issued. */
const LP_LAYOUT: Record<string, { amm: string; lpMint: number; lpIssued: number | null }> = {
  [RAYDIUM_CPMM]: { amm: "Raydium CPMM", lpMint: 136, lpIssued: 333 },
  [RAYDIUM_AMM_V4]: { amm: "Raydium AMM v4", lpMint: 464, lpIssued: 720 },
  [PUMP_SWAP]: { amm: "PumpSwap", lpMint: 107, lpIssued: 203 },
  [METEORA_DAMM_V1]: { amm: "Meteora DAMM v1", lpMint: 8, lpIssued: null },
};
/** Pools with no LP mint: liquidity lives in per-owner positions (NFTs or position accounts). */
const POSITION_AMMS: Record<string, string> = {
  [METEORA_DAMM_V2]: "Meteora DAMM v2",
  [METEORA_DLMM]: "Meteora DLMM",
  [RAYDIUM_CLMM]: "Raydium CLMM",
  [ORCA_WHIRLPOOL]: "Orca Whirlpool",
};
/** Launchpad curves: the reserves belong to the program, nobody holds a withdrawable LP stake. */
const CURVE_AMMS: Record<string, string> = {
  [PUMP_CURVE]: "pump.fun curve",
  [RAYDIUM_LAUNCHLAB]: "Raydium LaunchLab curve",
  [METEORA_DBC]: "Meteora DBC curve",
};
const DAMM_V2_LIQUIDITY = 360;
const DAMM_V2_PERMANENT_LOCK = 552;

/** LP owners that mean "gone for good". */
const BURN_OWNERS = new Set(["1nc1nerator11111111111111111111111111111111", SYSTEM_PROGRAM]);
/** Specific lock authorities (system-owned PDAs, so the program-owner test can't see them). */
const LOCK_OWNERS: Record<string, string> = {
  "3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH": "Raydium Burn & Earn",
};
/** Programs whose accounts holding LP mean a time- or permanently-locked position. */
const LOCKER_PROGRAMS: Record<string, string> = {
  LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE: "Raydium LP lock",
  gLHaGJsZ6G7AXZxoDL9EsSWkRbKAWhFHi73gVfNXuzK: "StakePoint locker",
  strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m: "Streamflow",
  LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn: "Jupiter Lock",
  [METEORA_DAMM_V1]: "Meteora lock escrow",
};

// ─── Tunables ────────────────────────────────────────────────────────────────────────────────────
/** Pools analysed for LP: the deepest few carrying at least this share of the coin's liquidity. */
const MAIN_POOLS = 3;
const MAIN_POOL_MIN_SHARE = 0.05;
/** LP holders read per pool (getTokenLargestAccounts returns 20; the tail is dust). */
const LP_HOLDERS_READ = 6;
/** Dust LP positions under this share are ignored when naming who can pull. */
const LP_DUST_SHARE = 0.005;
/** A pool whose 24h volume is this many × its liquidity, on a real slice of the coin's volume, is a wash pipe. */
const WASH_POOL_TURNOVER = 50;
const WASH_POOL_MIN_VOLUME_SHARE = 0.05;
/** Sampled swaps: second page only when the first held fewer swaps than this. */
const MIN_SWAPS_SAMPLE = 40;
/** Buy and sell by the same trader on the same pool within this many seconds = a round trip. */
const FLIP_WINDOW_S = 10;
/** A one-sided leg whose trader's net coin change is under this share of the leg was routed through (arb). */
const ROUTED_NET = 0.2;
/** Top-N traders whose share of sampled volume says "a handful of wallets". */
const HANDFUL = 5;
/** Bump bots: sub-$X buys repeated at one size (2 significant figures) this many times or more. */
const BUMP_MAX_USD = 5;
const BUMP_MIN_REPEATS = 3;
/** Even shares: the top-N real holders, and the near-equal band a manufactured cluster sits in. */
const EVEN_TOP_N = 20;
// A power-law book never puts 4 top-20 bags within 2% of each other, or 6 within 10% (that needs rank ≳50).
// Two bands, so both the identical-bag farm (CACKLE: 13 × 0.41%) and the plateau-then-cliff farm (14 wallets
// at 0.16-0.20%, then 0.02%) are caught.
const EVEN_BANDS = [
  { band: 1.02, min: 4 },
  { band: 1.1, min: 6 },
];
const EVEN_MIN_PCT = 0.1; // each member holds at least this % of supply (below it, dust ranks bunch up naturally)
const EVEN_DANGER_GROUP = 10;
/** Signal thresholds (see the check script's calibration table). */
const T = {
  pullableRed: 0.5, // share of the coin's liquidity one wallet can pull
  pullableAmber: 0.2,
  liqMcapRed: 0.01, // liquidity under 1% of market cap
  liqMcapAmber: 0.03,
  deepLiquidityUsd: 1_000_000,
  washRed: 0.5, // share of sampled volume that's round trips
  washAmber: 0.25,
  handfulRed: 0.8, // top-5 traders' share of sampled (non-routed) volume…
  handfulMinWindowS: 900, // …over a sample spanning at least 15 minutes
  bumpAmber: 0.6, // share of sampled swaps under BUMP_MAX_USD
  turnoverAmber: 30, // coin-wide 24h volume / liquidity
  evenCvRed: 0.15,
  evenCvAmber: 0.3,
  minSwapsForVerdict: 20,
};
const CACHE_TTL = 300;

const dexLimiter = new RateLimiter(250); // DexScreener: 300/min

// ─── Types ───────────────────────────────────────────────────────────────────────────────────────
export type MarketSeverity = "clean" | "caution" | "danger";

export interface MarketSignal {
  severity: Exclude<MarketSeverity, "clean">;
  /** One line, safe to render straight to a user. */
  text: string;
}

export type LpHolderKind = "burned" | "locked" | "wallet" | "program" | "unknown";

export interface LpHolder {
  owner: string;
  kind: LpHolderKind;
  /** Locker name when kind === "locked". */
  label: string | null;
  /** Share of the pool's LP (0-1). */
  share: number;
}

export interface PoolLp {
  address: string;
  dexId: string;
  /** DexScreener's pool label ("CPMM", "DLMM", "DYN2"…) or the AMM we decoded. */
  amm: string;
  quote: string;
  liquidity_usd: number;
  /** "lp_mint": fungible LP we can trace. "position": per-owner positions. "curve": launchpad reserves. */
  model: "lp_mint" | "position" | "curve" | "unknown";
  /** Shares of the pool's liquidity (0-1). Null where the model can't say. */
  burned_share: number | null;
  locked_share: number | null;
  /** Held by ordinary wallets: pullable in one transaction. */
  wallet_share: number | null;
  /** Held by PDAs/programs we don't recognise as lockers. */
  unknown_share: number | null;
  holders: LpHolder[];
  /** Position pools: positions and distinct owners found (DLMM only); null when not read. */
  positions: number | null;
  position_owners: number | null;
  /** USD a single wallet can take out right now (wallet_share × liquidity; position pools: see note). */
  pullable_usd: number | null;
  note: string;
}

export interface LpRisk {
  pools: PoolLp[];
  /** Coin-wide liquidity across pools where it's the base token. */
  liquidity_usd: number;
  mcap_usd: number | null;
  /** liquidity / market cap. The Signals Feed vetoes at 0.0004 (0.04%). */
  liq_to_mcap: number | null;
  /** Share of the coin's liquidity sitting in wallet-held LP — pullable in one tx. */
  pullable_share: number | null;
}

export interface VolumeRead {
  volume_h24_usd: number;
  volume_h1_usd: number;
  txns_h24: number;
  buys_h24: number;
  sells_h24: number;
  /** 24h volume / liquidity. Organic memecoins turn over ~0.5-5×/day; 30×+ is a wash tell. */
  turnover_h24: number | null;
  /** Average trade size (24h volume / trade count). Bump bots drag it to a few dollars. */
  avg_trade_usd: number | null;
  /** Pools moving far more volume than their liquidity could honestly support. */
  wash_pools: { address: string; dexId: string; volume_h24_usd: number; liquidity_usd: number; turnover: number }[];
}

export interface WashSample {
  pool: string;
  /** Transactions pulled, swaps on this pool among them, and the window they span. */
  txs: number;
  swaps: number;
  window_s: number;
  volume_usd: number;
  traders: number;
  /** Share of sampled volume in same-transaction buy+sell against this pool (Bitquery's #1 pattern). */
  same_tx_share: number;
  /** Share of sampled volume in sandwiches (a bot's buy and sell around someone else's trade). MEV, not wash. */
  sandwich_share: number;
  /** Share of sampled volume in buy→sell (or sell→buy) by one trader within FLIP_WINDOW_S. */
  quick_flip_share: number;
  /** same_tx + quick_flip, capped at 1: the round-trip share of volume. */
  wash_share: number;
  /** Share of sampled volume that only passed through the trader (arbitrage between the coin's pools). */
  routed_share: number;
  /** Share of the non-routed sampled volume from the top HANDFUL traders. */
  top_traders_share: number;
  /** Share of (non-routed) buys under BUMP_MAX_USD — bump / volume-bot micro buys. */
  micro_share: number;
  median_trade_usd: number | null;
  /** The most repeated micro size in USD (≥ BUMP_MIN_REPEATS hits), when there is one. */
  bump_size_usd: number | null;
}

export interface EvenShare {
  /** Holders considered (top real holders, max EVEN_TOP_N). */
  n: number;
  /** Coefficient of variation of their balances. Power-law books sit ~0.6-1.5; farms below ~0.3. */
  cv: number | null;
  /** The largest group of top holders whose bags sit within `group_band` (max/min) of each other, each ≥ EVEN_MIN_PCT. */
  group_size: number;
  group_band: number | null;
  group_pct: number;
  group_wallets: string[];
}

export interface MarketStructure {
  lp: LpRisk | null;
  volume: VolumeRead | null;
  wash: WashSample | null;
  even: EvenShare | null;
  signals: MarketSignal[];
  severity: MarketSeverity;
  /** Calls spent, by source — the scan's shared budget. */
  calls: { dexscreener: number; rpc: number; enhanced: number };
}

// ─── Raw shapes ──────────────────────────────────────────────────────────────────────────────────
interface DexPair {
  dexId: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  fdv?: number;
  marketCap?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h1?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

interface AccountB64 {
  owner: string;
  data: [string, string];
}

interface SwapTx {
  signature: string;
  timestamp: number;
  slot: number;
  feePayer: string;
  transactionError?: unknown;
  tokenTransfers?: { fromTokenAccount: string; toTokenAccount: string; fromUserAccount: string; toUserAccount: string; tokenAmount: number; mint: string }[];
  accountData?: { tokenBalanceChanges?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[] }[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────
const b58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = b58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
const keyAt = (buf: Buffer, off: number): string | null => (buf.length >= off + 32 ? base58(buf.subarray(off, off + 32)) : null);
const u64At = (buf: Buffer, off: number): bigint | null => (buf.length >= off + 8 ? buf.readBigUInt64LE(off) : null);
const u128At = (buf: Buffer, off: number): bigint | null => (buf.length >= off + 16 ? buf.readBigUInt64LE(off) + (buf.readBigUInt64LE(off + 8) << 64n) : null);
const ratio = (a: bigint, b: bigint): number => (b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : 0);
const pct = (x: number) => `${(x * 100).toFixed(x < 0.01 ? 2 : x < 0.1 ? 1 : 0)}%`;
const usd = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`);
const onCurve = (a: string) => {
  try {
    return !isOffCurveAddress(address(a));
  } catch {
    return false;
  }
};
const settle = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

function coefficientOfVariation(xs: number[]): number | null {
  const vals = xs.filter((x) => x > 0);
  if (vals.length < 2) return null;
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) / mean;
}

// ─── 3. Even shares (pure) ───────────────────────────────────────────────────────────────────────
/** Uniformity of the top real holders' bags. Pass infra-free holders; no calls. */
export function evenShare(holders: { wallet: string; pct_supply: number }[]): EvenShare | null {
  const top = [...holders].filter((h) => h.pct_supply > 0).sort((a, b) => b.pct_supply - a.pct_supply).slice(0, EVEN_TOP_N);
  if (top.length < 5) return null;
  // Largest run of near-identical bags: sorted descending, so a window [i, j] is within band iff top[i]/top[j] ≤ band.
  let group: typeof top = [];
  let groupBand: number | null = null;
  for (const { band, min } of EVEN_BANDS) {
    let best = { i: 0, j: -1 };
    for (let i = 0, j = 0; i < top.length && top[i].pct_supply >= EVEN_MIN_PCT; i++) {
      j = Math.max(j, i);
      while (j + 1 < top.length && top[j + 1].pct_supply >= EVEN_MIN_PCT && top[i].pct_supply / top[j + 1].pct_supply <= band) j++;
      if (j - i > best.j - best.i) best = { i, j };
    }
    if (best.j - best.i + 1 >= min && best.j - best.i + 1 > group.length) {
      group = top.slice(best.i, best.j + 1);
      groupBand = band;
    }
  }
  return {
    n: top.length,
    cv: coefficientOfVariation(top.map((h) => h.pct_supply)),
    group_size: group.length,
    group_band: groupBand,
    group_pct: group.reduce((s, h) => s + h.pct_supply, 0),
    group_wallets: group.map((h) => h.wallet),
  };
}

// ─── 1. LP pull risk ─────────────────────────────────────────────────────────────────────────────
async function readLp(
  rpc: SolanaRpc,
  mint: string,
  pairs: DexPair[],
  count: { rpc: number },
): Promise<LpRisk> {
  const own = pairs.filter((p) => p.baseToken.address === mint);
  const liquidity_usd = own.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const deepest = [...own].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const mcap_usd = deepest[0]?.marketCap ?? deepest[0]?.fdv ?? null;
  const main = deepest
    .filter((p) => (p.liquidity?.usd ?? 0) >= MAIN_POOL_MIN_SHARE * liquidity_usd)
    .slice(0, MAIN_POOLS);

  const pools: PoolLp[] = main.map((p) => ({
    address: p.pairAddress,
    dexId: p.dexId,
    amm: p.labels?.[0] ?? p.dexId,
    quote: p.quoteToken.address === WSOL_MINT ? "SOL" : p.quoteToken.symbol,
    liquidity_usd: p.liquidity?.usd ?? 0,
    model: "unknown",
    burned_share: null,
    locked_share: null,
    wallet_share: null,
    unknown_share: null,
    holders: [],
    positions: null,
    position_owners: null,
    pullable_usd: null,
    note: "pool account unreadable",
  }));

  // Call 1: every main pool account at once — which AMM, and where its LP lives.
  count.rpc++;
  const accts = await settle(rpc.call<{ value: (AccountB64 | null)[] }>("getMultipleAccounts", [pools.map((p) => p.address), { encoding: "base64" }]));
  const lpMintOf = new Map<PoolLp, { mint: string; issued: bigint | null }>();
  let dlmm: PoolLp | null = null;
  pools.forEach((pool, i) => {
    const a = accts?.value[i];
    if (!a) return;
    const buf = Buffer.from(a.data[0], "base64");
    const lay = LP_LAYOUT[a.owner];
    if (lay) {
      const lpMint = keyAt(buf, lay.lpMint);
      pool.amm = lay.amm;
      pool.model = "lp_mint";
      if (lpMint) lpMintOf.set(pool, { mint: lpMint, issued: lay.lpIssued === null ? null : u64At(buf, lay.lpIssued) });
      return;
    }
    if (POSITION_AMMS[a.owner]) {
      pool.amm = POSITION_AMMS[a.owner];
      pool.model = "position";
      pool.note = "position-based: each LP can withdraw their own position at any time; owners not resolved";
      if (a.owner === METEORA_DAMM_V2) {
        const liq = u128At(buf, DAMM_V2_LIQUIDITY);
        const perm = u128At(buf, DAMM_V2_PERMANENT_LOCK);
        if (liq && perm !== null && liq > 0n) {
          pool.locked_share = Math.min(1, ratio(perm, liq));
          pool.unknown_share = 1 - pool.locked_share;
          pool.note =
            pool.locked_share > 0.99
              ? "permanently locked on-chain (DAMM v2)"
              : `${pct(pool.locked_share)} permanently locked; the rest is position-based and withdrawable by its owners`;
        }
      }
      if (a.owner === METEORA_DLMM && !dlmm) dlmm = pool;
      return;
    }
    if (CURVE_AMMS[a.owner]) {
      pool.amm = CURVE_AMMS[a.owner];
      pool.model = "curve";
      pool.burned_share = 0;
      pool.locked_share = 1;
      pool.wallet_share = 0;
      pool.note = "bonding curve: reserves belong to the program, no LP to pull";
      return;
    }
    pool.note = `unrecognised AMM program ${a.owner.slice(0, 6)}…`;
  });

  // Call 2 (parallel): LP largest holders per LP-mint pool, and DLMM position owners for the deepest DLMM pool.
  const lpPools = [...lpMintOf.keys()];
  const [largest, positions] = await Promise.all([
    Promise.all(
      lpPools.map((p) => {
        count.rpc++;
        return settle(rpc.call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [lpMintOf.get(p)!.mint]));
      }),
    ),
    dlmm
      ? (count.rpc++,
        settle(
          rpc.call<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [
            METEORA_DLMM,
            { encoding: "base64", dataSlice: { offset: 40, length: 32 }, filters: [{ memcmp: { offset: 8, bytes: (dlmm as PoolLp).address } }] },
          ]),
        ))
      : Promise.resolve(null),
  ]);

  if (dlmm && positions) {
    const d = dlmm as PoolLp;
    const owners = new Map<string, number>();
    for (const p of positions) {
      const o = keyAt(Buffer.from(p.account.data[0], "base64"), 0);
      if (o) owners.set(o, (owners.get(o) ?? 0) + 1);
    }
    d.positions = positions.length;
    d.position_owners = owners.size;
    d.note =
      owners.size === 0
        ? "position-based: no open positions found"
        : owners.size === 1
          ? `position-based: all ${positions.length} position${positions.length > 1 ? "s" : ""} belong to one wallet (${[...owners.keys()][0].slice(0, 4)}…), which can withdraw it all`
          : `position-based: ${positions.length} positions from ${owners.size} wallets, each can withdraw their own`;
    if (owners.size === 1) {
      d.wallet_share = 1;
      d.unknown_share = 0;
      d.holders = [{ owner: [...owners.keys()][0], kind: onCurve([...owners.keys()][0]) ? "wallet" : "program", label: null, share: 1 }];
    }
  }

  // Call 3: LP mints (supply) + their biggest token accounts (owners), one jsonParsed read.
  const tokenAccts: { pool: PoolLp; address: string; amount: bigint }[] = [];
  lpPools.forEach((pool, i) => {
    for (const v of (largest[i]?.value ?? []).slice(0, LP_HOLDERS_READ)) if (BigInt(v.amount) > 0n) tokenAccts.push({ pool, address: v.address, amount: BigInt(v.amount) });
  });
  if (!lpPools.length) return finishLp(pools, liquidity_usd, mcap_usd);
  const lpMints = lpPools.map((p) => lpMintOf.get(p)!.mint);
  count.rpc++;
  const parsed = await settle(
    rpc.call<{ value: ({ data: { parsed?: { info?: { owner?: string; supply?: string } } } } | null)[] }>("getMultipleAccounts", [
      [...lpMints, ...tokenAccts.map((t) => t.address)],
      { encoding: "jsonParsed" },
    ]),
  );
  if (!parsed) {
    for (const p of lpPools) p.note = "LP holders unreadable";
    return finishLp(pools, liquidity_usd, mcap_usd);
  }
  const supplyOf = new Map<PoolLp, bigint>();
  lpPools.forEach((p, i) => {
    const s = parsed.value[i]?.data.parsed?.info?.supply;
    if (s !== undefined) supplyOf.set(p, BigInt(s));
  });
  const ownerOfAcct = tokenAccts.map((_, i) => parsed.value[lpMints.length + i]?.data.parsed?.info?.owner ?? null);

  // Call 4 (only when needed): which program owns each off-curve LP owner we don't already recognise.
  const unresolved = [...new Set(ownerOfAcct.filter((o): o is string => !!o && !BURN_OWNERS.has(o) && !LOCK_OWNERS[o] && !onCurve(o)))];
  const programOf = new Map<string, string | null>();
  if (unresolved.length) {
    count.rpc++;
    const infos = await settle(rpc.call<{ value: ({ owner: string } | null)[] }>("getMultipleAccounts", [unresolved, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]));
    unresolved.forEach((o, i) => programOf.set(o, infos?.value[i]?.owner ?? null));
  }

  for (const pool of lpPools) {
    const supply = supplyOf.get(pool);
    const issued = lpMintOf.get(pool)!.issued;
    if (supply === undefined) {
      pool.note = "LP mint unreadable";
      continue;
    }
    // The pool's own LP count survives SPL burns, so issued − supply is LP burned outside any account.
    const base = issued && issued >= supply ? issued : supply;
    if (base === 0n) {
      pool.note = "no LP outstanding";
      continue;
    }
    let burned = base - supply;
    const holders: LpHolder[] = [];
    tokenAccts.forEach((t, i) => {
      if (t.pool !== pool) return;
      const owner = ownerOfAcct[i];
      if (!owner) return;
      const share = ratio(t.amount, base);
      let kind: LpHolderKind;
      let label: string | null = null;
      if (BURN_OWNERS.has(owner)) {
        kind = "burned";
        burned += t.amount;
      } else if (LOCK_OWNERS[owner]) {
        kind = "locked";
        label = LOCK_OWNERS[owner];
      } else if (onCurve(owner)) kind = "wallet";
      else {
        const prog = programOf.get(owner);
        if (prog && LOCKER_PROGRAMS[prog]) {
          kind = "locked";
          label = LOCKER_PROGRAMS[prog];
        } else kind = prog ? "program" : "unknown";
      }
      holders.push({ owner, kind, label, share });
    });
    const sum = (k: LpHolderKind) => holders.filter((h) => h.kind === k).reduce((s, h) => s + h.share, 0);
    pool.holders = holders.filter((h) => h.share >= LP_DUST_SHARE);
    pool.burned_share = Math.min(1, ratio(burned, base));
    pool.locked_share = sum("locked");
    pool.wallet_share = sum("wallet");
    pool.unknown_share = Math.max(0, 1 - pool.burned_share - pool.locked_share - pool.wallet_share);
    pool.pullable_usd = pool.wallet_share * pool.liquidity_usd;
    const bits: string[] = [];
    if (pool.burned_share >= LP_DUST_SHARE) bits.push(`${pct(pool.burned_share)} burned`);
    if (pool.locked_share >= LP_DUST_SHARE) bits.push(`${pct(pool.locked_share)} locked (${[...new Set(holders.filter((h) => h.kind === "locked").map((h) => h.label))].join(", ")})`);
    if (pool.wallet_share >= LP_DUST_SHARE) bits.push(`${pct(pool.wallet_share)} in wallets that can pull it`);
    if (pool.unknown_share >= LP_DUST_SHARE) bits.push(`${pct(pool.unknown_share)} held by programs we can't verify`);
    pool.note = bits.join(", ") || "LP fully accounted for";
  }
  return finishLp(pools, liquidity_usd, mcap_usd);
}

function finishLp(pools: PoolLp[], liquidity_usd: number, mcap_usd: number | null): LpRisk {
  const known = pools.filter((p) => p.wallet_share !== null);
  const pullable = known.reduce((s, p) => s + (p.wallet_share ?? 0) * p.liquidity_usd, 0);
  return {
    pools,
    liquidity_usd,
    mcap_usd,
    liq_to_mcap: mcap_usd ? liquidity_usd / mcap_usd : null,
    pullable_share: known.length && liquidity_usd > 0 ? pullable / liquidity_usd : null,
  };
}

// ─── 2. Volume and wash trading ──────────────────────────────────────────────────────────────────
function readVolume(mint: string, pairs: DexPair[]): VolumeRead | null {
  const own = pairs.filter((p) => p.baseToken.address === mint);
  if (!own.length) return null;
  const v24 = own.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const liq = own.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const buys = own.reduce((s, p) => s + (p.txns?.h24?.buys ?? 0), 0);
  const sells = own.reduce((s, p) => s + (p.txns?.h24?.sells ?? 0), 0);
  return {
    volume_h24_usd: v24,
    volume_h1_usd: own.reduce((s, p) => s + (p.volume?.h1 ?? 0), 0),
    txns_h24: buys + sells,
    buys_h24: buys,
    sells_h24: sells,
    turnover_h24: liq > 0 ? v24 / liq : null,
    avg_trade_usd: buys + sells > 0 ? v24 / (buys + sells) : null,
    wash_pools: own
      .map((p) => ({ address: p.pairAddress, dexId: p.dexId, volume_h24_usd: p.volume?.h24 ?? 0, liquidity_usd: p.liquidity?.usd ?? 0, turnover: (p.volume?.h24 ?? 0) / Math.max(1, p.liquidity?.usd ?? 0) }))
      .filter((p) => p.turnover >= WASH_POOL_TURNOVER && p.volume_h24_usd >= WASH_POOL_MIN_VOLUME_SHARE * v24)
      .sort((a, b) => b.volume_h24_usd - a.volume_h24_usd),
  };
}

/** One swap against the sampled pool, reduced to the vault's legs of the coin. */
interface Leg {
  /** Chronological position in the sample (the API returns newest first). */
  seq: number;
  slot: number;
  t: number;
  trader: string;
  buy: number; // tokens out of the vault
  sell: number; // tokens into the vault
  /** The coin only passed through the trader (arbitrage / multi-hop route), it didn't stay or leave. */
  routed: boolean;
}

async function sampleWash(rpc: SolanaRpc, mint: string, pool: string, priceUsd: number, count: { enhanced: number }): Promise<WashSample | null> {
  count.enhanced++;
  const first = await settle(rpc.enhancedTransactions(pool, { limit: 100 }));
  if (!first) return null;
  let txs = first as unknown as SwapTx[];
  const swapCount = (xs: SwapTx[]) => xs.filter((tx) => tx.tokenTransfers?.some((x) => x.mint === mint)).length;
  if (swapCount(txs) < MIN_SWAPS_SAMPLE && txs.length === 100) {
    count.enhanced++;
    const more = await settle(rpc.enhancedTransactions(pool, { limit: 100, before: txs[txs.length - 1].signature }));
    if (more) txs = [...txs, ...(more as unknown as SwapTx[])];
  }
  txs = txs.filter((tx) => !tx.transactionError);

  // The vault is the coin's token account that shows up in the most transactions of this pool:
  // every swap moves the coin through it, and nothing else recurs as often. Layout-free across AMMs.
  const seen = new Map<string, number>();
  for (const tx of txs) {
    const accts = new Set<string>();
    for (const x of tx.tokenTransfers ?? []) if (x.mint === mint) accts.add(x.fromTokenAccount).add(x.toTokenAccount);
    for (const a of accts) seen.set(a, (seen.get(a) ?? 0) + 1);
  }
  const vault = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!vault) return null;

  const legs: Leg[] = [];
  let vaultOwner: string | null = null;
  for (const tx of txs) {
    let buy = 0;
    let sell = 0;
    for (const x of tx.tokenTransfers ?? []) {
      if (x.mint !== mint) continue;
      if (x.fromTokenAccount === vault) {
        buy += x.tokenAmount;
        vaultOwner ??= x.fromUserAccount;
      }
      if (x.toTokenAccount === vault) {
        sell += x.tokenAmount;
        vaultOwner ??= x.toUserAccount;
      }
    }
    if (buy === 0 && sell === 0) continue;
    // Trader = the fee payer, unless it never touched the coin (a relayer / gasless router): then the
    // wallet whose coin balance moved the most. Only on-curve wallets count — the other side of a route
    // is another pool's PDA or an AMM authority, never a trader.
    const changes = (tx.accountData ?? [])
      .flatMap((a) => a.tokenBalanceChanges ?? [])
      .filter((c) => c.mint === mint && c.userAccount !== vaultOwner && onCurve(c.userAccount));
    const netOf = (w: string) => changes.filter((c) => c.userAccount === w).reduce((s, c) => s + Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals, 0);
    let trader = tx.feePayer;
    if (!changes.some((c) => c.userAccount === tx.feePayer) && changes.length)
      trader = changes.reduce((a, b) => (Math.abs(netOf(b.userAccount)) > Math.abs(netOf(a.userAccount)) ? b : a)).userAccount;
    // Arb bots keep a multi-pool coin's pools aligned: the coin comes out of pool A and goes into pool B
    // in one tx, so no wallet's balance moves by the leg. That's real (if hollow) volume, not a self-trade.
    const routed = (buy === 0) !== (sell === 0) && Math.abs(netOf(trader)) < ROUTED_NET * (buy + sell);
    legs.push({ seq: 0, slot: tx.slot, t: tx.timestamp, trader, buy, sell, routed });
  }
  if (!legs.length) return null;
  legs.reverse().forEach((l, i) => (l.seq = i));

  const vol = (l: Leg) => (l.buy + l.sell) * priceUsd;
  const total = legs.reduce((s, l) => s + vol(l), 0);
  // Same-transaction round trip against this very vault. Arbitrage through two different pools only
  // touches this vault once, so it doesn't count here.
  const sameTx = legs.filter((l) => l.buy > 0 && l.sell > 0).reduce((s, l) => s + vol(l), 0);
  const routed = legs.filter((l) => l.routed).reduce((s, l) => s + vol(l), 0);

  // Quick flips: one trader, opposite sides, within FLIP_WINDOW_S, across transactions. A flip with
  // someone else's same-side trade in between, all inside one slot (a Jito bundle), is a sandwich — MEV
  // preying on that trade, not self-trading. Across slots, trades in between are just a busy pool.
  const flipped = new Set<Leg>();
  const sandwiched = new Set<Leg>();
  const byTrader = new Map<string, Leg[]>();
  for (const l of legs) if (!(l.buy > 0 && l.sell > 0) && !l.routed) byTrader.set(l.trader, [...(byTrader.get(l.trader) ?? []), l]);
  for (const ls of byTrader.values()) {
    ls.sort((a, b) => a.t - b.t);
    for (let i = 0; i < ls.length; i++)
      for (let j = i + 1; j < ls.length && ls[j].t - ls[i].t <= FLIP_WINDOW_S; j++)
        if ((ls[i].buy > 0) !== (ls[j].buy > 0)) {
          const [a, b] = ls[i].seq < ls[j].seq ? [ls[i], ls[j]] : [ls[j], ls[i]];
          const victim = a.slot === b.slot && legs.some((k) => k.seq > a.seq && k.seq < b.seq && k.trader !== a.trader && (k.buy > 0) === (a.buy > 0));
          const into = victim ? sandwiched : flipped;
          into.add(a);
          into.add(b);
        }
  }
  for (const l of sandwiched) flipped.delete(l);
  const quick = [...flipped].reduce((s, l) => s + vol(l), 0);
  const mev = [...sandwiched].reduce((s, l) => s + vol(l), 0);

  const perTrader = new Map<string, number>();
  for (const l of legs) if (!l.routed) perTrader.set(l.trader, (perTrader.get(l.trader) ?? 0) + vol(l));
  const topShare = [...perTrader.values()].sort((a, b) => b - a).slice(0, HANDFUL).reduce((s, v) => s + v, 0);
  const organic = total - routed;

  // Bump / volume bots: micro trades, often from a rotating farm of wallets so no single one stands out.
  // The tell is the size distribution, not the wallet: organic memecoin trades have a median of tens of
  // dollars; a botted pool's is a dollar or two. The modal size (2 significant figures) names the bot.
  const own = legs.filter((l) => !l.routed);
  const sizesSorted = own.map(vol).sort((a, b) => a - b);
  const median = sizesSorted.length ? sizesSorted[Math.floor(sizesSorted.length / 2)] : null;
  const bucket = (x: number) => Number(x.toPrecision(2));
  // Bumps are buys (a green tick on the chart); inventory/arb bots trade tiny sizes both ways, so only buys count.
  const buys = own.filter((l) => l.buy > 0 && l.sell === 0);
  const tiny = buys.filter((l) => vol(l) < BUMP_MAX_USD);
  const sizes = new Map<number, number>();
  for (const l of tiny) sizes.set(bucket(vol(l)), (sizes.get(bucket(vol(l))) ?? 0) + 1);
  const modal = [...sizes].filter(([, n]) => n >= BUMP_MIN_REPEATS).sort((a, b) => b[1] - a[1])[0];

  const ts = legs.map((l) => l.t);
  return {
    pool,
    txs: txs.length,
    swaps: legs.length,
    window_s: Math.max(...ts) - Math.min(...ts),
    volume_usd: total,
    traders: perTrader.size,
    routed_share: total > 0 ? routed / total : 0,
    same_tx_share: total > 0 ? sameTx / total : 0,
    sandwich_share: total > 0 ? mev / total : 0,
    quick_flip_share: total > 0 ? quick / total : 0,
    wash_share: total > 0 ? Math.min(1, (sameTx + quick) / total) : 0,
    top_traders_share: organic > 0 ? topShare / organic : 0,
    micro_share: buys.length ? tiny.length / buys.length : 0,
    median_trade_usd: median,
    bump_size_usd: modal ? modal[0] : null,
  };
}

// ─── Signals ─────────────────────────────────────────────────────────────────────────────────────
function signalsOf(ms: Omit<MarketStructure, "signals" | "severity" | "calls">): MarketSignal[] {
  const out: MarketSignal[] = [];
  const { lp, volume, wash, even } = ms;

  if (lp) {
    const walletPools = lp.pools.filter((p) => (p.wallet_share ?? 0) >= 0.05);
    const pull = lp.pullable_share;
    if (pull !== null && pull >= T.pullableAmber) {
      const p = walletPools[0];
      out.push({
        severity: pull >= T.pullableRed ? "danger" : "caution",
        text: `${pct(pull)} of the liquidity (${usd(pull * lp.liquidity_usd)}) sits in LP a wallet can pull in one transaction${p ? ` — ${p.amm} ${p.quote} pool, ${pct(p.wallet_share ?? 0)} of its LP unlocked` : ""}`,
      });
    }
    const main = lp.pools[0];
    if (main?.model === "position" && main.position_owners !== null && main.position_owners <= 2 && main.liquidity_usd >= 0.5 * lp.liquidity_usd)
      out.push({ severity: "caution", text: `the main pool (${main.amm}) is ${main.position_owners === 1 ? "one wallet's" : "two wallets'"} position — withdrawable at will, not locked` });
    // A big coin's DEX float can be a thin slice of its cap and still absorb real size; only flag amber when it's shallow in dollars too.
    if (lp.liq_to_mcap !== null && (lp.liq_to_mcap < T.liqMcapRed || (lp.liq_to_mcap < T.liqMcapAmber && lp.liquidity_usd < T.deepLiquidityUsd)))
      out.push({
        severity: lp.liq_to_mcap < T.liqMcapRed ? "danger" : "caution",
        text: `liquidity is ${pct(lp.liq_to_mcap)} of market cap (${usd(lp.liquidity_usd)} under ${usd(lp.mcap_usd ?? 0)}) — the price can't absorb real selling`,
      });
  }

  if (wash && wash.swaps >= T.minSwapsForVerdict) {
    if (wash.wash_share >= T.washAmber)
      out.push({
        severity: wash.wash_share >= T.washRed ? "danger" : "caution",
        text: `${pct(wash.wash_share)} of recent volume is round trips — the same wallet buying and selling ${wash.same_tx_share >= wash.quick_flip_share ? "inside one transaction" : `within ${FLIP_WINDOW_S}s`} (sampled ${wash.swaps} swaps)`,
      });
    // Over a few minutes a handful of MMs and bots always dominate an active pool; only a long window means something.
    if (wash.top_traders_share >= T.handfulRed && wash.traders >= HANDFUL && wash.window_s >= T.handfulMinWindowS)
      out.push({ severity: "caution", text: `${HANDFUL} wallets did ${pct(wash.top_traders_share)} of the last ${wash.swaps} swaps' volume` });
    if (wash.micro_share >= T.bumpAmber && (wash.median_trade_usd ?? Infinity) < BUMP_MAX_USD)
      out.push({
        severity: "caution",
        text: `${pct(wash.micro_share)} of recent buys are under $${BUMP_MAX_USD} (median $${(wash.median_trade_usd ?? 0).toFixed(2)}) — bump/volume bots keeping the coin on the trending lists`,
      });
  }
  if (volume) {
    for (const p of volume.wash_pools.slice(0, 1))
      out.push({ severity: "caution", text: `${usd(p.volume_h24_usd)} of 24h volume ran through a ${p.dexId} pool holding ${usd(p.liquidity_usd)} (${Math.round(p.turnover)}× turnover) — volume that pool can't honestly carry` });
    if (volume.turnover_h24 !== null && volume.turnover_h24 >= T.turnoverAmber && !volume.wash_pools.length)
      out.push({ severity: "caution", text: `24h volume is ${Math.round(volume.turnover_h24)}× the liquidity — far past organic turnover` });
  }

  if (even && even.cv !== null && even.cv < T.evenCvAmber)
    out.push({ severity: even.cv < T.evenCvRed ? "danger" : "caution", text: `the top ${even.n} holders' bags are near-identical in size (spread ${even.cv.toFixed(2)}) — a manufactured book, not a power-law crowd` });
  else if (even && even.group_size > 0 && even.group_band)
    out.push({
      severity: even.group_size >= EVEN_DANGER_GROUP ? "danger" : "caution",
      text: `${even.group_size} of the top ${even.n} holders hold the same bag to within ${Math.round((even.group_band - 1) * 100)}% (${even.group_pct.toFixed(1)}% of supply together) — real crowds don't buy in identical sizes`,
    });
  return out;
}

// ─── Entry point ─────────────────────────────────────────────────────────────────────────────────
/**
 * LP pull risk, fake volume, and even-share read for a mint. `holders` are the top real (non-infra)
 * holders with their % of supply. Cached ~5 min (the network reads; even-share is recomputed). Never throws.
 */
export async function readMarketStructure(
  rpc: SolanaRpc,
  cache: KV,
  mint: string,
  holders: { wallet: string; pct_supply: number }[],
): Promise<MarketStructure | null> {
  try {
    const even = evenShare(holders);
    const key = `mstruct:${mint}`;
    const hit = await cache.get<Omit<MarketStructure, "even" | "signals" | "severity">>(key);
    const calls = { dexscreener: 0, rpc: 0, enhanced: 0 };
    let base = hit;
    if (!base) {
      calls.dexscreener++;
      const pairs = (await settle(fetchJson<DexPair[]>(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`, {}, { limiter: dexLimiter }))) ?? [];
      const own = pairs.filter((p) => p.baseToken.address === mint).sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      // Sample the pool where the volume actually happens (a wash pipe is often NOT the deepest pool).
      const busiest = [...own].sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))[0];
      const priceUsd = Number(own[0]?.priceUsd ?? 0);
      const [lp, wash] = await Promise.all([
        own.length ? settle(readLp(rpc, mint, pairs, calls)) : Promise.resolve(null),
        busiest && priceUsd > 0 ? settle(sampleWash(rpc, mint, busiest.pairAddress, priceUsd, calls)) : Promise.resolve(null),
      ]);
      base = { lp, volume: readVolume(mint, pairs), wash, calls };
      if (pairs.length) await cache.set(key, base, CACHE_TTL);
    }
    const partial = { ...base, even };
    const signals = signalsOf(partial);
    const severity: MarketSeverity = signals.some((s) => s.severity === "danger") ? "danger" : signals.length ? "caution" : "clean";
    return { ...partial, signals, severity, calls: hit ? calls : base.calls };
  } catch {
    return null;
  }
}
