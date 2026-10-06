/**
 * Dumb in-memory rate cap for the RPC-backed routes. Deliberately not elegant: one process,
 * one Map, fixed 60s windows. Its only job is to stop a looping bot from burning the Helius
 * budget or the pump.fun keyless allowance; honest users never see it.
 *
 * Per-IP limit catches individual abusers; the global limit is the fuse that protects the
 * upstream budget even against a botnet of fresh IPs.
 */

const WINDOW_MS = 60_000;

interface Bucket { count: number; windowStart: number; }
const buckets = new Map<string, Bucket>();

function bump(key: string, limit: number, now: number): boolean {
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

/**
 * Env-tunable caps: KARMA_RATE_<ROUTE>_IP / KARMA_RATE_<ROUTE>_GLOBAL (per minute) override
 * the code defaults, so a Helius plan upgrade is an env change, not a redeploy of constants.
 * Sizing rule of thumb: a cold coin scan is ~60 RPC calls, so the GLOBAL cap for /api/coin
 * should be ≈ (plan RPS × 60s) / 60 calls — 10 RPS free ≈ 10/min, 50 RPS Developer ≈ 50/min.
 * Past that the requests don't fail upstream, they queue, and latency eats the product.
 */
function capFor(route: string, kind: "IP" | "GLOBAL", fallback: number): number {
  const v = Number(process.env[`KARMA_RATE_${route.toUpperCase()}_${kind}`]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** True = allowed. Checks the caller's IP window and the route's global window. */
export function allow(route: string, req: Request, perIp: number, global: number): boolean {
  perIp = capFor(route, "IP", perIp);
  global = capFor(route, "GLOBAL", global);
  const now = Date.now();
  // Occasional sweep so dead IPs don't accumulate forever.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
  }
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const ipOk = bump(`${route}:${ip}`, perIp, now);
  const globalOk = bump(`${route}:*`, global, now);
  return ipOk && globalOk;
}

export const tooMany = () =>
  Response.json(
    { error: "rate limited — the scan endpoints are budgeted, try again in a minute" },
    { status: 429, headers: { "retry-after": "60" } },
  );
