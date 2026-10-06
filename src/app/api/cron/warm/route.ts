import { scanCoin, scanEvmCoin } from "@/lib/karma/engine/coin";
import { SCORING } from "@/lib/karma/scoring.config";
import { pumpFunEvmCoin } from "@/lib/karma/sources/pumpfun";
import { putStoredScan, trimStoredScans } from "@/lib/karma/db";
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

  const now = Math.floor(Date.now() / 1000);
  const deadline = Date.now() + DEADLINE_MS;
  const registry = walletRegistry();
  const excluded = excludedFunders();
  const warmed = { solana: 0, bsc: 0 };
  const skipped: string[] = [];

  // Solana: trending pump mints, the full heavy scan.
  const solMints = await poolMints("solana", ["trending_pools?duration=24h", "trending_pools?duration=6h"], (m) => m.endsWith("pump"), MAX_SOLANA);
  for (const mint of solMints) {
    if (Date.now() > deadline) break;
    try {
      const scan = await scanCoin(serverRpc, mint, SCORING, Math.floor(Date.now() / 1000), serverCache, registry, excluded);
      await serverCache.set(`coinscan:${mint}`, scan, SCAN_TTL);
      await putStoredScan(mint, scan, scan.eligible);
      await recordScanRun(scan, "cron"); // append-only wallet history
      if (scan.eligible) await recordHolders(mint, scan.holders, { checkedAt: scan.checked_at }).catch(() => 0);
      if (scan.eligible) warmed.solana++;
      else skipped.push(mint);
    } catch {
      skipped.push(mint);
    }
  }

  // BSC: trending + new pools, kept only when they resolve as pump.fun coins (the pumpFunEvmCoin
  // check is cached and reused by scanEvmCoin, so it isn't a wasted call).
  const bscCandidates = await poolMints("bsc", ["trending_pools?duration=6h", "new_pools"], (m) => m.startsWith("0x"), MAX_BSC * 2);
  for (const mint of bscCandidates) {
    if (Date.now() > deadline || warmed.bsc >= MAX_BSC) break;
    try {
      const isPump = await pumpFunEvmCoin(mint, serverCache).catch(() => null);
      if (!isPump) continue;
      const scan = await scanEvmCoin(mint, SCORING, Math.floor(Date.now() / 1000), serverCache);
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

  // Space trim: drop scans older than 30 days so the free tier never fills.
  const trimmed = await trimStoredScans(30);
  await trimWalletHistory(90); // append-only wallet history: keep 90 days inside the free tier

  return Response.json({
    warmed: warmed.solana + warmed.bsc,
    solana: warmed.solana,
    bsc: warmed.bsc,
    skipped: skipped.length,
    trimmed,
    deadline_hit: Date.now() > deadline,
  });
}
