/**
 * Behavioral micro-karma probe: solve the "unknown 60%" by fingerprinting how the
 * top holders TRADE, not whether they ever made a call.
 *
 * scanCoin gives the top real holders (infra stripped). For every holder we don't
 * already grade, pull one free pump.fun /user-trades page and classify behaviour
 * (reuses the trade-fingerprint discriminators: churn, median hold, sell ratio).
 * Roll up: how much of the analysed bag sits in mercenary/bot hands vs organic.
 *
 *   npm exec tsx scripts/scan-mints-behavior.ts -- <mint> [<mint> ...]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { RateLimiter } from "../src/lib/karma/http";
import { scanCoin, type WalletRegistry, type CoinHolder } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile(f); } catch {} }

const ROOT = process.cwd();
const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

function loadRegistry(): WalletRegistry {
  const reg: WalletRegistry = new Map();
  try {
    const kols = JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8"));
    for (const k of kols) reg.set(k.wallet_address, { handle: k.handle ?? null, verified: !!k.verified, source_url: k.source_url ?? null, grade: null, title: null });
  } catch {}
  try {
    for (const f of readdirSync(path.join(ROOT, "validation"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(ROOT, "validation", f), "utf8"));
        const e = reg.get(r.wallet);
        if (e && r.score?.grade) { e.grade = r.score.grade; e.title = r.score.title ?? null; }
      } catch {}
    }
  } catch {}
  return reg;
}
const registry = loadRegistry();
const now = Math.floor(Date.now() / 1000);

// ── behavioral fingerprint (one free pump.fun request per wallet) ────────────
const BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36", Origin: "https://pump.fun", Referer: "https://pump.fun/" };
const pumpLimiter = new RateLimiter(1200);
interface Trade { isBuy: boolean; timestamp: string; mint: string; amountUsd: number; }
type Flag = "mercenary" | "serial-flipper" | "organic-hold" | "patient" | "thin" | "off-pump";

const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function pumpFetch(url: string): Promise<Response | null> {
  for (let a = 0; a < 5; a++) {
    await pumpLimiter.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) { pumpLimiter.penalize(Math.min(30_000, 2000 * 2 ** a)); continue; }
    return res;
  }
  return null;
}

interface Fp { flag: Flag; n: number; mints: number; perDay: number; holdMin: number | null; sellRatio: number; }
async function fingerprint(wallet: string): Promise<Fp> {
  let trades: Trade[] = [];
  try {
    const res = await pumpFetch(`https://frontend-api-v3.pump.fun/user-trades/${wallet}?limit=200`);
    if (res && res.ok) { const j = (await res.json()) as { trades?: Trade[] }; trades = (j.trades ?? []).filter((t) => t.timestamp && t.mint); }
  } catch {}
  if (!trades.length) return { flag: "off-pump", n: 0, mints: 0, perDay: 0, holdMin: null, sellRatio: 0 };
  if (trades.length < 4) return { flag: "thin", n: trades.length, mints: new Set(trades.map((t) => t.mint)).size, perDay: 0, holdMin: null, sellRatio: 0 };

  const times = trades.map((t) => new Date(t.timestamp).getTime()).sort((a, b) => a - b);
  const windowMs = Math.max(1, times.at(-1)! - times[0]);
  const perDay = +((trades.length / windowMs) * 86_400_000).toFixed(1);
  const sells = trades.filter((t) => !t.isBuy).length;
  const sellRatio = +(sells / trades.length).toFixed(3);
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) (byMint.get(t.mint) ?? byMint.set(t.mint, []).get(t.mint)!).push(t);
  const holds: number[] = [];
  for (const ts of byMint.values()) {
    ts.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const fb = ts.find((t) => t.isBuy); if (!fb) continue;
    const fbt = new Date(fb.timestamp).getTime();
    const fs = ts.find((t) => !t.isBuy && new Date(t.timestamp).getTime() > fbt); if (!fs) continue;
    holds.push((new Date(fs.timestamp).getTime() - fbt) / 60_000);
  }
  const holdMin = holds.length ? +median(holds)!.toFixed(1) : null;
  const mints = byMint.size;

  // classify (bad = non-organic, worth staying out over)
  let flag: Flag = "organic-hold";
  if (perDay >= 40 || (holdMin !== null && holdMin < 5)) flag = "mercenary";           // bot / per-second scalper
  else if (mints >= 20 && holdMin !== null && holdMin < 60 && sellRatio >= 0.35) flag = "serial-flipper"; // churns many fresh coins, dumps fast
  else if (holdMin !== null && holdMin >= 30 && sellRatio >= 0.25) flag = "patient";
  else flag = "organic-hold";
  return { flag, n: trades.length, mints, perDay, holdMin, sellRatio };
}

const BAD: Flag[] = ["mercenary", "serial-flipper"];

async function main() {
  const mints = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  for (const mint of mints) {
    console.log(`\n════ ${mint} ════`);
    let scan;
    try { scan = await scanCoin(rpc, mint, SCORING, now, cache, registry); }
    catch (e) { console.log(`  scan error: ${(e as Error).message}`); continue; }
    console.log(`  ${scan.symbol ?? "?"} — age ${scan.age_seconds !== null ? (scan.age_seconds / 86400).toFixed(1) + "d" : "?"} · 24h vol $${Math.round(scan.volume_24h_usd).toLocaleString()}`);
    if (!scan.eligible) { console.log(`  REFUSED: ${scan.refusal_reasons.join("; ")}`); continue; }

    // fingerprint every non-registry holder
    const targets = scan.holders.filter((h: CoinHolder) => !h.grade && !h.handle);
    console.log(`  fingerprinting ${targets.length} unknown holders (of top ${scan.holders.length})…\n`);
    const rows: Array<{ h: CoinHolder; fp: Fp }> = [];
    for (const h of targets) rows.push({ h, fp: await fingerprint(h.wallet) });

    const pctOf = (pred: (r: { fp: Fp }) => boolean) => rows.filter(pred).reduce((s, r) => s + r.h.pct_supply, 0);
    const badPct = pctOf((r) => BAD.includes(r.fp.flag));
    const offPct = pctOf((r) => r.fp.flag === "off-pump" || r.fp.flag === "thin");
    const okPct = pctOf((r) => r.fp.flag === "patient" || r.fp.flag === "organic-hold");

    for (const { h, fp } of rows.sort((a, b) => b.h.pct_supply - a.h.pct_supply)) {
      const mark = BAD.includes(fp.flag) ? "🚩" : fp.flag === "off-pump" ? "· " : "✓ ";
      const hold = fp.holdMin === null ? "–" : fp.holdMin < 60 ? `${fp.holdMin}m` : `${(fp.holdMin / 60).toFixed(1)}h`;
      console.log(`    ${mark} ${fp.flag.padEnd(14)} ${h.pct_supply.toFixed(2).padStart(5)}%  ${String(fp.n).padStart(3)}tx ${String(fp.mints).padStart(3)}mints hold ${hold.padStart(6)} sell ${(fp.sellRatio * 100).toFixed(0)}%  ${h.wallet.slice(0, 8)}`);
    }

    console.log(`\n  ── behavioral roll-up (of the ${targets.length} unknown, ${(badPct + offPct + okPct).toFixed(1)}% of supply) ──`);
    console.log(`     🚩 mercenary/serial-flipper: ${badPct.toFixed(1)}%`);
    console.log(`     ✓  organic/patient holders:  ${okPct.toFixed(1)}%`);
    console.log(`     ·  off-pump / too thin to read: ${offPct.toFixed(1)}%`);
    const verdict = badPct >= 15 ? "⚠ INORGANIC — meaningful supply in mercenary/dumper hands, stay cautious"
      : offPct >= okPct + badPct ? "? UNREADABLE — holders mostly trade off pump.fun, need on-chain read"
      : "clean on behavior — no dumper cluster in the readable holders";
    console.log(`     → ${verdict}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
