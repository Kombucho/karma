/**
 * End-to-end check of the quant features: stored scan (or a fresh scanCoin) + GeckoTerminal candles +
 * DexScreener market → buildFeatures → Jev answers on RUBRIC_V1. Also sanity-checks the indicators
 * (ranges, and RSI / ATR against a second, independently written computation).
 *
 * Usage: npx tsx --env-file=.env.local scripts/check-features.ts [mint ...]
 * With no mints: KNOTS, GP, CACKLE + the top 2 other coins on GeckoTerminal's Solana trending list.
 * Candles for each coin are also written to $TMPDIR/candles-<symbol>.json for offline re-checks.
 */
import { writeFileSync } from "node:fs";
import { MemoryCache } from "../src/lib/karma/cache";
import { getStoredScan } from "../src/lib/karma/db";
import { scanCoin, type CoinScan } from "../src/lib/karma/engine/coin";
import { excludedFunders, walletRegistry } from "../src/lib/karma/registry";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";
import { bollinger, rsi, type Candle } from "../src/lib/karma/sources/ta";
import { buildFeatures, fetchCandlesForMint, fetchMarketNow, snapshotCandles } from "../src/lib/karma/quant/features";
import { atr, rsiSeries } from "../src/lib/karma/quant/indicators";
import { askJev, jevState } from "../src/lib/karma/quant/jev";
import { RUBRIC_V1 } from "../src/lib/karma/quant/rubric-v1";
import type { QuantFeatures } from "../src/lib/karma/quant/types";

const FIXED = [
  "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS", // KNOTS
  "HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ", // GP
  "BQJfL1yiHbJQ8AciHLcKxaCbQrWP2ws8oZHHYgbBpump", // CACKLE
];

async function trending(n: number, skip: Set<string>): Promise<string[]> {
  const res = await fetch("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools", { signal: AbortSignal.timeout(8000) });
  const j = (await res.json()) as { data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> };
  const out: string[] = [];
  for (const p of j.data ?? []) {
    const m = (p.relationships?.base_token?.data?.id ?? "").replace("solana_", "");
    if (m && !skip.has(m) && !out.includes(m)) out.push(m);
    if (out.length >= n) break;
  }
  return out;
}

/** RSI written independently: Wilder smoothing as an exponential average with α = 1/period over the gain/loss arrays. */
function rsiIndependent(closes: number[], period = 14): number | null {
  const diffs = closes.slice(1).map((c, i) => c - closes[i]);
  if (diffs.length < period) return null;
  const gains = diffs.map((d) => (d > 0 ? d : 0));
  const losses = diffs.map((d) => (d < 0 ? -d : 0));
  const a = 1 / period;
  let g = gains.slice(0, period).reduce((s, x) => s + x, 0) / period;
  let l = losses.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < diffs.length; i++) {
    g = a * gains[i] + (1 - a) * g;
    l = a * losses[i] + (1 - a) * l;
  }
  return l === 0 ? 100 : (100 * g) / (g + l); // = 100 − 100/(1 + g/l)
}

/** ATR written independently: TR from its three-way definition, Wilder α = 1/period. */
function atrIndependent(cs: Candle[], period = 14): number | null {
  const tr = cs.slice(1).map((c, i) => Math.max(c.h, cs[i].c) - Math.min(c.l, cs[i].c)); // = max(h−l, |h−pc|, |l−pc|)
  if (tr.length < period) return null;
  let x = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) x += (tr[i] - x) / period;
  return x;
}

const rel = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.abs(a - b) / Math.max(1e-300, Math.abs(b)));

function sanity(f: QuantFeatures, candles: Candle[] | null): string[] {
  // candles here = snapshotCandles(...), exactly what buildFeatures read
  const bad: string[] = [];
  const walk = (o: unknown, path: string) => {
    if (typeof o === "number" && !Number.isFinite(o)) bad.push(`${path} not finite`);
    else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
  };
  walk(f, "f");
  const c = f.chart;
  if (!c) return bad;
  const inRange = (k: string, v: number | null, lo: number, hi: number) => {
    if (v !== null && (v < lo || v > hi)) bad.push(`${k}=${v} outside ${lo}..${hi}`);
  };
  inRange("rsi14", c.rsi14, 0, 100);
  inRange("stoch_rsi", c.stoch_rsi, 0, 1);
  inRange("drawdown_from_high", c.drawdown_from_high, 0, 1);
  inRange("range_pos", c.range_pos, 0, 1);
  inRange("atr_pct", c.atr_pct, 0, 5);
  inRange("bb_width", c.bb_width, 0, 10);
  if (candles) {
    const seen = candles;
    const closes = seen.map((x) => x.c);
    // bb_pos must agree with where the close sits between the bands.
    const b = bollinger(closes);
    if (b && c.bb_pos !== null) {
      const want = (closes.at(-1)! - b.lower) / (b.upper - b.lower);
      if (Math.abs(want - c.bb_pos) > 1e-9) bad.push(`bb_pos ${c.bb_pos} vs ${want}`);
    }
    // RSI: feature vs ta.ts vs the independent version vs the last point of rsiSeries.
    const r1 = rel(c.rsi14, rsiIndependent(closes));
    const r2 = rel(rsiSeries(closes).at(-1) ?? null, rsi(closes));
    if (r1 === null || r1 > 1e-9) bad.push(`rsi mismatch vs independent: ${c.rsi14} vs ${rsiIndependent(closes)}`);
    if (r2 === null || r2 > 1e-9) bad.push("rsiSeries last != ta.rsi");
    // ATR: feature × close vs the independent version.
    const a = rel(c.atr_pct !== null ? c.atr_pct * closes.at(-1)! : null, atrIndependent(seen));
    if (a === null || a > 1e-9) bad.push(`atr mismatch: ${c.atr_pct} vs ${atrIndependent(seen)! / closes.at(-1)!}`);
    if (Math.abs((atr(seen) ?? 0) - (atrIndependent(seen) ?? 0)) > 1e-9 * (atrIndependent(seen) ?? 1)) bad.push("atr() != independent");
  }
  return bad;
}

async function loadScan(mint: string, cache: MemoryCache): Promise<{ scan: CoinScan; from: string }> {
  const stored = await getStoredScan<CoinScan>(mint);
  if (stored) return { scan: stored.scan, from: `stored ${Math.round(stored.ageSeconds / 3600)}h ago` };
  const t = Date.now();
  const scan = await scanCoin(SolanaRpc.fromEnv(cache), mint, SCORING, Math.floor(t / 1000), cache, walletRegistry(), excludedFunders());
  return { scan, from: `fresh scan ${Math.round((Date.now() - t) / 1000)}s` };
}

(async () => {
  const cache = new MemoryCache();
  const args = process.argv.slice(2);
  const mints = args.length ? args : [...FIXED, ...(await trending(2, new Set(FIXED)))];
  let cost = 0;
  for (const [i, mint] of mints.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 4_000)); // GeckoTerminal's free tier 429s on bursts
    const now = Math.floor(Date.now() / 1000);
    const { scan, from } = await loadScan(mint, cache);
    const { pool, candles } = await fetchCandlesForMint("solana", mint, cache);
    const market = await fetchMarketNow(mint);
    const f = buildFeatures(scan, candles, market, now);
    console.log(`\n=== ${scan.symbol ?? mint} (${mint}) · scan: ${from} · pool ${pool ?? "NONE"} · candles ${candles?.length ?? 0}`);
    if (candles) writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/candles-${scan.symbol ?? mint}.json`, JSON.stringify(candles));
    console.log(JSON.stringify(jevState(f)));
    const bad = sanity(f, snapshotCandles(candles, now));
    const what = f.chart ? "ranges, bb_pos, RSI + ATR vs independent" : "finite only: no chart";
    console.log(bad.length ? `SANITY FAIL: ${bad.join("; ")}` : `sanity ok (${what})`);
    if (f.chart) {
      // Intuition line: the raw picture the indicators should agree with.
      const seen = snapshotCandles(candles, now);
      const hi = Math.max(...seen.map((x) => x.h));
      const lo = Math.min(...seen.map((x) => x.l));
      const b = bollinger(seen.map((x) => x.c))!;
      const c24 = seen.at(-25)?.c;
      console.log(
        `picture: close ${seen.at(-1)!.c.toPrecision(4)} · 7d range ${lo.toPrecision(4)}..${hi.toPrecision(4)} · bands ${b.lower.toPrecision(4)}..${b.upper.toPrecision(4)} · 24h ago ${c24?.toPrecision(4)}`,
      );
    }
    const jev = await askJev(jevState(f), RUBRIC_V1.questions);
    if (!jev) {
      console.log("jev: no answer");
      continue;
    }
    cost += jev.cost_usd ?? 0;
    const fmt = Object.entries(jev.answers).map(([k, a]) => {
      const v = a.type === "noul" ? `p=${a.noul?.toFixed(2)}` : a.type === "choice" ? `${a.choice}` : `${a.score}`;
      const probs = a.probabilities ? ` {${Object.entries(a.probabilities).map(([o, p]) => `${o}:${p.toFixed(2)}`).join(" ")}}` : "";
      return `  ${k}: ${v}${a.confidence !== undefined ? ` conf=${a.confidence.toFixed(2)}` : ""}${probs}`;
    });
    console.log(`jev ${jev.model} · ${jev.input_tokens} tok · $${jev.cost_usd}\n${fmt.join("\n")}`);
  }
  console.log(`\njev total $${cost.toFixed(6)}`);
  process.exit(0);
})();
