/**
 * pump.fun coin sweep → wallet hunt.
 *
 * Kombucho's ask: sweep the top-100 movers and top-100 most-holders coins on pump.fun,
 * same criteria as the top-coin scan (>24h old, mcap $50k–$20M, >200 holders), and
 * mine their holders for new caller wallets.
 *
 * pump.fun's REST API exposes NO holder_count field and NO movers sort (those boards
 * are rendered from its NATS websocket, session-gated). So both boards are DERIVED here,
 * which is also more truthful than trusting pump.fun's cached numbers:
 *   - candidate universe: pump.fun /coins?sort=market_cap (reliable), graduated only.
 *   - MOST HOLDERS: true holder count per coin via Helius DAS (getTokenAccounts).
 *   - MOVERS: 24h price change via Dexscreener's batch token endpoint.
 * Then the union runs through the same `scanCoin` (CA karma) + gem seam (aged-unknown
 * holders that are also pump.fun callers) as scripts/scan-top-coins.ts.
 *
 * Budget note: pump.fun bans the IP (CF 1015) at ~1000 req/hr. The gem-seam callout
 * checks are the sink, hard-capped by SCAN_MAX_GEM_CHECKS. Board fetch is ~10 calls.
 *
 * Usage:  npm run sweep-pump        (defaults below)
 * Output: console report + seed/pumpfun_sweep.json (audit + feed for score-callouts).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { RateLimiter, fetchJson } from "../src/lib/karma/http";
import { scanCoin, type CoinScan, type WalletRegistry } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile(f); } catch {} }

const ROOT = process.cwd();
const now = Math.floor(Date.now() / 1000);
const DAY = 86400;

// ── knobs ────────────────────────────────────────────────────────────────────
const MIN_MC_USD = Number(process.env.SCAN_MIN_FDV ?? 50_000);
const MAX_MC_USD = Number(process.env.SCAN_MAX_FDV ?? 20_000_000); // above this, holders are CEXs not callers
const MIN_HOLDERS = Number(process.env.SCAN_MIN_HOLDERS ?? 200);
const MIN_AGE_H = Number(process.env.SCAN_MIN_AGE_H ?? 24);
const PUMP_PAGES = Number(process.env.SCAN_PUMP_PAGES ?? 10); // ×50 = candidate universe depth
const BOARD_N = Number(process.env.SCAN_BOARD_N ?? 100); // top-N per board (movers / holders)
const MAX_SCAN = Number(process.env.SCAN_MAX_COINS ?? 60); // coins actually pushed through scanCoin
const MAX_GEM_CHECKS = Number(process.env.SCAN_MAX_GEM_CHECKS ?? 200); // pump.fun callout checks (ban budget)
const GEM_MIN_CALLOUTS = Number(process.env.SCAN_GEM_MIN_CALLOUTS ?? 3);
const LOOKBACK_SINCE = now - SCORING.lookbackDays * DAY;

const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

// ── registry (seed identities + grades already computed) ─────────────────────
function loadRegistry(): { registry: WalletRegistry; scored: Set<string> } {
  const registry: WalletRegistry = new Map();
  const scored = new Set<string>();
  try {
    for (const k of JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8")))
      registry.set(k.wallet_address, { handle: k.handle ?? null, verified: !!k.verified, source_url: k.source_url ?? null, grade: null, title: null });
  } catch {}
  try {
    for (const f of readdirSync(path.join(ROOT, "validation"))) {
      if (!f.endsWith(".json")) continue;
      scored.add(f.replace(/\.json$/, ""));
      try {
        const r = JSON.parse(readFileSync(path.join(ROOT, "validation", f), "utf8"));
        const e = registry.get(r.wallet);
        if (e && r.score?.grade) { e.grade = r.score.grade; e.title = r.score.title ?? null; }
      } catch {}
    }
  } catch {}
  return { registry, scored };
}
const { registry, scored } = loadRegistry();

// ── pump.fun frontend ─────────────────────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};
const pumpLimiter = new RateLimiter(1200); // ~50/min shared

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

interface Coin { mint: string; symbol: string; mcUsd: number; ageH: number; holders: number; h24: number | null; }

async function fetchPumpBoard(): Promise<Coin[]> {
  const out = new Map<string, Coin>();
  for (let page = 0; page < PUMP_PAGES; page++) {
    const url = `https://frontend-api-v3.pump.fun/coins?offset=${page * 50}&limit=50&sort=market_cap&order=DESC&includeNsfw=true`;
    const res = await pumpFetch(url);
    if (!res || !res.ok) break;
    const list = (await res.json()) as any[];
    if (!Array.isArray(list) || !list.length) break;
    for (const c of list) {
      const mcUsd = Number(c.usd_market_cap ?? 0);
      const ageH = c.created_timestamp ? (Date.now() - c.created_timestamp) / 3.6e6 : Infinity;
      if (!c.complete) continue;               // pre-graduation → no DEX price for scanCoin; skip
      if (mcUsd < MIN_MC_USD || mcUsd > MAX_MC_USD) continue;
      if (ageH < MIN_AGE_H) continue;
      if (!out.has(c.mint)) out.set(c.mint, { mint: c.mint, symbol: c.symbol ?? c.mint.slice(0, 6), mcUsd, ageH, holders: -1, h24: null });
    }
  }
  return [...out.values()];
}

/** Dexscreener batch: 24h price change (movers) + mcap cross-check. Best pair per mint by liquidity. */
async function enrichDexscreener(coins: Coin[]): Promise<void> {
  const dsLimiter = new RateLimiter(250);
  const byMint = new Map(coins.map((c) => [c.mint, c]));
  const mints = [...byMint.keys()];
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    try {
      const j = await fetchJson<{ pairs?: any[] }>(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`, {}, { limiter: dsLimiter, retries: 3 });
      const best = new Map<string, any>();
      for (const p of j.pairs ?? []) {
        const m = p.baseToken?.address;
        if (!m || !byMint.has(m)) continue;
        const prev = best.get(m);
        if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) best.set(m, p);
      }
      for (const [m, p] of best) { const c = byMint.get(m)!; c.h24 = p.priceChange?.h24 ?? null; if (p.marketCap) c.mcUsd = p.marketCap; }
    } catch {}
  }
}

/** Unique-owner count from one DAS page (cap 1000) — enough for the >200 gate. null = DAS unavailable. */
async function holderCount(mint: string): Promise<number | null> {
  try {
    const das = await rpc.call<{ token_accounts?: Array<{ owner: string }> }>("getTokenAccounts", { mint, limit: 1000 });
    return das?.token_accounts ? new Set(das.token_accounts.map((a) => a.owner)).size : null;
  } catch { return null; }
}

async function calloutCount(wallet: string): Promise<number> {
  const res = await pumpFetch(`https://frontend-api-v3.pump.fun/callout/list/${wallet}?limit=100&offset=0&sortBy=TIMESTAMP&sortOrder=DESC`);
  if (res === null) return -1;
  if (res.status === 404) return 0;
  if (!res.ok) return -1;
  const data = (await res.json()) as { callouts?: Array<{ coinMint: string; createdAt: number; calloutPrice: number }> };
  const mints = new Set<string>();
  for (const c of data.callouts ?? []) if (c.createdAt / 1000 >= LOOKBACK_SINCE && c.calloutPrice > 0) mints.add(c.coinMint);
  return mints.size;
}

async function xHandle(wallet: string): Promise<string | null> {
  const res = await pumpFetch(`https://frontend-api-v3.pump.fun/users/${wallet}`);
  if (!res || !res.ok) return null;
  try { const u = (await res.json()) as any; return u.x_username ?? u.twitter ?? u.username ?? null; } catch { return null; }
}

// ── run ────────────────────────────────────────────────────────────────────
interface Gem { wallet: string; handle: string | null; callouts: number; alreadyScored: boolean; maxCoinHolders: number; coins: Array<{ symbol: string; mint: string; pct_supply: number }>; }

async function main() {
  console.log(`\nKarma · pump.fun sweep  (mcap $${(MIN_MC_USD / 1e3).toFixed(0)}k–$${(MAX_MC_USD / 1e6).toFixed(0)}M · >${MIN_HOLDERS} holders · >${MIN_AGE_H}h)\n`);

  const board = await fetchPumpBoard();
  console.log(`pump board: ${board.length} graduated coins in mcap band & >${MIN_AGE_H}h (from ${PUMP_PAGES} pages)`);

  await enrichDexscreener(board);
  console.log(`dexscreener: enriched ${board.filter((c) => c.h24 !== null).length}/${board.length} with 24h change\n`);

  // True holder counts → the >200 gate.
  let checked = 0;
  for (const c of board) { c.holders = (await holderCount(c.mint)) ?? -1; if (++checked % 25 === 0) console.log(`  holder counts: ${checked}/${board.length}…`); }
  const qualified = board.filter((c) => c.holders > MIN_HOLDERS);
  console.log(`\nqualified: ${qualified.length} coins with >${MIN_HOLDERS} holders\n`);

  const mostHolders = [...qualified].sort((a, b) => b.holders - a.holders).slice(0, BOARD_N);
  const movers = qualified.filter((c) => c.h24 !== null).sort((a, b) => (b.h24 ?? 0) - (a.h24 ?? 0)).slice(0, BOARD_N);

  // Scan the union (holders first — richer holder base → more callers to mine), capped.
  const seen = new Set<string>();
  const scanList: Coin[] = [];
  for (const c of [...mostHolders, ...movers]) { if (!seen.has(c.mint)) { seen.add(c.mint); scanList.push(c); } if (scanList.length >= MAX_SCAN) break; }

  const scans = new Map<string, CoinScan>();
  const unknowns = new Map<string, Gem>();
  let coinsWithKnown = 0, dumperCoins = 0;
  for (const c of scanList) {
    let scan: CoinScan;
    try { scan = await scanCoin(rpc, c.mint, SCORING, now, cache, registry); } catch { continue; }
    if (!scan.eligible) continue;
    scans.set(c.mint, scan);
    if (scan.holders.some((h) => h.grade || h.handle)) coinsWithKnown++;
    if (scan.holders.some((h) => h.grade === "D" || h.grade === "F")) dumperCoins++;
    for (const h of scan.holders) {
      if (h.kind !== "wallet") continue; // aged, unknown, not infra/fresh/known
      const g = unknowns.get(h.wallet) ?? { wallet: h.wallet, handle: null, callouts: 0, alreadyScored: scored.has(h.wallet), maxCoinHolders: 0, coins: [] };
      g.coins.push({ symbol: scan.symbol ?? c.symbol, mint: c.mint, pct_supply: h.pct_supply });
      g.maxCoinHolders = Math.max(g.maxCoinHolders, c.holders);
      unknowns.set(h.wallet, g);
    }
  }

  // Gem seam: prioritise not-yet-scored, then holders from the most-established coins (best caller odds).
  const toCheck = [...unknowns.values()]
    .sort((a, b) => Number(a.alreadyScored) - Number(b.alreadyScored) || b.maxCoinHolders - a.maxCoinHolders)
    .slice(0, MAX_GEM_CHECKS);
  console.log(`── GEM SEAM ─────────────────────────────────────────────────────────`);
  console.log(`  ${unknowns.size} aged-unknown holders across ${scans.size} scanned coins; checking ${toCheck.length} for callouts (cap ${MAX_GEM_CHECKS})…\n`);
  const gems: Gem[] = [];
  for (const g of toCheck) {
    const n = await calloutCount(g.wallet);
    if (n < GEM_MIN_CALLOUTS) continue;
    g.callouts = n;
    g.handle = await xHandle(g.wallet);
    gems.push(g);
  }
  gems.sort((a, b) => Number(a.alreadyScored) - Number(b.alreadyScored) || b.callouts - a.callouts);

  // ── report ──
  const line = (c: Coin, s?: CoinScan) => {
    const bad = s ? s.holders.filter((h) => h.grade === "D" || h.grade === "F") : [];
    const good = s ? s.holders.filter((h) => h.grade && h.grade !== "D" && h.grade !== "F") : [];
    const tag = bad.length ? ` ⚠ ${bad.length} dumper(s): ${bad.map((h) => "@" + (h.handle ?? "?")).join(",")}` : good.length ? ` ✓ ${good.map((h) => "@" + (h.handle ?? "?") + "(" + h.grade + ")").join(",")}` : "";
    return `  ${c.symbol.padEnd(12)} ${String(c.holders).padStart(5)} hldrs · $${(c.mcUsd / 1e6).toFixed(2)}M · ${c.h24 !== null ? (c.h24 >= 0 ? "+" : "") + c.h24.toFixed(0) + "%" : "  ?"}${tag}`;
  };
  console.log(`\n── TOP MOST-HOLDERS (scanned) ───────────────────────────────────────`);
  for (const c of mostHolders.slice(0, 15)) console.log(line(c, scans.get(c.mint)));
  console.log(`\n── TOP MOVERS 24h (scanned) ─────────────────────────────────────────`);
  for (const c of movers.slice(0, 15)) console.log(line(c, scans.get(c.mint)));

  console.log(`\n── NEW CALLER CANDIDATES (feed to score-callouts) ───────────────────`);
  const newGems = gems.filter((g) => !g.alreadyScored);
  if (!newGems.length) console.log("  none cleared the callout threshold this run.");
  for (const g of newGems.slice(0, 40))
    console.log(`  ${(g.handle ? "@" + g.handle : g.wallet.slice(0, 8) + "…").padEnd(22)} ${g.callouts} callouts · in ${g.coins.length} coin(s) · top coin ${g.maxCoinHolders} hldrs\n    ${g.wallet}`);

  console.log(`\n── READ ─────────────────────────────────────────────────────────────`);
  console.log(`  universe ${board.length} → qualified ${qualified.length} (>${MIN_HOLDERS} hldrs) → scanned ${scans.size}`);
  console.log(`  coins with a graded wallet in top holders: ${coinsWithKnown}/${scans.size}   dumper-in-bag coins: ${dumperCoins}`);
  console.log(`  aged-unknown holders mined: ${unknowns.size} · caller candidates: ${gems.length} (${newGems.length} NEW)`);

  const out = {
    generated_at: new Date().toISOString(),
    filters: { min_mc_usd: MIN_MC_USD, max_mc_usd: MAX_MC_USD, min_holders: MIN_HOLDERS, min_age_h: MIN_AGE_H },
    universe: board.length, qualified: qualified.length, scanned: scans.size,
    most_holders: mostHolders.map((c) => ({ symbol: c.symbol, mint: c.mint, holders: c.holders, mc_usd: c.mcUsd, h24: c.h24 })),
    movers: movers.map((c) => ({ symbol: c.symbol, mint: c.mint, holders: c.holders, mc_usd: c.mcUsd, h24: c.h24 })),
    ca_karma: [...scans.entries()].map(([mint, s]) => ({ mint, symbol: s.symbol, summary: s.summary, known_holders: s.holders.filter((h) => h.grade || h.handle) })),
    new_caller_candidates: newGems,
  };
  writeFileSync(path.join(ROOT, "seed", "pumpfun_sweep.json"), JSON.stringify(out, null, 2));
  console.log(`\n  written: seed/pumpfun_sweep.json\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
