/**
 * Recompute grades under the opportunity model (v2) from already-stored data — no API calls.
 * Every token already carries copy_peak_multiple and the caller-integrity signal, so we can
 * re-label and re-score locally in seconds.
 *
 *   npm run recompute            # dry-run: print the before/after shift, write nothing
 *   npm run recompute -- --write # apply: rewrite validation/*.json + bump config_version
 *
 * OPPORTUNITY (peak ≥2x within 24h = WIN) rewards reachable upside; INTEGRITY (caller dumped)
 * caps it. Weights live in KARMA_V2 in rules.ts — tune there, re-run.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { opportunityLabel, karmaOpportunity } from "../src/lib/karma/engine/rules";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const UNPROVEN_MIN = 10;

interface Tok {
  mint: string;
  status: string;
  label: string | null;
  copy_peak_multiple: number | null;
  copy_return_24h: number | null;
  max_drop_from_peak_24h: number | null;
  entry_time?: number | null;
  dumped?: boolean;
  rugged?: boolean;
  held_through_rug?: boolean;
  caller_exited?: boolean;
  wallet_roi?: number | null;
}
const RUG_DROP = -0.8; // coin collapsed ≥80% from its 24h peak = followers rugged

/** One entry per coin (earliest call). pump.fun's offset bug duplicated calls per page. */
function dedupeByMint(toks: Tok[]): Tok[] {
  const byMint = new Map<string, Tok>();
  for (const t of toks) {
    const prev = byMint.get(t.mint);
    if (!prev || (t.entry_time ?? 0) < (prev.entry_time ?? 0)) byMint.set(t.mint, t);
  }
  return [...byMint.values()];
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

async function main() {
  const write = process.argv.includes("--write");
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
  const shifts: Array<{ handle: string; n: number; winRate: number; dumpRate: number; rugRate: number; medPeak: number; old: number | null; neu: number }> = [];

  for (const f of files) {
    const full = path.join(VALIDATION_DIR, f);
    const d = JSON.parse(await readFile(full, "utf8"));
    if (!String(d.config_version ?? "").includes("callout")) continue;

    const toks: Tok[] = dedupeByMint((d.tokens ?? []).filter((t: Tok) => t.status === "scored"));
    const n = toks.length;

    // Re-label opportunity; preserve integrity signals: DUMP (caller profited from the crash)
    // and RUG (the coin collapsed ≥80% from peak, hurting followers whoever profited).
    for (const t of toks) {
      t.dumped = t.dumped ?? (t.label === "DUMP");
      t.rugged = t.max_drop_from_peak_24h != null && t.max_drop_from_peak_24h <= RUG_DROP;
      t.label = opportunityLabel(t.copy_peak_multiple);
    }

    const wins = toks.filter((t) => t.label === "WIN").length;
    const losses = toks.filter((t) => t.label === "LOSS").length;
    const neutrals = toks.filter((t) => t.label === "NEUTRAL").length;
    const dumps = toks.filter((t) => t.dumped).length;
    const rugs = toks.filter((t) => t.rugged).length;
    const winRate = n ? wins / n : 0;
    const dumpRate = n ? dumps / n : 0;
    const rugRate = n ? rugs / n : 0;
    const medPeak = median(toks.map((t) => t.copy_peak_multiple).filter((x): x is number => x != null)) ?? 0;
    const medRet = median(toks.map((t) => t.copy_return_24h).filter((x): x is number => x != null));
    const unproven = n < UNPROVEN_MIN;
    const karma = unproven ? null : karmaOpportunity({ winRate, dumpRate, rugRate });

    const oldKarma = d.score?.karma_score ?? null;
    if (!unproven || n > 0) {
      shifts.push({ handle: d.handle ?? d.wallet.slice(0, 8), n, winRate, dumpRate, rugRate, medPeak, old: oldKarma, neu: karma ?? -1 });
    }

    if (write) {
      d.score = {
        ...d.score,
        n_tokens: n, wins, losses, neutrals, dumps, rugs,
        follower_hit_rate: n ? winRate : null,   // now = 2x-shot rate
        median_copy_return: medRet,
        median_peak_multiple: medPeak,
        dump_rate: n ? dumpRate : null,
        rug_rate: n ? rugs / n : null,
        unproven,
        karma_score: karma,
        model: "opportunity-v2",
        verdict: verdict(n, wins, dumps),
      };
      d.config_version = String(d.config_version).replace(/-opp$/, "") + "-opp";
      // Collapse the duplicated tokens array to one entry per mint (earliest call).
      d.tokens = dedupeByMint(d.tokens ?? []);
      await writeFile(full, JSON.stringify(d, null, 2));
    }
  }

  // Report the distribution shift.
  const proven = shifts.filter((s) => s.neu >= 0).sort((a, b) => b.neu - a.neu);
  console.log(`\n${"handle".padEnd(16)} ${"n".padStart(3)} ${"2x%".padStart(5)} ${"dump%".padStart(6)} ${"rug%".padStart(5)} ${"medPk".padStart(6)} ${"NEW".padStart(5)} ${"OLD".padStart(5)}`);
  for (const s of proven) {
    console.log(`${s.handle.slice(0, 16).padEnd(16)} ${String(s.n).padStart(3)} ${(s.winRate * 100).toFixed(0).padStart(4)}% ${(s.dumpRate * 100).toFixed(0).padStart(5)}% ${(s.rugRate * 100).toFixed(0).padStart(4)}% ${s.medPeak.toFixed(1).padStart(5)}x ${s.neu.toFixed(1).padStart(5)} ${(s.old == null ? "–" : s.old.toFixed(1)).padStart(5)}`);
  }
  const ks = proven.map((s) => s.neu);
  if (ks.length) {
    const med = median(ks)!;
    console.log(`\n${proven.length} proven · NEW karma median ${med.toFixed(1)}, max ${Math.max(...ks).toFixed(1)}, ≥6: ${ks.filter((k) => k >= 6).length}, ≥5: ${ks.filter((k) => k >= 5).length}`);
  }
  console.log(write ? "\n✓ written (config_version → …-opp)" : "\n(dry-run — pass --write to apply)");
}

function verdict(n: number, wins: number, dumps: number): string {
  if (n === 0) return "No scorable callouts.";
  if (dumps > 0) return `Dumped on holders in ${dumps} of ${n} calls.`;
  return `${wins} of ${n} calls gave a 2x+ shot.`;
}

main().catch((e) => { console.error(e); process.exit(1); });
