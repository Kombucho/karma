/**
 * Apply the v3 trust model to every validation file. Local only — no API calls, seconds to run.
 *
 *   npm run rescore            # dry-run: print the movement, write nothing
 *   npm run rescore -- --write # apply
 *
 * Writes a new `trust` block carrying the full breakdown (shrunk rates, vs-market multiples,
 * the karma band, evidence weight, the un-scored opportunity stat) and mirrors karma/grade/
 * title into `score` so every existing reader keeps working. The pre-v3 values are preserved
 * under `score.legacy_v2` — this dataset is the audit trail, so nothing gets overwritten
 * without a copy left behind.
 *
 * Unlike the old model there is no UNPROVEN cliff: shrinkage means a 4-call record scores
 * honestly near the market average with a visibly wide band, instead of being hidden behind
 * "Not scored yet". That is what takes coverage from 316 graded wallets to ~389.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCORING, TRUST_PRIORS } from "../src/lib/karma/scoring.config";
import { trustBreakdown, isRuggedForTrust, isDumped, hadTwoXShot } from "../src/lib/karma/engine/rules";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");

interface Tok {
  mint: string;
  status: string;
  label: string | null;
  entry_time: number | null;
  copy_peak_multiple: number | null;
  max_drop_from_peak_24h: number | null;
  dumped?: boolean;
  rugged?: boolean;
}

/** One entry per coin (earliest call) — pump.fun's paging bug duplicates callouts. */
function dedupe(toks: Tok[]): Tok[] {
  const m = new Map<string, Tok>();
  for (const t of toks) {
    const prev = m.get(t.mint);
    if (!prev || (t.entry_time ?? 0) < (prev.entry_time ?? 0)) m.set(t.mint, t);
  }
  return [...m.values()];
}

async function main() {
  const write = process.argv.includes("--write");
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
  const moves: Array<{ handle: string; n: number; oldG: string | null; newG: string; oldK: number | null; newK: number; floored: boolean }> = [];
  let skipped = 0;

  for (const f of files) {
    const full = path.join(VALIDATION_DIR, f);
    const d = JSON.parse(await readFile(full, "utf8"));

    const toks = dedupe((d.tokens ?? []).filter((t: Tok) => t.status === "scored"));
    const n = toks.length;
    if (n < SCORING.minCallsToScore) { skipped++; continue; }

    const t = trustBreakdown({
      dumps: toks.filter(isDumped).length,
      rugs: toks.filter(isRuggedForTrust).length,
      twoX: toks.filter(hadTwoXShot).length,
      n,
    });

    moves.push({
      handle: d.handle ?? d.wallet.slice(0, 8),
      n,
      oldG: d.score?.grade ?? null,
      newG: t.grade,
      oldK: d.score?.karma_score ?? null,
      newK: t.karma,
      floored: t.grade_floored,
    });

    if (write) {
      // Preserve the pre-v3 record once — re-running must not overwrite the original audit copy.
      const legacy = d.score?.legacy_v2 ?? {
        model: d.score?.model ?? "callout-v1",
        karma_score: d.score?.karma_score ?? null,
        grade: d.score?.grade ?? null,
        title: d.score?.title ?? null,
        config_version: d.config_version,
      };
      d.trust = { ...t, model: "trust-v3", priors_version: TRUST_PRIORS.version, as_of: d.computed_at };
      d.score = {
        ...d.score,
        legacy_v2: legacy,
        karma_score: t.karma,
        grade: t.grade,
        title: t.title,
        unproven: false,
        confidence: t.confidence,
        verdict: t.verdict,
        model: "trust-v3",
      };
      d.config_version = String(d.config_version).replace(/-trust-v3$/, "") + "-trust-v3";
      await writeFile(full, JSON.stringify(d, null, 2));
    }
  }

  const counts = new Map<string, number>();
  for (const m of moves) counts.set(m.newG, (counts.get(m.newG) ?? 0) + 1);
  const order = ["S", "A", "B", "C", "D", "F"];

  console.log(`\n  ${moves.length} scoreable · ${skipped} below the ${SCORING.minCallsToScore}-call floor · ${files.length} files\n`);
  console.log(`  grade distribution: ${order.map((g) => `${g}=${counts.get(g) ?? 0}`).join("  ")}`);
  console.log(`  capped by an integrity floor: ${moves.filter((m) => m.floored).length}`);

  const graded = moves.filter((m) => m.oldG);
  console.log(`\n  movement (${graded.filter((m) => m.oldG !== m.newG).length} of ${graded.length} changed grade):`);
  const mv = new Map<string, number>();
  for (const m of graded) { const k = `${m.oldG}→${m.newG}`; mv.set(k, (mv.get(k) ?? 0) + 1); }
  console.log(`  ${[...mv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join("  ")}`);

  const top = moves.filter((m) => m.newG !== "F" && m.newG !== "D").sort((a, b) => b.newK - a.newK).slice(0, 12);
  console.log(`\n  top of the new board:`);
  console.log(`  ${"handle".padEnd(18)} ${"n".padStart(3)} ${"karma".padStart(6)} ${"grade".padStart(6)}   was`);
  for (const m of top) {
    console.log(`  @${m.handle.slice(0, 17).padEnd(17)} ${String(m.n).padStart(3)} ${String(m.newK).padStart(6)} ${m.newG.padStart(6)}   ${m.oldG ?? "–"} / ${m.oldK ?? "–"}`);
  }

  console.log(write ? `\n  ✓ written (config_version → …-trust-v3, pre-v3 values kept in score.legacy_v2)\n` : `\n  (dry-run — pass --write to apply)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
