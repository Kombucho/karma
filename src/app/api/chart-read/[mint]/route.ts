import type { CoinScan } from "@/lib/karma/engine/coin";
import { getStoredScan } from "@/lib/karma/db";
import { serverCache } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";
import type { ChartRead } from "@/lib/karma/quant/chart-read";
import { CHART_READ_RUBRIC, assembleChartRead, chartReadSnapshot } from "@/lib/karma/quant/chart-read-assemble";
import { ledgerRows, writeLedger } from "@/lib/karma/quant/ledger";
import type { Hypothesis } from "@/lib/karma/quant/hypotheses";
import { recentSnapshot, saveSnapshot } from "@/lib/karma/quant/store";

/**
 * JEV · CHART READ for one coin: patterns, levels with touch/hold odds, a headline call,
 * fetched lazily by the coin page. EVM coins read on their own chain's pool (from the scan). Memoised 5 min in-process
 * and at the edge; every fresh read is also stored as a quant snapshot (source "page", deduped to one per
 * mint per 6h) so the calls get scored against what price does next.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MEMO_S = 300;
const SNAPSHOT_EVERY_S = 6 * 3600;
const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!BASE58_ADDRESS.test(mint) && !EVM_ADDRESS.test(mint)) return Response.json({ error: "not a coin address" }, { status: 400, headers: NO_STORE });
  if (!allow("chartread", req, 10, 30)) return tooMany();

  const memoKey = `chartread:${mint}`;
  let read = await serverCache.get<ChartRead>(memoKey);
  if (!read) {
    const { symbol, network } = await scanInfo(mint);
    // EVM coins read on their own chain's pool (the scan's chart_ref); no scan yet = nothing to read against.
    if (!network) return Response.json({ error: "no chart for this coin yet" }, { status: 404, headers: NO_STORE });
    const fresh = await assembleChartRead({ mint, network, symbol, cache: serverCache });
    if (!fresh) return Response.json({ error: "chart read unavailable — not enough candles yet" }, { status: 404, headers: NO_STORE });
    // Every claim goes to Jev's ledger (rejected hypotheses too: they're the control group), then the
    // server-only list is stripped from what the page gets.
    const { hypotheses_all, ...pub } = fresh as ChartRead & { hypotheses_all?: Hypothesis[] };
    read = pub;
    await serverCache.set(memoKey, read, MEMO_S);
    // Fixture reads never enter the graded record; neither do reads with no price to grade against.
    if (process.env.CHART_READ_FIXTURE !== "1" && read.price != null && !(await recentSnapshot(mint, CHART_READ_RUBRIC, SNAPSHOT_EVERY_S))) {
      await saveSnapshot(chartReadSnapshot(read, network, symbol));
      await writeLedger(ledgerRows({ ...read, hypotheses_all }, network)).catch(() => 0);
    }
  }
  return Response.json(read, { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=60" } });
}

/** Ticker + chart network from the scan the page already paid for (hot cache, else stored). Never scans. */
async function scanInfo(mint: string): Promise<{ symbol: string | null; network: string | null }> {
  const hot = await serverCache.get<CoinScan>(`coinscan:${mint}`);
  const scan = hot ?? (await getStoredScan<CoinScan>(mint))?.scan ?? null;
  const network = scan ? (scan.chain === "solana" ? "solana" : (scan.chart_ref?.network ?? null)) : EVM_ADDRESS.test(mint) ? null : "solana";
  return { symbol: (scan as { symbol?: string | null } | null)?.symbol ?? null, network };
}
