/**
 * Top-coins CA-karma feeder.
 *
 * Two experiments in one pass (see CHECKPOINT / the 50-passer thread):
 *
 *   1. CA KARMA — run the existing `scanCoin` primitive on today's hot Solana
 *      coins and read the registry overlap: of each contract's top holders, how
 *      many are wallets we've already graded (especially D/F dumpers). The real
 *      question it answers: is the 486-wallet corpus dense enough that random hot
 *      coins even contain graded wallets? If most come back all-unknown, the CA
 *      product isn't shippable yet and the read-through is "grow the corpus first".
 *
 *   2. GEM SEAM — a good caller is rarely a top holder by size (those are LPs,
 *      snipers, whales). The one place a new gem hides is an *aged, unknown*
 *      holder who is ALSO a pump.fun caller: someone who called a coin and held
 *      through it (the WIN profile). So we take only `kind === "wallet"` holders
 *      (aged, not fresh, not infra, not already-known) and keep the ones with a
 *      real callout history. Everything else in the holder list is a sniper, the
 *      anti-caller. pump.fun checks are hard-capped to stay under the CF 1015 ban.
 *
 * Sourcing / filters (Kombucho's ask): coins >24h old, FDV >= $50k, >200 holders.
 *   - FDV, not mcap: memecoin market_cap_usd is usually null on GeckoTerminal;
 *     fdv_usd is present. They diverge when supply isn't in float — labelled FDV.
 *   - Age: feed pre-filters loosely on POOL age (a migrated pool can be younger
 *     than the token); `scanCoin` is the authority and enforces the real 24h gate.
 *   - Holders: the trending feed carries no count, so one Helius DAS enumeration
 *     per candidate gives it (capped at one 1000-account page — enough for >200).
 *
 * Usage:
 *   npm run scan-coins                 # default: 20 coins, 40 gem checks
 *   SCAN_MAX_COINS=10 npm run scan-coins
 *
 * Output: console report + seed/top_coin_scan.json (audit trail + next-step feed).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { RateLimiter, fetchJson } from "../src/lib/karma/http";
import { scanCoin, type CoinScan, type WalletRegistry } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile(f); } catch {}
}

const ROOT = process.cwd();
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

// ── knobs (env-overridable) ─────────────────────────────────────────────────
const MIN_FDV_USD = Number(process.env.SCAN_MIN_FDV ?? 50_000);
// Soft ceiling: above this, top holders are CEXs/whales not pump.fun callers, so CA-karma overlap
// with a KOL-caller corpus is ~0. Targets the mid-cap band where graded callers actually hold. Lift with SCAN_MAX_FDV=0.
const MAX_FDV_USD = Number(process.env.SCAN_MAX_FDV ?? 20_000_000);
const MIN_HOLDERS = Number(process.env.SCAN_MIN_HOLDERS ?? 200);
const FEED_MIN_AGE_H = Number(process.env.SCAN_FEED_MIN_AGE_H ?? 12); // lenient; scanCoin enforces 24h
const MAX_COINS = Number(process.env.SCAN_MAX_COINS ?? 20);
const MAX_GEM_CHECKS = Number(process.env.SCAN_MAX_GEM_CHECKS ?? 40);
const GEM_MIN_CALLOUTS = Number(process.env.SCAN_GEM_MIN_CALLOUTS ?? 3);
const LOOKBACK_SINCE = now - SCORING.lookbackDays * DAY;

const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

// ── registry: seed identities + grades we've already computed ────────────────
/** Mirrors src/app/api/coin/[mint]/route.ts loadRegistry, plus a set of already-scored wallets. */
function loadRegistry(): { registry: WalletRegistry; scored: Set<string> } {
  const registry: WalletRegistry = new Map();
  const scored = new Set<string>();
  try {
    const kols = JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8"));
    for (const k of kols)
      registry.set(k.wallet_address, {
        handle: k.handle ?? null,
        verified: !!k.verified,
        source_url: k.source_url ?? null,
        grade: null,
        title: null,
      });
  } catch {}
  try {
    for (const f of readdirSync(path.join(ROOT, "validation"))) {
      if (!f.endsWith(".json")) continue;
      scored.add(f.replace(/\.json$/, ""));
      try {
        const r = JSON.parse(readFileSync(path.join(ROOT, "validation", f), "utf8"));
        const entry = registry.get(r.wallet);
        if (entry && r.score?.grade) { entry.grade = r.score.grade; entry.title = r.score.title ?? null; }
      } catch {}
    }
  } catch {}
  return { registry, scored };
}
const { registry, scored } = loadRegistry();

// ── GeckoTerminal feed: trending + volume-sorted Solana pools ────────────────
const GT = "https://api.geckoterminal.com/api/v2/networks/solana";
const gtLimiter = new RateLimiter(60_000 / 28); // public API: 30/min

// Quote-side assets that show up as a pool's "base" in cross-quoted pairs — never our target.
const QUOTE_MINTS = new Set([
  "So11111111111111111111111111111111111111112", // wSOL
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
]);

interface Candidate { mint: string; symbol: string; fdvUsd: number; poolAgeH: number; vol24hUsd: number; }

async function gtPools(url: string): Promise<any[]> {
  try {
    const json = await fetchJson<{ data?: any[] }>(url, {}, { limiter: gtLimiter, retries: 6 });
    return json.data ?? [];
  } catch { return []; }
}

async function fetchFeed(): Promise<Candidate[]> {
  const urls = [
    `${GT}/trending_pools?page=1&duration=24h`,
    ...[1, 2, 3, 4, 5].map((p) => `${GT}/pools?page=${p}&sort=h24_volume_usd_desc`),
  ];
  const byMint = new Map<string, Candidate>();
  for (const url of urls) {
    for (const p of await gtPools(url)) {
      const a = p.attributes ?? {};
      const baseId: string = p.relationships?.base_token?.data?.id ?? "";
      const mint = baseId.startsWith("solana_") ? baseId.slice("solana_".length) : "";
      if (!mint || QUOTE_MINTS.has(mint)) continue;
      const fdvUsd = Number(a.fdv_usd ?? a.market_cap_usd ?? 0);
      const created = a.pool_created_at ? Math.floor(Date.parse(a.pool_created_at) / 1000) : null;
      const poolAgeH = created ? (now - created) / 3600 : Infinity; // unknown age → don't cut here
      const vol24hUsd = Number(a.volume_usd?.h24 ?? 0);
      const symbol = String(a.name ?? "").split(" / ")[0] || mint.slice(0, 6);
      if (fdvUsd < MIN_FDV_USD) continue;
      if (MAX_FDV_USD > 0 && fdvUsd > MAX_FDV_USD) continue;
      if (poolAgeH < FEED_MIN_AGE_H) continue;
      const prev = byMint.get(mint);
      if (!prev || vol24hUsd > prev.vol24hUsd) byMint.set(mint, { mint, symbol, fdvUsd, poolAgeH, vol24hUsd });
    }
  }
  // FDV-desc: scan the meatiest, most-established coins first — those most likely to clear >200 holders.
  return [...byMint.values()].sort((a, b) => b.fdvUsd - a.fdvUsd);
}

/** Unique-owner count from one DAS page (capped at 1000). Enough to decide the >200 gate. */
async function holderCount(mint: string): Promise<number | null> {
  try {
    const das = await rpc.call<{ token_accounts?: Array<{ owner: string }> }>("getTokenAccounts", { mint, limit: 1000 });
    const accts = das?.token_accounts;
    if (!accts) return null; // DAS unsupported on this endpoint
    return new Set(accts.map((a) => a.owner)).size;
  } catch { return null; }
}

// ── pump.fun caller check (gem seam) ─────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};
const pumpLimiter = new RateLimiter(1200); // ~50/min, shared, matches the callout scorer

async function pumpFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await pumpLimiter.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) { pumpLimiter.penalize(Math.min(30_000, 2000 * 2 ** attempt)); continue; }
    return res;
  }
  return null;
}

/** #distinct-mint callouts within the lookback. -1 = transient failure (unknown, don't brand). */
async function calloutCount(wallet: string): Promise<number> {
  const url = `https://frontend-api-v3.pump.fun/callout/list/${wallet}?limit=100&offset=0&sortBy=TIMESTAMP&sortOrder=DESC`;
  const res = await pumpFetch(url);
  if (res === null) return -1;
  if (res.status === 404) return 0;
  if (!res.ok) return -1;
  const data = (await res.json()) as { callouts?: Array<{ coinMint: string; createdAt: number; calloutPrice: number }> };
  const mints = new Set<string>();
  for (const c of data.callouts ?? [])
    if (c.createdAt / 1000 >= LOOKBACK_SINCE && c.calloutPrice > 0) mints.add(c.coinMint);
  return mints.size;
}

/** Best-effort wallet → X handle backlink. */
async function xHandle(wallet: string): Promise<string | null> {
  const res = await pumpFetch(`https://frontend-api-v3.pump.fun/users/${wallet}`);
  if (!res || !res.ok) return null;
  try {
    const u = (await res.json()) as any;
    return u.x_username ?? u.twitter ?? u.username ?? null;
  } catch { return null; }
}

// ── run ──────────────────────────────────────────────────────────────────────
interface GemCandidate {
  wallet: string; handle: string | null; callouts: number; alreadyScored: boolean;
  coins: Array<{ symbol: string; mint: string; pct_supply: number }>;
}

async function main() {
  console.log(`\nKarma · top-coin CA scan  (FDV ≥ $${(MIN_FDV_USD / 1000).toFixed(0)}k · >${MIN_HOLDERS} holders · >24h)\n`);

  const feed = await fetchFeed();
  console.log(`feed: ${feed.length} coins past FDV+age pre-filter, checking holders…\n`);

  // Holder gate, then scan up to MAX_COINS.
  const scans: Array<{ cand: Candidate; holders: number; scan: CoinScan }> = [];
  const refused: Array<{ symbol: string; mint: string; why: string }> = [];
  for (const cand of feed) {
    if (scans.length >= MAX_COINS) break;
    const holders = await holderCount(cand.mint);
    if (holders !== null && holders < MIN_HOLDERS) { refused.push({ symbol: cand.symbol, mint: cand.mint, why: `${holders} holders < ${MIN_HOLDERS}` }); continue; }
    let scan: CoinScan;
    try { scan = await scanCoin(rpc, cand.mint, SCORING, now, cache, registry); }
    catch (e) { refused.push({ symbol: cand.symbol, mint: cand.mint, why: `scan error: ${(e as Error).message}` }); continue; }
    if (!scan.eligible) { refused.push({ symbol: cand.symbol, mint: cand.mint, why: scan.refusal_reasons[0] ?? "ineligible" }); continue; }
    scans.push({ cand, holders: holders ?? -1, scan });
  }

  // ── CA karma report ──
  let coinsWithKnown = 0;
  console.log("── CA KARMA (who holds the bag) ─────────────────────────────────────\n");
  for (const { cand, holders, scan } of scans) {
    const s = scan.summary!;
    const known = scan.holders.filter((h) => h.grade || h.handle);
    if (known.length) coinsWithKnown++;
    const hc = holders >= 1000 ? "1000+" : holders >= 0 ? String(holders) : "n/a";
    console.log(`  ${(scan.symbol ?? cand.symbol).padEnd(12)} FDV $${(cand.fdvUsd / 1000).toFixed(0)}k · ${hc} holders · ${(cand.poolAgeH / 24).toFixed(1)}d`);
    console.log(`    ${cand.mint}`);
    console.log(`    KOL ${s.pct_kol.toFixed(1)}% · D/F dumpers ${s.pct_bad_kol.toFixed(1)}% · fresh ${s.pct_fresh.toFixed(1)}% · bundled ${s.pct_bundled.toFixed(1)}% · unknown ${s.pct_unknown.toFixed(1)}%`);
    const bad = scan.holders.filter((h) => h.grade === "D" || h.grade === "F");
    if (bad.length) console.log(`    ⚠ dumpers in bag: ${bad.map((h) => `@${h.handle ?? "?"}(${h.grade} ${h.pct_supply.toFixed(1)}%)`).join(", ")}`);
    const good = scan.holders.filter((h) => h.grade && h.grade !== "D" && h.grade !== "F");
    if (good.length) console.log(`    ✓ graded holders: ${good.map((h) => `@${h.handle ?? "?"}(${h.grade})`).join(", ")}`);
    console.log("");
  }

  // ── gem seam: aged-unknown holders that are also callers ──
  console.log("── GEM SEAM (aged unknown holders with a callout history) ───────────\n");
  const unknownByWallet = new Map<string, GemCandidate>();
  for (const { scan } of scans) {
    for (const h of scan.holders) {
      if (h.kind !== "wallet") continue; // aged, unknown, not infra/fresh/kol
      const g = unknownByWallet.get(h.wallet) ?? { wallet: h.wallet, handle: null, callouts: 0, alreadyScored: scored.has(h.wallet), coins: [] };
      g.coins.push({ symbol: scan.symbol ?? "?", mint: scan.mint, pct_supply: h.pct_supply });
      unknownByWallet.set(h.wallet, g);
    }
  }
  // Prioritise wallets seen holding across MORE coins (recurring conviction), cap the pump.fun traffic.
  const toCheck = [...unknownByWallet.values()]
    .sort((a, b) => b.coins.length - a.coins.length)
    .slice(0, MAX_GEM_CHECKS);
  console.log(`  ${unknownByWallet.size} aged-unknown holders; checking top ${toCheck.length} for callouts (cap ${MAX_GEM_CHECKS})…\n`);

  const gems: GemCandidate[] = [];
  for (const g of toCheck) {
    const n = await calloutCount(g.wallet);
    if (n < GEM_MIN_CALLOUTS) continue; // -1 (transient) and thin non-callers both fall out
    g.callouts = n;
    g.handle = await xHandle(g.wallet);
    gems.push(g);
  }
  gems.sort((a, b) => b.callouts - a.callouts);

  if (!gems.length) console.log("  none: no aged-unknown holder cleared the callout threshold this run.\n");
  for (const g of gems) {
    const tag = g.alreadyScored ? "(already scored)" : "NEW";
    console.log(`  ${tag.padEnd(16)} ${g.handle ? "@" + g.handle : g.wallet.slice(0, 8) + "…"}  ${g.callouts} callouts · holds ${g.coins.length} of the scanned coins`);
    console.log(`    ${g.wallet}`);
  }

  // ── verdict on the real question ──
  console.log("\n── READ ─────────────────────────────────────────────────────────────");
  const holderGated = refused.filter((r) => r.why.includes("holders <")).length;
  console.log(`  coins scanned:            ${scans.length}  (refused ${refused.length}: ${holderGated} under ${MIN_HOLDERS} holders, ${refused.length - holderGated} other)`);
  console.log(`  coins with ≥1 graded wallet in top holders: ${coinsWithKnown}/${scans.length}  ← corpus-density signal`);
  const newGems = gems.filter((g) => !g.alreadyScored);
  console.log(`  gem candidates:           ${gems.length}  (${newGems.length} NEW, not yet scored)`);
  if (scans.length && coinsWithKnown / scans.length < 0.2)
    console.log(`  → corpus too sparse: <20% of hot coins contain a graded wallet. Grow the corpus before shipping CA karma.`);
  else if (scans.length)
    console.log(`  → corpus has signal: graded wallets show up in ${((coinsWithKnown / scans.length) * 100).toFixed(0)}% of hot coins.`);

  const out = {
    generated_at: new Date().toISOString(),
    filters: { min_fdv_usd: MIN_FDV_USD, min_holders: MIN_HOLDERS, min_age_hours: 24 },
    coins_scanned: scans.length,
    coins_with_known_holder: coinsWithKnown,
    scans: scans.map(({ cand, holders, scan }) => ({ symbol: scan.symbol ?? cand.symbol, mint: cand.mint, fdv_usd: cand.fdvUsd, holders, summary: scan.summary, known_holders: scan.holders.filter((h) => h.grade || h.handle) })),
    refused,
    gem_candidates: gems,
  };
  const outPath = path.join(ROOT, "seed", "top_coin_scan.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n  written: ${path.relative(ROOT, outPath)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
