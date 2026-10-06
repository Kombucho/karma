/**
 * Pull the pump.fun profile behind every scored wallet: X handle, follower count, bio,
 * avatar, ban status.
 *
 *   npm run enrich            # wallets without an identity block
 *   npm run enrich -- --force # refresh everyone (follower counts move)
 *
 * Why this matters beyond putting a face on the card: FOLLOWERS is the dimension Karma has
 * been blind to. A caller who dumps on 55,000 people and one who dumps on 200 currently score
 * identically, because the score measures *rate* of harm, not *volume*. Rate is the right
 * thing to grade a person on — reach isn't a character trait, and punishing someone for being
 * popular would be measuring the wrong thing. But it is exactly the right thing to RANK a
 * public shame board by, because the board's job is to warn the most people about the most
 * damage. So: reach never touches the grade, and it orders the board.
 *
 * One request per wallet, keyless, cached by the identity block's presence.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RateLimiter } from "../src/lib/karma/http";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const KOLS = path.join(ROOT, "seed", "kols.json");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
};

const limiter = new RateLimiter(1200);

export interface Identity {
  username: string | null;
  /** The X handle pump.fun has on file — authoritative where it exists, unlike a guess. */
  x_username: string | null;
  followers: number | null;
  bio: string | null;
  avatar_url: string | null;
  /** pump.fun banned this account. A signal in itself, and shown on the card. */
  banned: boolean;
  is_pump_user: boolean;
  checked_at: number;
}

async function fetchProfile(wallet: string): Promise<Identity | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await limiter.take();
    const res = await fetch(`https://frontend-api-v3.pump.fun/users/${wallet}`, { headers: BROWSER_HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) { limiter.penalize(Math.min(15_000, 2000 * 2 ** attempt)); continue; }
      return null;
    }
    const j = (await res.json()) as Record<string, unknown>;
    return {
      username: (j.username as string) ?? null,
      x_username: (j.x_username as string) ?? null,
      followers: typeof j.followers === "number" ? j.followers : null,
      bio: ((j.bio as string) ?? "").trim() || null,
      avatar_url: (j.profile_image as string) ?? null,
      banned: !!j.is_banned,
      is_pump_user: !!j.is_pump_user,
      checked_at: Math.floor(Date.now() / 1000),
    };
  }
  return null;
}

async function main() {
  const force = process.argv.includes("--force");
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));

  const todo: string[] = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
    if (d.identity && !force) continue;
    todo.push(f);
  }
  console.log(`\n  ${todo.length} profiles to pull (of ${files.length})\n`);

  const kols = JSON.parse(await readFile(KOLS, "utf8")) as Array<Record<string, unknown>>;
  const byWallet = new Map(kols.map((k) => [k.wallet_address as string, k]));

  let found = 0, banned = 0, missing = 0, xLinked = 0;
  const reach: Array<{ handle: string; followers: number }> = [];

  for (const [i, f] of todo.entries()) {
    const full = path.join(VALIDATION_DIR, f);
    const d = JSON.parse(await readFile(full, "utf8"));
    const id = await fetchProfile(d.wallet).catch(() => null);
    if (!id) { missing++; continue; }

    d.identity = id;
    // The seed's handle was scraped or hand-entered; pump.fun's x_username is what the account
    // itself declares. Prefer the declared one, but never silently drop a handle we already had.
    if (id.x_username && !d.handle) d.handle = id.x_username;
    await writeFile(full, JSON.stringify(d, null, 2));

    const k = byWallet.get(d.wallet);
    if (k) {
      k.followers = id.followers;
      k.avatar_url = id.avatar_url;
      if (id.x_username) { k.x_username = id.x_username; xLinked++; }
      if (id.banned) k.banned = true;
    }

    found++;
    if (id.banned) banned++;
    if (id.followers) reach.push({ handle: id.x_username ?? id.username ?? d.wallet.slice(0, 8), followers: id.followers });

    if ((i + 1) % 25 === 0 || i === todo.length - 1) {
      console.log(`  ${String(i + 1).padStart(4)}/${todo.length}  found ${found} · x-linked ${xLinked} · banned ${banned} · no profile ${missing}`);
    }
  }

  await writeFile(KOLS, JSON.stringify(kols, null, 2));

  reach.sort((a, b) => b.followers - a.followers);
  const total = reach.reduce((s, r) => s + r.followers, 0);
  console.log(`\n  ${found} profiles · ${xLinked} with an X handle on file · ${banned} banned by pump.fun`);
  console.log(`  combined reach of the corpus: ${total.toLocaleString()} followers`);
  console.log(`\n  biggest accounts:`);
  for (const r of reach.slice(0, 12)) console.log(`    @${r.handle.padEnd(20)} ${r.followers.toLocaleString().padStart(9)}`);
  console.log(`\n  → identity block written to validation/*.json; followers merged into seed/kols.json\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
