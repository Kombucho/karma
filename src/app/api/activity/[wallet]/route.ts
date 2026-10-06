import { MemoryCache } from "@/lib/karma/cache";
import { probeLive } from "@/lib/karma/engine/live";
import { SCORING } from "@/lib/karma/scoring.config";
import { SolanaRpc } from "@/lib/karma/sources/solana";

// Module-level: within a warm instance, tx deltas and token meta persist across probes,
// so a re-probe only pays for transactions that are actually new. Supabase replaces this in Phase 2.
const cache = new MemoryCache();
const rpc = SolanaRpc.fromEnv(cache);

const PROBE_TTL = 60;
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

import { allow, tooMany } from "@/lib/karma/throttle";

export async function GET(_req: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  if (!BASE58_ADDRESS.test(wallet)) return Response.json({ error: "not a Solana address" }, { status: 400 });
  if (!allow("activity", _req, 10, 20)) return tooMany();

  const key = `live:${wallet}`;
  let live = await cache.get<Awaited<ReturnType<typeof probeLive>>>(key);
  if (!live) {
    try {
      live = await probeLive(rpc, wallet, SCORING, Math.floor(Date.now() / 1000), cache);
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
    await cache.set(key, live, PROBE_TTL);
  }

  return Response.json(live, {
    headers: { "cache-control": `public, s-maxage=${PROBE_TTL}, stale-while-revalidate=30` },
  });
}
