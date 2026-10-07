import { scanCoin, type CoinScan } from "@/lib/karma/engine/coin";
import { SCORING } from "@/lib/karma/scoring.config";
import { getStoredScan, putStoredScan } from "@/lib/karma/db";
import { recordScanRun } from "@/lib/karma/history";
import { recordHolders } from "@/lib/karma/sources/sibling-overlap";
import { excludedFunders, serverCache, serverRpc, walletRegistry } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";
import { SESSION_COOKIE, canFreshScan, clientIp, recordFreshScan, resolveAccess } from "@/lib/karma/access";

const SCAN_TTL = 300;
const DB_FRESH_SECONDS = 1800;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!BASE58_ADDRESS.test(mint) && !EVM_ADDRESS.test(mint)) return Response.json({ error: "not a Solana or EVM mint address" }, { status: 400 });
  // A cold scan is ~50-100 RPC calls; this cap is what stands between a looping bot and the RPC budget.
  if (!allow("coin", _req, 10, 12)) return tooMany();

  const key = `coinscan:${mint}`;
  let scan = await serverCache.get<CoinScan>(key);
  if (!scan) {
    const stored = await getStoredScan<CoinScan>(mint);
    if (stored && stored.ageSeconds < DB_FRESH_SECONDS && !stored.scan.partial) {
      scan = stored.scan;
      await serverCache.set(key, scan, SCAN_TTL);
    } else {
      const cookie = _req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`))?.[1];
      const access = await resolveAccess(cookie ? decodeURIComponent(cookie) : undefined, clientIp(_req.headers));
      if (!canFreshScan(access))
        return Response.json(
          { error: "out of fresh scans today — hold $KARMA to scan more", used: access.used, daily: access.daily },
          { status: 402 },
        );
      try {
        scan = await scanCoin(serverRpc, mint, SCORING, Math.floor(Date.now() / 1000), serverCache, walletRegistry(), excludedFunders());
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 502 });
      }
      await recordFreshScan(access);
      await serverCache.set(key, scan, SCAN_TTL);
      await putStoredScan(mint, scan, scan.eligible);
      await recordScanRun(scan, "api"); // append-only wallet history
      // Feeds the sibling-overlap lens (no-op until the coin_holders table exists).
      if (scan.eligible) await recordHolders(mint, scan.holders, { checkedAt: scan.checked_at }).catch(() => 0);
    }
  }

  return Response.json(scan, {
    status: scan.eligible ? 200 : 422,
    headers: { "cache-control": `public, s-maxage=${SCAN_TTL}, stale-while-revalidate=60` },
  });
}
