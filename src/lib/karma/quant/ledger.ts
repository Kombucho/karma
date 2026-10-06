import type { SupabaseClient } from "@supabase/supabase-js";
import { db } from "../db";
import type { Candle } from "../sources/ta";
import type { ChartRead } from "./chart-read";
import type { Hypothesis } from "./hypotheses";
import type { CandleBook } from "./market";

/**
 * JEV'S LEDGER (tables jev_ledger / jev_scorecard, db/schema.sql). Jev's own backtest space: every probability
 * the chart read publishes becomes a row; the nightly cron resolves rows whose window has passed against the
 * 1h path, then rescores every cell (family × timeframe × higher-timeframe context). The chart read reads the
 * scorecard back: the track record it shows, and a lean of its odds toward what actually happened once a
 * calibration bucket holds enough calls.
 *
 * Families:
 *  touch       a level is reached within the horizon (4h / 24h / 3d / 7d)
 *  move        price trades ±25% within 7 days
 *  hypothesis  a 1h / 4h idea hits its target before its invalidation (context: survives / rejected)
 *  pattern     an audited 4h–3d pattern does the same over 7 days (context: weekly alignment)
 * Every call with its tables missing is a no-op: the read never breaks on the ledger.
 */

export interface LedgerRow {
  mint: string;
  network: string;
  t: string; // ISO
  source: "page" | "cron" | "replay";
  family: "touch" | "move" | "hypothesis" | "pattern";
  timeframe: string;
  kind: string;
  context: string;
  horizon_h: number;
  p_shown: number | null;
  p_physics: number | null;
  p_jev: number | null;
  target: { side: "support" | "resistance"; level: number } | { bull: boolean; target: number; stop: number };
  price: number | null;
  y?: 0 | 1 | null;
  resolved_at?: string | null;
}

const hLabel = (h: number) => (h < 24 ? `${h}h` : h === 24 ? "24h" : `${h / 24}d`);

/** Every claim a chart read makes, as ledger rows (including hypotheses the card didn't show: the rejected are the control group). */
export function ledgerRows(read: ChartRead & { hypotheses_all?: Hypothesis[] }, network: string, source: LedgerRow["source"] = "page"): LedgerRow[] {
  if (!read.price) return [];
  const t = new Date(read.t * 1000).toISOString();
  const base = { mint: read.mint, network, t, source, price: read.price };
  const rows: LedgerRow[] = [];
  for (const l of read.levels) {
    for (const [h, p] of [
      [4, l.p_touch_4h ?? null],
      [24, l.p_touch_24h],
      [72, l.p_touch_3d ?? null],
      [168, l.p_touch_7d ?? null],
    ] as [number, number | null][]) {
      if (p == null) continue;
      rows.push({ ...base, family: "touch", timeframe: hLabel(h), kind: l.side, context: "", horizon_h: h, p_shown: h === 24 ? p : null, p_physics: h === 24 ? (l.p_touch_24h_physics ?? null) : p, p_jev: h === 24 ? (l.p_touch_24h_jev ?? null) : null, target: { side: l.side, level: l.price } });
    }
  }
  const w = read.week;
  if (w?.up25 != null) rows.push({ ...base, family: "move", timeframe: "7d", kind: "up25", context: "", horizon_h: 168, p_shown: w.up25, p_physics: w.up25, p_jev: w.jev?.up25 ?? null, target: { side: "resistance", level: read.price * 1.25 } });
  if (w?.down25 != null) rows.push({ ...base, family: "move", timeframe: "7d", kind: "down25", context: "", horizon_h: 168, p_shown: w.down25, p_physics: w.down25, p_jev: w.jev?.down25 ?? null, target: { side: "support", level: read.price * 0.75 } });
  for (const hy of read.hypotheses_all ?? []) {
    rows.push({ ...base, family: "hypothesis", timeframe: hy.tf, kind: hy.kind, context: hy.survives ? "survives" : "rejected", horizon_h: hy.window_h, p_shown: hy.survives ? hy.p : null, p_physics: hy.p, p_jev: null, target: { bull: hy.bull, target: hy.target, stop: hy.stop } });
  }
  for (const p of read.patterns) {
    if (!p.tf || p.p_resolves == null || p.bias === "neutral") continue;
    const target = p.levels.find((x) => x.name === "target")?.price;
    const stop = p.levels.find((x) => x.name === "invalidation")?.price;
    if (target === undefined || stop === undefined) continue;
    rows.push({ ...base, family: "pattern", timeframe: p.tf, kind: p.kind, context: `wk:${p.weekly ?? "null"}`, horizon_h: 168, p_shown: p.p_resolves, p_physics: p.p_resolves, p_jev: null, target: { bull: p.bias === "bull", target, stop } });
  }
  return rows;
}

/** Insert, ignoring rows already in the ledger (same mint, time, claim and target). */
export async function writeLedger(rows: LedgerRow[], client: SupabaseClient | null = db()): Promise<number> {
  if (!client || !rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const { error, count } = await client
      .from("jev_ledger")
      .upsert(rows.slice(i, i + 500), { onConflict: "mint,t,family,timeframe,kind,target", ignoreDuplicates: true, count: "exact" });
    if (error) return n;
    n += count ?? 0;
  }
  return n;
}

/** Did the row's claim happen on the 1h path after t? null = window not covered yet. */
export function resolveRow(r: Pick<LedgerRow, "t" | "horizon_h" | "target">, candles: Candle[]): 0 | 1 | null {
  const t = Math.floor(Date.parse(r.t) / 1000);
  const end = t + r.horizon_h * 3600;
  const win = candles.filter((c) => c.t + 3600 > t && c.t < end).sort((a, b) => a.t - b.t);
  if (!win.length || win[win.length - 1].t + 3600 < end) return null;
  const g = r.target;
  if ("side" in g) return win.some((c) => (g.side === "support" ? c.l <= g.level : c.h >= g.level)) ? 1 : 0;
  for (const c of win) {
    if (g.bull ? c.l <= g.stop : c.h >= g.stop) return 0; // a candle crossing both counts as the stop (conservative)
    if (g.bull ? c.h >= g.target : c.l <= g.target) return 1;
  }
  return 0;
}

export interface LedgerRunSummary {
  pending: number;
  resolved: number;
  mints: number;
  cells: number;
  deadline_hit: boolean;
}

/**
 * The nightly step: resolve every pending row whose window has passed (one 1h candle fetch per mint, shared
 * with the rest of the cron through the CandleBook), then rescore the scorecard.
 */
export async function runLedger(opts: { now: number; deadline: number; book: CandleBook }): Promise<LedgerRunSummary> {
  const c = db();
  const summary: LedgerRunSummary = { pending: 0, resolved: 0, mints: 0, cells: 0, deadline_hit: false };
  if (!c) return summary;
  const { data, error } = await c
    .from("jev_ledger")
    .select("id, mint, network, t, horizon_h, target")
    .is("y", null)
    .lte("t", new Date((opts.now - 4 * 3600) * 1000).toISOString())
    .gte("t", new Date((opts.now - 12 * 86400) * 1000).toISOString()) // 1h candles cover ~12.5 days
    .order("t")
    .limit(5000);
  if (error || !data) return summary;
  const rows = data as (Pick<LedgerRow, "mint" | "network" | "t" | "horizon_h" | "target"> & { id: number })[];
  const due = rows.filter((r) => Date.parse(r.t) / 1000 + r.horizon_h * 3600 <= opts.now);
  summary.pending = due.length;
  const byMint = new Map<string, typeof due>();
  for (const r of due) byMint.set(`${r.network}:${r.mint}`, [...(byMint.get(`${r.network}:${r.mint}`) ?? []), r]);
  for (const [key, rs] of byMint) {
    if (Date.now() > opts.deadline) {
      summary.deadline_hit = true;
      break;
    }
    const [network, mint] = key.split(/:(.*)/s);
    const candles = await opts.book.candles(network, mint, null);
    if (!candles?.length) continue;
    summary.mints++;
    const done = new Date().toISOString();
    for (const r of rs) {
      const y = resolveRow(r, candles);
      if (y === null) continue;
      const { error: e } = await c.from("jev_ledger").update({ y, resolved_at: done }).eq("id", r.id);
      if (!e) summary.resolved++;
    }
  }
  summary.cells = await rescore(c);
  return summary;
}

interface Scored {
  family: string;
  timeframe: string;
  context: string;
  n: number;
  hit: number;
  predicted: number;
  brier: number;
  brier_base: number;
  ece: number;
  skill: number | null;
  calibration: { bucket: string; n: number; predicted: number; actual: number }[];
}

/** Score (p, y) pairs: hit rate, mean p, Brier, base-rate Brier, 10-bin calibration error, skill, buckets. */
export function scoreCell(pairs: { p: number; y: number }[]): Omit<Scored, "family" | "timeframe" | "context"> {
  const n = pairs.length;
  const hit = pairs.reduce((s, x) => s + x.y, 0) / n;
  const predicted = pairs.reduce((s, x) => s + x.p, 0) / n;
  const brier = pairs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / n;
  const brier_base = hit * (1 - hit);
  const calibration: Scored["calibration"] = [];
  let ece = 0;
  for (let b = 0; b < 10; b++) {
    const inB = pairs.filter((x) => x.p >= b / 10 && (b === 9 ? x.p <= 1 : x.p < (b + 1) / 10));
    if (!inB.length) continue;
    const pm = inB.reduce((s, x) => s + x.p, 0) / inB.length;
    const am = inB.reduce((s, x) => s + x.y, 0) / inB.length;
    ece += (inB.length / n) * Math.abs(pm - am);
    calibration.push({ bucket: `${(b / 10).toFixed(1)}-${((b + 1) / 10).toFixed(1)}`, n: inB.length, predicted: pm, actual: am });
  }
  return { n, hit, predicted, brier, brier_base, ece, skill: brier_base > 0 ? 1 - brier / brier_base : null, calibration };
}

/** Recompute every cell from all resolved rows (each cell, plus the context-pooled '*' cell). */
async function rescore(c: SupabaseClient): Promise<number> {
  const all: { family: string; timeframe: string; context: string; p: number; y: number }[] = [];
  for (let from = 0; from < 500_000; from += 1000) {
    const { data, error } = await c
      .from("jev_ledger")
      .select("family, timeframe, context, p_shown, p_physics, p_jev, y")
      .not("y", "is", null)
      .range(from, from + 999);
    if (error || !data) break;
    for (const r of data as { family: string; timeframe: string; context: string; p_shown: number | null; p_physics: number | null; p_jev: number | null; y: number }[]) {
      // Score what was SHOWN; rejected hypotheses (never shown) are scored on their physics odds, as the control.
      const p = r.p_shown ?? r.p_physics;
      if (p != null) all.push({ family: r.family, timeframe: r.timeframe, context: r.context, p, y: r.y });
      // Jev the challenger: its own read of the same claim, scored in a parallel "jev" cell.
      if (r.p_jev != null && r.p_shown != null) all.push({ family: r.family, timeframe: r.timeframe, context: "jev", p: r.p_jev, y: r.y });
    }
    if (data.length < 1000) break;
  }
  const cells = new Map<string, { p: number; y: number }[]>();
  for (const r of all) {
    for (const ctx of r.context === "jev" ? ["jev"] : [r.context, "*"]) {
      const k = `${r.family}|${r.timeframe}|${ctx}`;
      cells.set(k, [...(cells.get(k) ?? []), { p: r.p, y: r.y }]);
    }
  }
  const rows = [...cells].map(([k, pairs]) => {
    const [family, timeframe, context] = k.split("|");
    return { family, timeframe, context, ...scoreCell(pairs), updated_at: new Date().toISOString() };
  });
  for (let i = 0; i < rows.length; i += 500) await c.from("jev_scorecard").upsert(rows.slice(i, i + 500), { onConflict: "family,timeframe,context" });
  return rows.length;
}

export type Scorecard = Map<string, Scored>;
let memo: { at: number; card: Scorecard } | null = null;

/** The scorecard, cached 10 minutes in-process. Empty when the table doesn't exist yet. */
export async function loadScorecard(): Promise<Scorecard> {
  if (memo && Date.now() - memo.at < 600_000) return memo.card;
  const card: Scorecard = new Map();
  const c = db();
  if (c) {
    const { data } = await c.from("jev_scorecard").select("*");
    for (const r of (data ?? []) as Scored[]) card.set(`${r.family}|${r.timeframe}|${r.context}`, r);
  }
  memo = { at: Date.now(), card };
  return card;
}

/** Calls a bucket needs before its actual rate starts pulling the shown odds. */
const LEAN_N = 30;

/**
 * Jev adjusting itself: lean a fresh probability toward what its calibration bucket actually delivered,
 * weighted by how much history the bucket holds (n / (n + 100)): no history → unchanged; 300 calls → 75%
 * of the way to the observed rate.
 */
export function lean(card: Scorecard, family: string, timeframe: string, context: string, p: number | null): number | null {
  if (p == null) return p;
  const cell = card.get(`${family}|${timeframe}|${context}`) ?? card.get(`${family}|${timeframe}|*`);
  const b = cell?.calibration.find((x) => {
    const [lo, hi] = x.bucket.split("-").map(Number);
    return p >= lo && (hi >= 1 ? p <= 1 : p < hi);
  });
  if (!b || b.n < LEAN_N) return p;
  const w = b.n / (b.n + 100);
  return (1 - w) * p + w * (p + (b.actual - b.predicted));
}

/** The record to show next to a claim: calls graded, calibration error, skill. Null under LEAN_N calls. */
export function trackRecord(card: Scorecard, family: string, timeframe: string, context = "*"): { n: number; ece: number; skill: number | null; hit: number } | null {
  const cell = card.get(`${family}|${timeframe}|${context}`);
  return cell && cell.n >= LEAN_N ? { n: cell.n, ece: cell.ece, skill: cell.skill, hit: cell.hit } : null;
}

/** Graded calls Jev needs in a cell before it can take part in what the card shows. */
const CHALLENGER_N = 200;

/**
 * Jev the challenger: once its own read of a claim has CHALLENGER_N graded calls and a lower Brier score than
 * the calibrated model's on the same calls, it earns a say — the shown odds become the average of the two.
 * Until then (and whenever it falls behind again) the calibrated model stands alone.
 */
export function challenge(card: Scorecard, family: string, timeframe: string, model: number | null, jev: number | null): number | null {
  if (model == null || jev == null) return model;
  const j = card.get(`${family}|${timeframe}|jev`);
  const m = card.get(`${family}|${timeframe}|`) ?? card.get(`${family}|${timeframe}|*`);
  if (!j || !m || j.n < CHALLENGER_N || !(j.brier < m.brier)) return model;
  return (model + jev) / 2;
}
