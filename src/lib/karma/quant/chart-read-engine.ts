import type { KV } from "../cache";
import { bollinger, fetchOHLCV, type Candle } from "../sources/ta";
import type { ChartRead, HypothesisRead, LevelRead, PatternRead, WeekRead } from "./chart-read";
import { fetchCandlesForMint } from "./features";
import { emaSpread, finite, roc, rsi14, volumeZ } from "./indicators";
import { askJev } from "./jev";
import { pickLevels, type LevelCandidate, type RawLevel } from "./levels";
import { fmtPrice, pivotsFor, rangeCandidate, type Pivot } from "./patterns";
import { funnel, type Hypothesis } from "./hypotheses";
import { btcDailyTrend, levelOdds, volumeZ6 } from "./level-odds";
import { challenge, lean, loadScorecard, trackRecord } from "./ledger";
import { firstPassage, sigmaDaily, touchProb } from "./physics";
import { dailyTrend, detectPatterns as detectSwing, weeklyTrend, type SwingTf } from "./swing-patterns";
import type { JevAnswer, RubricQuestion } from "./types";

/**
 * JEV · CHART READ (chart-v2), patterns + levels half.
 *
 * What changed from chart-v1 (PR #47), and why — every point measured in the quant lab on held-out coins:
 *  - PATTERNS come from swing-patterns.ts on 4h / 12h / 1d with a weekly-trend check (a blind three-grader
 *    audit: 92% valid vs 12% for the 15m/1h detector), so there's no "which candidate is in play" question.
 *  - LEVEL TOUCH odds are physics (reflection principle, the coin's own volatility) blended with Jev's
 *    read: calibration error 1.7 pts vs 6.6 for Jev alone on 6,070 replayed calls.
 *  - PATTERN odds are the random-walk probability of target-before-stop in 7 days (Jev's was 22 pts off).
 *  - HOLD and FIRST-MOVE calls are gone: no skill on held-out coins (AUC 0.49, skill −0.01).
 *  - 7-DAY ±25% odds added (physics; passed on held-out coins). Jev's own read of them is stored beside
 *    it and graded, and replaces nothing until it has a record.
 * Code computes every number; Jev reads the levels and the week, never raw candles.
 */

export const CHART_READ_VERSION = "chart-v2";
const HORIZON_H = 24;
/** Patterns are read over a week: long enough for a 4h–1d shape to resolve, short enough to grade on 1h candles. */
const PATTERN_DAYS = 7;

export interface ChartCandles {
  pool: string | null;
  candles15m: Candle[] | null;
  candles1h: Candle[] | null;
  /** chart-v2: the timeframes a trader reads memecoins on. */
  candles4h?: Candle[] | null;
  candles12h?: Candle[] | null;
  candles1d?: Candle[] | null;
}

/**
 * GeckoTerminal fill-in for gaps: GT omits intervals with no trades; a quiet interval is a real observation
 * (a flat candle at the previous close), and ATR / zigzag assume one candle per interval.
 */
export function fillGaps(candles: Candle[], step: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const prev = out.at(-1);
    if (prev) for (let t = prev.t + step; t < c.t && out.length < 5_000; t += step) out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
    out.push(c);
  }
  return out;
}

/**
 * Every timeframe the read needs, through one pool, sequentially (GT's free tier 429s on bursts):
 * 1h via the shared quant path, 15m (levels), then 4h (50 days), 12h (150 days) and 1d (180 days, GT's
 * free cap — also the weekly check). Each call is cached by fetchOHLCV; a failed timeframe is just absent.
 */
export async function fetchChartCandles(network: string, mint: string, cache: KV): Promise<ChartCandles> {
  const { pool, candles: candles1h } = await fetchCandlesForMint(network, mint, cache, 2);
  if (!pool) return { pool: null, candles15m: null, candles1h: null };
  const get = async (tf: "minute" | "hour" | "day", limit: number, agg: number) => {
    await new Promise((r) => setTimeout(r, 1_200)); // space the calls: GT's free tier 429s on bursts
    let raw = await fetchOHLCV(network, pool, tf, limit, cache, mint, agg);
    for (let attempt = 1; !raw && attempt <= 2; attempt++) {
      await new Promise((r) => setTimeout(r, 4_000 * attempt));
      raw = await fetchOHLCV(network, pool, tf, limit, cache, mint, agg);
    }
    return raw;
  };
  const raw15 = await get("minute", 300, 15);
  const raw4h = await get("hour", 300, 4);
  const raw12h = await get("hour", 300, 12);
  const raw1d = await get("day", 180, 1);
  return {
    pool,
    // gap-filling a quiet coin can triple the count; 4 days of 15m is all the levels use
    candles15m: raw15 ? fillGaps(raw15, 900).slice(-384) : null,
    candles1h,
    candles4h: raw4h ? fillGaps(raw4h, 4 * 3600) : null,
    candles12h: raw12h ? fillGaps(raw12h, 12 * 3600) : null,
    candles1d: raw1d ? fillGaps(raw1d, 86400) : null,
  };
}

export interface PatternsAndLevelsRead extends Pick<ChartRead, "mint" | "t" | "price" | "timeframe" | "patterns" | "levels" | "headline" | "hypotheses" | "record" | "young"> {
  /** Every hypothesis, survivors and rejected: the ledger's control group. Not for the card. */
  hypotheses_all: Hypothesis[];
  version: string;
  /** 1h ATR (or 2 × 15m ATR for a coin with no 1h history). */
  atr_1h: number | null;
  week: WeekRead | null;
  /** chart-v2 has no first-move call; kept for the shape the page and fixtures share. */
  next_move: null;
  jev: { model: string; cost_usd: number | null; input_tokens: number | null } | null;
  /** Everything code computed, for debugging and the check script. Not for the card. */
  debug: {
    pivots15m: Pivot[];
    pivots1h: Pivot[];
    raw_levels: RawLevel[];
    levels: LevelCandidate[];
    state: Record<string, unknown>;
    answers: Record<string, JevAnswer> | null;
    /** Jev's shadow read of the week (not shown until graded). */
    week_jev: { up25: number | null; down25: number | null } | null;
  };
}

const sig = (x: number, n = 4) => (Number.isFinite(x) && x !== 0 ? Number(x.toPrecision(n)) : x);
const pct = (x: number) => Math.round(x * 1000) / 10; // fraction → % with one decimal
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

const TF_RANK: Record<SwingTf, number> = { "3d": 5, "1d": 4, "12h": 3, "4h": 2, "1h": 1 };

/**
 * The audited swing patterns across 4h / 12h / 1d, each checked against the weekly trend, with the random-walk
 * odds of reaching its target before its invalidation in PATTERN_DAYS. A shape found on two timeframes is
 * kept once, on the higher one. Candles are native per timeframe (GT aggregates), newest last.
 */
export function swingPatterns(c: Pick<ChartCandles, "candles4h" | "candles12h" | "candles1d">, now: number, price: number, sigma: number | null): PatternRead[] {
  const wk = weeklyTrend(c.candles1d ?? c.candles12h ?? c.candles4h ?? [], now + 1);
  const byTf: [SwingTf, Candle[] | null | undefined][] = [
    ["3d", c.candles1d],
    ["1d", c.candles1d],
    ["12h", c.candles12h],
    ["4h", c.candles4h],
  ];
  const out: (PatternRead & { start: number; end: number })[] = [];
  for (const [tf, candles] of byTf) {
    if (!candles || candles.length < (tf === "3d" ? 130 : 60)) continue;
    for (const p of detectSwing(candles, now + 1, tf)) {
      if (out.some((q) => q.kind === p.kind && p.start_t < q.end && p.end_t > q.start)) continue;
      const weekly = wk === null ? null : wk === "flat" ? "flat" : (wk === "up") === (p.bias === "up") ? "aligned" : "against";
      const words = p.kind.replace(/_/g, " ");
      out.push({
        kind: p.kind,
        label: `${words} on the ${tf}, trigger ${fmtPrice(p.trigger)}, target ${fmtPrice(p.target)}${weekly === "aligned" ? ", weekly trend agrees" : weekly === "against" ? ", against the weekly trend" : ""}`,
        bias: p.bias === "up" ? "bull" : "bear",
        levels: [
          { name: "trigger", price: p.trigger },
          { name: "target", price: p.target },
          { name: "invalidation", price: p.stop },
        ],
        p_in_play: null,
        p_resolves: sigma ? firstPassage(price, p.target, p.stop, sigma, PATTERN_DAYS) : null,
        tf,
        weekly,
        confirmed: p.confirmed,
        start: p.start_t,
        end: p.end_t,
      });
    }
  }
  // Higher timeframe first, then aligned with the weekly, then confirmed.
  const w = (x: PatternRead) => TF_RANK[x.tf!] * 4 + (x.weekly === "aligned" ? 2 : 0) + (x.confirmed ? 1 : 0);
  return out.sort((a, b) => w(b) - w(a)).map(({ start, end, ...p }) => (void start, void end, p));
}

/** Recent pivots as a compact list for Jev: type, price, % from now, hours ago. */
function pivotList(ps: Pivot[], price: number, now: number, n = 8) {
  return ps.slice(-n).map((p) => ({
    type: p.type === "H" ? "high" : "low",
    price: sig(p.price),
    from_now_pct: pct(p.price / price - 1),
    hours_ago: r1((now - p.t) / 3600),
    ...(p.confirmed ? {} : { forming: true }),
  }));
}

function indicatorSummary(c1h: Candle[], c15: Candle[]) {
  const base = c1h.length >= 30 ? c1h : c15;
  const tf = base === c1h ? "1h" : "15m";
  const closes = base.map((c) => c.c);
  const hi = Math.max(...base.map((c) => c.h));
  const lo = Math.min(...base.map((c) => c.l));
  const bb = bollinger(closes);
  const last = closes.at(-1) ?? 0;
  const perDay = tf === "1h" ? 24 : 96;
  return {
    timeframe: tf,
    change_24h_pct: r1((roc(closes, perDay) ?? NaN) * 100),
    change_6h_pct: r1((roc(closes, perDay / 4) ?? NaN) * 100),
    rsi14_1h: r1(c1h.length >= 15 ? rsi14(c1h.map((c) => c.c)) : null),
    rsi14_15m: r1(c15.length >= 15 ? rsi14(c15.map((c) => c.c)) : null),
    ema20_vs_ema50_pct: r1((emaSpread(closes) ?? NaN) * 100),
    bollinger_pos: r2(bb ? bb.pos : null),
    volume_z_recent: r1(volumeZ(base, tf === "1h" ? 6 : 8)),
    window_range_pos: r2(hi > lo ? (last - lo) / (hi - lo) : null),
    below_window_high_pct: r1(hi > 0 ? (1 - last / hi) * 100 : null),
  };
}

/** Drop nulls / NaN so Jev never sees a blank field. */
function prune<T>(o: T): T {
  if (Array.isArray(o)) return o.map(prune) as T;
  if (o && typeof o === "object")
    return Object.fromEntries(
      Object.entries(o as Record<string, unknown>)
        .filter(([, v]) => v !== null && v !== undefined && !(typeof v === "number" && !Number.isFinite(v)))
        .map(([k, v]) => [k, prune(v)]),
    ) as T;
  return o;
}

const levelId = (l: LevelCandidate, i: number) => `${l.side === "support" ? "S" : "R"}${i + 1}`;

/**
 * Jev's two jobs in chart-v2: read each candidate level (its touch probability is blended with physics, where
 * it adds calibration), and a shadow read of the week's ±25% range, anchored on the physics number (lab-v3:
 * Jev adjusting a baseline beat Jev guessing from scratch). The week read is stored and graded, not shown.
 */
function buildJev(price: number, now: number, c15: Candle[], c1h: Candle[], pv: { p15: Pivot[]; p1h: Pivot[]; atr1h: number }, levels: LevelCandidate[], patterns: PatternRead[], weekPhys: { up25: number; down25: number } | null) {
  const ids = new Map<LevelCandidate, string>();
  let s = 0;
  let r = 0;
  for (const l of levels) ids.set(l, levelId(l, l.side === "support" ? s++ : r++));
  const state = prune({
    price: sig(price),
    horizon_hours: HORIZON_H,
    atr_1h_pct: r1((pv.atr1h / price) * 100),
    indicators: indicatorSummary(c1h, c15),
    pivots_1h: pivotList(pv.p1h, price, now),
    pivots_15m: pivotList(pv.p15, price, now),
    patterns: patterns.slice(0, 3).map((p) => ({ kind: p.kind.replace(/_/g, " "), timeframe: p.tf, bias: p.bias, weekly: p.weekly, confirmed: p.confirmed })),
    levels: levels.map((l) => ({
      id: ids.get(l),
      side: l.side,
      price: sig(l.price),
      from_now_pct: pct(l.dist),
      from_now_atr: r1(l.dist_atr),
      strength: r1(l.score),
      sources: l.sources,
    })),
    volatility_baseline: weekPhys ? { touch_up25_7d: r2(weekPhys.up25), touch_down25_7d: r2(weekPhys.down25) } : null,
  });

  const questions: Record<string, RubricQuestion> = {};
  for (const l of levels) {
    const id = ids.get(l)!;
    const where = `${l.side} ${id} at ${fmtPrice(l.price)} (${pct(l.dist)}% from now, ${r1(Math.abs(l.dist_atr))} ATR)`;
    questions[`touch_${id}`] = {
      type: "noul",
      instructions: `Will price trade at or ${l.side === "support" ? "below" : "above"} the ${where} at any point in the next ${HORIZON_H} hours?`,
    };
  }
  if (weekPhys) {
    const anchor = (k: string) => `\`volatility_baseline.${k}\` is what a random walk with this coin's own volatility gives — start from it, and move it only as far as the chart and the levels justify.`;
    questions.week_up25 = { type: "noul", instructions: `Will price trade at least 25% ABOVE ${fmtPrice(price)} at any point in the next 7 days? ${anchor("touch_up25_7d")}` };
    questions.week_down25 = { type: "noul", instructions: `Will price trade at least 25% BELOW ${fmtPrice(price)} at any point in the next 7 days? ${anchor("touch_down25_7d")}` };
  }
  return { state, questions, ids };
}

const noul = (a: JevAnswer | undefined) => (a && typeof a.noul === "number" && Number.isFinite(a.noul) ? Math.min(1, Math.max(0, a.noul)) : null);

/**
 * The one-line call, written in code, about the CHART only: the strongest audited pattern (higher timeframe,
 * weekly-aligned first), else the range price is stuck in. Level odds and the week have their own rows, so
 * the headline never mixes claims.
 */
export function composeHeadline(read: Pick<PatternsAndLevelsRead, "patterns" | "levels" | "week">): string | null {
  const $ = (x: number) => `$${fmtPrice(x)}`;
  const top = read.patterns.find((p) => p.kind !== "range" && p.tf);
  if (top) {
    const words = top.kind.replace(/_/g, " ");
    const tgt = top.levels.find((x) => x.name === "target");
    return `${words[0].toUpperCase()}${words.slice(1)} on the ${top.tf}${top.weekly === "aligned" ? ", with the weekly trend" : top.weekly === "against" ? ", against the weekly trend" : ""}${tgt ? ` · target ${$(tgt.price)}` : ""}`;
  }
  const range = read.patterns.find((p) => p.kind === "range");
  const hi = range?.levels.find((x) => x.name === "range high")?.price;
  const lo = range?.levels.find((x) => x.name === "range low")?.price;
  return hi && lo ? `Ranging between ${$(lo)} and ${$(hi)}` : null;
}

/**
 * The patterns + levels read for one coin. `price` is the live price (DexScreener) when the caller has
 * it, else the last 15m close. One Jev call per read, cached 5 minutes per mint and 15m candle.
 */
export async function readChartPatternsAndLevels(mint: string, c: ChartCandles, price: number | null, cache: KV): Promise<PatternsAndLevelsRead> {
  const c15 = c.candles15m ?? [];
  const c1h = c.candles1h ?? [];
  const now = Math.floor(Date.now() / 1000);
  const px = finite(price) ?? c15.at(-1)?.c ?? c1h.at(-1)?.c ?? null;
  const empty: PatternsAndLevelsRead = {
    version: CHART_READ_VERSION,
    mint,
    t: now,
    price: px,
    timeframe: "1h",
    patterns: [],
    levels: [],
    headline: null,
    hypotheses: [],
    hypotheses_all: [],
    record: null,
    atr_1h: null,
    week: null,
    next_move: null,
    jev: null,
    debug: { pivots15m: [], pivots1h: [], raw_levels: [], levels: [], state: {}, answers: null, week_jev: null },
  };
  if (!px || !(px > 0) || (c15.length < 30 && c1h.length < 30)) return empty;

  const p15 = pivotsFor(c15, "15m");
  const p1h = pivotsFor(c1h, "1h");
  const atr1h = p1h.atr ?? (p15.atr ? 2 * p15.atr : null);
  if (!atr1h || !(atr1h > 0)) return empty;

  const sigma = sigmaDaily(c.candles1d ?? null, c1h.length ? c1h : null, [
    { candles: c.candles12h ?? null, stepS: 12 * 3600 },
    { candles: c.candles4h ?? null, stepS: 4 * 3600 },
  ]);
  const patterns = swingPatterns(c, now, px, sigma);
  // No audited pattern on any timeframe: say so with the 1h range, as chart-v1 always did.
  if (!patterns.length && c1h.length >= 30 && p1h.atr) {
    const rg = rangeCandidate(c1h, p1h.pivots, p1h.atr, "1h", 24);
    patterns.push({ kind: "range", label: rg.label, bias: "neutral", levels: rg.levels, p_in_play: null, p_resolves: null });
  }
  const weekPhys = sigma ? { up25: touchProb(px, px * 1.25, sigma, 7), down25: touchProb(px, px * 0.75, sigma, 7) } : null;

  const { raw, picked } = pickLevels({ price: px, candles1h: c1h, candles15m: c15, pivots1h: p1h.pivots, pivots15m: p15.pivots, atr: atr1h, now });
  const { state, questions, ids } = buildJev(px, now, c15, c1h, { p15: p15.pivots, p1h: p1h.pivots, atr1h }, picked, patterns, weekPhys);

  const cacheKey = `chartread:${CHART_READ_VERSION}:${mint}:${c15.at(-1)?.t ?? c1h.at(-1)?.t}`;
  let jev = Object.keys(questions).length ? await cache.get<Awaited<ReturnType<typeof askJev>>>(cacheKey) : null;
  if (jev === undefined) {
    jev = await askJev(state, questions, 12_000);
    if (jev) await cache.set(cacheKey, jev, 300);
  }
  const A = jev?.answers ?? null;

  const card = await loadScorecard();
  // The level lab's context (level-odds.ts): how wicky the coin is, volume, hour, trend flags, age.
  const firstDay = c.candles1d?.[0]?.t ?? c1h[0]?.t ?? now;
  const ageDays = (now - firstDay) / 86400;
  const btcT = await btcDailyTrend(now);
  const ctx = {
    volRatio: sigma ? ((atr1h / px) * Math.sqrt(24)) / sigma : 1,
    volZ: volumeZ6(c1h),
    hour: new Date(now * 1000).getUTCHours(),
    btcTrendNotFlat: btcT !== null && btcT !== "flat",
    coinTrendNotFlat: (() => {
      const t = dailyTrend(c.candles1d ?? [], now + 1);
      return t !== null && t !== "flat";
    })(),
    ageDays,
    trench: true,
  };
  const levels: LevelRead[] = picked.map((l) => {
    const phys = (days: number) => (sigma ? touchProb(px, l.price, sigma, days) : null);
    const odds = (h: 4 | 24 | 72, days: number) => {
      const p = phys(days);
      // The level lab fitted its calibration on coins with a 30-day series; under ~11 days σ comes from 6h
      // returns instead and the calibration extrapolates (+23 pts on a 5-day coin), so show the physics.
      return p === null ? null : ageDays < 11 ? p : levelOdds(h, p, ctx);
    };
    const phys24 = phys(1);
    const j = noul(A?.[`touch_${ids.get(l)}`]);
    return {
      price: l.price,
      side: l.side,
      sources: l.sources,
      dist: l.dist,
      // Shown: the level lab's calibrated odds, then leaned toward what Jev's ledger says this bucket delivered.
      // Jev takes part only once its own ledger record beats the calibrated model (ledger.ts challenge()).
      p_touch_24h: lean(card, "touch", "24h", "", challenge(card, "touch", "24h", odds(24, 1), j)),
      p_touch_24h_physics: phys24,
      p_touch_24h_jev: j, // Jev's read, graded in its own ledger cell as the challenger
      p_touch_4h: odds(4, 4 / 24),
      p_touch_3d: odds(72, 3),
      p_touch_7d: phys(7),
      p_hold: null,
    };
  });
  // Reaching a farther level on one side means passing the nearer one: its odds can't be higher.
  for (const side of ["support", "resistance"] as const) {
    for (const k of ["p_touch_4h", "p_touch_24h", "p_touch_3d", "p_touch_7d"] as const) {
      let cap = 1;
      for (const l of levels.filter((x) => x.side === side).sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))) {
        const v = l[k];
        if (v == null) continue;
        l[k] = Math.min(v, cap);
        cap = l[k] as number;
      }
    }
  }
  const weekJev = A ? { up25: noul(A.week_up25), down25: noul(A.week_down25) } : null;
  const week: WeekRead | null = weekPhys
    ? { up25: lean(card, "move", "7d", "", weekPhys.up25), down25: lean(card, "move", "7d", "", weekPhys.down25), sigma_daily: sigma, jev: weekJev }
    : null;
  // The funnel: 1h / 4h ideas tested on the daily + weekly; survivors shown with the random walk's odds.
  const hypothesesAll = c1h.length >= 60 ? funnel(c1h, c.candles4h ?? null, c.candles1d ?? null, px, sigma, now) : [];
  const seenKind = new Set<string>();
  const hypotheses: HypothesisRead[] = hypothesesAll
    .filter((h) => h.survives && h.p !== null)
    .sort((a, b) => (b.p ?? 0) - (a.p ?? 0))
    .filter((h) => !seenKind.has(`${h.tf}:${h.kind}`) && !!seenKind.add(`${h.tf}:${h.kind}`))
    .slice(0, 3)
    .map((h) => ({
      tf: h.tf,
      kind: h.kind,
      bias: h.bull ? "bull" : "bear",
      target: h.target,
      stop: h.stop,
      window_h: h.window_h,
      p: lean(card, "hypothesis", h.tf, "survives", h.p),
      p_chance: h.p,
      tests: h.tests,
    }));
  const record = {
    touch_24h: trackRecord(card, "touch", "24h"),
    move_7d: trackRecord(card, "move", "7d"),
    hypotheses: trackRecord(card, "hypothesis", "1h", "survives") ?? trackRecord(card, "hypothesis", "4h", "survives"),
  };
  const top = patterns.find((p) => p.tf);
  const read: PatternsAndLevelsRead = {
    version: CHART_READ_VERSION,
    mint,
    t: now,
    price: px,
    timeframe: top?.tf ?? "1h",
    patterns,
    levels,
    headline: null,
    hypotheses,
    hypotheses_all: hypothesesAll,
    record,
    young: ageDays < 60,
    atr_1h: atr1h,
    week,
    next_move: null,
    jev: jev ? { model: jev.model, cost_usd: jev.cost_usd, input_tokens: jev.input_tokens } : null,
    debug: {
      pivots15m: p15.pivots,
      pivots1h: p1h.pivots,
      raw_levels: raw,
      levels: picked,
      state,
      answers: A,
      week_jev: weekJev,
    },
  };
  read.headline = composeHeadline(read);
  return read;
}

// ─── gradability ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Every probability the read published, as a price event code can check on 1h candles after `t`:
 *
 *  - touch:    P(price trades at/through `level` within `horizon_h`). Event = any 1h candle in (t, t+h] with
 *              low ≤ level (support) or high ≥ level (resistance). chart-v2 publishes 24h (blend) and 7d (physics).
 *  - resolves: P(pattern hits its target before its invalidation within `horizon_h`). Walk 1h candles in
 *              order; first to be crossed wins; a candle crossing both counts as invalidation (conservative).
 *  - move:     P(price trades ±25% away within 7 days) — the week row; `jev` carries Jev's shadow read of it.
 *  - hold / first: chart-v1 claims, kept so old snapshots still grade.
 * Graded by gradeChartReads (quant/chart-grade.ts) from the daily cron.
 */
export type ChartTarget =
  | { claim: "touch"; question: string; p: number; t: number; horizon_h: number; side: "support" | "resistance"; level: number }
  | { claim: "hold"; question: string; p: number; t: number; horizon_h: number; side: "support" | "resistance"; level: number; break_by: number }
  | { claim: "resolves"; question: string; p: number; t: number; horizon_h: number; bias: "bull" | "bear"; target: number; invalidation: number }
  | { claim: "move"; question: string; p: number; jev: number | null; t: number; horizon_h: number; side: "support" | "resistance"; level: number }
  | { claim: "first"; question: string; probabilities: Record<string, number>; t: number; horizon_h: number; support: number; resistance: number };

export function chartReadTargets(read: Pick<ChartRead, "t" | "price" | "patterns" | "levels" | "week">): ChartTarget[] {
  const out: ChartTarget[] = [];
  const t = read.t;
  let s = 0;
  let r = 0;
  for (const l of read.levels) {
    const id = l.side === "support" ? `S${++s}` : `R${++r}`;
    if (l.p_touch_24h != null) out.push({ claim: "touch", question: `touch_24h_${id}`, p: l.p_touch_24h, t, horizon_h: 24, side: l.side, level: l.price });
    if (l.p_touch_7d != null) out.push({ claim: "touch", question: `touch_7d_${id}`, p: l.p_touch_7d, t, horizon_h: 168, side: l.side, level: l.price });
  }
  for (const p of read.patterns) {
    if (p.p_resolves === null || p.bias === "neutral") continue;
    const target = p.levels.find((x) => x.name === "target")?.price;
    const inv = p.levels.find((x) => x.name === "invalidation")?.price;
    if (target === undefined || inv === undefined) continue;
    out.push({ claim: "resolves", question: `resolves_${p.kind}_${p.tf ?? "1h"}`, p: p.p_resolves, t, horizon_h: PATTERN_DAYS * 24, bias: p.bias, target, invalidation: inv });
  }
  const w = read.week;
  if (w && read.price) {
    if (w.up25 != null) out.push({ claim: "move", question: "week_up25", p: w.up25, jev: w.jev?.up25 ?? null, t, horizon_h: 168, side: "resistance", level: read.price * 1.25 });
    if (w.down25 != null) out.push({ claim: "move", question: "week_down25", p: w.down25, jev: w.jev?.down25 ?? null, t, horizon_h: 168, side: "support", level: read.price * 0.75 });
  }
  return out;
}

/**
 * Did the target's event happen? 1 / 0 for touch, move, hold, resolves; the realised option for "first";
 * null when it can't be told yet (candles don't cover the horizon) or doesn't apply (hold, never touched).
 * `candles` = 1h candles, any range; only those inside (t, t + horizon] are read.
 */
export function chartTargetEvent(target: ChartTarget, candles: Candle[]): 0 | 1 | string | null {
  const end = target.t + target.horizon_h * 3600;
  const win = candles.filter((c) => c.t + 3600 > target.t && c.t < end).sort((a, b) => a.t - b.t);
  if (!win.length || win[win.length - 1].t + 3600 < end) return null; // horizon not covered yet
  const hits = (c: Candle, side: "support" | "resistance", lvl: number) => (side === "support" ? c.l <= lvl : c.h >= lvl);
  switch (target.claim) {
    case "touch":
    case "move":
      return win.some((c) => hits(c, target.side, target.level)) ? 1 : 0;
    case "hold": {
      const k = win.findIndex((c) => hits(c, target.side, target.level));
      if (k < 0) return null;
      const broke = win.slice(k).some((c) => (target.side === "support" ? c.c < target.level - target.break_by : c.c > target.level + target.break_by));
      return broke ? 0 : 1;
    }
    case "resolves": {
      const bull = target.bias === "bull";
      for (const c of win) {
        const inv = bull ? c.l <= target.invalidation : c.h >= target.invalidation;
        const tgt = bull ? c.h >= target.target : c.l <= target.target;
        if (inv) return 0;
        if (tgt) return 1;
      }
      return 0;
    }
    case "first": {
      for (const c of win) {
        const s = c.l <= target.support;
        const r = c.h >= target.resistance;
        if (s && r) return null;
        if (s) return "retest_support";
        if (r) return "push_resistance";
      }
      return "chop";
    }
  }
}
