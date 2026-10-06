import type { KV } from "../cache";
import { HttpError, RateLimiter, fetchJson } from "../http";
import type { Candle } from "../types";

const BASE = "https://api.geckoterminal.com/api/v2/networks/solana";
// Public API: 30 calls/min, 180 days of history, 1000 candles per call
const limiter = new RateLimiter(60_000 / 28);
const PAGE = 1000;

export interface Timeframe {
  timeframe: "minute" | "hour" | "day";
  aggregate: number;
  seconds: number;
}

export const MINUTE_1: Timeframe = { timeframe: "minute", aggregate: 1, seconds: 60 };
export const MINUTE_15: Timeframe = { timeframe: "minute", aggregate: 15, seconds: 900 };

type Row = [number, number, number, number, number, number];

/**
 * Candles for `mint` priced in SOL (`currency=token` on a SOL-quoted pool) covering [from, to].
 * Pages backwards from `to`. Pages that end more than an hour ago are cached forever.
 */
export async function getCandles(
  pool: string,
  mint: string,
  tf: Timeframe,
  from: number,
  to: number,
  cache: KV,
  maxPages = 4,
): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = new Map<number, Row>();
  let before = Math.ceil(to / tf.seconds) * tf.seconds;

  for (let page = 0; page < maxPages; page++) {
    const key = `ohlcv:${pool}:${mint}:${tf.timeframe}${tf.aggregate}:${before}`;
    let list = await cache.get<Row[]>(key);
    if (!list) {
      list = await fetchOhlcv(pool, mint, tf, before);
      await cache.set(key, list, before < now - 3600 ? undefined : 600);
    }
    for (const r of list) rows.set(r[0], r);
    if (list.length < PAGE) break;
    const oldest = Math.min(...list.map((r) => r[0]));
    if (oldest <= from) break;
    before = oldest;
  }

  return [...rows.values()]
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, res: tf.seconds, pool }))
    .filter((c) => c.t + c.res > from && c.t < to)
    .sort((a, b) => a.t - b.t);
}

async function fetchOhlcv(pool: string, mint: string, tf: Timeframe, before: number): Promise<Row[]> {
  const url =
    `${BASE}/pools/${pool}/ohlcv/${tf.timeframe}?aggregate=${tf.aggregate}` +
    `&before_timestamp=${before}&limit=${PAGE}&currency=token&token=${mint}`;
  try {
    const json = await fetchJson<{ data?: { attributes?: { ohlcv_list?: Row[] } } }>(url, {}, { limiter });
    return json.data?.attributes?.ohlcv_list ?? [];
  } catch (err) {
    // 401: beyond the public 180-day window. 404: pool not indexed. Both mean "no data", not a crash.
    if (err instanceof HttpError && [400, 401, 404].includes(err.status)) return [];
    throw err;
  }
}
