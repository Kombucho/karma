/**
 * Sweep X for claim posts and bind verified handle↔wallet pairs into the seed.
 *
 *   npm run verify-claims            # show what would be merged
 *   npm run verify-claims -- --write # merge into seed/kols.json + seed/quotes.json
 *
 * The proof: a post containing "<wallet> is my Karma card", published from the handle being
 * claimed. Only the account owner can publish from it, so authorship IS the binding. We take
 * the author of the post as truth and never trust a handle typed into a form.
 *
 * Requires x-cli on PATH (same tool used for the vocabulary research).
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = process.cwd();
const KOLS = path.join(ROOT, "seed", "kols.json");
const QUOTES = path.join(ROOT, "seed", "quotes.json");

const PHRASE = "is my Karma card";
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const QUOTED = /my line for the cookie jar:\s*"([^"]{4,140})"/i;

interface Claim { handle: string; wallet: string; quote: string | null; tweet_id: string }

async function searchX(): Promise<string> {
  const { stdout } = await run("x-cli", ["tweet", "search", `"${PHRASE}" -is:retweet`, "--max", "100"], {
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

/** Parse x-cli's boxed output into claims. Author + body are all we need. */
function parseClaims(out: string): Claim[] {
  const claims: Claim[] = [];
  // Each tweet block starts with a header carrying the id, then a line with @handle.
  for (const block of out.split(/╭─+ Tweet /).slice(1)) {
    const id = block.slice(0, 40).match(/(\d{10,})/)?.[1] ?? "";
    const handle = block.match(/│\s*@([A-Za-z0-9_]{1,15})\b/)?.[1];
    if (!handle) continue;
    // Strip the box drawing so wallet/quote matching sees clean text.
    const body = block.replace(/[│╭╮╰╯─]/g, " ").replace(/\s+/g, " ");
    if (!body.includes(PHRASE)) continue;
    const wallet = body.match(BASE58)?.[0];
    if (!wallet) continue;
    claims.push({ handle, wallet, quote: body.match(QUOTED)?.[1]?.trim() ?? null, tweet_id: id });
  }
  return claims;
}

async function main() {
  const write = process.argv.includes("--write");

  let out: string;
  try {
    out = await searchX();
  } catch (e) {
    console.error(`\n  x-cli search failed: ${(e as Error).message}\n  (is x-cli on PATH and authorised?)\n`);
    process.exit(1);
  }

  const claims = parseClaims(out);
  const kols = JSON.parse(await readFile(KOLS, "utf8")) as Array<Record<string, unknown>>;
  const byWallet = new Map(kols.map((k) => [k.wallet_address as string, k]));

  const fresh: Claim[] = [];
  const already: Claim[] = [];
  for (const c of claims) {
    const existing = byWallet.get(c.wallet);
    if (existing && (existing.handle as string)?.toLowerCase() === c.handle.toLowerCase()) already.push(c);
    else fresh.push(c);
  }

  console.log(`\n  ${claims.length} claim posts found · ${fresh.length} new · ${already.length} already bound\n`);
  for (const c of fresh) {
    const clash = byWallet.get(c.wallet);
    const note = clash?.handle ? `  ⚠ wallet already bound to @${clash.handle} — NOT overwriting` : "";
    console.log(`  @${c.handle.padEnd(18)} ${c.wallet}${note}`);
    if (c.quote) console.log(`  ${" ".repeat(19)} quote: "${c.quote}"`);
  }

  if (!write) {
    console.log(`\n  (dry run — pass --write to merge)\n`);
    return;
  }

  let added = 0;
  for (const c of fresh) {
    const existing = byWallet.get(c.wallet);
    // A wallet already bound to a different handle is a dispute, not an update. Never silently
    // reassign an identity: a wrong binding is worse than a missing one.
    if (existing?.handle) continue;
    if (existing) {
      existing.handle = c.handle;
      existing.source_url = `https://x.com/${c.handle}/status/${c.tweet_id}`;
      existing.verified = true;
    } else {
      kols.push({
        handle: c.handle,
        wallet_address: c.wallet,
        source_url: `https://x.com/${c.handle}/status/${c.tweet_id}`,
        verified: true,
      });
    }
    added++;
  }
  await writeFile(KOLS, JSON.stringify(kols, null, 2));

  // Quotes ride the same proof: the post that binds the handle also carries the line.
  const quotes = JSON.parse(await readFile(QUOTES, "utf8").catch(() => "[]")) as Array<Record<string, unknown>>;
  const haveIds = new Set(quotes.map((q) => q.tweet_id));
  let quotesAdded = 0;
  for (const c of claims) {
    if (!c.quote || haveIds.has(c.tweet_id)) continue;
    quotes.push({ text: c.quote, handle: c.handle, tweet_id: c.tweet_id });
    quotesAdded++;
  }
  await writeFile(QUOTES, JSON.stringify(quotes, null, 2));

  console.log(`\n  ✓ ${added} identities bound · ${quotesAdded} quotes added to the cookie jar`);
  console.log(`  run \`npm run leaderboard\` to surface the new handles on the boards\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
