import { BASE58_ADDRESS } from "@/lib/karma/data";
import { fingerprintWallet } from "@/lib/karma/engine/fingerprint";
import { serverCache } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";

/**
 * Live behaviour read for any wallet — the fallback surface for the ~everyone who pastes a
 * wallet that isn't in the scored corpus. Costs ≤9 keyless pump.fun requests cold, so it is
 * throttled and cached for an hour: behaviour is a slow variable, re-reading it per view
 * would be spend without information.
 */

const TTL = 3600;

export async function GET(req: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  if (!BASE58_ADDRESS.test(wallet)) return Response.json({ error: "not a Solana address" }, { status: 400 });
  if (!allow("behavior", req, 15, 240)) return tooMany();

  const key = `behavior:${wallet}`;
  let read = await serverCache.get<Awaited<ReturnType<typeof fingerprintWallet>>>(key);
  if (!read) {
    try {
      read = await fingerprintWallet(wallet, serverCache, Math.floor(Date.now() / 1000));
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
    await serverCache.set(key, read, TTL);
  }

  return Response.json(
    { ...read, note: "Behaviour read, not a Karma grade — no public callouts means no follower trust to measure." },
    { headers: { "cache-control": `public, s-maxage=${TTL}, stale-while-revalidate=600` } },
  );
}
