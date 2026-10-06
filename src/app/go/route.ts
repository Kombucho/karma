import { BASE58_ADDRESS, EVM_ADDRESS, getWalletReport, resolveHandle } from "@/lib/karma/data";
import { serverRpc } from "@/lib/karma/registry";

/**
 * Search resolver. Takes ?q=<wallet | @handle | mint> from the home search box and routes it:
 * wallets → the Karma Card, mints → the Coin Scan, unknown handles → back home.
 *
 * An 0x address is an EVM (pump.fun multichain) coin → straight to the Coin Scan, no RPC.
 * Solana wallets and mints share the base58 alphabet, so that discriminator is behavioural:
 *   1. a validation file exists → it's a scored wallet, done, zero RPC;
 *   2. getTokenSupply answers → only mints have a supply, so it's a coin;
 *   3. otherwise → treat as a wallet (the card handles "not scored" honestly).
 * One cheap RPC call in the middle case, and pasting either kind of address just works.
 */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (!q) return Response.redirect(new URL("/", req.url), 302);

  // EVM coins go straight to the coin scan — they're never Karma wallets.
  if (EVM_ADDRESS.test(q)) return Response.redirect(new URL(`/coin/${q}`, req.url), 302);

  if (BASE58_ADDRESS.test(q)) {
    if (getWalletReport(q)) return Response.redirect(new URL(`/w/${q}`, req.url), 302);
    const isMint = await serverRpc
      .call<{ value: { amount: string } }>("getTokenSupply", [q])
      .then(() => true)
      .catch(() => false);
    return Response.redirect(new URL(isMint ? `/coin/${q}` : `/w/${q}`, req.url), 302);
  }

  const wallet = resolveHandle(q);
  if (wallet) return Response.redirect(new URL(`/w/${wallet}`, req.url), 302);

  return Response.redirect(new URL(`/?notfound=${encodeURIComponent(q)}`, req.url), 302);
}
