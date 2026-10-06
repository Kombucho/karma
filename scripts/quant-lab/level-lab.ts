/**
 * LEVEL LAB — the dataset behind validating Jev's price-level percentages.
 *
 * For one coin (argv[2]), every 4h bar close t since 2020: the level engine's support/resistance levels
 * (1h candles; the live read adds 15m), and for each level everything knowable at t that might move the
 * odds of price reaching it, plus whether it did within 4h / 24h / 3d. Market conditions (the BTC/ETH/SOL
 * tide) and pattern ideas (1h/4h hypotheses pointing through the level) are INTERNAL inputs: they never
 * reach the card, they only sharpen or fail to sharpen the odds. Look-ahead safe: features read candles
 * < t, outcomes read candles ≥ t.
 *
 * Output: data/lab/levels/<SYM>.csv (header row). Usage: npx tsx scripts/quant-lab/level-lab.ts BTC
 * Run all coins in parallel: ls-coins | xargs -P 8 -I{} npx tsx scripts/quant-lab/level-lab.ts {}
 */
import { createWriteStream, mkdirSync } from "node:fs";
import type { Candle } from "../../src/lib/karma/sources/ta";
import { detectPatterns as looseShapes } from "../../src/lib/karma/quant/hypothesis-shapes";
import { pickLevels } from "../../src/lib/karma/quant/levels";
import { pivotsFor } from "../../src/lib/karma/quant/patterns";
import { sigmaDaily, touchProb } from "../../src/lib/karma/quant/physics";
import { dailyTrend, toBars, weeklyTrend } from "../../src/lib/karma/quant/swing-patterns";
import { existsSync, readFileSync } from "node:fs";
import { fillHourlyGaps } from "../../src/lib/karma/quant/features";
import { binanceHourly, gtHourly, kucoinHourly, LEVEL_COINS } from "./data";

/**
 * A coin's 1h history: Binance for the listed majors; for trench coins (data/lab/trench-coins.json, found and
 * verified by a research sub-agent) KuCoin when it has a longer history, else the coin's deepest DEX pool on
 * GeckoTerminal. DEX candles skip quiet hours, so they're gap-filled (a quiet hour is a real flat candle).
 */
async function loadCoin(sym: string): Promise<{ candles: Candle[]; source: string }> {
  if (LEVEL_COINS.includes(sym)) return { candles: await binanceHourly(sym), source: "binance" };
  const list = existsSync("data/lab/trench-coins.json") ? (JSON.parse(readFileSync("data/lab/trench-coins.json", "utf8")) as { ticker: string; mint: string; pair: string; kucoin: boolean }[]) : [];
  const coin = list.find((x) => x.ticker.toUpperCase() === sym);
  if (!coin) throw new Error(`${sym}: not in LEVEL_COINS or trench-coins.json`);
  // FORCE_GT=1: build from the DEX pool even when KuCoin has more history (the candle-source A/B test).
  const ku = coin.kucoin && process.env.FORCE_GT !== "1" ? await kucoinHourly(sym).catch(() => []) : [];
  const gt = await gtHourly("solana", coin.pair, coin.mint).catch(() => []);
  const best = ku.length > gt.length ? { candles: ku, source: "kucoin" } : { candles: gt, source: "geckoterminal" };
  return { candles: fillHourlyGaps(best.candles), source: best.source };
}

const H = 3600;
const STEP = 4 * H;
const HORIZONS = [4, 24, 72];

/** Index of the first candle with t >= at (candles sorted, 1h, gap-free from Binance). */
function idxAt(c: Candle[], at: number): number {
  let lo = 0;
  let hi = c.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (c[m].t < at) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const trendNum = (t: "up" | "down" | "flat" | null) => (t === "up" ? 1 : t === "down" ? -1 : 0);

/** Market tide at t from BTC/ETH/SOL 1h history: BTC daily/weekly trend, breadth above the 20d EMA, BTC returns. */
function tide(maj: Record<string, Candle[]>, at: number) {
  const out: Record<string, number> = {};
  let breadth = 0;
  for (const [s, c] of Object.entries(maj)) {
    const i = idxAt(c, at);
    if (i < 24 * 40) continue;
    const past = c.slice(Math.max(0, i - 24 * 200), i);
    const d = toBars(past, at, 60, 86400);
    const closes = d.map((x) => x.c);
    const k = 2 / 21;
    let e = closes[0];
    for (const x of closes) e += k * (x - e);
    if (closes.at(-1)! > e) breadth++;
    if (s === "BTC") {
      out.btc_d = trendNum(dailyTrend(past, at));
      out.btc_w = trendNum(weeklyTrend(past, at));
      out.btc_r24 = past.at(-1)!.c / past.at(-25)!.c - 1;
      out.btc_r7d = past.at(-1)!.c / past.at(-169)!.c - 1;
    }
  }
  out.breadth = breadth; // 0..3 majors above their 20-day EMA
  return out;
}

async function main() {
  const sym = process.argv[2];
  const { candles: c, source } = await loadCoin(sym);
  // Trench coins are young: a 14-day warm-up (volatility needs ~11 days; trends just read flat early on).
  const warm = (source === "binance" ? 60 : 14) * 86400;
  if (c.length < 24 * 20) {
    console.log(`${sym}: only ${c.length}h of history (${source}), skipped`);
    return;
  }
  const maj = { BTC: await binanceHourly("BTC"), ETH: await binanceHourly("ETH"), SOL: await binanceHourly("SOL") };
  mkdirSync("data/lab/levels", { recursive: true });
  mkdirSync("data/lab/levels-gt", { recursive: true });
  const out = createWriteStream(process.env.FORCE_GT === "1" ? `data/lab/levels-gt/${sym}.csv` : `data/lab/levels/${sym}.csv`);
  const cols = [
    "sym", "t", "hour", "dow", "side", "dist", "dist_atr", "score", "touches", "n_src", "src_pivot", "src_volume", "src_vwap", "src_fib", "src_round", "src_extreme", "src_band",
    "sigma", "vol_ratio", "vol_z", "rsi1h", "r24", "r7d", "coin_d", "coin_w", "btc_d", "btc_w", "btc_r24", "btc_r7d", "breadth",
    "hyp_through", "hyp_against", "hyp_n",
    "phys4", "phys24", "phys72", "y4", "y24", "y72",
  ];
  out.write(cols.join(",") + "\n");
  let rows = 0;
  const start = c[0].t + warm;
  for (let at = start - (start % STEP) + STEP; at < c.at(-1)!.t - 72 * H; at += STEP) {
    const i = idxAt(c, at);
    if (i < warm / H) continue;
    const past = c.slice(Math.max(0, i - 24 * 200), i);
    const price = past.at(-1)!.c;
    const c1h = past.slice(-168);
    const pv = pivotsFor(c1h, "1h");
    if (!pv.atr) continue;
    const daily = toBars(past, at, 60, 86400);
    const sig = sigmaDaily(daily, past.slice(-24 * 14));
    if (!sig) continue;
    const { picked } = pickLevels({ price, candles1h: c1h, candles15m: [], pivots1h: pv.pivots, pivots15m: [], atr: pv.atr, now: at });
    if (!picked.length) continue;

    // Coin context.
    const closes = c1h.map((x) => x.c);
    let gain = 0;
    let loss = 0;
    for (let k = closes.length - 14; k < closes.length; k++) {
      const d = closes[k] - closes[k - 1];
      if (d > 0) gain += d;
      else loss -= d;
    }
    const rsi = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    const vol6 = c1h.slice(-6).reduce((s, x) => s + x.v, 0) / 6;
    const volAll = c1h.reduce((s, x) => s + x.v, 0) / c1h.length;
    const volSd = Math.sqrt(c1h.reduce((s, x) => s + (x.v - volAll) ** 2, 0) / c1h.length);
    const r24 = price / past.at(-25)!.c - 1;
    const r7d = price / past.at(-169)!.c - 1;
    const dT = trendNum(dailyTrend(past, at));
    const wT = trendNum(weeklyTrend(past, at));
    const td = tide(maj, at);
    // Pattern ideas on 1h and 4h (loose shapes): direction + target, to count how many point through each level.
    const ideas: { bull: boolean; target: number }[] = [];
    for (const bars of [c1h.slice(-300), toBars(past, at, 300, 4 * H)]) {
      if (bars.length < 60) continue;
      for (const p of looseShapes(bars, "1h", price).candidates) {
        if (p.bias === "neutral" || p.target === null) continue;
        ideas.push({ bull: p.bias === "bull", target: p.target });
      }
    }
    const atrDay = pv.atr / price * Math.sqrt(24);
    const hour = new Date(at * 1000).getUTCHours();
    const dow = new Date(at * 1000).getUTCDay();

    for (const l of picked) {
      const up = l.side === "resistance";
      const toward = (x: number) => (up ? x : -x); // +1 = the trend points at the level
      const src = l.sources.join(" ").toLowerCase();
      const through = ideas.filter((h) => h.bull === up && (up ? h.target >= l.price : h.target <= l.price)).length;
      const against = ideas.filter((h) => h.bull !== up).length;
      const ys = HORIZONS.map((h) => {
        const j = idxAt(c, at);
        const end = at + h * H;
        if (c.at(-1)!.t < end) return "";
        for (let k = j; k < c.length && c[k].t < end; k++) if (up ? c[k].h >= l.price : c[k].l <= l.price) return 1;
        return 0;
      });
      const phys = HORIZONS.map((h) => touchProb(price, l.price, sig, h / 24));
      const row = [
        sym, at, hour, dow, up ? 1 : -1, Math.log(l.price / price), l.dist_atr, l.score, l.touches, l.sources.length,
        +src.includes("pivot"), +(src.includes("volume") || src.includes("poc")), +src.includes("vwap"), +src.includes("fib"), +src.includes("round"),
        +(src.includes("high") || src.includes("low")), +src.includes("bollinger"),
        sig, atrDay / sig, volSd > 0 ? (vol6 - volAll) / volSd : 0, rsi, r24, r7d, toward(dT), toward(wT),
        toward(td.btc_d ?? 0), toward(td.btc_w ?? 0), toward(td.btc_r24 ?? 0), toward(td.btc_r7d ?? 0), up ? td.breadth ?? 0 : 3 - (td.breadth ?? 0),
        through, against, ideas.length,
        ...phys, ...ys,
      ];
      out.write(row.map((x) => (typeof x === "number" ? (Number.isInteger(x) ? x : Number(x.toPrecision(5))) : x)).join(",") + "\n");
      rows++;
    }
  }
  out.end();
  console.log(`${sym}: ${rows} rows (${source}, ${c.length}h)`);
}

main();
