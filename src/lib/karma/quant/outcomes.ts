import type { Candle } from "../sources/ta";
import { CANDLE_LIMIT, CandleBook, dexBatch, type DexNow } from "./market";
import { pendingOutcomeSnapshots, saveOutcome } from "./store";
import type { QuantOutcome } from "./types";

/**
 * OUTCOMES: the realised price path after each snapshot, per horizon. For every snapshot whose horizon
 * has elapsed and has no outcome row yet, measure from GeckoTerminal 1h candles: the price at the
 * horizon, the low and the high between the snapshot and the horizon. DexScreener's current price is
 * the fallback for the horizon price when candles stop short (the coin stopped trading, or the pool
 * isn't indexed). A coin with no candles AND no live pair is a real outcome — it died — and is
 * recorded as a total loss with status "dead" so it can be audited.
 *
 * One GeckoTerminal call per mint covers every pending snapshot of that mint (300 candles = 12.5 days),
 * and one DexScreener call covers 30 mints. A failed fetch writes nothing: the pair is retried next run.
 */

export const HORIZONS_H = [24, 168] as const;
/**
 * The daily cron runs at the same minute every day, so yesterday's snapshot lands a few seconds past
 * "24h ago" when today's run looks for it. This slack counts a horizon as elapsed up to 30 min early
 * (the last partial hour is read from the live price), instead of pushing every 24h outcome to 48h.
 */
export const HORIZON_SLACK_S = 30 * 60;
/** Below this pool depth a pair is treated as gone (rugged / drained). */
export const DEAD_LIQUIDITY_USD = 500;
/** Don't look back further than the candle window covers (minus a day of margin). */
const MAX_LOOKBACK_S = (CANDLE_LIMIT - 24) * 3600;

export interface PendingSnapshot {
  id: number;
  mint: string;
  network: string;
  t: number;
  price_usd: number;
  horizons: number[]; // horizons still missing an outcome
}

/**
 * Pure: the outcome of one snapshot at one horizon. `candles` null = unknown (fetch failed) → null,
 * nothing is written. `dex` null = DexScreener has no pair for the coin (or wasn't asked).
 */
export function measureOutcome(
  snap: { id: number; t: number; price_usd: number },
  horizonH: number,
  candles: Candle[] | null,
  dex: DexNow | null,
  now: number,
): QuantOutcome | null {
  if (candles === null || !(snap.price_usd > 0)) return null;
  const end = snap.t + horizonH * 3600;
  if (end > now + HORIZON_SLACK_S) return null;
  const p0 = snap.price_usd;
  const make = (price: number, low: number, high: number, status: QuantOutcome["status"]): QuantOutcome => ({
    snapshot_id: snap.id,
    horizon_h: horizonH,
    price_usd: price,
    low_usd: low,
    high_usd: high,
    ret: price / p0 - 1,
    max_drawdown: Math.max(0, 1 - low / p0),
    max_runup: Math.max(0, high / p0 - 1),
    status,
  });

  // Candles that start after the snapshot and before the horizon: the path. The candle containing the
  // snapshot is excluded from low/high (its extremes may predate the snapshot) — only its close counts.
  const path = candles.filter((c) => c.t >= snap.t && c.t < end);
  const containing = candles.filter((c) => c.t < snap.t && c.t + 3600 > snap.t);
  const alive = !!dex && (dex.liquidity_usd ?? 0) >= DEAD_LIQUIDITY_USD && (dex.price_usd ?? 0) > 0;
  const horizonIsNow = now - end < 3 * 3600;

  // Scale sanity: the candle at the snapshot must agree with the snapshot price within 3x, or the
  // candles are pricing something else (wrong pool / wrong side of the pair). Unknown, not an outcome.
  const anchor = candles.filter((c) => c.t <= snap.t).at(-1);
  if (anchor && anchor.t > snap.t - 6 * 3600 && (anchor.c / p0 > 3 || anchor.c / p0 < 1 / 3)) return null;

  if (path.length) {
    const closes = [...containing.map((c) => c.c), ...path.map((c) => c.c)];
    let low = Math.min(...path.map((c) => c.l), ...closes);
    let high = Math.max(...path.map((c) => c.h), ...closes);
    const last = path[path.length - 1];
    // Candles reach the horizon (GeckoTerminal skips hours with no trades, so "reach" = the last
    // traded hour; no trades since means the price stood still at that close).
    const reaches = last.t + 3600 >= end || !horizonIsNow || !dex?.price_usd;
    if (reaches) return make(last.c, low, high, "ok");
    // Candles stop short of a horizon that is right now: the live price closes the gap.
    const px = dex!.price_usd!;
    low = Math.min(low, px);
    high = Math.max(high, px);
    return make(px, low, high, "dex_price");
  }

  // No candles in the window at all.
  if (!alive) {
    // Nothing traded and no live pool: the coin died. Total loss, flagged for audit.
    return { snapshot_id: snap.id, horizon_h: horizonH, price_usd: 0, low_usd: 0, high_usd: p0, ret: -1, max_drawdown: 1, max_runup: 0, status: "dead" };
  }
  // Alive but no candles (pool not indexed, or no trades): the path is just the two endpoints.
  const px = dex!.price_usd!;
  if (!horizonIsNow && !candles.length) return null; // an old horizon with no chart at all: can't know the price then
  const ref = horizonIsNow ? px : (candles.filter((c) => c.t < end).at(-1)?.c ?? px);
  return make(ref, Math.min(p0, ref), Math.max(p0, ref), "partial");
}

/** Group pending (snapshot, horizon) pairs by mint so each mint costs one candle fetch. */
export function groupByMint(pending: PendingSnapshot[]): Map<string, PendingSnapshot[]> {
  const m = new Map<string, PendingSnapshot[]>();
  for (const p of pending) {
    const k = `${p.network}:${p.mint}`;
    m.set(k, [...(m.get(k) ?? []), p]);
  }
  return m;
}

export interface OutcomeRunSummary {
  pending: number;
  mints: number;
  measured: number;
  by_status: Record<string, number>;
  skipped_unknown: number;
  gt_calls: number;
  deadline_hit: boolean;
}

/** I/O: find elapsed horizons without outcomes, measure them mint by mint, write them. */
export async function runOutcomes(opts: { now: number; deadline: number; book: CandleBook; maxMints?: number; dryRun?: boolean }): Promise<OutcomeRunSummary> {
  const { now, deadline, book } = opts;
  const pending = await pendingOutcomeSnapshots(now - MAX_LOOKBACK_S, now, HORIZONS_H, HORIZON_SLACK_S);
  // Mints whose candles the snapshot step already fetched go first (no GeckoTerminal call), then the
  // oldest snapshots, which are closest to falling out of the 300-candle window.
  const oldest = (xs: PendingSnapshot[]) => Math.min(...xs.map((x) => x.t));
  const groups = [...groupByMint(pending).entries()]
    .sort(([, a], [, b]) => Number(book.has(b[0].network, b[0].mint)) - Number(book.has(a[0].network, a[0].mint)) || oldest(a) - oldest(b))
    .slice(0, opts.maxMints ?? 80);
  const summary: OutcomeRunSummary = { pending: pending.reduce((s, p) => s + p.horizons.length, 0), mints: groups.length, measured: 0, by_status: {}, skipped_unknown: 0, gt_calls: 0, deadline_hit: false };

  // One DexScreener batch per network for every mint we'll touch.
  const byNetwork = new Map<string, string[]>();
  for (const [, snaps] of groups) byNetwork.set(snaps[0].network, [...(byNetwork.get(snaps[0].network) ?? []), snaps[0].mint]);
  const dex = new Map<string, { ok: boolean; now: DexNow | null }>();
  for (const [network, mints] of byNetwork) {
    const r = await dexBatch(network, mints);
    for (const m of mints) dex.set(`${network}:${m}`, { ok: r.ok.has(m), now: r.data.get(m) ?? null });
  }

  const gt0 = book.gtCalls;
  for (const [key, snaps] of groups) {
    if (Date.now() > deadline) {
      summary.deadline_hit = true;
      break;
    }
    const d = dex.get(key);
    const candles = await book.candles(snaps[0].network, snaps[0].mint, d?.now?.pair ?? null);
    for (const s of snaps) {
      for (const h of s.horizons) {
        // An unanswered DexScreener call must not read as "no pair": only measure dead/partial when it answered.
        const o = measureOutcome(s, h, candles, d?.ok ? d.now : null, now);
        if (!o || (!d?.ok && o.status !== "ok")) {
          summary.skipped_unknown++;
          continue;
        }
        if (!opts.dryRun) await saveOutcome(o);
        summary.measured++;
        summary.by_status[o.status ?? "ok"] = (summary.by_status[o.status ?? "ok"] ?? 0) + 1;
      }
    }
  }
  summary.gt_calls = book.gtCalls - gt0;
  return summary;
}
