import { chartForMint } from "@/lib/karma/sources/ta";
import { serverCache } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";

/**
 * Chart-health read, fetched lazily by the coin page so the fragile GeckoTerminal OHLCV call never
 * blocks or slows a scan. Takes the token MINT and resolves its best pool itself (passing the token
 * as a pool was the "chart won't load" bug). Hard-cached (10 min OHLCV, 1h pool) and throttled,
 * because GT's free tier 429s under load. Descriptive indicators + levels only — not a trade signal.
 */
const NETWORKS = new Set(["solana", "bsc", "base", "eth", "robinhood", "hyperevm"]);
const MINT = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

export async function GET(req: Request, { params }: { params: Promise<{ network: string; mint: string }> }) {
  const { network, mint } = await params;
  if (!NETWORKS.has(network) || !MINT.test(mint)) return Response.json({ error: "bad chart ref" }, { status: 400 });
  if (!allow("chart", req, 6, 12)) return tooMany();

  const health = await chartForMint(network, mint, serverCache);
  return Response.json(health, {
    status: 200,
    headers: { "cache-control": "public, s-maxage=600, stale-while-revalidate=120" },
  });
}
