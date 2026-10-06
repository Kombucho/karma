/**
 * Build the boards from validation/*.json under the v3 trust model.
 *
 *   Highest Karma — callers measurably less likely to hurt you, best first.
 *   Hall of Shame — below the pass line, worst first (the shareable one).
 *   No record     — fewer than minCallsToScore public calls. Listed, never ranked.
 *
 * Usage: npm run leaderboard
 *
 * The D/F guardrail that used to live here is gone, and that is the point: integrity floors
 * are now part of the model (SCORING.integrityFloor), so a rugger cannot reach a passing
 * grade in the first place. One source of truth — the board just sorts what the model said.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCORING, TRUST_PRIORS } from "../src/lib/karma/scoring.config";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const OUT_JSON = path.join(ROOT, "seed", "leaderboard.json");

/** Grade ≥C. Below it, Karma is not willing to say "worth following". */
const PASS_LINE = SCORING.trustGrades.C;

interface Row {
  handle: string | null;
  wallet: string;
  karma: number | null;
  karma_low: number | null;
  karma_high: number | null;
  grade: string | null;
  title: string | null;
  n: number;
  dumps: number;
  rugs: number;
  wins: number;
  /** Shrunk rates as a multiple of the market's own — 1.0 is exactly average. */
  dumpVsMarket: number | null;
  rugVsMarket: number | null;
  dumpRate: number | null;
  rugRate: number | null;
  twoXRate: number | null;
  confidence: string;
  floored: boolean;
  unproven: boolean;
  verdict: string;
  computed_at: number | null;
  /** For wallets with no callout record: the behavioural bucket, so nothing is "unproven". */
  behavior: string | null;
  behaviorVerdict: string | null;
  medianHoldMin: number | null;
  tradesPerDay: number | null;
  sniped: number | null;
  sniperSampled: number | null;
}

async function load(): Promise<Row[]> {
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
  const rows: Row[] = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
    const t = d.trust;
    const s = d.score ?? {};
    rows.push({
      handle: d.handle ?? null,
      wallet: d.wallet,
      karma: t?.karma ?? null,
      karma_low: t?.karma_low ?? null,
      karma_high: t?.karma_high ?? null,
      grade: t?.grade ?? null,
      title: t?.title ?? null,
      n: t?.n ?? 0,
      dumps: s.dumps ?? 0,
      rugs: s.rugs ?? 0,
      wins: s.wins ?? 0,
      dumpVsMarket: t?.dump_vs_market ?? null,
      rugVsMarket: t?.rug_vs_market ?? null,
      dumpRate: t?.dump_rate ?? null,
      rugRate: t?.rug_rate ?? null,
      twoXRate: t?.opportunity?.two_x_rate ?? null,
      confidence: t?.confidence ?? "low",
      floored: t?.grade_floored ?? false,
      // v3 has no UNPROVEN cliff: a wallet is either scored, or it has no public record at all.
      unproven: !t,
      verdict: t?.verdict ?? s.verdict ?? "",
      computed_at: d.computed_at ?? null,
      behavior: d.behavior?.klass ?? null,
      behaviorVerdict: d.behavior?.verdict ?? null,
      medianHoldMin: d.behavior?.median_hold_min ?? null,
      tradesPerDay: d.behavior?.trades_per_day ?? null,
      sniped: d.behavior?.sniped ?? null,
      sniperSampled: d.behavior?.sniper_sampled ?? null,
    });
  }
  return rows;
}

const x = (v: number | null) => (v === null ? "  –  " : `${v.toFixed(2)}x`.padStart(5));

function table(rows: Row[]): string {
  const head = ["#", "HANDLE", "KARMA", "GR", "n", "DUMPvMKT", "RUGvMKT", "2x", "CONF"];
  const w = [3, 18, 9, 2, 3, 8, 7, 5, 6];
  const fmt = (c: string[]) => c.map((s, i) => (i === 1 ? s.padEnd(w[i]) : s.padStart(w[i]))).join("  ");
  const lines = [fmt(head)];
  rows.forEach((r, i) => {
    lines.push(fmt([
      String(i + 1),
      `@${r.handle ?? r.wallet.slice(0, 8) + "…"}`.slice(0, 18),
      r.karma === null ? "–" : `${r.karma} (${r.karma_low}-${r.karma_high})`,
      (r.grade ?? "–") + (r.floored ? "!" : ""),
      String(r.n),
      x(r.dumpVsMarket),
      x(r.rugVsMarket),
      r.twoXRate === null ? "  – " : `${(r.twoXRate * 100).toFixed(0)}%`,
      r.confidence,
    ]));
  });
  return lines.join("\n");
}

async function main() {
  const rows = await load();
  const scored = rows.filter((r) => r.karma !== null);
  const norecord = rows.filter((r) => r.karma === null);

  const highest = scored.filter((r) => r.karma! >= PASS_LINE).sort((a, b) => b.karma! - a.karma!);
  const shame = scored.filter((r) => r.karma! < PASS_LINE).sort((a, b) => a.karma! - b.karma!);

  const bar = "═".repeat(78);
  console.log(`\n${bar}\n  HIGHEST KARMA  (${highest.length})  — grade ≥C (karma ≥${PASS_LINE}), best first\n${bar}`);
  console.log(highest.length ? table(highest.slice(0, 30)) : "  (none above the pass line)");
  if (highest.length > 30) console.log(`  … ${highest.length - 30} more`);

  console.log(`\n${bar}\n  HALL OF SHAME  (${shame.length})  — worst first\n${bar}`);
  console.log(table(shame.slice(0, 20)));
  if (shame.length > 20) console.log(`  … ${shame.length - 20} more`);

  const buckets = new Map<string, number>();
  for (const r of norecord) buckets.set(r.behavior ?? "unread", (buckets.get(r.behavior ?? "unread") ?? 0) + 1);
  console.log(`\n  Scored: ${scored.length}  ·  no callout record: ${norecord.length}  ·  total files: ${rows.length}`);
  console.log(`  behaviour buckets: ${[...buckets.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  console.log(`  Reference — market rates: dump ${(TRUST_PRIORS.dump.p * 100).toFixed(1)}%  rug ${(TRUST_PRIORS.rug.p * 100).toFixed(1)}%  2x ${(TRUST_PRIORS.win.p * 100).toFixed(1)}%`);
  console.log(`  "!" after a grade = capped by an integrity floor.  KARMA shows the point estimate and its 95% band.`);

  await writeFile(
    OUT_JSON,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        model: "trust-v3",
        priors_version: TRUST_PRIORS.version,
        market: { dump: TRUST_PRIORS.dump.p, rug: TRUST_PRIORS.rug.p, two_x: TRUST_PRIORS.win.p },
        pass_line: PASS_LINE,
        highest,
        shame,
        unproven: norecord,
      },
      null,
      2,
    ),
  );
  console.log(`\n  → ${path.relative(ROOT, OUT_JSON)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
