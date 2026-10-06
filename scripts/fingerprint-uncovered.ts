/**
 * Bucket every wallet that has no callout record — kill "unproven".
 *
 * A wallet with no public calls can't earn a trust grade (no audience, nobody to dump on),
 * but it is never "unproven": it has an identity and a trading history, so it belongs in a
 * behavioural bucket. This runs the same fingerprint the live /api/behavior route uses, in
 * batch, and writes the result into each validation file as `behavior`.
 *
 *   npm run fingerprint-uncovered            # all wallets with no trust block
 *   npm run fingerprint-uncovered -- --force # re-read wallets already bucketed
 *
 * ~9 keyless pump.fun requests per uncached wallet, rate-limited, so a few hundred wallets
 * takes roughly an hour. Resumable: already-bucketed wallets are skipped unless --force, and
 * a failure on one wallet never loses the wallets already written.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { MemoryCache } from "../src/lib/karma/cache";
import { fingerprintWallet } from "../src/lib/karma/engine/fingerprint";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");

const cache = new MemoryCache();

async function main() {
  const force = process.argv.includes("--force");
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
  const now = Math.floor(Date.now() / 1000);

  const todo: Array<{ file: string; wallet: string; handle: string | null }> = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
    if (d.trust) continue;                    // already has a real grade
    if (d.behavior && !force) continue;       // already bucketed
    todo.push({ file: f, wallet: d.wallet, handle: d.handle ?? null });
  }

  console.log(`\n  ${todo.length} wallets to bucket (of ${files.length} files)\n`);
  const tally = new Map<string, number>();
  let done = 0;
  let failed = 0;

  for (const w of todo) {
    try {
      const read = await fingerprintWallet(w.wallet, cache, now);
      const full = path.join(VALIDATION_DIR, w.file);
      const d = JSON.parse(await readFile(full, "utf8"));
      d.behavior = read;
      await writeFile(full, JSON.stringify(d, null, 2));
      tally.set(read.klass, (tally.get(read.klass) ?? 0) + 1);
      done++;
      if (done % 10 === 0 || done === todo.length) {
        console.log(`  ${String(done).padStart(4)}/${todo.length}  ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join("  ")}`);
      }
    } catch (e) {
      failed++;
      // A dead wallet or a rate-limit blip must not sink the run — record nothing, move on.
      if (failed % 20 === 0) console.log(`  (${failed} unreadable so far: ${(e as Error).message})`);
    }
  }

  console.log(`\n  bucketed ${done}, unreadable ${failed}`);
  console.log(`  distribution: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ")}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
