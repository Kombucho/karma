/**
 * Post-mortem backtest: replay Jev's live rubric through a finished coin's whole life and find where the
 * read broke. For each coin, full 1h history from KuCoin (GeckoTerminal's free tier stops at 180 days),
 * then every STEP hours: chart features from only the candles knowable at t (the same chartFeatures the
 * live loop uses), ask Jev, measure what the price actually did next, grade it the way the cron grades.
 *
 * Chart-only on purpose: the holder lenses can't be rebuilt for past dates, so `holders` is empty. That's
 * the honest read of what the chart half of the rubric can and can't see.
 *
 * Usage: npx tsx --env-file=.env.local scripts/backtest-postmortem.ts [SYMBOL ...] [--step=12]
 * Default coins: TROLL USELESS FARTCOIN MELANIA. Writes data/backtests/postmortem-<date>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import type { Candle } from "../src/lib/karma/sources/ta";
import { chartFeatures, CHART_MIN_CANDLES, CHART_WINDOW, fillHourlyGaps } from "../src/lib/karma/quant/features";
import { eventFor, probFor, scorePairs, type Pair } from "../src/lib/karma/quant/grade";
import { askJev, jevState } from "../src/lib/karma/quant/jev";
import { measureOutcome } from "../src/lib/karma/quant/outcomes";
import { RUBRIC_V1 } from "../src/lib/karma/quant/rubric-v1";
import type { JevAnswer, QuantFeatures, QuantOutcome } from "../src/lib/karma/quant/types";

const COINS: Record<string, { mint: string; supply: number }> = {
  TROLL: { mint: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2", supply: 1e9 },
  USELESS: { mint: "Dz9mQ9NzkBcCsuGPFJ3r1bS4wgqKMHBPiVuniW8Mbonk", supply: 1e9 },
  FARTCOIN: { mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", supply: 1e9 },
  MELANIA: { mint: "FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P", supply: 1e9 },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Full 1h history, oldest-first. KuCoin pages 1500 candles newest-first: [t, open, close, high, low, vol, turnover]. */
async function kucoinHourly(symbol: string): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  let end = Math.floor(Date.now() / 1000);
  for (let page = 0; page < 40; page++) {
    const start = end - 1500 * 3600;
    const res = await fetch(`https://api.kucoin.com/api/v1/market/candles?type=1hour&symbol=${symbol}-USDT&startAt=${start}&endAt=${end}`);
    const j = (await res.json()) as { code: string; data?: string[][] };
    if (j.code === "429000") {
      await sleep(3000);
      page--;
      continue;
    }
    const rows = j.data ?? [];
    if (!rows.length) break;
    for (const [t, o, c, h, l, v] of rows) out.set(Number(t), { t: Number(t), o: +o, h: +h, l: +l, c: +c, v: +v * +c });
    end = start;
    await sleep(350);
  }
  return fillHourlyGaps([...out.values()].sort((a, b) => a.t - b.t));
}

interface Row {
  t: number;
  date: string;
  price: number;
  from_ath: number; // drawdown from the running all-time high at t
  chart: QuantFeatures["chart"];
  answers: Record<string, JevAnswer>;
  outcomes: Record<number, QuantOutcome | null>;
}

async function replay(symbol: string, step: number): Promise<{ candles: Candle[]; rows: Row[] }> {
  const { supply } = COINS[symbol] ?? { supply: 1e9 };
  const candles = await kucoinHourly(symbol);
  const now = candles.at(-1)!.t + 3600;
  const times: number[] = [];
  for (let i = CHART_MIN_CANDLES; i < candles.length - 24; i += step) times.push(candles[i].t + 3600);

  const rows: Row[] = [];
  let ath = 0;
  let athIdx = 0;
  const queue = [...times];
  const worker = async () => {
    for (let t = queue.shift(); t !== undefined; t = queue.shift()) {
      const seen = candles.filter((c) => c.t < t).slice(-CHART_WINDOW);
      const price = seen.at(-1)!.c;
      const chart = chartFeatures(seen);
      const features = {
        coin: { symbol, age_hours: (t - candles[0].t) / 3600, mcap_usd: price * supply },
        chart,
        holders: {},
      };
      let jev = await askJev(features, RUBRIC_V1.questions, 15_000);
      for (let k = 0; !jev && k < 3; k++) {
        await sleep(1500 * (k + 1));
        jev = await askJev(features, RUBRIC_V1.questions, 15_000);
      }
      if (!jev) continue;
      const outcomes: Row["outcomes"] = {};
      for (const h of [24, 168]) outcomes[h] = measureOutcome({ id: 0, t, price_usd: price }, h, candles, { price_usd: candles.at(-1)!.c, mcap_usd: null, liquidity_usd: 1e9, pair: null }, now);
      rows.push({ t, date: new Date(t * 1000).toISOString().slice(0, 13) + "h", price, from_ath: 0, chart, answers: jev.answers, outcomes });
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  rows.sort((a, b) => a.t - b.t);
  // Running ATH from candles (not just sampled rows), so from_ath is what a holder saw at t.
  for (const r of rows) {
    while (athIdx < candles.length && candles[athIdx].t < r.t) ath = Math.max(ath, candles[athIdx++].h);
    r.from_ath = ath > 0 ? 1 - r.price / ath : 0;
  }
  return { candles, rows };
}

/** One question's grade over a set of rows. */
function grade(rows: Row[], q: string) {
  const target = RUBRIC_V1.targets[q];
  const pairs: Pair[] = [];
  let hits = 0;
  let calls = 0;
  for (const r of rows) {
    const o = r.outcomes[target.horizon_h] ?? undefined;
    const y = eventFor(target, o);
    const p = probFor(target, r.answers[q]);
    if (y === null || p === null) continue;
    pairs.push({ p, y });
    if (target.kind === "direction") {
      const c = r.answers[q]?.choice ?? "";
      const dir = target.up.includes(c) ? 1 : target.down.includes(c) ? 0 : null;
      if (dir !== null) {
        calls++;
        hits += dir === y ? 1 : 0;
      }
    }
  }
  const s = scorePairs(pairs);
  return { ...s, hit_rate: calls ? hits / calls : null, hit_n: calls };
}

/**
 * The misses that matter: confident calls the price punished. Error = (p - y)², only kept when the
 * prediction sat on the wrong side of 0.5 — these are the moments the read "broke".
 */
function breaks(rows: Row[]) {
  const out: Array<{ date: string; price: number; from_ath: number; q: string; p: number; happened: boolean; move: string; setup?: string }> = [];
  for (const r of rows) {
    for (const q of ["dump_24h", "dump_7d", "pump_7d"]) {
      const target = RUBRIC_V1.targets[q];
      const o = r.outcomes[target.horizon_h] ?? undefined;
      const y = eventFor(target, o);
      const p = probFor(target, r.answers[q]);
      if (y === null || p === null || (p - y) ** 2 < 0.36) continue; // off by ≥0.6
      out.push({
        date: r.date,
        price: r.price,
        from_ath: r.from_ath,
        q,
        p,
        happened: y === 1,
        move: `dd ${((o?.max_drawdown ?? 0) * 100).toFixed(0)}% / up ${((o?.max_runup ?? 0) * 100).toFixed(0)}%`,
        setup: r.answers.setup?.choice,
      });
    }
  }
  return out;
}

/** Rolling mean Brier over the three noul questions, by week: where the read goes from fine to broken. */
function rollingError(rows: Row[], windowRows = 14) {
  const perRow = rows.map((r) => {
    const errs: number[] = [];
    for (const q of ["dump_24h", "dump_7d", "pump_7d"]) {
      const target = RUBRIC_V1.targets[q];
      const y = eventFor(target, r.outcomes[target.horizon_h] ?? undefined);
      const p = probFor(target, r.answers[q]);
      if (y !== null && p !== null) errs.push((p - y) ** 2);
    }
    return errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : null;
  });
  const out: Array<{ date: string; price: number; from_ath: number; err: number }> = [];
  for (let i = windowRows; i <= rows.length; i += Math.floor(windowRows / 2)) {
    const w = perRow.slice(i - windowRows, i).filter((x): x is number => x !== null);
    if (w.length) out.push({ date: rows[i - 1].date, price: rows[i - 1].price, from_ath: rows[i - 1].from_ath, err: w.reduce((a, b) => a + b, 0) / w.length });
  }
  return out;
}

/** Regimes by distance from the running ATH: does the read hold up near highs, in the crash, in the grave? */
function byRegime(rows: Row[]) {
  const bands: Array<[string, (r: Row) => boolean]> = [
    ["near ATH (<20% off)", (r) => r.from_ath < 0.2],
    ["pullback (20-60% off)", (r) => r.from_ath >= 0.2 && r.from_ath < 0.6],
    ["crashed (>60% off)", (r) => r.from_ath >= 0.6],
  ];
  return bands.map(([name, f]) => {
    const rs = rows.filter(f);
    return { regime: name, n: rs.length, dump_7d: grade(rs, "dump_7d"), pump_7d: grade(rs, "pump_7d"), setup: grade(rs, "setup") };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const step = Number(args.find((a) => a.startsWith("--step="))?.split("=")[1] ?? 12);
  const symbols = args.filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
  const list = symbols.length ? symbols : Object.keys(COINS);
  if (!process.env.JEV_API_KEY) throw new Error("JEV_API_KEY missing (run with --env-file=.env.local)");

  const report: Record<string, unknown> = { rubric: RUBRIC_V1.version, step_h: step, generated: new Date().toISOString(), coins: {} };
  const all: Row[] = [];
  for (const sym of list) {
    const t0 = Date.now();
    const { candles, rows } = await replay(sym, step);
    all.push(...rows);
    const athC = candles.reduce((a, c) => (c.h > a.h ? c : a));
    const questions = Object.fromEntries(Object.keys(RUBRIC_V1.targets).map((q) => [q, grade(rows, q)]));
    const br = breaks(rows);
    (report.coins as Record<string, unknown>)[sym] = {
      mint: COINS[sym]?.mint,
      candles: candles.length,
      from: new Date(candles[0].t * 1000).toISOString().slice(0, 10),
      ath: { date: new Date(athC.t * 1000).toISOString().slice(0, 10), price: athC.h },
      now_from_ath: 1 - candles.at(-1)!.c / athC.h,
      snapshots: rows.length,
      questions,
      regimes: byRegime(rows),
      rolling_error: rollingError(rows),
      breaks: br,
      timeline: rows.map((r) => ({ date: r.date, price: r.price, from_ath: r.from_ath, setup: r.answers.setup?.choice, trend: r.answers.trend?.score, dump_7d: r.answers.dump_7d?.noul, pump_7d: r.answers.pump_7d?.noul, dd_7d: r.outcomes[168]?.max_drawdown, up_7d: r.outcomes[168]?.max_runup })),
    };
    const q = questions as Record<string, ReturnType<typeof grade>>;
    const f = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "  -  " : x.toFixed(d));
    console.log(
      `\n${sym}: ${rows.length} snapshots, ${candles.length}h of candles from ${new Date(candles[0].t * 1000).toISOString().slice(0, 10)}, ATH ${new Date(athC.t * 1000).toISOString().slice(0, 10)} (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    );
    for (const k of Object.keys(q)) console.log(`  ${k.padEnd(9)} n=${q[k].n} base=${f(q[k].base_rate)} brier=${f(q[k].brier, 3)} skill=${f(q[k].bss)} hit=${f(q[k].hit_rate)}`);
    console.log(`  breaks (confident + wrong): ${br.length}`);
  }
  const pooled = Object.fromEntries(Object.keys(RUBRIC_V1.targets).map((q) => [q, grade(all, q)]));
  report.pooled = { questions: pooled, regimes: byRegime(all) };
  console.log("\nPOOLED");
  for (const [k, g] of Object.entries(pooled)) console.log(`  ${k.padEnd(9)} n=${g.n} base=${g.base_rate?.toFixed(2)} brier=${g.brier?.toFixed(3)} skill=${g.bss?.toFixed(2)} hit=${g.hit_rate?.toFixed(2) ?? "-"}`);
  for (const r of byRegime(all)) console.log(`  ${r.regime.padEnd(22)} n=${r.n} dump_7d skill=${r.dump_7d.bss?.toFixed(2)} pump_7d skill=${r.pump_7d.bss?.toFixed(2)} setup hit=${r.setup.hit_rate?.toFixed(2)}`);

  mkdirSync("data/backtests", { recursive: true });
  const file = `data/backtests/postmortem-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`\nwrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
