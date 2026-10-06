/**
 * Harvest pump.fun's top earners + traders from the PnL leaderboard.
 *
 * The boards move daily, so this re-pulls the union of
 *   period ∈ {daily, weekly, monthly} × sort ∈ {realized, unrealized, combined}
 * (9 boards, limit 100 each = 9 requests), unions by wallet, keeps the ones with an
 * X handle (pump.fun's own first-party dox backlink), and diffs against the existing
 * seed. NEW X-handled wallets are appended to seed/kols.json so the incremental
 * `score-callouts` run picks them up — its callout fetch IS the active-caller check,
 * so no separate callout pass is spent here.
 *
 * Cheap by design: only the 9 board requests hit pump.fun. Cloudflare bans ~1k req/hr;
 * this is 9. Run once, then `npm run score-callouts` (incremental) grades the new names.
 *
 * Usage: npm run harvest-pnl        (writes seed files, prints new-wallet count)
 * Output: seed/pnl_leaderboard_harvest.json  +  appended entries in seed/kols.json
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RateLimiter } from "../src/lib/karma/http";

const ROOT = process.cwd();
const KOLS_PATH = path.join(ROOT, "seed", "kols.json");
const HARVEST_PATH = path.join(ROOT, "seed", "pnl_leaderboard_harvest.json");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
};

const PERIODS = ["daily", "weekly", "monthly"] as const;
const SORTS = ["realized", "unrealized", "combined"] as const;

// One shared pacer, generous backoff — same discipline as the scorer.
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

interface Entry {
  rank: number;
  walletAddress: string;
  pnlUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  positionsCount: number;
  username: string | null;
  xUsername: string | null;
  isVerified: boolean;
  userId: string | null;
}

interface Harvested {
  wallet: string;
  username: string | null;
  xUsername: string | null;
  isVerified: boolean;
  boards: string[];        // e.g. "daily/realized#1"
  best_pnl_usd: number;    // max pnlUsd across the boards it appears on
  positions_max: number;
}

interface Kol {
  handle: string | null;
  display_name: string;
  wallet_address: string;
  chain: string;
  source_url: string;
  source_note: string;
  verified: boolean;
  added_at: string;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const byWallet = new Map<string, Harvested>();
  let boardsPulled = 0;

  for (const period of PERIODS) {
    for (const sort of SORTS) {
      const url = `https://frontend-api-v3.pump.fun/pnl-leaderboard?period=${period}&sort=${sort}&limit=100`;
      process.stdout.write(`  ${period}/${sort} …`);
      const res = await pumpFetch(url);
      if (!res || !res.ok) { console.log(` failed (${res?.status ?? "no response"})`); continue; }
      const data = (await res.json()) as { entries?: Entry[] };
      const entries = data.entries ?? [];
      boardsPulled++;
      for (const e of entries) {
        const prev = byWallet.get(e.walletAddress);
        const placement = `${period}/${sort}#${e.rank}`;
        if (!prev) {
          byWallet.set(e.walletAddress, {
            wallet: e.walletAddress,
            username: e.username ?? null,
            xUsername: e.xUsername ?? null,
            isVerified: !!e.isVerified,
            boards: [placement],
            best_pnl_usd: e.pnlUsd ?? 0,
            positions_max: e.positionsCount ?? 0,
          });
        } else {
          prev.boards.push(placement);
          prev.best_pnl_usd = Math.max(prev.best_pnl_usd, e.pnlUsd ?? 0);
          prev.positions_max = Math.max(prev.positions_max, e.positionsCount ?? 0);
          // fill identity if a later board carries it
          prev.username ??= e.username ?? null;
          prev.xUsername ??= e.xUsername ?? null;
          prev.isVerified ||= !!e.isVerified;
        }
      }
      console.log(` ${entries.length}`);
    }
  }

  const all = [...byWallet.values()].sort((a, b) => b.best_pnl_usd - a.best_pnl_usd);
  const withHandle = all.filter((h) => h.xUsername);

  await writeFile(
    HARVEST_PATH,
    JSON.stringify(
      {
        harvested_at: today,
        method: "pump.fun /pnl-leaderboard union (daily/weekly/monthly × realized/unrealized/combined, limit 100)",
        boards_pulled: boardsPulled,
        unique_wallets: all.length,
        with_x_handle: withHandle.length,
        wallets: all,
      },
      null,
      2,
    ),
  );

  // ── merge NEW X-handled wallets into the seed ────────────────────────────────
  const kols = JSON.parse(await readFile(KOLS_PATH, "utf8")) as Kol[];
  const known = new Set(kols.map((k) => k.wallet_address));
  const knownHandles = new Set(kols.map((k) => k.handle?.toLowerCase()).filter(Boolean));

  const added: Kol[] = [];
  for (const h of withHandle) {
    if (known.has(h.wallet)) continue;
    if (h.xUsername && knownHandles.has(h.xUsername.toLowerCase())) continue; // same caller, different/new wallet listing — skip dup handle
    added.push({
      handle: h.xUsername,
      display_name: h.username ?? h.xUsername ?? h.wallet.slice(0, 8),
      wallet_address: h.wallet,
      chain: "solana",
      source_url: h.xUsername ? `https://x.com/${h.xUsername}` : `https://pump.fun/profile/${h.wallet}`,
      source_note: `pump.fun pnl-leaderboard ${today}: ${h.boards.join(", ")}; best pnl $${Math.round(h.best_pnl_usd).toLocaleString()}${h.isVerified ? "; pump.fun-verified X badge" : ""}`,
      verified: h.isVerified,
      added_at: today,
    });
    known.add(h.wallet);
    if (h.xUsername) knownHandles.add(h.xUsername.toLowerCase());
  }

  if (added.length) {
    await writeFile(KOLS_PATH, JSON.stringify([...kols, ...added], null, 2));
  }

  const topEarner = all[0];
  console.log(`\n── harvest ${today} ──`);
  console.log(`boards pulled:      ${boardsPulled}/9`);
  console.log(`unique wallets:     ${all.length}`);
  console.log(`with X handle:      ${withHandle.length}`);
  console.log(`already in seed:    ${withHandle.length - added.length}`);
  console.log(`NEW → added to seed: ${added.length}`);
  if (topEarner) {
    console.log(`\ntop earner:  @${topEarner.xUsername ?? topEarner.username ?? "?"}  (${topEarner.wallet})`);
    console.log(`             best pnl $${Math.round(topEarner.best_pnl_usd).toLocaleString()} · boards ${topEarner.boards.join(", ")}`);
  }
  if (added.length) {
    console.log(`\nnew names to grade next (score-callouts is incremental, only these run):`);
    for (const a of added.slice(0, 40)) {
      const h = withHandle.find((w) => w.wallet === a.wallet_address)!;
      console.log(`  @${a.handle}  $${Math.round(h.best_pnl_usd).toLocaleString()}  ${a.verified ? "✓" : " "}  ${h.boards[0]}`);
    }
    if (added.length > 40) console.log(`  … +${added.length - 40} more`);
  }
  console.log(`\nnext: npm run score-callouts   (grades the ${added.length} new wallets, skips the rest)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
