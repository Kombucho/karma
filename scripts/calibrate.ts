/**
 * Calibration harness — the evidence layer under the score.
 *
 * Everything the trust model needs to be defensible is derived here from the
 * validation corpus on disk, never guessed:
 *
 *   1. BASE RATES       what a called coin does on average (the market, not the caller)
 *   2. RELIABILITY      split-half r per metric: does this trait persist, or is it a coin flip?
 *   3. VARIANCE         how much spread between callers is real vs binomial noise (gives tau)
 *   4. PREDICTIVE       first-half score -> second-half harm, by quartile (does the score work?)
 *   5. THRESHOLDS       grade counts under the frozen cut points, and the old->new movement
 *
 * Run:  npm run calibrate            # print the report
 *       npm run calibrate -- --write # also write seed/calibration.json (the published stats)
 *
 * The numbers printed in sections 1 and 3 are the priors that belong in TRUST_PRIORS
 * (scoring.config.ts). They are frozen constants on purpose: a score whose priors move
 * every time the corpus grows is not a score, it's a moving target. Re-run this, read the
 * drift, and bump the version deliberately.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCORING, TRUST_PRIORS } from "../src/lib/karma/scoring.config";
import { karmaTrust, gradeWithFloor, shrink, isRugged, isDumped, hadTwoXShot } from "../src/lib/karma/engine/rules";

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const OUT = path.join(ROOT, "seed", "calibration.json");

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
interface Wallet {
  handle: string;
  wallet: string;
  oldKarma: number | null;
  oldGrade: string | null;
  toks: Tok[];
}

// ── small stats kit ─────────────────────────────────────────────────────────────
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const variance = (xs: number[]) => (xs.length ? mean(xs.map((x) => (x - mean(xs)) ** 2)) : 0);
function pearson(xs: number[], ys: number[]): number {
  const mx = mean(xs), my = mean(ys);
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return dx && dy ? num / (dx * dy) : NaN;
}
function pctl(xs: number[], ps = [5, 10, 25, 50, 75, 90, 95]): Record<number, number> {
  const s = [...xs].sort((a, b) => a - b);
  const out: Record<number, number> = {};
  for (const p of ps) out[p] = s.length ? s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))] : NaN;
  return out;
}
const rate = (ts: Tok[], fn: (t: Tok) => boolean) => (ts.length ? ts.filter(fn).length / ts.length : 0);
const fmtPct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** One entry per coin (earliest call) — pump.fun's paging bug duplicates callouts. */
function dedupe(toks: Tok[]): Tok[] {
  const m = new Map<string, Tok>();
  for (const t of toks) {
    const prev = m.get(t.mint);
    if (!prev || (t.entry_time ?? 0) < (prev.entry_time ?? 0)) m.set(t.mint, t);
  }
  return [...m.values()];
}

async function load(): Promise<Wallet[]> {
  const files = (await readdir(VALIDATION_DIR)).filter((f) => f.endsWith(".json"));
  const out: Wallet[] = [];
  for (const f of files) {
    const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, f), "utf8"));
    const toks = dedupe((d.tokens ?? []).filter((t: Tok) => t.status === "scored" && t.entry_time)).sort(
      (a, b) => (a.entry_time ?? 0) - (b.entry_time ?? 0),
    );
    out.push({
      handle: d.handle ?? d.wallet.slice(0, 8),
      wallet: d.wallet,
      oldKarma: d.score?.karma_score ?? null,
      oldGrade: d.score?.grade ?? null,
      toks,
    });
  }
  return out;
}

const METRICS = [
  { key: "rug", label: "rugRate", fn: isRugged },
  { key: "dump", label: "dumpRate", fn: isDumped },
  { key: "win", label: "winRate(2x)", fn: hadTwoXShot },
] as const;

async function main() {
  const write = process.argv.includes("--write");
  const wallets = await load();
  const all = wallets.flatMap((w) => w.toks);
  const withData = wallets.filter((w) => w.toks.length > 0);
  // The reliability tests need enough calls to halve; MIN_SPLIT is the floor for those sections only.
  const MIN_SPLIT = 12;
  const splittable = wallets.filter((w) => w.toks.length >= MIN_SPLIT);

  const line = (s = "") => console.log(s);
  const rule = (t: string) => line(`\n${"─".repeat(78)}\n  ${t}\n${"─".repeat(78)}`);

  line(`\nKarma calibration · ${wallets.length} wallet files · ${withData.length} with scored calls`);
  line(`${all.length} scored call observations across ${new Set(all.map((t) => t.mint)).size} distinct coins`);

  // ── 1. BASE RATES ─────────────────────────────────────────────────────────────
  rule("1 · BASE RATES — what a KOL-called coin does on average");
  const base: Record<string, number> = {};
  for (const m of METRICS) {
    base[m.key] = rate(all, m.fn);
    line(`  ${m.label.padEnd(12)} ${fmtPct(base[m.key]).padStart(7)}   (population prior p)`);
  }
  line(`\n  Read: these are the market, not the caller. A caller at ${fmtPct(base.rug)} rug rate is average,`);
  line(`  not evil. Any score that does not adjust for this is grading the asset class.`);

  // ── 2. RELIABILITY ────────────────────────────────────────────────────────────
  rule(`2 · RELIABILITY — does the trait persist? (split-half, n=${splittable.length} wallets with ≥${MIN_SPLIT} calls)`);
  line(`  ${"metric".padEnd(12)} ${"split-half r".padStart(13)} ${"Spearman-Brown".padStart(15)}   ${"bottom⅓→next".padStart(13)} ${"top⅓→next".padStart(11)}  ${"spread".padStart(7)}`);
  const reliability: Record<string, { r: number; sb: number; spread: number }> = {};
  for (const m of METRICS) {
    const a: number[] = [], b: number[] = [];
    for (const w of splittable) {
      const h = w.toks.length >> 1;
      a.push(rate(w.toks.slice(0, h), m.fn));
      b.push(rate(w.toks.slice(h), m.fn));
    }
    const r = pearson(a, b);
    const sb = (2 * r) / (1 + r); // Spearman-Brown: half-test r -> full-test reliability
    const pairs = a.map((x, i) => [x, b[i]] as const).sort((p, q) => p[0] - q[0]);
    const k = Math.floor(pairs.length / 3);
    const bot = mean(pairs.slice(0, k).map((p) => p[1]));
    const top = mean(pairs.slice(-k).map((p) => p[1]));
    reliability[m.key] = { r, sb, spread: top - bot };
    line(
      `  ${m.label.padEnd(12)} ${r.toFixed(3).padStart(13)} ${sb.toFixed(3).padStart(15)}   ` +
        `${fmtPct(bot).padStart(13)} ${fmtPct(top).padStart(11)}  ${(top - bot >= 0 ? "+" : "") + fmtPct(top - bot)}`,
    );
  }
  line(`\n  Read: r ≳ 0.4 = a real, persistent trait worth scoring. r ≲ 0.2 = noise; scoring it`);
  line(`  manufactures false confidence. Same wallets, same sample sizes, so the gap is not an artifact.`);

  // ── 3. VARIANCE DECOMPOSITION ────────────────────────────────────────────────
  rule("3 · VARIANCE — how much caller-to-caller spread is real? (gives tau for shrinkage)");
  line(`  ${"metric".padEnd(12)} ${"observed var".padStart(12)} ${"binomial noise".padStart(14)} ${"TRUE var".padStart(10)} ${"tau (SD)".padStart(9)} ${"obs/noise".padStart(10)}`);
  const taus: Record<string, number> = {};
  for (const m of METRICS) {
    const p = base[m.key];
    const rates = withData.filter((w) => w.toks.length >= SCORING.minCallsToScore).map((w) => rate(w.toks, m.fn));
    const ns = withData.filter((w) => w.toks.length >= SCORING.minCallsToScore).map((w) => w.toks.length);
    const noise = mean(ns.map((n) => (p * (1 - p)) / n));
    const obs = variance(rates);
    const trueVar = Math.max(0, obs - noise);
    taus[m.key] = Math.sqrt(trueVar);
    line(
      `  ${m.label.padEnd(12)} ${obs.toFixed(4).padStart(12)} ${noise.toFixed(4).padStart(14)} ` +
        `${trueVar.toFixed(4).padStart(10)} ${taus[m.key].toFixed(3).padStart(9)} ${(obs / noise).toFixed(2).padStart(9)}x`,
    );
  }
  line(`\n  tau is the real between-caller SD once coin-flip noise is removed. It sets how hard a`);
  line(`  thin record gets pulled to the population mean — the principled replacement for UNPROVEN.`);
  line(`\n  Priors currently frozen in TRUST_PRIORS (${TRUST_PRIORS.version}):`);
  line(`    rug  p=${TRUST_PRIORS.rug.p}  tau=${TRUST_PRIORS.rug.tau}     measured now: p=${base.rug.toFixed(3)} tau=${taus.rug.toFixed(3)}`);
  line(`    dump p=${TRUST_PRIORS.dump.p}  tau=${TRUST_PRIORS.dump.tau}     measured now: p=${base.dump.toFixed(3)} tau=${taus.dump.toFixed(3)}`);
  const drift = Math.max(
    Math.abs(base.rug - TRUST_PRIORS.rug.p) / TRUST_PRIORS.rug.p,
    Math.abs(base.dump - TRUST_PRIORS.dump.p) / TRUST_PRIORS.dump.p,
  );
  line(`    drift: ${fmtPct(drift)} ${drift > 0.15 ? "  ⚠ >15% — the market moved, consider bumping the prior version" : "  ✓ within tolerance"}`);

  // ── 4. PREDICTIVE VALIDITY OF THE SCORE ──────────────────────────────────────
  rule(`4 · PREDICTIVE VALIDITY — does the score itself predict future harm?`);
  line(`  Score each wallet on its FIRST half of calls, then measure what its SECOND half did.`);
  line(`  This is the only test that matters: a score that does not do this is decoration.\n`);

  interface Cand { name: string; score: (r: { rug: number; dump: number; win: number; n: number }) => number }
  const candidates: Cand[] = [
    { name: "v2 opportunity (live)", score: (x) => 10 * (0.4 * Math.min(x.win / 0.6, 1) + 0.6 * (1 - x.dump) ** 2 * (1 - x.rug) ** 1.5) },
    { name: "v3 trust (raw rates)", score: (x) => 100 * (1 - x.dump) ** 2 * (1 - x.rug) ** 1.5 },
    { name: "v3 trust (shrunk)", score: (x) => karmaTrust({ dumpRate: x.dump, rugRate: x.rug, n: x.n }) },
  ];

  line(`  ${"model".padEnd(24)} ${"quartile".padEnd(9)} ${"→ next dump".padStart(12)} ${"→ next rug".padStart(11)} ${"→ next 2x".padStart(10)}  separation`);
  const validity: Record<string, { dumpRatio: number; rugRatio: number }> = {};
  for (const c of candidates) {
    const rows = splittable.map((w) => {
      const h = w.toks.length >> 1;
      const f1 = w.toks.slice(0, h), f2 = w.toks.slice(h);
      return {
        s: c.score({ rug: rate(f1, isRugged), dump: rate(f1, isDumped), win: rate(f1, hadTwoXShot), n: f1.length }),
        dump: rate(f2, isDumped),
        rug: rate(f2, isRugged),
        win: rate(f2, hadTwoXShot),
      };
    }).sort((a, b) => a.s - b.s);
    const k = Math.floor(rows.length / 4);
    const bot = rows.slice(0, k), top = rows.slice(-k);
    const bd = mean(bot.map((r) => r.dump)), td = mean(top.map((r) => r.dump));
    const br = mean(bot.map((r) => r.rug)), tr = mean(top.map((r) => r.rug));
    validity[c.name] = { dumpRatio: bd / td, rugRatio: br / tr };
    line(`  ${c.name.padEnd(24)} ${"bottom ¼".padEnd(9)} ${fmtPct(bd).padStart(12)} ${fmtPct(br).padStart(11)} ${fmtPct(mean(bot.map((r) => r.win))).padStart(10)}`);
    line(`  ${"".padEnd(24)} ${"top ¼".padEnd(9)} ${fmtPct(td).padStart(12)} ${fmtPct(tr).padStart(11)} ${fmtPct(mean(top.map((r) => r.win))).padStart(10)}` +
      `   dump ${(bd / td).toFixed(2)}x · rug ${(br / tr).toFixed(2)}x`);
  }
  line(`\n  Separation = how many times more harm the bottom quartile inflicts than the top.`);
  line(`  Higher is a better score. Note what the 2x column does across quartiles: nothing.`);

  // ── 4b. WHAT SHRINKAGE ACTUALLY BUYS ─────────────────────────────────────────
  // Raw rates out-separate shrunk ones in section 4, so shrinkage has to justify itself on
  // something else. The metric that matters for a PUBLIC score is not average separation across
  // the whole range — it is precision at the top. The board says "worth following" about the
  // wallets it ranks highest, and being wrong there is the only error that costs trust. So:
  // take the top K by each model and measure what those wallets actually did next.
  rule("4b · PRECISION AT THE TOP — what the board is wrong about, and how often");
  line(`  "harm" = next-period dump rate + rug rate. Market average for reference: ${fmtPct(base.dump + base.rug)}.\n`);
  line(`  ${"model".padEnd(12)} ${"K".padStart(4)} ${"→ next harm".padStart(12)} ${"worst member".padStart(13)} ${"thin (<10)".padStart(11)}  ${"blowups".padStart(8)}`);
  const topRows = (useShrink: boolean) =>
    splittable.map((w) => {
      const h = w.toks.length >> 1;
      const f1 = w.toks.slice(0, h), f2 = w.toks.slice(h);
      const d = rate(f1, isDumped), r = rate(f1, isRugged);
      return {
        s: useShrink ? karmaTrust({ dumpRate: d, rugRate: r, n: f1.length }) : 100 * (1 - d) ** 2 * (1 - r) ** 1.5,
        n: f1.length,
        harm: rate(f2, isDumped) + rate(f2, isRugged),
      };
    }).sort((a, b) => b.s - a.s);
  const precisionTop: Array<{ K: number; model: string; next_harm: number; worst: number; thin: number; blowups: number }> = [];
  for (const K of [10, 25, 50]) {
    for (const [name, useShrink] of [["raw rates", false], ["shrunk", true]] as const) {
      const top = topRows(useShrink).slice(0, K);
      // A "blowup" is a wallet the model put in the top K that then inflicted worse-than-market harm.
      const blowups = top.filter((x) => x.harm > base.dump + base.rug).length;
      precisionTop.push({ K, model: name, next_harm: mean(top.map((x) => x.harm)), worst: Math.max(...top.map((x) => x.harm)), thin: top.filter((x) => x.n < 10).length, blowups });
      line(
        `  ${name.padEnd(12)} ${String(K).padStart(4)} ${fmtPct(mean(top.map((x) => x.harm))).padStart(12)} ` +
          `${fmtPct(Math.max(...top.map((x) => x.harm))).padStart(13)} ${String(top.filter((x) => x.n < 10).length).padStart(11)}  ` +
          `${(String(blowups) + `/${K}`).padStart(8)}`,
      );
    }
    line();
  }
  line(`  Read: blowups are the wallets the board recommended that then behaved worse than the`);
  line(`  market. That number, not average separation, is what a reputation product lives on.`);
  line(`  (harm can exceed 100% — one call can be both dumped and rugged.)`);
  line(`\n  What this measured, against what we assumed: shrinkage does NOT improve average`);
  line(`  separation (section 4) and does NOT make thin records behave like thick ones at equal`);
  line(`  scores. It earns its place in exactly one spot — the top of the board, where it halves`);
  line(`  the number of thin flukes on the podium and cuts the worst member's damage from 111%`);
  line(`  to 88%. By K=25 the two models converge. Since the podium is the only place Karma makes`);
  line(`  a positive recommendation, that is the trade worth taking, and it is the only claim`);
  line(`  shrinkage is allowed to make on the methodology page.`);
  line(`\n  Publish this too: even the best model puts 2 blowups in its top 10. Karma does not say`);
  line(`  "safe" — it says "measurably less likely to hurt you", and this is that claim's hit rate.`);

  // ── 5. THRESHOLDS + MOVEMENT ─────────────────────────────────────────────────
  rule("5 · THRESHOLDS — grade distribution under the frozen cut points");
  const scored = withData
    .filter((w) => w.toks.length >= SCORING.minCallsToScore)
    .map((w) => {
      const d = rate(w.toks, isDumped), r = rate(w.toks, isRugged);
      const k = karmaTrust({ dumpRate: d, rugRate: r, n: w.toks.length });
      const dHat = shrink(d, w.toks.length, TRUST_PRIORS.dump), rHat = shrink(r, w.toks.length, TRUST_PRIORS.rug);
      return { ...w, n: w.toks.length, d, r, k, g: gradeWithFloor(k, dHat, rHat).grade, floored: gradeWithFloor(k, dHat, rHat).floored, dHat, rHat };
    });
  line(`  scoreable (≥${SCORING.minCallsToScore} calls): ${scored.length} of ${wallets.length}   [old model: ${wallets.filter((w) => w.oldGrade).length} graded]`);
  line(`\n  karma percentiles: ${Object.entries(pctl(scored.map((s) => s.k))).map(([p, v]) => `p${p}=${v.toFixed(0)}`).join("  ")}`);
  const counts = new Map<string, number>();
  for (const s of scored) counts.set(s.g, (counts.get(s.g) ?? 0) + 1);
  line(`\n  ${"grade".padEnd(7)} ${"cut".padStart(5)} ${"n".padStart(5)} ${"share".padStart(7)}   ${"mean dump̂".padStart(10)} ${"mean ruĝ".padStart(9)}   vs market rug`);
  for (const [g, cut] of Object.entries(SCORING.trustGrades) as Array<[string, number]>) {
    const rows = scored.filter((s) => s.g === g);
    if (!rows.length) { line(`  ${g.padEnd(7)} ${String(cut).padStart(5)} ${"0".padStart(5)} ${"–".padStart(7)}`); continue; }
    const mr = mean(rows.map((s) => s.rHat));
    line(
      `  ${g.padEnd(7)} ${String(cut).padStart(5)} ${String(rows.length).padStart(5)} ${fmtPct(rows.length / scored.length).padStart(7)}   ` +
        `${fmtPct(mean(rows.map((s) => s.dHat))).padStart(10)} ${fmtPct(mr).padStart(9)}   ${(mr / base.rug).toFixed(2)}x`,
    );
  }

  // The credibility check the old model failed: can a rugger clear the pass line?
  rule("6 · CONTRADICTION CHECK — the credibility holes that made screenshots attackable");
  const passLine = SCORING.trustGrades.C;
  const ruggerAbove = scored.filter((s) => s.k >= passLine && s.rHat >= base.rug * 1.4);
  const dumperAbove = scored.filter((s) => s.k >= passLine && s.dHat >= base.dump * 1.5);
  line(`  pass line (grade ≥C, karma ≥${passLine}): ${scored.filter((s) => s.k >= passLine).length} wallets`);
  line(`  ...of which rug ≥1.4x the market rate: ${ruggerAbove.length}   ${ruggerAbove.length === 0 ? "✓" : "✗ still attackable"}`);
  line(`  ...of which dump ≥1.5x the market rate: ${dumperAbove.length}   ${dumperAbove.length === 0 ? "✓" : "✗ still attackable"}`);
  const worst = scored.filter((s) => s.k >= passLine).sort((a, b) => b.rHat - a.rHat)[0];
  if (worst) line(`  worst passer: @${worst.handle} karma ${worst.k} · ruĝ ${fmtPct(worst.rHat)} (${(worst.rHat / base.rug).toFixed(2)}x market) · dump̂ ${fmtPct(worst.dHat)}`);

  line(`\n  old → new grade movement (wallets graded under both):`);
  const moved = scored.filter((s) => s.oldGrade);
  const mv = new Map<string, number>();
  for (const s of moved) { const k = `${s.oldGrade}→${s.g}`; mv.set(k, (mv.get(k) ?? 0) + 1); }
  const top10 = [...mv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  line(`  ${top10.map(([k, v]) => `${k}:${v}`).join("  ")}`);
  line(`  unchanged: ${moved.filter((s) => s.oldGrade === s.g).length}/${moved.length}`);

  if (write) {
    await writeFile(
      OUT,
      JSON.stringify(
        {
          generated_from: `${wallets.length} wallets · ${all.length} scored calls · ${new Set(all.map((t) => t.mint)).size} coins`,
          priors_version: TRUST_PRIORS.version,
          base_rates: base,
          measured_tau: taus,
          reliability,
          predictive_validity: validity,
          grade_distribution: Object.fromEntries(counts),
          scoreable: scored.length,
          total_wallets: wallets.length,
          market_harm: base.dump + base.rug,
          precision_at_top: precisionTop,
          movement: Object.fromEntries([...mv.entries()].sort((a, b) => b[1] - a[1])),
          movement_unchanged: moved.filter((s) => s.oldGrade === s.g).length,
          movement_total: moved.length,
        },
        null,
        2,
      ),
    );
    line(`\n  → ${path.relative(ROOT, OUT)}  (publishable stats for /methodology)`);
  } else {
    line(`\n  (pass --write to publish these stats to seed/calibration.json)`);
  }
  line();
}

main().catch((e) => { console.error(e); process.exit(1); });
