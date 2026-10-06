/**
 * Quant lab dataset: one row per coin every STEP hours, with everything knowable at t (features) and what
 * happened after t (outcomes). Features never read a candle or tweet bucket that ends after t.
 *
 * Usage: npx tsx scripts/quant-lab/build-dataset.ts [--step=12] [SYM ...]  →  data/lab/dataset.jsonl
 */
import { createWriteStream, mkdirSync } from "node:fs";
import type { Candle } from "../../src/lib/karma/sources/ta";
import { chartFeatures, CHART_WINDOW, fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { detectPatterns, followThrough } from "../../src/lib/karma/quant/swing-patterns";
import { kucoinHourly, LAB_COINS } from "./data";

const H = 3600;
const D = 86400;

export interface LabRow {
  id: string;
  sym: string;
  t: number;
  price: number;
  f: {
    coin: Record<string, number | null>;
    chart: ReturnType<typeof chartFeatures>;
    tide: Record<string, number | null>;
    patterns: Array<Record<string, number | string | boolean>>;
  };
  y: {
    h24: { dd: number; up: number; ret: number };
    h168: { dd: number; up: number; ret: number };
    /** Per detected pattern (same order as f.patterns): target | stop | neither | null. */
    patterns: Array<string | null>;
  };
}

/** Index of the last candle with t < at (binary search; candles sorted). */
function lastBefore(c: Candle[], at: number): number {
  let lo = 0;
  let hi = c.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid].t < at) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const priceAt = (c: Candle[], at: number) => {
  const i = lastBefore(c, at);
  return i >= 0 ? c[i].c : null;
};
const ret = (c: Candle[], at: number, hours: number) => {
  const a = priceAt(c, at - hours * H);
  const b = priceAt(c, at);
  return a && b ? b / a - 1 : null;
};

function emaSpread(c: Candle[], at: number): number | null {
  const i = lastBefore(c, at);
  if (i < 200) return null;
  const xs = c.slice(i - 199, i + 1).map((k) => k.c);
  const ema = (n: number) => xs.reduce((e, x, j) => (j === 0 ? x : e + (2 / (n + 1)) * (x - e)), xs[0]);
  return ema(20) / ema(50) - 1;
}

function contextFeatures(c: Candle[], at: number): Record<string, number | null> {
  const i = lastBefore(c, at);
  const px = c[i].c;
  let ath = 0;
  let athT = c[0].t;
  for (let k = 0; k <= i; k++) if (c[k].h > ath) [ath, athT] = [c[k].h, c[k].t];
  const d30 = c.slice(Math.max(0, i - 30 * 24 + 1), i + 1);
  const hi30 = Math.max(...d30.map((k) => k.h));
  const lo30 = Math.min(...d30.map((k) => k.l));
  // Realised daily volatility over 30 days, from 24h-spaced closes.
  const daily: number[] = [];
  for (let k = i; k - 24 >= 0 && daily.length < 30; k -= 24) daily.push(Math.log(c[k].c / c[k - 24].c));
  const mean = daily.reduce((a, b) => a + b, 0) / Math.max(1, daily.length);
  const vol = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  const v7 = c.slice(Math.max(0, i - 7 * 24 + 1), i + 1).reduce((s, k) => s + k.v, 0) / 7;
  const v30 = d30.reduce((s, k) => s + k.v, 0) / 30;
  return {
    age_days: (at - c[0].t) / D,
    from_ath: 1 - px / ath,
    days_since_ath: (at - athT) / D,
    ret_24h: ret(c, at, 24),
    ret_7d: ret(c, at, 168),
    ret_30d: ret(c, at, 720),
    vol_30d: daily.length > 5 ? vol : null,
    range_pos_30d: hi30 > lo30 ? (px - lo30) / (hi30 - lo30) : null,
    up_from_30d_low: px / lo30 - 1,
    volume_7d_vs_30d: v30 > 0 ? v7 / v30 : null,
  };
}

function tideFeatures(btc: Candle[], sol: Candle[], at: number): Record<string, number | null> {
  return {
    btc_ret_24h: ret(btc, at, 24),
    btc_ret_7d: ret(btc, at, 168),
    btc_trend: emaSpread(btc, at),
    sol_ret_24h: ret(sol, at, 24),
    sol_ret_7d: ret(sol, at, 168),
    sol_trend: emaSpread(sol, at),
  };
}

function pathOutcome(c: Candle[], at: number, hours: number, p0: number) {
  const path = c.filter((k) => k.t >= at && k.t < at + hours * H);
  if (path.length < hours * 0.8) return null;
  const lo = Math.min(...path.map((k) => k.l));
  const hi = Math.max(...path.map((k) => k.h));
  return { dd: Math.max(0, 1 - lo / p0), up: Math.max(0, hi / p0 - 1), ret: path.at(-1)!.c / p0 - 1 };
}

async function main() {
  const args = process.argv.slice(2);
  const step = Number(args.find((a) => a.startsWith("--step="))?.split("=")[1] ?? 12) * H;
  const syms = args.filter((a) => !a.startsWith("--"));
  const coins = syms.length ? syms : LAB_COINS;
  const [btc, sol] = [await kucoinHourly("BTC"), await kucoinHourly("SOL")];
  mkdirSync("data/lab", { recursive: true });
  const out = createWriteStream("data/lab/dataset.jsonl");
  let rows = 0;
  for (const sym of coins) {
    const raw = await kucoinHourly(sym);
    const c = fillHourlyGaps(raw);
    const start = c[0].t + 45 * D;
    const end = c.at(-1)!.t - 15 * D;
    let n = 0;
    for (let at = start - (start % step); at <= end; at += step) {
      const i = lastBefore(c, at);
      if (i < CHART_WINDOW) continue;
      const price = c[i].c;
      const h24 = pathOutcome(c, at, 24, price);
      const h168 = pathOutcome(c, at, 168, price);
      if (!h24 || !h168) continue;
      const pats = detectPatterns(c, at);
      const row: LabRow = {
        id: `${sym}:${at}`,
        sym,
        t: at,
        price,
        f: {
          coin: contextFeatures(c, at),
          chart: chartFeatures(c.slice(Math.max(0, i - CHART_WINDOW + 1), i + 1)),
          tide: tideFeatures(btc, sol, at),
          patterns: pats.map((p) => ({
            kind: p.kind,
            bias: p.bias,
            confirmed: p.confirmed,
            to_trigger: price / p.trigger - 1,
            to_target: p.target / price - 1,
            to_stop: p.stop / price - 1,
            quality: Math.round(p.quality * 100) / 100,
            bars_old: Math.round((at - p.end_t) / (4 * H)),
          })),
        },
        y: { h24, h168, patterns: pats.map((p) => followThrough(c, at, p)) },
      };
      out.write(JSON.stringify(row) + "\n");
      n++;
    }
    rows += n;
    console.log(`${sym}: ${n} rows`);
  }
  out.end();
  console.log(`total ${rows} rows → data/lab/dataset.jsonl`);
}

if (require.main === module) main();
