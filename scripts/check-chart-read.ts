/**
 * End-to-end check of JEV · CHART READ (chart-v2): GeckoTerminal 15m / 1h / 4h / 12h / 1d candles → pivots,
 * audited swing patterns with the weekly check → candidate levels → one Jev call → headline + gradable targets.
 *
 * Sanity checks per coin:
 *  - price scale: DexScreener's live price vs the last 15m / 1h close (catches charting the pool's base
 *    token instead of our coin), and every level inside the coin's own candle range (±50%).
 *  - geometry: every level pivot is the candle's actual high / low at that index, and the extreme of its
 *    neighbourhood (±2 bars).
 *
 * Usage: npx tsx --env-file=.env.local scripts/check-chart-read.ts [mint ...]
 * With no mints: PURR, KNOTS, ZCAT + the top 2 other coins on GeckoTerminal's Solana trending list.
 */
import { MemoryCache } from "../src/lib/karma/cache";
import type { Candle } from "../src/lib/karma/sources/ta";
import { chartReadTargets, fetchChartCandles, readChartPatternsAndLevels } from "../src/lib/karma/quant/chart-read-engine";
import { fetchMarketNow } from "../src/lib/karma/quant/features";
import { fmtPrice, type Pivot } from "../src/lib/karma/quant/patterns";

const FIXED: [string, string][] = [
  ["PURR", "8RNUw4N655VSrZKuhGdywhbSMDTrheguFPfxbpE2NZHQ"], // GT search "PURR": the Hypurr pools with the most volume
  ["KNOTS", "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS"],
  ["ZCAT", "HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR"],
];

async function trending(n: number, skip: Set<string>): Promise<[string, string][]> {
  const res = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools", { signal: AbortSignal.timeout(8000) });
  const j = (await res.json()) as { data?: Array<{ attributes?: { name?: string }; relationships?: { base_token?: { data?: { id?: string } } } }> };
  const out: [string, string][] = [];
  for (const p of j.data ?? []) {
    const m = (p.relationships?.base_token?.data?.id ?? "").replace("solana_", "");
    const sym = (p.attributes?.name ?? "?").split(" / ")[0];
    if (m && !skip.has(m) && !out.some(([, x]) => x === m) && !["SOL", "USDC", "USDT"].includes(sym)) out.push([sym, m]);
    if (out.length >= n) break;
  }
  return out;
}

const ago = (t: number) => `${((Date.now() / 1000 - t) / 3600).toFixed(1)}h`;

function checkPivots(ps: Pivot[], candles: Candle[]): string[] {
  const bad: string[] = [];
  for (const [k, p] of ps.entries()) {
    const c = candles[p.i];
    if (!c || c.t !== p.t) {
      bad.push(`pivot@${p.i} not on a candle`);
      continue;
    }
    const want = p.type === "H" ? c.h : c.l;
    if (want !== p.price) bad.push(`pivot@${p.i} ${p.type} ${p.price} != candle ${want}`);
    if (k && ps[k - 1].type === p.type) bad.push(`pivot@${p.i} same type as the one before`);
    // zigzag invariant: a pivot is the extreme of every candle between its two neighbouring pivots
    const from = k ? ps[k - 1].i + 1 : 0;
    const to = k + 1 < ps.length ? ps[k + 1].i - 1 : candles.length - 1;
    const span = candles.slice(from, to + 1);
    const ext = p.type === "H" ? Math.max(...span.map((x) => x.h)) : Math.min(...span.map((x) => x.l));
    if (ext !== p.price) bad.push(`pivot@${p.i} ${p.type} ${fmtPrice(p.price)} not the extreme between its neighbours (${fmtPrice(ext)})`);
  }
  return bad;
}

(async () => {
  const cache = new MemoryCache();
  const args = process.argv.slice(2);
  const coins: [string, string][] = args.length ? args.map((m) => [m.slice(0, 6), m]) : [...FIXED, ...(await trending(2, new Set(FIXED.map(([, m]) => m))))];
  let cost = 0;
  let calls = 0;
  for (const [i, [sym, mint]] of coins.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 20_000)); // GT free tier: ~3 calls per coin, keep well under 10/min
    const chart = await fetchChartCandles("solana", mint, cache);
    const { pool, candles15m, candles1h } = chart;
    const market = await fetchMarketNow(mint);
    const price = market?.price_usd ?? null;
    console.log(`\n══════ ${sym} ${mint} · pool ${pool ?? "NONE"} · 15m ${candles15m?.length ?? 0} · 1h ${candles1h?.length ?? 0} · 4h ${chart.candles4h?.length ?? 0} · 12h ${chart.candles12h?.length ?? 0} · 1d ${chart.candles1d?.length ?? 0} · dex price ${price ?? "?"}`);
    if (!candles15m && !candles1h) {
      console.log("no candles");
      continue;
    }
    const t0 = Date.now();
    const read = await readChartPatternsAndLevels(mint, chart, price, cache);
    const ms = Date.now() - t0;
    const c15 = candles15m ?? [];
    const c1h = candles1h ?? [];
    const all = [...c15, ...c1h];
    const lo = Math.min(...all.map((c) => c.l));
    const hi = Math.max(...all.map((c) => c.h));

    // price scale
    const last15 = c15.at(-1)?.c;
    const last1h = c1h.at(-1)?.c;
    const scale = [last15, last1h].filter((x): x is number => !!x).map((x) => (price ? x / price : 1));
    console.log(`price ${fmtPrice(read.price ?? 0)} · last 15m close ${last15 ? fmtPrice(last15) : "-"} · last 1h close ${last1h ? fmtPrice(last1h) : "-"} · candle range ${fmtPrice(lo)}–${fmtPrice(hi)} · ATR1h ${fmtPrice(read.atr_1h ?? 0)} (${(((read.atr_1h ?? 0) / (read.price ?? 1)) * 100).toFixed(1)}%)`);
    if (scale.some((x) => x < 0.8 || x > 1.25)) console.log(`  !! SCALE: candle close / dex price = ${scale.map((x) => x.toFixed(2)).join(", ")}`);

    const d = read.debug;
    const pv = (ps: Pivot[]) => ps.slice(-8).map((p) => `${p.type}${p.confirmed ? "" : "?"} ${fmtPrice(p.price)} (${ago(p.t)})`).join(" · ");
    console.log(`pivots 1h  [${d.pivots1h.length}]: ${pv(d.pivots1h)}`);
    console.log(`pivots 15m [${d.pivots15m.length}]: ${pv(d.pivots15m)}`);
    const pivotBad = [...checkPivots(d.pivots1h, c1h), ...checkPivots(d.pivots15m, c15)];
    console.log(pivotBad.length ? `  !! PIVOTS: ${pivotBad.slice(0, 5).join("; ")}` : "  pivots ok (each = candle extreme, the extreme between its neighbours, alternating H/L)");

    console.log("patterns:");
    for (const p of read.patterns) {
      console.log(`  ${p.kind.padEnd(20)} ${p.tf ?? "1h"} ${p.bias.padEnd(7)} weekly ${p.weekly ?? "-"} ${p.confirmed ? "confirmed" : "forming"} · random-walk target-first ${p.p_resolves?.toFixed(2) ?? "-"}`);
      console.log(`    ${p.levels.map((l) => `${l.name} ${fmtPrice(l.price)}`).join(", ")}`);
    }
    console.log(`week: ${JSON.stringify(read.week)}`);
    console.log("levels:");
    const outOfRange: string[] = [];
    for (const l of read.levels) {
      if (l.price < lo * 0.5 || l.price > hi * 1.5) outOfRange.push(fmtPrice(l.price));
      console.log(`  ${l.side.padEnd(10)} ${fmtPrice(l.price).padEnd(12)} ${(l.dist * 100).toFixed(1).padStart(6)}%  touch 24h ${l.p_touch_24h?.toFixed(2) ?? "-"} 7d ${l.p_touch_7d?.toFixed(2) ?? "-"}  ← ${l.sources.join("; ")}`);
    }
    if (outOfRange.length) console.log(`  !! LEVELS outside the coin's candle range: ${outOfRange.join(", ")}`);
    console.log(`HEADLINE: ${read.headline ?? "(none)"}`);
    console.log(`jev: ${read.jev ? `${read.jev.model} $${read.jev.cost_usd} · ${read.jev.input_tokens} input tokens` : "NO ANSWER"} · read ${ms}ms · ${Object.keys(d.answers ?? {}).length} answers · state ${JSON.stringify(d.state).length} chars`);
    console.log(`targets: ${chartReadTargets(read).length} gradable claims (${[...new Set(chartReadTargets(read).map((t) => t.claim))].join(", ")})`);
    if (process.env.VERBOSE) console.log(JSON.stringify(d.state, null, 1));
    if (read.jev?.cost_usd) {
      cost += read.jev.cost_usd;
      calls++;
    }
  }
  console.log(`\nJev: ${calls} reads, $${cost.toFixed(6)} total, $${calls ? (cost / calls).toFixed(6) : "-"} per read`);
})();
