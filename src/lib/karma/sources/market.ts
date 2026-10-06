import type { KV } from "../cache";

/**
 * The tide under every coin: is the broad crypto market risk-on or risk-off right now. Not a call on
 * any coin, context — aping a fresh launch into a bleeding BTC is a different bet than into a green
 * one, and the scan should say which world you're in.
 *
 * All keyless from Binance (verified): spot klines for trend, futures "data" endpoints for the
 * derivatives skew. There is NO free market-wide liquidation feed (Binance retired the public one,
 * Coinglass paywalls it), so "squeeze pressure" is an honest PROXY built from funding + open
 * interest + the gap between retail and top-trader positioning, never labelled as real liquidations.
 */

const SPOT = "https://api.binance.com/api/v3";
const FUT = "https://fapi.binance.com";

const SYMBOLS = [
  { key: "BTC", pair: "BTCUSDT" },
  { key: "SOL", pair: "SOLUSDT" },
  { key: "ETH", pair: "ETHUSDT" },
] as const;

export type AssetKey = (typeof SYMBOLS)[number]["key"];

export interface AssetRegime {
  symbol: AssetKey;
  price: number | null;
  /** up = price above both EMAs and EMA20>EMA50; down = the mirror; chop = neither. */
  trend: "up" | "down" | "chop" | null;
  chg_24h: number | null; // fraction, e.g. -0.03 = down 3%
  chg_7d: number | null;
  funding: number | null; // latest funding rate (positive = longs pay shorts = crowded longs)
  oi_change_24h: number | null; // fraction change in open interest over ~24h
  /** Honest proxy for where a liquidation cascade would accumulate, from funding + OI direction. */
  squeeze: "longs-crowded" | "shorts-crowded" | "balanced" | null;
}

export interface MarketRegime {
  as_of: number;
  assets: AssetRegime[];
  risk: "risk-on" | "risk-off" | "mixed";
  /** One-line human read of the tide. */
  note: string;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Exponential moving average of the last values in `xs`. */
function ema(xs: number[], period: number): number | null {
  if (xs.length < period) return null;
  const k = 2 / (period + 1);
  let e = xs.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < xs.length; i++) e = xs[i] * k + e * (1 - k);
  return e;
}

async function assetRegime(sym: (typeof SYMBOLS)[number]): Promise<AssetRegime> {
  const out: AssetRegime = {
    symbol: sym.key,
    price: null,
    trend: null,
    chg_24h: null,
    chg_7d: null,
    funding: null,
    oi_change_24h: null,
    squeeze: null,
  };

  // Trend from 1h closes (200 candles ≈ 8.3 days — enough for EMA50 and a 7d change).
  const klines = await getJson<unknown[][]>(`${SPOT}/klines?symbol=${sym.pair}&interval=1h&limit=200`);
  if (klines && klines.length) {
    const closes = klines.map((k) => Number(k[4])).filter((n) => Number.isFinite(n));
    const price = closes.at(-1) ?? null;
    const e20 = ema(closes, 20);
    const e50 = ema(closes, 50);
    out.price = price;
    if (price !== null && closes.length >= 24) out.chg_24h = price / closes[closes.length - 24] - 1;
    if (price !== null && closes.length >= 168) out.chg_7d = price / closes[closes.length - 168] - 1;
    if (price !== null && e20 !== null && e50 !== null) {
      out.trend = price > e20 && e20 > e50 ? "up" : price < e20 && e20 < e50 ? "down" : "chop";
    }
  }

  // Derivatives: latest funding + open-interest direction over ~24h.
  const funding = await getJson<Array<{ fundingRate: string }>>(`${FUT}/fapi/v1/fundingRate?symbol=${sym.pair}&limit=1`);
  if (funding && funding[0]) out.funding = Number(funding[0].fundingRate);

  const oi = await getJson<Array<{ sumOpenInterestValue: string }>>(
    `${FUT}/futures/data/openInterestHist?symbol=${sym.pair}&period=1h&limit=24`,
  );
  if (oi && oi.length >= 2) {
    const first = Number(oi[0].sumOpenInterestValue);
    const last = Number(oi[oi.length - 1].sumOpenInterestValue);
    if (first > 0) out.oi_change_24h = last / first - 1;
  }

  // Squeeze proxy: crowded longs (positive funding + rising OI) liquidate on a dip; crowded shorts
  // (negative funding) are squeeze fuel on a pop. Not real liquidation data — a positioning read.
  if (out.funding !== null) {
    const oiRising = (out.oi_change_24h ?? 0) > 0.02;
    if (out.funding > 0.0002 && oiRising) out.squeeze = "longs-crowded";
    else if (out.funding < -0.00005) out.squeeze = "shorts-crowded";
    else out.squeeze = "balanced";
  }

  return out;
}

/** The market tide, cached 10 minutes (it moves slowly relative to a coin scan). */
export async function fetchMarketRegime(cache: KV, now: number): Promise<MarketRegime | null> {
  const key = "market_regime";
  const hit = await cache.get<MarketRegime>(key);
  if (hit) return hit;

  const assets = await Promise.all(SYMBOLS.map((s) => assetRegime(s).catch(() => null)));
  const ok = assets.filter((a): a is AssetRegime => a !== null);
  if (!ok.length) return null;

  // Risk read: lean on BTC first (it leads), then the breadth of up vs down across the three.
  const ups = ok.filter((a) => a.trend === "up").length;
  const downs = ok.filter((a) => a.trend === "down").length;
  const btc = ok.find((a) => a.symbol === "BTC");
  let risk: MarketRegime["risk"];
  if (ups >= 2 && downs === 0) risk = "risk-on";
  else if (downs >= 2 && ups === 0) risk = "risk-off";
  else if (btc?.trend === "down" && downs >= ups) risk = "risk-off";
  else if (btc?.trend === "up" && ups >= downs) risk = "risk-on";
  else risk = "mixed";

  const btcTxt =
    btc && btc.chg_24h !== null ? `BTC ${btc.chg_24h >= 0 ? "+" : ""}${(btc.chg_24h * 100).toFixed(1)}% 24h` : "BTC flat";
  const note =
    risk === "risk-on"
      ? `The tide is risk-on: ${btcTxt}, majors trending up.`
      : risk === "risk-off"
        ? `The tide is risk-off: ${btcTxt}, majors bleeding — every fresh launch is swimming against it.`
        : `The tide is mixed: ${btcTxt}, no clear direction across majors.`;

  const regime: MarketRegime = { as_of: now, assets: ok, risk, note };
  await cache.set(key, regime, 600);
  return regime;
}
