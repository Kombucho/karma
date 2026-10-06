/**
 * Enrich scored wallets with the earliest public call timestamp per token.
 *
 * Strategy (X first, pump.fun callouts fallback):
 *   1. Search X via x-cli: `from:<handle> $TICKER` — 20 most recent, filtered to
 *      window [entry_time - 3d, entry_time + 14d].
 *   2. Fetch the wallet's pump.fun callouts via the public callout API (no auth needed).
 *      A callout is an explicit on-platform token promotion — better signal than a comment.
 *      Cached per wallet.
 *
 * Usage:
 *   npm run call-times                   # all validation/*.json
 *   npm run call-times -- @Chairman_DN  # single handle
 *   npm run call-times -- --no-pumpfun  # skip pump.fun fallback
 *
 * Output: seed/call_times.json
 */

import { execSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TokenResult, WalletReport } from "../src/lib/karma/types";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile(f); } catch { /* optional */ }
}

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const KOLS_PATH = path.join(ROOT, "seed", "kols.json");
const OUT_PATH = path.join(ROOT, "seed", "call_times.json");
const PF_CACHE_DIR = path.join(ROOT, "seed", "pumpfun_callouts");

// KOLs almost always call AFTER buying. Allow 30 min pre-buy (buy & post simultaneously)
// and 48h post-buy (most calls happen same day, cut noise beyond that).
const BEFORE_SECS = 30 * 60;
const AFTER_SECS = 48 * 3600;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};

interface Kol { handle: string | null; wallet_address: string; }

interface CallTime {
  wallet: string;
  mint: string;
  symbol: string | null;
  entry_time: number;
  call_time: number;
  tweet_id: string | null;
  source: "x" | "pumpfun";
  query: string;
  text: string;
}

interface PumpCallout {
  coinMint: string;
  createdAt: number; // milliseconds
  thesis: string | null;
}

// ── X via x-cli ───────────────────────────────────────────────────────────────

function parseXCsv(csv: string): Array<{ id: string; posted_at: number; text: string }> {
  const out: Array<{ id: string; posted_at: number; text: string }> = [];
  for (const line of csv.trim().split("\n").slice(1)) {
    const m = line.match(/^(\d+),(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}),([^,]+),(.*)/s);
    if (!m) continue;
    out.push({ id: m[1], posted_at: Math.floor(new Date(m[2]).getTime() / 1000), text: m[4].replace(/^"|"$/g, "") });
  }
  return out;
}

function searchX(query: string): Array<{ id: string; posted_at: number; text: string }> {
  try {
    const out = execSync(`x search all -n 20 -c ${JSON.stringify(query)}`, {
      timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return parseXCsv(out);
  } catch { return []; }
}

function findOnX(handle: string, token: TokenResult): CallTime | null {
  if (!token.entry_time || !token.symbol) return null;
  const ticker = `$${token.symbol.toUpperCase()}`;
  const windowStart = token.entry_time - BEFORE_SECS;
  const windowEnd = token.entry_time + AFTER_SECS;

  for (const query of [`from:${handle} ${ticker}`, `from:${handle} ${token.mint}`]) {
    const tickerInText = (text: string) =>
      text.toUpperCase().includes(ticker.toUpperCase()) || text.includes(token.mint.slice(0, 20));

    const match = searchX(query)
      .filter((t) => t.posted_at >= windowStart && t.posted_at <= windowEnd && tickerInText(t.text))
      .sort((a, b) => a.posted_at - b.posted_at)[0];
    if (!match) continue;
    return {
      wallet: "", mint: token.mint, symbol: token.symbol, entry_time: token.entry_time,
      call_time: match.posted_at, tweet_id: match.id, source: "x",
      query, text: match.text,
    };
  }
  return null;
}

// ── pump.fun callouts ─────────────────────────────────────────────────────────

async function fetchCallouts(wallet: string): Promise<PumpCallout[]> {
  const cacheFile = path.join(PF_CACHE_DIR, `${wallet}.json`);
  try { return JSON.parse(await readFile(cacheFile, "utf8")); } catch { /* fetch */ }

  const all: PumpCallout[] = [];
  // Fetch up to 500 callouts (5 pages of 100)
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `https://frontend-api-v3.pump.fun/callout/list/${wallet}?limit=100&offset=${offset}&sortBy=TIMESTAMP&sortOrder=ASC`;
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) break;
    const data = await res.json() as { callouts?: PumpCallout[] };
    const batch = data.callouts ?? [];
    all.push(...batch.map((c) => ({ coinMint: c.coinMint, createdAt: c.createdAt, thesis: c.thesis ?? null })));
    if (batch.length < 100) break;
    await new Promise((r) => setTimeout(r, 400));
  }

  await mkdir(PF_CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(all, null, 2));
  return all;
}

function findOnPumpFun(callouts: PumpCallout[], token: TokenResult): CallTime | null {
  if (!token.entry_time) return null;
  const windowStart = (token.entry_time - BEFORE_SECS) * 1000;
  const windowEnd = (token.entry_time + AFTER_SECS) * 1000;

  const match = callouts
    .filter((c) => c.coinMint === token.mint && c.createdAt >= windowStart && c.createdAt <= windowEnd)
    .sort((a, b) => a.createdAt - b.createdAt)[0];

  if (!match) return null;
  return {
    wallet: "", mint: token.mint, symbol: token.symbol ?? null, entry_time: token.entry_time,
    call_time: Math.floor(match.createdAt / 1000),
    tweet_id: null, source: "pumpfun",
    query: `pump.fun callout/list/${token.mint.slice(0, 8)}`,
    text: match.thesis ?? "(no thesis)",
  };
}

// ── main ───────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const noPumpfun = argv.includes("--no-pumpfun");
  const handleArg = argv.find((a) => !a.startsWith("--"));

  const kols = JSON.parse(await readFile(KOLS_PATH, "utf8")) as Kol[];
  const handleByWallet = new Map(kols.map((k) => [k.wallet_address, k.handle]));

  let files: string[];
  if (handleArg) {
    const h = handleArg.replace(/^@/, "");
    const kol = kols.find((k) => k.handle?.toLowerCase() === h.toLowerCase());
    if (!kol) { console.error(`No KOL for "${handleArg}" in kols.json`); process.exit(1); }
    files = [path.join(VALIDATION_DIR, `${kol.wallet_address}.json`)];
  } else {
    const all = await readdir(VALIDATION_DIR);
    files = all.filter((f) => f.endsWith(".json")).map((f) => path.join(VALIDATION_DIR, f));
  }

  const existing = await readFile(OUT_PATH, "utf8").then(JSON.parse).catch(() => []) as CallTime[];
  const seen = new Set(existing.map((c) => `${c.wallet}:${c.mint}`));
  const results: CallTime[] = [...existing];
  let xFound = 0, pfFound = 0, missed = 0, skipped = 0;

  for (const file of files) {
    const report = await readFile(file, "utf8").then(JSON.parse).catch(() => null) as (WalletReport & { handle?: string | null }) | null;
    if (!report) continue;

    const wallet = path.basename(file, ".json");
    const handle = report.handle ?? handleByWallet.get(wallet) ?? null;
    const scored = (report.tokens ?? []).filter((t: TokenResult) => t.status === "scored" && t.symbol);

    console.log(`\n${handle ? `@${handle}` : wallet.slice(0, 8) + "…"}  ${scored.length} scored tokens`);

    // Fetch pump.fun callouts once per wallet (cached to disk)
    let callouts: PumpCallout[] = [];
    if (!noPumpfun) {
      process.stdout.write(`  pump.fun callouts…`);
      try {
        callouts = await fetchCallouts(wallet);
        console.log(` ${callouts.length}`);
      } catch (e) {
        console.log(` failed: ${(e as Error).message?.slice(0, 60)}`);
      }
    }

    for (const token of scored) {
      const key = `${wallet}:${token.mint}`;
      if (seen.has(key)) { skipped++; continue; }

      const sym = (token.symbol ?? token.mint.slice(0, 6)).padEnd(10);

      // 1. Try X
      if (handle) {
        process.stdout.write(`  ${sym} X…`);
        const xMatch = findOnX(handle, token);
        await new Promise((r) => setTimeout(r, 1200));
        if (xMatch) {
          xFound++;
          const diff = Math.round((xMatch.call_time - (token.entry_time ?? 0)) / 60);
          console.log(` ✓ ${diff >= 0 ? "+" : ""}${diff}min  "${xMatch.text.slice(0, 55)}"`);
          results.push({ ...xMatch, wallet });
          seen.add(key);
          continue;
        }
        process.stdout.write(` – pf…`);
      } else {
        process.stdout.write(`  ${sym} pf…`);
      }

      // 2. pump.fun callout fallback
      const pfMatch = callouts.length ? findOnPumpFun(callouts, token) : null;
      if (pfMatch) {
        pfFound++;
        const diff = Math.round((pfMatch.call_time - (token.entry_time ?? 0)) / 60);
        console.log(` ✓ ${diff >= 0 ? "+" : ""}${diff}min  "${pfMatch.text.slice(0, 55)}"`);
        results.push({ ...pfMatch, wallet });
        seen.add(key);
      } else {
        missed++;
        console.log(` no match`);
      }
    }
  }

  await writeFile(OUT_PATH, JSON.stringify(results, null, 2));
  console.log(`\nDone: x=${xFound}  pumpfun=${pfFound}  missed=${missed}  cached=${skipped}`);
  console.log(`→ ${results.length} call times  →  seed/call_times.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
