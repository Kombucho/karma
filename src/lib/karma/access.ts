import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { getBase58Encoder } from "@solana/kit";
import { db } from "./db";
import { fetchJson } from "./http";
import { serverCache, serverRpc } from "./registry";

/**
 * Hold-to-scan: the gate on fresh coin scans, the only surface that spends RPC budget.
 *
 * Caller cards, cached scans (anyone's scan <30 min old) and the board stay free for everyone. A
 * *fresh* scan counts against a daily allowance:
 *   · anyone            → FREE_DAILY per IP
 *   · $KARMA holders    → by the USD value they hold, per wallet (proved by signing a message)
 *   · owner wallets     → unlimited (KARMA_OWNER_WALLETS)
 *
 * Holding, not paying: no transfers to verify, no lock program. The wallet session is an HMAC'd
 * cookie; the balance is read live (cached 5 min). Until NEXT_PUBLIC_KARMA_MINT is set nobody can
 * hold, so everyone but the owner sits on the free tier.
 *
 * Counters live in Supabase (scan_usage, db/schema.sql); if the table is missing they fall back to
 * per-instance memory, which still gates, just leakier across instances.
 *
 * Master switch: KARMA_GATE=on enforces the allowances. Off (the default) everything stays free, but
 * fresh scans are still counted, so scan_usage shows real demand before any price is set.
 */

const GATE_ON = process.env.KARMA_GATE === "on";

const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

export const FREE_DAILY = num(process.env.KARMA_FREE_DAILY, 5);
/** Holder tiers, richest first: hold ≥ usd worth of $KARMA → daily fresh scans. */
export const TIERS = [
  { name: "whale", usd: num(process.env.KARMA_TIER2_USD, 50), daily: num(process.env.KARMA_TIER2_DAILY, 150) },
  { name: "holder", usd: num(process.env.KARMA_TIER1_USD, 5), daily: num(process.env.KARMA_TIER1_DAILY, 25) },
] as const;

const MINT = process.env.NEXT_PUBLIC_KARMA_MINT ?? "";
const OWNERS = new Set((process.env.KARMA_OWNER_WALLETS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
export const SESSION_COOKIE = "karma_w";
export const SESSION_DAYS = 30;

export interface Access {
  wallet: string | null;
  tier: "owner" | "whale" | "holder" | "free";
  /** Infinity for the owner. */
  daily: number;
  used: number;
  /** USD value of the wallet's $KARMA, when known. */
  holdingUsd: number | null;
  subject: string;
}

// ── session cookie ───────────────────────────────────────────────────────────────────────────────

function secret(): string {
  const s = process.env.KARMA_SESSION_SECRET;
  if (s) return s;
  // Derived fallback so prod works before the dedicated secret is set; never a constant in code.
  return createHash("sha256").update(`karma-session:${process.env.SUPABASE_SECRET_KEY ?? ""}:${process.env.HELIUS_API_KEY ?? "dev"}`).digest("hex");
}

const mac = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function signSession(wallet: string): string {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return `${wallet}.${exp}.${mac(`${wallet}.${exp}`)}`;
}

/** The wallet a cookie proves, or null if absent, forged or expired. */
export function readSession(value: string | undefined): string | null {
  if (!value) return null;
  const [wallet, exp, sig] = value.split(".");
  if (!wallet || !exp || !sig) return null;
  const want = Buffer.from(mac(`${wallet}.${exp}`));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return Number(exp) > Date.now() / 1000 ? wallet : null;
}

// ── sign-in message ──────────────────────────────────────────────────────────────────────────────

export function signInMessage(wallet: string, host: string, issuedAt: string): string {
  return `Karma: sign in to unlock coin scans.\nNo transaction, no fees.\n\nWallet: ${wallet}\nDomain: ${host}\nIssued: ${issuedAt}`;
}

// DER prefix that turns a raw 32-byte ed25519 key into an SPKI key Node can verify with.
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

/** True when `signature` (base64) is `wallet`'s ed25519 signature over `message`. */
export function verifyWalletSignature(wallet: string, message: string, signatureB64: string): boolean {
  try {
    const pub = Buffer.from(getBase58Encoder().encode(wallet));
    if (pub.length !== 32) return false;
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub]), format: "der", type: "spki" });
    return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

// ── holdings ─────────────────────────────────────────────────────────────────────────────────────

async function karmaPriceUsd(): Promise<number | null> {
  if (!MINT) return null;
  const hit = await serverCache.get<number>(`karma_price:${MINT}`);
  if (hit !== undefined) return hit;
  try {
    const pairs = await fetchJson<{ priceUsd?: string; liquidity?: { usd?: number } }[]>(
      `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`, {}, { retries: 2, timeoutMs: 5000 });
    const best = [...(pairs ?? [])].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const p = best?.priceUsd ? Number(best.priceUsd) : null;
    if (p && p > 0) await serverCache.set(`karma_price:${MINT}`, p, 300);
    return p && p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** Whole $KARMA tokens the wallet holds (all token accounts, either token program). */
async function karmaBalance(wallet: string): Promise<number> {
  if (!MINT) return 0;
  const key = `karma_bal:${wallet}`;
  const hit = await serverCache.get<number>(key);
  if (hit !== undefined) return hit;
  const res = await serverRpc.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number | null } } } } } }[] }>(
    "getTokenAccountsByOwner", [wallet, { mint: MINT }, { encoding: "jsonParsed" }]);
  const bal = res.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
  await serverCache.set(key, bal, 300);
  return bal;
}

export async function holdingUsd(wallet: string): Promise<number | null> {
  if (!MINT) return null;
  try {
    const [bal, price] = await Promise.all([karmaBalance(wallet), karmaPriceUsd()]);
    return price === null ? null : bal * price;
  } catch {
    return null;
  }
}

// ── daily counters ───────────────────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const memUsage = new Map<string, number>();

async function usedToday(subject: string): Promise<number> {
  const c = db();
  if (c) {
    const { data, error } = await c.from("scan_usage").select("count").eq("subject", subject).eq("day", today()).maybeSingle();
    if (!error) return (data?.count as number | undefined) ?? 0;
  }
  return memUsage.get(`${today()}:${subject}`) ?? 0;
}

/** Counts one fresh scan against the subject's day. */
export async function recordFreshScan(access: Access): Promise<void> {
  if (access.tier === "owner") return;
  const c = db();
  if (c) {
    const { error } = await c.rpc("bump_scan_usage", { p_subject: access.subject, p_day: today() });
    if (!error) return;
  }
  const k = `${today()}:${access.subject}`;
  if (memUsage.size > 20000) memUsage.clear();
  memUsage.set(k, (memUsage.get(k) ?? 0) + 1);
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────────

export function clientIp(h: Headers): string {
  return (h.get("x-forwarded-for") ?? "local").split(",")[0].trim();
}

/** Who's asking and what they're allowed today. Cheap: one cookie check, at most one balance read. */
export async function resolveAccess(sessionCookie: string | undefined, ip: string): Promise<Access> {
  const wallet = readSession(sessionCookie);
  if (wallet && OWNERS.has(wallet)) return { wallet, tier: "owner", daily: Infinity, used: 0, holdingUsd: null, subject: `w:${wallet}` };

  if (wallet) {
    const usd = await holdingUsd(wallet);
    const tier = usd === null ? undefined : TIERS.find((t) => usd >= t.usd);
    // Holders count per wallet; a signed-in non-holder still shares their IP's free allowance.
    if (tier) {
      const subject = `w:${wallet}`;
      return { wallet, tier: tier.name, daily: tier.daily, used: await usedToday(subject), holdingUsd: usd, subject };
    }
    const subject = `ip:${ip}`;
    return { wallet, tier: "free", daily: FREE_DAILY, used: await usedToday(subject), holdingUsd: usd, subject };
  }

  const subject = `ip:${ip}`;
  return { wallet: null, tier: "free", daily: FREE_DAILY, used: await usedToday(subject), holdingUsd: null, subject };
}

export const canFreshScan = (a: Access) => !GATE_ON || a.used < a.daily;
export const karmaMintLive = () => !!MINT;
