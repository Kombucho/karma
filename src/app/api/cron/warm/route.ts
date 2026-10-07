import { scanCoin, scanEvmCoin, type CoinScan } from "@/lib/karma/engine/coin";
import { SCORING } from "@/lib/karma/scoring.config";
import { pumpFunEvmCoin } from "@/lib/karma/sources/pumpfun";
import { getStoredScan, putStoredScan, trimStoredScans } from "@/lib/karma/db";
import { trimWalletFacts } from "@/lib/karma/fact-cache";
import { withBudget } from "@/lib/karma/http";
import { recordScanRun, trimWalletHistory } from "@/lib/karma/history";
import { recordHolders } from "@/lib/karma/sources/sibling-overlap";
import { excludedFunders, serverCache, serverRpc, walletRegistry } from "@/lib/karma/registry";

/**
 * Precompute warmer: scans trending pump.fun coins on both chains on a schedule, so the first human
 * visitor to a hot coin gets the cached, persisted result instead of eating the cold RPC sweep.
 * Every scan is upserted whole (holders, dev, crowd sample, EVM holder book, concentration) so it
 * survives instance recycles and accumulates the board.
 *
 * Self-bounding: a wall-clock deadline stops the loop before Vercel's 300s function limit, so adding
 * more coins never risks a timeout — it just warms as many as fit. Solana first (the heavier scans,
 * and the primary board), then BSC (cheaper) until the clock runs down.
 *
 * serverCache is in-process, so this warms one instance's memory; the DB upsert is what makes it land
 * for every instance (getScan reads a <30-min stored scan). Secured by CRON_SECRET when set.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const GT = "https://api.geckoterminal.com/api/v2/networks";
const SCAN_TTL = 300;
const MAX_SOLANA = 12;
const MAX_BSC = 12;
const DEADLINE_MS = 260_000; // stop well before the 300s ceiling
/** Pass 1 budget per coin: the cheap layer plus whatever history fits. */
const WIDE_MS = 15_000;
/**
 * Coins the wide pass touches. One run a day (free tier) has ~260s and a full keyless read is ~150s, so at
 * most 1-2 coins finish per run: skim the top few, then let the deep pass finish the hottest.
 */
const WIDE_COINS = 4;
/** Pass 2 cap per coin, so one huge holder book can't eat the whole run. */
const DEEP_MS = 90_000;
/** A complete scan younger than this is left alone. */
const COMPLETE_FRESH_S = 6 * 3600;

/** Base-token mints off GeckoTerminal trending/new pools for one network, filtered to a predicate. */
async function poolMints(network: string, feeds: string[], keep: (mint: string) => boolean, cap: number): Promise<string[]> {
  const mints = new Set<string>();
  for (const feed of feeds) {
    try {
      const r = await fetch(`${GT}/${network}/${feed}`, { headers: { accept: "application/json" } });
      const j = (await r.json()) as { data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> };
      for (const p of j.data ?? []) {
        const id = p.relationships?.base_token?.data?.id ?? "";
        const prefix = `${network}_`;
        const m = id.startsWith(prefix) ? id.slice(prefix.length) : "";
        if (m && keep(m)) mints.add(m);
      }
    } catch {
      // one feed failing just shrinks the set
    }
  }
  return [...mints].slice(0, cap);
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const started = Date.now();
  const deadline = started + DEADLINE_MS;
  // Seconds into the run at the end of each phase: the cron's own answer to "where did the time go".
  const phases: Record<string, number> = {};
  const mark = (name: string) => (phases[name] = Math.round((Date.now() - started) / 1000));
  const registry = walletRegistry();
  const excluded = excludedFunders();
  const warmed = { solana: 0, bsc: 0 };
  const skipped: string[] = [];

  // Solana, in layers. Pass 1 (wide): every trending coin gets a short budget, enough for the cheap layer
  // (market, safety, top holders off current-state RPC) and whatever history fits. A coin that runs out is
  // stored as partial (never served) and everything it read stays in the fact cache. BSC goes next so the
  // deep pass can't starve it, then pass 2 (deep) spends what's left finishing partial coins from where
  // their facts left off. Each cron run moves every coin further; none is ever shown half-read.
  const solMints = await poolMints("solana", ["trending_pools?duration=24h", "trending_pools?duration=6h"], (m) => m.endsWith("pump"), MAX_SOLANA);
  const layers = { wide: 0, deep: 0, complete: 0, partial: 0, fresh: 0 };
  const unfinished: string[] = [];
  const warmSolana = async (mint: string, ms: number): Promise<boolean> => {
    try {
      const { value: scan, hit } = await withBudget(ms, () =>
        scanCoin(serverRpc, mint, SCORING, Math.floor(Date.now() / 1000), serverCache, registry, excluded),
      );
      if (hit) {
        await putStoredScan(mint, { ...scan, partial: true }, false);
        return false;
      }
      await serverCache.set(`coinscan:${mint}`, scan, SCAN_TTL);
      await putStoredScan(mint, scan, scan.eligible);
      await recordScanRun(scan, "cron"); // append-only wallet history: complete reads only
      if (scan.eligible) await recordHolders(mint, scan.holders, { checkedAt: scan.checked_at }).catch(() => 0);
      if (scan.eligible) warmed.solana++;
      else skipped.push(mint);
      return true;
    } catch {
      // Budget ran out before the holder book even landed (or the coin is unreadable): its facts are cached.
      return false;
    }
  };
  for (const mint of solMints) {
    if (Date.now() > deadline - WIDE_MS || layers.wide >= WIDE_COINS) break;
    const stored = await getStoredScan<CoinScan>(mint);
    if (stored && !stored.scan.partial && stored.ageSeconds < COMPLETE_FRESH_S) {
      layers.fresh++;
      continue;
    }
    layers.wide++;
    if (await warmSolana(mint, WIDE_MS)) layers.complete++;
    else unfinished.push(mint);
  }

  mark("wide");

  // BSC: trending + new pools, kept only when they resolve as pump.fun coins (the pumpFunEvmCoin
  // check is cached and reused by scanEvmCoin, so it isn't a wasted call).
  const bscCandidates = await poolMints("bsc", ["trending_pools?duration=6h", "new_pools"], (m) => m.startsWith("0x"), MAX_BSC * 2);
  for (const mint of bscCandidates) {
    // Leave the deep pass its minute when Solana coins are still unfinished.
    if (Date.now() > deadline - (unfinished.length ? 60_000 : 0) || warmed.bsc >= MAX_BSC) break;
    try {
      const isPump = await pumpFunEvmCoin(mint, serverCache).catch(() => null);
      if (!isPump) continue;
      // Budgeted like Solana: an EVM read that stalls gets cut at the run's deadline, not Vercel's.
      const { value: scan, hit } = await withBudget(Math.max(1_000, deadline - Date.now()), () => scanEvmCoin(mint, SCORING, Math.floor(Date.now() / 1000), serverCache));
      if (hit) break;
      await serverCache.set(`coinscan:${mint}`, scan, SCAN_TTL);
      await putStoredScan(mint, scan, scan.eligible);
      await recordScanRun(scan, "cron"); // append-only wallet history
      if (scan.eligible) await recordHolders(mint, scan.holders, { checkedAt: scan.checked_at }).catch(() => 0);
      if (scan.eligible) warmed.bsc++;
      else skipped.push(mint);
    } catch {
      skipped.push(mint);
    }
  }

  mark("bsc");

  // Pass 2 (deep): the clock that's left, one unfinished coin at a time.
  for (const mint of unfinished) {
    const left = deadline - Date.now();
    if (left < 20_000) break;
    layers.deep++;
    if (await warmSolana(mint, Math.min(DEEP_MS, left - 5_000))) layers.complete++;
  }
  layers.partial = layers.wide - layers.complete;
  mark("deep");

  // Space trim: drop scans older than 30 days so the free tier never fills.
  const trimmed = await trimStoredScans(30);
  await trimWalletHistory(90); // append-only wallet history: keep 90 days inside the free tier
  await trimWalletFacts(60);

  return Response.json({
    warmed: warmed.solana + warmed.bsc,
    solana: warmed.solana,
    bsc: warmed.bsc,
    skipped: skipped.length,
    trimmed,
    deadline_hit: Date.now() > deadline,
    layers,
    phases: { ...phases, total: Math.round((Date.now() - started) / 1000) },
  });
}
