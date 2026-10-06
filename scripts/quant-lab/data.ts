/**
 * Quant lab data layer: long 1h histories the free on-chain feeds can't give (GeckoTerminal stops at 180
 * days), cached on disk so every experiment replays the same world.
 *
 *  - candles: KuCoin spot 1h, <SYM>-USDT, full listing history (1500/page, newest-first)
 *
 * Cache: data/lab/cache/<kind>-<SYM>.json (gitignored). Delete a file to refetch it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Candle } from "../../src/lib/karma/sources/ta";

const CACHE = "data/lab/cache";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with retries on network resets (long pulls hit ECONNRESET now and then). */
async function getWithRetry(url: string, init?: RequestInit): Promise<Response> {
  for (let i = 0; ; i++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      if (i >= 5) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

function cached<T>(name: string): T | null {
  const f = `${CACHE}/${name}.json`;
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
}
function store(name: string, v: unknown) {
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(`${CACHE}/${name}.json`, JSON.stringify(v));
}

/** Full 1h history, oldest-first, NOT gap-filled (the caller decides). v = quote (USDT) volume. */
export async function kucoinHourly(sym: string): Promise<Candle[]> {
  const hit = cached<Candle[]>(`candles-${sym}`);
  if (hit) return hit;
  const out = new Map<number, Candle>();
  let end = Math.floor(Date.now() / 1000);
  let empty = 0;
  for (let page = 0; page < 60; page++) {
    const start = end - 1500 * 3600;
    const res = await getWithRetry(`https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=${sym}-USDT&startAt=${start}&endAt=${end}`);
    const j = (await res.json()) as { code: string; data?: string[][] };
    if (j.code === "429000") {
      await sleep(3000);
      page--;
      continue;
    }
    const rows = j.data ?? [];
    // One empty page can be a listing gap; two in a row is before the listing.
    if (!rows.length && ++empty >= 2) break;
    if (rows.length) empty = 0;
    for (const [t, o, c, h, l, , turnover] of rows) out.set(Number(t), { t: Number(t), o: +o, h: +h, l: +l, c: +c, v: +turnover });
    end = start;
    await sleep(300);
  }
  const candles = [...out.values()].sort((a, b) => a.t - b.t);
  store(`candles-${sym}`, candles);
  return candles;
}

/** 15-minute KuCoin candles over [from, to), oldest-first — for replaying the 15m/1h chart read. */
export async function kucoin15m(sym: string, from: number, to: number): Promise<Candle[]> {
  const name = `candles15m-${sym}-${from}-${to}`;
  const hit = cached<Candle[]>(name);
  if (hit) return hit;
  const out = new Map<number, Candle>();
  for (let end = to; end > from; end -= 1500 * 900) {
    const start = Math.max(from, end - 1500 * 900);
    const res = await getWithRetry(`https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${sym}-USDT&startAt=${start}&endAt=${end}`);
    const j = (await res.json()) as { code: string; data?: string[][] };
    if (j.code === "429000") {
      await sleep(3000);
      end += 1500 * 900;
      continue;
    }
    for (const [t, o, c, h, l, , turnover] of j.data ?? []) out.set(Number(t), { t: Number(t), o: +o, h: +h, l: +l, c: +c, v: +turnover });
    await sleep(300);
  }
  const candles = [...out.values()].sort((a, b) => a.t - b.t);
  store(name, candles);
  return candles;
}

/**
 * Binance spot 1h klines, <SYM>USDT, from `since` to now, oldest-first (1000 per request, keyless).
 * The level lab's source: years of history for the majors, gap-free, quote volume in USDT.
 */
export async function binanceHourly(sym: string, since = Date.UTC(2020, 0, 1) / 1000): Promise<Candle[]> {
  const name = `binance1h-${sym}`;
  const hit = cached<Candle[]>(name);
  if (hit) return hit;
  const out: Candle[] = [];
  let start = since * 1000;
  for (let page = 0; page < 200; page++) {
    const res = await getWithRetry(`https://api.binance.com/api/v3/klines?symbol=${sym}USDT&interval=1h&limit=1000&startTime=${start}`);
    if (res.status === 429 || res.status === 418) {
      await sleep(30_000);
      page--;
      continue;
    }
    const rows = (await res.json()) as (string | number)[][];
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ t: Number(r[0]) / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] });
    start = Number(rows.at(-1)![0]) + 3600_000;
    if (rows.length < 1000) break;
    await sleep(120);
  }
  store(name, out);
  return out;
}

/**
 * GeckoTerminal 1h candles for a DEX pool, priced in `mint`, paged back with before_timestamp. The free API
 * serves ~180 days, which covers the trenches (most of them are younger). Spaced 2.5s apart: GT 429s bursts.
 */
export async function gtHourly(network: string, pool: string, mint: string): Promise<Candle[]> {
  const name = `gt1h-${network}-${pool}`;
  const hit = cached<Candle[]>(name);
  if (hit) return hit;
  const out = new Map<number, Candle>();
  let before = Math.floor(Date.now() / 1000);
  let fails = 0;
  for (let page = 0; page < 8; page++) {
    await sleep(2500);
    const res = await getWithRetry(`https://api.geckoterminal.com/api/v2/networks/${network}/pools/${pool}/ohlcv/hour?limit=1000&before_timestamp=${before}&currency=usd&token=${mint}`);
    if (res.status === 429 || res.status >= 500) {
      // Rate limit or a GT server error (502s happen): wait and retry the same page, up to a point.
      if (++fails > 6) break;
      await sleep(20_000);
      page--;
      continue;
    }
    if (!res.ok) break; // 401 = past the free window
    const j = (await res.json()) as { data?: { attributes?: { ohlcv_list?: number[][] } } };
    const list = j.data?.attributes?.ohlcv_list ?? [];
    if (!list.length) break;
    for (const [t, o, h, l, c, v] of list) out.set(t, { t, o, h, l, c, v });
    before = Math.min(...list.map((r) => r[0]));
  }
  const candles = [...out.values()].sort((a, b) => a.t - b.t);
  if (candles.length) store(name, candles); // never cache a failure as "no history"
  return candles;
}

/** The level lab universe: top coins across majors, large alts and memecoins, all Binance-listed. */
export const LEVEL_COINS = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "LINK", "DOT", "TRX", "LTC", "NEAR", "SUI", "APT", "ARB", "OP",
  "INJ", "TIA", "SEI", "WIF", "BONK", "PEPE", "FLOKI", "SHIB", "JUP", "PYTH", "RENDER", "FET", "TAO", "ONDO", "ENA", "WLD",
  "BOME", "PENGU", "PNUT", // TRUMP dropped: a larp, per Kombucho (so is MELANIA, out of the trench set)
];

/** The lab universe: Solana memecoins with long KuCoin histories. Tickers, not mints — the lab is chart + X only. */
export const LAB_COINS = [
  "BONK", "WIF", "POPCAT", "MEW", "BOME", "PNUT", "GOAT", "MOODENG", "CHILLGUY", "ZEREBRO", "FWOG", "GIGA",
  "TRUMP", "PENGU", "PONKE", "MYRO", "WEN", "GRIFFAIN", "BAN", "ACT", "FARTCOIN", "TROLL", "USELESS", "MELANIA",
];
/** The market tide the coins swim in. */
export const TIDE = ["BTC", "SOL"];
