import { cookies, headers } from "next/headers";
import { BASE58_ADDRESS } from "@/lib/karma/data";
import {
  SESSION_COOKIE, SESSION_DAYS, clientIp, resolveAccess, signInMessage, signSession, verifyWalletSignature,
} from "@/lib/karma/access";

/**
 * Wallet sign-in for hold-to-scan. The client asks its wallet to sign signInMessage() (no
 * transaction, no fees), posts it here, and gets an HMAC'd session cookie naming the wallet.
 *
 *   GET    → the caller's current access (tier, used/daily), for the paywall UI
 *   POST   → { wallet, issuedAt, signature (base64) } → sets the cookie
 *   DELETE → signs out
 */
export const dynamic = "force-dynamic";

const MAX_SKEW_MS = 10 * 60_000;

function view(a: Awaited<ReturnType<typeof resolveAccess>>) {
  return {
    wallet: a.wallet,
    tier: a.tier,
    daily: Number.isFinite(a.daily) ? a.daily : null,
    used: a.used,
    holdingUsd: a.holdingUsd,
  };
}

export async function GET() {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return Response.json(view(await resolveAccess(c.get(SESSION_COOKIE)?.value, clientIp(h))));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { wallet?: string; issuedAt?: string; signature?: string } | null;
  const { wallet, issuedAt, signature } = body ?? {};
  if (!wallet || !BASE58_ADDRESS.test(wallet) || !issuedAt || !signature) return Response.json({ error: "bad request" }, { status: 400 });

  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > MAX_SKEW_MS) return Response.json({ error: "signature expired, try again" }, { status: 400 });

  const h = await headers();
  const host = h.get("host") ?? new URL(req.url).host;
  if (!verifyWalletSignature(wallet, signInMessage(wallet, host, issuedAt), signature))
    return Response.json({ error: "signature doesn't match this wallet" }, { status: 401 });

  const token = signSession(wallet);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
  return Response.json(view(await resolveAccess(token, clientIp(h))));
}

export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
