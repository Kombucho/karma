import type { KV } from "../cache";
import type { ChartRead } from "./chart-read";
import { chartReadTargets, fetchChartCandles, readChartPatternsAndLevels, type ChartTarget } from "./chart-read-engine";
import { fetchMarketNow } from "./features";
import { fixtureChart } from "./chart-read-fixture";
import { loadScorecard, trackRecord } from "./ledger";
import type { JevAnswer, QuantFeatures, QuantSnapshot } from "./types";

/**
 * Assembles one ChartRead from the chart engine (patterns + levels + headline). CHART_READ_FIXTURE=1
 * short-circuits both with the fixture (UI work, screenshots). Also folds the read into a quant snapshot
 * so the page's calls get graded against price later, like Jev's rubric read.
 */

/** Version tag the chart-read snapshots are stored and graded under. Bump when the engine's questions change. */
export const CHART_READ_RUBRIC = "chart-v2";
/** Graded outcomes a question needs before its record means anything (same bar as Jev's read). */
export const CHART_READ_MIN_GRADED_N = 40;

export interface AssembleInput {
  mint: string;
  network: string;
  symbol: string | null;
  cache: KV;
}

const settle = <T>(p: Promise<T | null>): Promise<T | null> => p.catch(() => null);

export async function assembleChartRead({ mint, network, symbol, cache }: AssembleInput): Promise<ChartRead | null> {
  const now = Math.floor(Date.now() / 1000);
  const fixture = process.env.CHART_READ_FIXTURE === "1";
  // Sentiment was cut (2026-09-25): pump.fun callouts read bullish on every coin, so it said nothing.
  void symbol;
  const [chart, graded] = await Promise.all([fixture ? Promise.resolve(fixtureChart()) : settle(chartHalf(mint, network, cache)), isGraded()]);
  if (!chart) return null;
  return {
    mint,
    t: now,
    price: chart?.price ?? null,
    timeframe: chart?.timeframe ?? "1h",
    patterns: chart?.patterns ?? [], // the engine orders them: higher timeframe, weekly-aligned, confirmed
    levels: sortLevels(chart?.levels ?? []),
    headline: chart?.headline ?? null,
    week: chart && "week" in chart ? chart.week : null,
    hypotheses: chart && "hypotheses" in chart ? chart.hypotheses : [],
    record: chart && "record" in chart ? chart.record : null,
    young: chart && "young" in chart ? chart.young : false,
    candles: chart && "candles" in chart ? chart.candles : [],
    // Server-side only (the route strips it before responding): every hypothesis, for Jev's ledger.
    ...(chart && "hypotheses_all" in chart ? { hypotheses_all: chart.hypotheses_all } : {}),
    rubric_version: CHART_READ_RUBRIC,
    graded,
  };
}

/** Candles (15m + 1h, one pool) and live price, then the patterns + levels read. Null without candles. */
async function chartHalf(mint: string, network: string, cache: KV) {
  const [c, market] = await Promise.all([fetchChartCandles(network, mint, cache), fetchMarketNow(mint, network).catch(() => null)]);
  if (!c.candles1h?.length && !c.candles15m?.length) return null;
  const last = (c.candles15m ?? c.candles1h ?? []).at(-1)?.c ?? null;
  // DexScreener's quote can come from a stray pair ($AGENCY, 6 Oct 2026: $0.00465 while its pool never
  // traded under $0.00625), which flips every level to the wrong side. Over 20% off the pool's own latest
  // candle, trust the candle.
  const live = market?.price_usd ?? null;
  const price = live && last && Math.abs(Math.log(live / last)) > Math.log(1.2) ? last : (live ?? last);
  const read = await readChartPatternsAndLevels(mint, c, price, cache);
  // The last 3 days of 1h candles ride along for the panel's chart (same series the levels came from), the
  // still-open one carried to the price the read used so "now" sits on the chart.
  const candles = (c.candles1h ?? []).slice(-72).map(({ t, o, h, l, c: cl }) => ({ t, o, h, l, c: cl }));
  const open = candles.at(-1);
  if (open && price && price > 0) Object.assign(open, { c: price, h: Math.max(open.h, price), l: Math.min(open.l, price) });
  return { ...read, candles };
}

/** Nearest first on each side, resistances then supports. */
function sortLevels(levels: ChartRead["levels"]): ChartRead["levels"] {
  const near = (a: { dist: number }, b: { dist: number }) => Math.abs(a.dist) - Math.abs(b.dist);
  return [...levels.filter((l) => l.side === "resistance").sort(near), ...levels.filter((l) => l.side === "support").sort(near)];
}

/** "Graded" once Jev's ledger holds a real record for the claims the card leans on (touches today, the week). */
async function isGraded(): Promise<boolean> {
  const card = await loadScorecard().catch(() => new Map());
  return !!trackRecord(card, "touch", "24h") && !!trackRecord(card, "move", "7d");
}

/**
 * The read as a gradeable snapshot. Answer keys are STABLE question ids (nearest support is `s1`, nearest
 * resistance `r1`, …) so the grader can pool them across coins; the exact prices ride along in
 * `features.chart_read`, which is what an outcome is checked against.
 */
export function chartReadSnapshot(read: ChartRead, network: string, symbol: string | null): QuantSnapshot {
  // Answer keys are the chart targets' stable question ids (touch_24h_S1, week_up25, resolves_double_bottom_12h…);
  // the exact levels ride along in features.chart_read + chart_targets, which is what outcomes are checked against.
  const answers: Record<string, JevAnswer> = {};
  const targets = chartReadTargets(read);
  for (const tg of targets) if ("p" in tg) answers[tg.question] = { type: "noul", noul: tg.p };

  const features: QuantFeatures & { chart_read: ChartRead; chart_targets: ChartTarget[] } = {
    mint: read.mint,
    network,
    symbol,
    t: read.t,
    price_usd: read.price,
    mcap_usd: null,
    liquidity_usd: null,
    age_hours: null,
    chart: null,
    holders: {
      verdict: null,
      top10_pct: null,
      holder_count: null,
      insider_shaped_pct: null,
      sniper_pct: null,
      connected_pct: null,
      ecosystem_only_pct: null,
      reward_only_pct: null,
      crowd_manufactured: null,
      fresh_flow_severity: null,
      fresh_net_sol_1h: null,
      sibling_verdict: null,
      lp_pullable_share: null,
      wash_share: null,
      even_share_group_pct: null,
      dev_launches: null,
      dev_graduated: null,
      dev_holds_pct: null,
      token_risk: null,
      transfer_fee_bps: null,
    },
    chart_read: { ...read, candles: undefined }, // the chart's candles are display-only; the ledger refetches
    chart_targets: targets,
  };
  return { mint: read.mint, t: read.t, price_usd: read.price, rubric_version: CHART_READ_RUBRIC, features, answers, source: "page" };
}
