/**
 * Trade-behaviour fingerprint — separates patient position traders from bots/scalpers.
 *
 * Karma's callout scorer only sees people who post public calls. The pnl-leaderboard is
 * full of top earners who never call — some are patient traders worth a copy-trade track,
 * most are per-second snipers/bots worth nothing. Hold time is the discriminator.
 *
 * One free request per wallet (`/user-trades/{wallet}?limit=200`, keyless, browser headers)
 * carries {isBuy, timestamp, mint, amountUsd} per trade — enough to FINGERPRINT behaviour
 * without reconstructing full PnL from chain (that's the tx-scan wall the project fled).
 * 182 leaderboard wallets = 182 requests, well under the ~1k/hr Cloudflare ban.
 *
 * We don't need full history to CLASSIFY, only the behavioural signature in one page:
 *   - trades_per_day   frequency = the inverse of hold time
 *   - median_hold_min  median over round-tripped mints of (first_sell − first_buy):
 *                      "how long they hold before they start taking profit" (Kombucho's ask)
 *   - sell_ratio       do they realise (sells/total) vs sit on bags
 *   - distinct_mints   churn
 *
 * Usage:
 *   npm run fingerprint                 # all wallets in seed/pnl_leaderboard_harvest.json
 *   npm run fingerprint -- no-callout   # only those with no graded callout file (recommended)
 * Output: seed/trade_fingerprints.json  + printed distribution + the patient-trader shortlist
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { RateLimiter } from "../src/lib/karma/http";

const ROOT = process.cwd();
const HARVEST_PATH = path.join(ROOT, "seed", "pnl_leaderboard_harvest.json");
const VALIDATION_DIR = path.join(ROOT, "validation");
const OUT_PATH = path.join(ROOT, "seed", "trade_fingerprints.json");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
};

// ── classifier thresholds (retune after seeing the distribution) ────────────────
const TH = {
  page: 200,               // trades pulled per wallet (one page)
  botTradesPerDay: 40,     // ≥ this = mechanical churn, not a human
  botHoldMin: 5,           // median hold < 5 min = scalper/bot
  patientHoldMinLo: 30,    // human "let it breathe" floor: 30 min
  patientHoldMinHi: 14 * 24 * 60, // 14 days ceiling (beyond = long-term bag, different animal)
  patientMaxTradesPerDay: 25,     // above this, too frantic to be a position trader
  patientMinSellRatio: 0.25,      // must actually realise, not just accumulate
  whaleMaxSellRatio: 0.12,        // almost all buys, barely sells = bag holder
};

const limiter = new RateLimiter(1200);

async function pumpFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await limiter.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      limiter.penalize(Math.min(30_000, 2000 * 2 ** attempt));
      continue;
    }
    return res;
  }
  return null;
}

interface Trade { isBuy: boolean; timestamp: string; mint: string; amountUsd: number; }

type Klass = "bot/scalper" | "patient-trader" | "bag-whale" | "mixed" | "no-data";

interface Fingerprint {
  wallet: string;
  handle: string | null;
  best_pnl_usd: number;
  n_trades: number;
  window_hours: number;
  trades_per_day: number;
  distinct_mints: number;
  sell_ratio: number;
  median_hold_min: number | null;
  round_trips: number;      // mints where we saw a buy then a later sell
  klass: Klass;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function classify(f: Omit<Fingerprint, "klass">): Klass {
  if (!f.n_trades) return "no-data";
  const hold = f.median_hold_min;
  // Bot: frantic frequency OR sub-5-minute median holds.
  if (f.trades_per_day >= TH.botTradesPerDay) return "bot/scalper";
  if (hold !== null && hold < TH.botHoldMin) return "bot/scalper";
  // Bag whale: buys and (almost) never sells.
  if (f.sell_ratio <= TH.whaleMaxSellRatio) return "bag-whale";
  // Patient: human hold window, actually realises, not frantic.
  if (
    hold !== null &&
    hold >= TH.patientHoldMinLo &&
    hold <= TH.patientHoldMinHi &&
    f.sell_ratio >= TH.patientMinSellRatio &&
    f.trades_per_day <= TH.patientMaxTradesPerDay
  ) return "patient-trader";
  return "mixed";
}

async function fingerprint(wallet: string, handle: string | null, bestPnl: number): Promise<Fingerprint> {
  const url = `https://frontend-api-v3.pump.fun/user-trades/${wallet}?limit=${TH.page}`;
  let trades: Trade[] = [];
  try {
    const res = await pumpFetch(url);
    if (res && res.ok) {
      const j = (await res.json()) as { trades?: Trade[] };
      trades = (j.trades ?? []).filter((t) => t.timestamp && t.mint);
    }
  } catch { /* leave empty → no-data */ }

  const base = {
    wallet, handle, best_pnl_usd: bestPnl,
    n_trades: trades.length, window_hours: 0, trades_per_day: 0,
    distinct_mints: 0, sell_ratio: 0, median_hold_min: null as number | null, round_trips: 0,
  };
  if (!trades.length) return { ...base, klass: "no-data" };

  const times = trades.map((t) => new Date(t.timestamp).getTime()).sort((a, b) => a - b);
  const windowMs = Math.max(1, times[times.length - 1] - times[0]);
  base.window_hours = +(windowMs / 3_600_000).toFixed(1);
  base.trades_per_day = +((trades.length / windowMs) * 86_400_000).toFixed(1);
  const buys = trades.filter((t) => t.isBuy).length;
  const sells = trades.length - buys;
  base.sell_ratio = +(sells / trades.length).toFixed(3);

  // Per mint: first buy time, and first sell that comes AFTER it. hold = start of profit-taking.
  const byMint = new Map<string, Trade[]>();
  for (const t of trades) (byMint.get(t.mint) ?? byMint.set(t.mint, []).get(t.mint)!).push(t);
  base.distinct_mints = byMint.size;
  const holds: number[] = [];
  for (const ts of byMint.values()) {
    ts.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const firstBuy = ts.find((t) => t.isBuy);
    if (!firstBuy) continue;
    const fb = new Date(firstBuy.timestamp).getTime();
    const firstSell = ts.find((t) => !t.isBuy && new Date(t.timestamp).getTime() > fb);
    if (!firstSell) continue;
    holds.push((new Date(firstSell.timestamp).getTime() - fb) / 60_000); // minutes
  }
  base.round_trips = holds.length;
  base.median_hold_min = holds.length ? +median(holds)!.toFixed(1) : null;

  return { ...base, klass: classify(base) };
}

async function gradedWallets(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    for (const f of await readdir(VALIDATION_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
        // "graded caller" = has scored callout tokens (not a no-callout UNPROVEN record)
        if ((d.scan?.scored ?? 0) > 0) set.add(d.wallet);
      } catch { /* skip */ }
    }
  } catch { /* no dir */ }
  return set;
}

async function main() {
  const mode = process.argv.slice(2)[0]; // "no-callout" to skip graded callers
  const harvest = JSON.parse(await readFile(HARVEST_PATH, "utf8")) as {
    wallets: Array<{ wallet: string; xUsername: string | null; best_pnl_usd: number }>;
  };

  let targets = harvest.wallets;
  if (mode === "no-callout") {
    const graded = await gradedWallets();
    const before = targets.length;
    targets = targets.filter((w) => !graded.has(w.wallet));
    console.log(`skipping ${before - targets.length} already-graded callers → ${targets.length} to fingerprint`);
  }

  console.log(`fingerprinting ${targets.length} wallets · 1 request each · ~${Math.ceil(targets.length * 1.3 / 60)} min\n`);
  const out: Fingerprint[] = [];
  for (const [i, w] of targets.entries()) {
    const f = await fingerprint(w.wallet, w.xUsername, w.best_pnl_usd);
    out.push(f);
    const hold = f.median_hold_min === null ? "  –  " : f.median_hold_min < 60
      ? `${f.median_hold_min}m`.padStart(6) : `${(f.median_hold_min / 60).toFixed(1)}h`.padStart(6);
    console.log(
      `[${String(i + 1).padStart(3)}/${targets.length}] ${(f.handle ?? f.wallet.slice(0, 8)).padEnd(18)} ` +
      `${String(f.n_trades).padStart(3)}tx ${String(f.trades_per_day).padStart(6)}/d  hold ${hold}  ` +
      `sell ${(f.sell_ratio * 100).toFixed(0).padStart(3)}%  ${f.klass}`,
    );
  }

  const byClass = (k: Klass) => out.filter((f) => f.klass === k);
  const patient = byClass("patient-trader").sort((a, b) => b.best_pnl_usd - a.best_pnl_usd);

  await writeFile(OUT_PATH, JSON.stringify({
    fingerprinted_at: new Date().toISOString().slice(0, 10),
    thresholds: TH,
    counts: {
      total: out.length,
      patient_trader: patient.length,
      bot_scalper: byClass("bot/scalper").length,
      bag_whale: byClass("bag-whale").length,
      mixed: byClass("mixed").length,
      no_data: byClass("no-data").length,
    },
    fingerprints: out.sort((a, b) => b.best_pnl_usd - a.best_pnl_usd),
  }, null, 2));

  console.log(`\n── distribution (n=${out.length}) ──`);
  for (const k of ["patient-trader", "bot/scalper", "bag-whale", "mixed", "no-data"] as Klass[]) {
    console.log(`  ${k.padEnd(15)} ${byClass(k).length}`);
  }
  console.log(`\npatient traders worth a copy-trade track (${patient.length}):`);
  for (const p of patient.slice(0, 30)) {
    console.log(`  @${(p.handle ?? p.wallet.slice(0, 8)).padEnd(18)} $${Math.round(p.best_pnl_usd).toLocaleString().padStart(9)}  ` +
      `hold ${(p.median_hold_min! / 60).toFixed(1)}h  ${p.trades_per_day}/d  sell ${(p.sell_ratio * 100).toFixed(0)}%`);
  }
  console.log(`\nwrote ${path.relative(ROOT, OUT_PATH)} · retune thresholds in TH{} and re-run (cached-free, re-hits API)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
