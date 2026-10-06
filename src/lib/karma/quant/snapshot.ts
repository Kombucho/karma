import type { CoinScan } from "../engine/coin";
import { getStoredScan } from "../db";
import type { JevBudget } from "./budget";
import { buildFeatures } from "./features";
import { jevState } from "./jev";
import { CandleBook, dexBatch, dexChain, gtTrendingMints } from "./market";
import { networkOf, recentScanMints, recentSnapshotMints, saveSnapshot } from "./store";
import type { QuantSnapshot, Rubric } from "./types";

/**
 * SNAPSHOT step: pick ~30 coins (GeckoTerminal trending Solana + mints stored eligible in the last
 * 24h), and for each one load the STORED scan (never rescan here), pull candles and the live
 * price/mcap/liquidity, build features, and ask Jev every rubric in play (live + shadows). A mint
 * already snapshotted under a rubric in the last 20h is skipped for that rubric.
 *
 * Costs per coin: 1 GeckoTerminal call (paced), 1/30 of a DexScreener call, 1 Jev call per rubric.
 * Jev calls are fired as soon as a coin's features exist and awaited at the end, so their ~1s latency
 * overlaps the GeckoTerminal pacing instead of adding to it.
 */

export const SNAPSHOT_COINS = 30;
export const DEDUPE_S = 20 * 3600;

export interface SnapshotPreview {
  mint: string;
  symbol: string | null;
  rubric: string;
  price_usd: number;
  candles: number;
  chart: boolean;
  answers: QuantSnapshot["answers"];
  id: number | null;
}

export interface SnapshotRunSummary {
  candidates: number;
  coins: number;
  saved: number;
  skipped: { no_scan: number; no_price: number; deduped: number; jev_failed: number; unsupported_chain: number };
  gt_calls: number;
  deadline_hit: boolean;
  previews: SnapshotPreview[];
}

export async function runSnapshots(opts: {
  now: number;
  deadline: number;
  book: CandleBook;
  budget: JevBudget;
  rubrics: Rubric[];
  maxCoins?: number;
  /** Explicit mints instead of trending + recent scans (the check script). */
  mints?: string[];
  dryRun?: boolean;
}): Promise<SnapshotRunSummary> {
  const { now, deadline, book, budget, rubrics } = opts;
  const maxCoins = opts.maxCoins ?? SNAPSHOT_COINS;
  const gt0 = book.gtCalls;
  const s: SnapshotRunSummary = {
    candidates: 0,
    coins: 0,
    saved: 0,
    skipped: { no_scan: 0, no_price: 0, deduped: 0, jev_failed: 0, unsupported_chain: 0 },
    gt_calls: 0,
    deadline_hit: false,
    previews: [],
  };

  // Candidates: trending first (the coins people are trading now), then everything scanned in 24h.
  let candidates = opts.mints;
  if (!candidates) {
    book.gtCalls++;
    const [trending, scanned] = await Promise.all([gtTrendingMints("solana", "24h"), recentScanMints(now - 24 * 3600)]);
    candidates = [...new Set([...trending, ...scanned])];
  }
  s.candidates = candidates.length;

  const recent = new Map<string, Set<string>>();
  for (const r of rubrics) recent.set(r.version, await recentSnapshotMints(r.version, now - DEDUPE_S));

  // Walk candidates until we hold `maxCoins` stored scans that still need a snapshot under some rubric.
  const picked: { scan: CoinScan; network: string; rubrics: Rubric[] }[] = [];
  for (const mint of candidates) {
    if (picked.length >= maxCoins) break;
    const due = rubrics.filter((r) => !recent.get(r.version)!.has(mint));
    if (!due.length) {
      s.skipped.deduped++;
      continue;
    }
    const stored = await getStoredScan<CoinScan>(mint);
    if (!stored?.scan?.eligible) {
      s.skipped.no_scan++;
      continue;
    }
    const network = stored.scan.chart_ref?.network ?? networkOf(mint);
    if (!dexChain(network)) {
      s.skipped.unsupported_chain++;
      continue;
    }
    picked.push({ scan: stored.scan, network, rubrics: due });
  }

  const dex = new Map<string, Awaited<ReturnType<typeof dexBatch>>>();
  for (const network of new Set(picked.map((p) => p.network))) dex.set(network, await dexBatch(network, picked.filter((p) => p.network === network).map((p) => p.scan.mint)));

  const pending: Promise<void>[] = [];
  for (const { scan, network, rubrics: due } of picked) {
    if (Date.now() > deadline) {
      s.deadline_hit = true;
      break;
    }
    const d = dex.get(network)?.data.get(scan.mint) ?? null;
    const candles = await book.candles(network, scan.mint, d?.pair ?? null);
    const price = d?.price_usd ?? candles?.at(-1)?.c ?? null;
    if (!price || !(price > 0)) {
      s.skipped.no_price++;
      continue;
    }
    s.coins++;
    const features = buildFeatures(scan, candles, { price_usd: price, mcap_usd: d?.mcap_usd ?? null, liquidity_usd: d?.liquidity_usd ?? null }, now);
    const state = jevState(features);
    for (const rubric of due) {
      pending.push(
        (async () => {
          const r = await budget.call(state, rubric.questions);
          if (!r) {
            s.skipped.jev_failed++;
            return;
          }
          const snap: QuantSnapshot = { mint: scan.mint, t: now, price_usd: price, rubric_version: rubric.version, features, answers: r.answers, source: "cron" };
          const id = opts.dryRun ? null : await saveSnapshot(snap);
          if (id !== null) s.saved++;
          s.previews.push({ mint: scan.mint, symbol: scan.symbol, rubric: rubric.version, price_usd: price, candles: candles?.length ?? 0, chart: features.chart !== null, answers: r.answers, id });
        })(),
      );
    }
  }
  await Promise.all(pending);
  s.gt_calls = book.gtCalls - gt0;
  return s;
}
