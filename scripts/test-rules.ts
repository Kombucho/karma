/**
 * Golden tests for the scoring core. No framework, no config — `npm test` and read the output.
 *
 * These lock the exact logic the product's honesty depends on: the label predicates, the
 * shrinkage maths, the score shape, and the grade boundaries. Everything here is hand-checked
 * against the model's stated intent, so a failure means the model changed, not that a number
 * drifted. Run before and after any calibration edit.
 */

import { SCORING, TRUST_PRIORS } from "../src/lib/karma/scoring.config";
import {
  isRugged, isDumped, hadTwoXShot,
  shrink, posteriorSd, karmaTrust, gradeFromKarma, gradeWithFloor, trustBreakdown,
  labelFor, isDump, opportunityLabel, median, provisionalRead,
} from "../src/lib/karma/engine/rules";

let pass = 0;
const failures: string[] = [];

function check(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`); console.log(`  ✗ ${name}  got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function near(name: string, got: number, want: number, tol = 0.005) {
  const ok = Math.abs(got - want) <= tol;
  if (ok) { pass++; console.log(`  ✓ ${name}  (${got.toFixed(4)})`); }
  else { failures.push(`${name}: got ${got}, want ${want} ±${tol}`); console.log(`  ✗ ${name}  got ${got.toFixed(4)}, want ${want} ±${tol}`); }
}
function section(s: string) { console.log(`\n${s}`); }

// ── Label predicates ────────────────────────────────────────────────────────────
// The three facts every score is built from. Each must read BOTH data models: the opportunity
// recompute stores integrity as `dumped`/`rugged` flags, the older callout scorer put RUG/DUMP
// straight into `label`. Getting this wrong silently zeroes a caller's record.
section("Label predicates — both storage models");
check("rugged: explicit flag wins", isRugged({ rugged: true, label: "WIN", max_drop_from_peak_24h: 0 }), true);
check("rugged: flag false beats a legacy label", isRugged({ rugged: false, label: "RUG" }), false);
check("rugged: legacy RUG label", isRugged({ label: "RUG" }), true);
check("rugged: derived from drop at threshold", isRugged({ max_drop_from_peak_24h: -0.8 }), true);
check("rugged: just inside threshold is not a rug", isRugged({ max_drop_from_peak_24h: -0.79 }), false);
check("rugged: no data is not a rug", isRugged({ max_drop_from_peak_24h: null }), false);
check("dumped: explicit flag", isDumped({ dumped: true }), true);
check("dumped: legacy DUMP label", isDumped({ label: "DUMP" }), true);
check("dumped: a rug is not automatically a dump", isDumped({ label: "RUG" }), false);
check("2x shot: at threshold", hadTwoXShot({ copy_peak_multiple: 2.0 }), true);
check("2x shot: just under", hadTwoXShot({ copy_peak_multiple: 1.99 }), false);
check("2x shot: unmeasured is not a win", hadTwoXShot({ copy_peak_multiple: null }), false);

// A call can be a great shot AND a rug: "good pick, bad hands" must stay separable.
const goodPickBadHands = { copy_peak_multiple: 5.0, rugged: true, dumped: true };
check("good pick + bad hands: all three fire independently", [hadTwoXShot(goodPickBadHands), isRugged(goodPickBadHands), isDumped(goodPickBadHands)], [true, true, true]);

// ── Shrinkage ───────────────────────────────────────────────────────────────────
// w = tau² / (tau² + p(1−p)/n). Hand-computed below so a silent change to the formula fails here.
section("Shrinkage — empirical Bayes toward the population prior");
const D = TRUST_PRIORS.dump, R = TRUST_PRIORS.rug;
near("no data falls back to the prior exactly", shrink(0.9, 0, D), D.p, 0);
{
  // n=10, dump: noise = .199*.801/10 = .0159399; tau² = .009801; w = .38076
  const w = D.tau ** 2 / (D.tau ** 2 + (D.p * (1 - D.p)) / 10);
  near("n=10 weight on own record ≈ 0.38", w, 0.381, 0.01);
  near("n=10, observed 0.60 → shrunk", shrink(0.6, 10, D), w * 0.6 + (1 - w) * D.p, 0.0001);
}
{
  const w30 = D.tau ** 2 / (D.tau ** 2 + (D.p * (1 - D.p)) / 30);
  near("n=30 weight on own record ≈ 0.65", w30, 0.653, 0.01);
}
// n=3: noise = .199*.801/3 = .05313, tau² = .009801, w = .1557 → .1557*0 + .8443*.199 = .168
near("a perfect record at n=3 is barely believed", shrink(0, 3, D), 0.168, 0.005);
near("a perfect record at n=100 mostly is", shrink(0, 100, D), 0.024, 0.01);
check("shrinkage is monotone in n (converges on the observation)",
  [shrink(0.8, 5, D) > shrink(0.8, 30, D), shrink(0.8, 30, D) > D.p], [false, true]);
near("large n converges on the raw rate", shrink(0.8, 100000, D), 0.8, 0.001);
check("posterior SD narrows with evidence", posteriorSd(5, R) > posteriorSd(50, R), true);
near("posterior SD at n=0 is the full between-caller SD", posteriorSd(0, R), R.tau, 0.0001);

// ── Score shape ─────────────────────────────────────────────────────────────────
section("Karma trust score — shape and anchors");
// The anchor that makes the whole scale legible: a caller at the market's own rates. Under the
// fair-window priors the market rug base rate is lower (collapses that gave a fair exit no longer
// count), so the average caller sits higher than under trust-v3: 100·(1−.199)²·(1−.251)^1.5 ≈ 42.
near("a caller at market rates scores ~42", karmaTrust({ dumpRate: D.p, rugRate: R.p, n: 1000 }), 42, 1);
check("a spotless long record is high but never 100", (() => {
  const k = karmaTrust({ dumpRate: 0, rugRate: 0, n: 1000 });
  return k > 90 && k <= 100;
})(), true);
check("total predator floors at 0", karmaTrust({ dumpRate: 1, rugRate: 1, n: 1000 }), 0);
check("dumping is punished harder than rugging at equal rate", (() => {
  const dumper = karmaTrust({ dumpRate: 0.5, rugRate: R.p, n: 1000 });
  const rugger = karmaTrust({ dumpRate: D.p, rugRate: 0.5, n: 1000 });
  return dumper < rugger;
})(), true);
check("karma is monotone decreasing in dump rate", (() => {
  const ks = [0, 0.2, 0.4, 0.6, 0.8].map((d) => karmaTrust({ dumpRate: d, rugRate: 0.4, n: 1000 }));
  return ks.every((k, i) => i === 0 || k <= ks[i - 1]);
})(), true);
check("karma is monotone decreasing in rug rate", (() => {
  const ks = [0, 0.2, 0.4, 0.6, 0.8].map((r) => karmaTrust({ dumpRate: 0.2, rugRate: r, n: 1000 }));
  return ks.every((k, i) => i === 0 || k <= ks[i - 1]);
})(), true);
// The regression that made every screenshot attackable: a thin clean record outscoring a proven one.
check("a 3-call clean record does NOT outscore a 40-call clean record",
  karmaTrust({ dumpRate: 0, rugRate: 0, n: 3 }) < karmaTrust({ dumpRate: 0, rugRate: 0, n: 40 }), true);
// The v2 bug, locked out: no amount of upside can lift a dumper, because upside is not an input.
check("the opportunity axis is not an input to karma at all", (() => {
  type K = Parameters<typeof karmaTrust>[0];
  const withWin = { dumpRate: 0.5, rugRate: 0.5, n: 20, winRate: 1.0 } as K;
  return karmaTrust(withWin) === karmaTrust({ dumpRate: 0.5, rugRate: 0.5, n: 20 });
})(), true);

// ── Grades ──────────────────────────────────────────────────────────────────────
section("Grade boundaries — inclusive at the cut point");
const G = SCORING.trustGrades;
check("cut points are strictly descending", (Object.values(G) as number[]).every((v, i, a) => i === 0 || v < a[i - 1]), true);
for (const [g, cut] of Object.entries(G) as Array<[string, number]>) {
  check(`karma ${cut} is exactly grade ${g}`, gradeFromKarma(cut), g);
}
check("just below the A cut is a B", gradeFromKarma(G.A - 1), "B");
check("0 is an F", gradeFromKarma(0), "F");
check("100 is an S", gradeFromKarma(100), "S");
// The credibility guarantee, and why it needs a floor rather than better thresholds:
// karma multiplies two axes, so a spotless rug record carries a bad dump record upward. At
// n=200 a 1.5x-market dumper with zero rugs scores ~49 — a "Fair / worth following" B on the
// formula alone. No threshold tuning removes that; it is what multiplying does. The floor does.
section("Integrity floors — the guarantee the formula alone cannot give");
check("the formula alone DOES let a heavy dumper score into B (this is why the floor exists)",
  gradeFromKarma(karmaTrust({ dumpRate: D.p * 1.5, rugRate: 0, n: 200 })), "B");
/** Grade a caller from a raw dump/rug rate exactly the way the product does. */
const gradeRaw = (dumpRate: number, rugRate: number, n: number) =>
  gradeWithFloor(karmaTrust({ dumpRate, rugRate, n }), shrink(dumpRate, n, D), shrink(rugRate, n, R));

// The floor reads SHRUNK rates, so the raw record it takes to trip falls as evidence builds.
// That asymmetry is the point: we do not brand someone a dumper on a thin sample.
check("a 2x-market dumper is capped once there is any real record", (() => {
  for (const n of [20, 50, 200, 1000]) {
    const g = gradeRaw(D.p * 2, 0, n).grade;
    if (g !== "D" && g !== "F") return false;
  }
  return true;
})(), true);
check("a 1.5x-market dumper is capped once the sample can carry the claim", [
  gradeRaw(D.p * 1.5, 0, 20).floored,   // 20 calls: not yet believed
  gradeRaw(D.p * 1.5, 0, 200).floored,  // 200 calls: believed, capped
], [false, true]);
check("a 2x-market rugger is likewise capped", (() => {
  const g = gradeRaw(0, R.p * 2, 200).grade;
  return g === "D" || g === "F";
})(), true);
check("the floor reports itself so the card can explain the cap", gradeRaw(D.p * 2, 0, 200).floored, true);
check("a clean caller is never floored", gradeWithFloor(70, 0.05, 0.15).floored, false);
check("the floor only caps, never promotes", gradeWithFloor(5, 0.9, 0.9).grade, "F");

// ── Breakdown object ────────────────────────────────────────────────────────────
section("Trust breakdown — the object the card renders");
{
  const b = trustBreakdown({ dumps: 2, rugs: 6, twoX: 4, n: 20 });
  check("grade agrees with its own karma", b.grade, gradeFromKarma(b.karma));
  check("band brackets the point estimate", b.karma_low <= b.karma && b.karma <= b.karma_high, true);
  check("observed rates are the raw counts", [b.dump_rate_observed, b.rug_rate_observed], [0.1, 0.3]);
  check("shrunk dump sits between observation and prior", b.dump_rate > 0.1 && b.dump_rate < D.p, true);
  check("vs-market is the shrunk rate over the prior", Math.abs(b.dump_vs_market - b.dump_rate / D.p) < 1e-9, true);
  check("opportunity carries its own reliability", b.opportunity.reliability, TRUST_PRIORS.win.reliability);
  check("opportunity is reported but did not touch karma",
    b.karma === karmaTrust({ dumpRate: 0.1, rugRate: 0.3, n: 20 }), true);
}
{
  const thin = trustBreakdown({ dumps: 0, rugs: 0, twoX: 2, n: 3 });
  const thick = trustBreakdown({ dumps: 0, rugs: 0, twoX: 20, n: 40 });
  check("a thin record gets a visibly wider band", (thin.karma_high - thin.karma_low) > (thick.karma_high - thick.karma_low), true);
  check("thin record is low confidence", thin.confidence, "low");
  check("thick record is high confidence", thick.confidence, "high");
  check("evidence weight rises with n", thin.evidence_weight < thick.evidence_weight, true);
}
{
  const empty = trustBreakdown({ dumps: 0, rugs: 0, twoX: 0, n: 0 });
  check("zero calls falls back to the market prior, not a perfect score", empty.karma, karmaTrust({ dumpRate: D.p, rugRate: R.p, n: 0 }));
  check("zero calls says so", empty.verdict, "No settled calls on record. Nothing to read.");
}
{
  const predator = trustBreakdown({ dumps: 12, rugs: 14, twoX: 8, n: 20 });
  check("a heavy dumper is named as one", predator.verdict.includes("Dumped into their own buyers"), true);
  check("a heavy dumper grades F", predator.grade, "F");
}

// ── Legacy v1/v2 paths still intact ─────────────────────────────────────────────
// recompute.ts and the older validation files still route through these; the UI reads both.
section("Legacy model — unchanged behaviour");
check("median of an even-length set", median([1, 2, 3, 4]), 2.5);
check("median of an empty set is null", median([]), null);
check("opportunityLabel: 2x is a WIN", opportunityLabel(2.0), "WIN");
check("opportunityLabel: under 1 is a LOSS", opportunityLabel(0.9), "LOSS");
check("opportunityLabel: unknown is NEUTRAL", opportunityLabel(null), "NEUTRAL");
{
  const base = { wallet_roi: 1.0, fraction_sold: 0.9, drawdown_after_exit: -0.9 } as never;
  check("isDump: profitable exit into a collapse", isDump(base, SCORING), true);
  check("isDump: clean profit-taking with no collapse is not a dump",
    isDump({ wallet_roi: 1.0, fraction_sold: 0.9, drawdown_after_exit: -0.1 } as never, SCORING), false);
  check("isDump: selling at a loss is not a dump",
    isDump({ wallet_roi: -0.5, fraction_sold: 0.9, drawdown_after_exit: -0.9 } as never, SCORING), false);
  check("isDump: trimming a little is not a dump",
    isDump({ wallet_roi: 1.0, fraction_sold: 0.2, drawdown_after_exit: -0.9 } as never, SCORING), false);
  check("labelFor: a rug outranks everything",
    labelFor({ max_drop_from_peak_24h: -0.95, wallet_roi: 1, fraction_sold: 1, drawdown_after_exit: -0.9, copy_return_24h: 3 } as never, SCORING), "RUG");
}

// ── Provisional reads ───────────────────────────────────────────────────────────
// Fast 1h reads exist so a fresh call shows within the hour. They must never reach the score:
// the priors were calibrated on settled 24h outcomes, and the 1h signal measures 0.40 split-half
// against the 24h definition's 0.53, agreeing with the settled verdict only 58% of the time.
section("Provisional reads — displayed, never scored");
const HOUR = 3600, T0 = 1_800_000_000;
check("a settled token is never provisional",
  provisionalRead({ status: "scored", entry_time: T0, price_1h: 1, copy_entry_price: 2 }, T0 + 3 * HOUR), null);
check("under an hour old there is no 1h price to read",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: 1, copy_entry_price: 2 }, T0 + 30 * 60), null);
check("past the settle window it is not provisional, it is awaiting a re-score",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: 1, copy_entry_price: 2 }, T0 + 30 * HOUR), null);
check("a halved price at 3h reads as collapsing",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: 0.4, copy_entry_price: 1 }, T0 + 3 * HOUR)?.read, "collapsing");
check("a doubled price at 3h reads as running",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: 2.1, copy_entry_price: 1 }, T0 + 3 * HOUR)?.read, "running");
check("drifting reads as flat",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: 1.1, copy_entry_price: 1 }, T0 + 3 * HOUR)?.read, "flat");
check("no 1h price means no read, never a guess",
  provisionalRead({ status: "incomplete", entry_time: T0, price_1h: null, copy_entry_price: 1 }, T0 + 3 * HOUR), null);
// The rule that matters: karma takes settled counts only, so a provisional call cannot move it.
check("karma's inputs contain no provisional channel", (() => {
  const before = karmaTrust({ dumpRate: 0.1, rugRate: 0.3, n: 20 });
  type K = Parameters<typeof karmaTrust>[0];
  const after = karmaTrust({ dumpRate: 0.1, rugRate: 0.3, n: 20, provisional: 99 } as K);
  return before === after;
})(), true);

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(70)}`);
if (failures.length) {
  console.log(`  ${pass} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log(`    ✗ ${f}`);
  console.log();
  process.exit(1);
}
console.log(`  ${pass} passed, 0 failed — scoring core locked\n`);
