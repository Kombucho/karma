import { serverRpc } from "@/lib/karma/registry";
import { allow, tooMany } from "@/lib/karma/throttle";

/**
 * A wallet's most recent transactions, on demand. Split out of the coin scan so the cold scan
 * doesn't pay for tx history nobody may expand — the bundle tree calls this only when a user
 * clicks a wallet to inspect it.
 */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const LIMIT = 8;

export async function GET(_req: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  if (!BASE58_ADDRESS.test(wallet)) return Response.json({ error: "not a Solana address" }, { status: 400 });
  if (!allow("wallet-txs", _req, 30, 12)) return tooMany();

  try {
    const sigs = await serverRpc.getSignatures(wallet, undefined, LIMIT);
    const txs = sigs.slice(0, LIMIT).map((s) => ({ sig: s.signature, t: s.blockTime, err: !!s.err }));
    return Response.json(
      { wallet, txs },
      { headers: { "cache-control": "public, s-maxage=30, stale-while-revalidate=60" } },
    );
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
