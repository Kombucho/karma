import { GRADE_TITLES, SCORING, TRUST_PRIORS, type ScoringConfig, type TrustPrior } from "../scoring.config";
import type { Confidence, Grade, Label, TokenResult, WalletScore } from "../types";

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** §5.4: the wallet took profit, meaningfully exited, and the price then fell hard on whoever still held. */
export function isDump(r: TokenResult, cfg: ScoringConfig): boolean {
  return (
    r.wallet_roi !== null &&
    r.wallet_roi > cfg.dump.minWalletRoi &&
    r.fraction_sold !== null &&
    r.fraction_sold >= cfg.dump.minFractionSold &&
    r.drawdown_after_exit !== null &&
    r.drawdown_after_exit <= cfg.dump.maxDrawdownAfterExit
  );
}

/** §5.5, first match wins. Only call on tokens with a copy_return_24h. */
export function labelFor(r: TokenResult, cfg: ScoringConfig): Label {
  if (r.max_drop_from_peak_24h !== null && r.max_drop_from_peak_24h <= cfg.rug.dropFromPeak) return "RUG";
  if (isDump(r, cfg)) return "DUMP";
  const ret = r.copy_return_24h ?? 0;
  if (ret >= cfg.win.minCopyReturn24h || (r.copy_peak_multiple ?? 0) >= cfg.win.minPeakMultiple) return "WIN";
  if (ret < cfg.loss.maxCopyReturn24h) return "LOSS";
  return "NEUTRAL";
}

export interface GradeInputs {
  hitRate: number;
  medianCopyReturn: number;
  dumpRate: number;
  rugRate: number;
  walletPnlSol: number;
}

/** §5.7. Dump and rug rates cap the grade no matter how profitable the wallet itself was. */
export function gradeFor(m: GradeInputs, cfg: ScoringConfig): Grade {
  const { F, D, S, A, B } = cfg.grades;
  if (m.rugRate >= F.minRugRate || m.dumpRate >= F.minDumpRate) return "F";
  if (m.dumpRate >= D.minDumpRate || (m.walletPnlSol > 0 && m.medianCopyReturn <= D.profitableMaxMedian)) return "D";
  if (m.hitRate >= S.minHitRate && m.medianCopyReturn >= S.minMedian && m.dumpRate <= S.maxDumpRate && m.rugRate <= S.maxRugRate)
    return "S";
  if (m.hitRate >= A.minHitRate && m.medianCopyReturn >= A.minMedian && m.dumpRate <= A.maxDumpRate && m.rugRate <= A.maxRugRate)
    return "A";
  if (m.hitRate >= B.minHitRate && m.dumpRate <= B.maxDumpRate) return "B";
  // The PRD's C band is hit rate 25–35%; hit rates under 25% with no dump/rug problem land here too
  return "C";
}

/**
 * Karma score, 0–10 (higher = safer to follow). Dumps weighted heaviest — profiting by
 * dumping on followers is the cardinal sin. v1 weights; calibrate against the full
 * population distribution before locking. Returns null for wallets below the sample floor.
 */
export function karmaScore(m: { hitRate: number; median: number; dumpRate: number; rugRate: number }): number {
  const raw = 5 + 3 * (m.hitRate - 0.3) + 2 * Math.max(-1, Math.min(1, m.median)) - 4 * m.dumpRate - 3 * m.rugRate;
  return Math.round(Math.max(0, Math.min(10, raw)) * 10) / 10;
}

// ── Opportunity model (v2) ──────────────────────────────────────────────────────
// Two independent axes instead of the naive buy-and-hold-24h read:
//   OPPORTUNITY — did the call give a reachable shot? (peak multiple within 24h)
//   INTEGRITY   — did the caller dump on followers? (caller exited into the collapse)
// A call can be a great opportunity AND a dump ("good pick, bad hands"); the two are
// tracked separately so the score rewards signal and punishes front-running.

/** Peak-reachable opportunity label for a follower with any exit discipline. */
export function opportunityLabel(peakMultiple: number | null): "WIN" | "NEUTRAL" | "LOSS" {
  if (peakMultiple === null) return "NEUTRAL";
  if (peakMultiple >= 2) return "WIN";      // a 2x+ was on the table within 24h
  if (peakMultiple < 1) return "LOSS";      // never even recovered entry — dead on arrival
  return "NEUTRAL";                          // drifted up but no real shot
}

// Three-axis weights. Tune against the full 607 distribution before final launch.
export const KARMA_V2 = { winCeil: 0.6, oppWeight: 0.4, integrityWeight: 0.6, dumpExp: 2, rugExp: 1.5 };

/**
 * Opportunity-model karma, 0–10, over three axes:
 *   OPPORTUNITY — winRate = fraction of calls that reached 2x within 24h (reward).
 *   INTEGRITY   — two penalties that compound:
 *     dumpRate = caller cashed out into the crash (predatory, weighted heaviest);
 *     rugRate  = the coin collapsed and hurt followers, whoever profited (reckless/complicit).
 * A rugger who exits at a loss on his visible wallet (extracting via dev supply or another
 * wallet) can't hide behind "I lost too" — the rug still tanks the score, because a follower
 * gets wrecked when the coin rugs regardless of who pocketed it.
 */
export function karmaOpportunity(m: { winRate: number; dumpRate: number; rugRate: number }): number {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const opp = Math.min(m.winRate / KARMA_V2.winCeil, 1);
  const integrity = Math.pow(1 - clamp(m.dumpRate), KARMA_V2.dumpExp) * Math.pow(1 - clamp(m.rugRate), KARMA_V2.rugExp);
  const k = 10 * (KARMA_V2.oppWeight * opp + KARMA_V2.integrityWeight * integrity);
  return Math.round(Math.max(0, Math.min(10, k)) * 10) / 10;
}

// ── Trust model (v3) ────────────────────────────────────────────────────────────
//
// What changed and why, in one paragraph: we measured whether each axis is a persistent
// trait or a coin flip (split-half correlation over 245 callers with ≥12 calls each, same
// samples for every metric). Integrity persists — dumping r=0.50, rugging r=0.53. Picking
// does not — the 2×-shot rate comes back at r=0.11, and sorting callers by last period's
// picking record predicts next period's picking record barely better than alphabetical order.
// The v2 karma put 40% of its weight on that axis. Removing it did not cost accuracy, it
// BOUGHT accuracy: on the same split-half test, integrity-only separated the worst quartile
// from the best by 1.84× on future dump rate against the blend's 1.64×. So the part came out.
//
// Two further corrections make the remaining number mean something:
//   BASE RATE  45% of KOL-called coins collapse ≥80% from peak within 24h. That is the asset
//              class, not the caller. We report every rate against the market rate, so "1.4×
//              the market" is legible where a bare "63% rug rate" is not.
//   SHRINKAGE  a 10-call record is mostly noise. Empirical Bayes pulls each rate toward the
//              population mean by exactly how much noise the sample size implies, which is the
//              principled version of the old UNPROVEN cliff — and it lets us honestly score the
//              451 wallets the cliff was hiding instead of showing them "Not scored yet".

/** The coin collapsed ≥80% from its 24h peak: followers got wrecked, whoever pocketed it. */
export function isRugged(t: { rugged?: boolean; label?: string | null; max_drop_from_peak_24h?: number | null }): boolean {
  if (t.rugged !== undefined) return t.rugged;
  if (t.label === "RUG") return true;
  return t.max_drop_from_peak_24h != null && t.max_drop_from_peak_24h <= SCORING.rug.dropFromPeak;
}

/** The caller took profit, meaningfully exited, and the price then fell hard on whoever held. */
export function isDumped(t: { dumped?: boolean; label?: string | null }): boolean {
  return t.dumped !== undefined ? t.dumped : t.label === "DUMP";
}

/**
 * Provisional read for a call that has not settled yet.
 *
 * A call needs 24h of history before it can be scored, but memecoins are decided in minutes,
 * so a board that stays silent for a day is useless exactly when it matters most. This gives a
 * fast read off the 1h price, with one hard rule: it is DISPLAYED, NEVER SCORED.
 *
 * That rule is not caution, it is arithmetic. The priors (p, tau) and every threshold were
 * calibrated on settled 24h outcomes, and we measured what a 1h signal is worth: split-half
 * reliability 0.40 against the 24h definition's 0.53, agreeing with the settled verdict only
 * 58% of the time. At one hour a coin that is dipping and a coin that is dead look identical.
 * Feeding that into the same number would quietly degrade the one thing Karma sells.
 *
 * So the call shows up within the hour wearing a PROVISIONAL mark, and the re-score upgrades
 * it to the real verdict once 24h closes.
 */
export type ProvisionalRead = "collapsing" | "running" | "flat" | null;

export function provisionalRead(t: {
  status?: string;
  entry_time?: number | null;
  price_1h?: number | null;
  copy_entry_price?: number | null;
  entry_price?: number | null;
}, now: number): { read: ProvisionalRead; ageHours: number } | null {
  if (t.status !== "incomplete" || !t.entry_time) return null;
  const age = now - t.entry_time;
  // Younger than an hour there is no 1h price yet; past the settle window it is not provisional,
  // it is simply waiting on a re-score, and saying "provisional" there would be a lie.
  if (age < 3600 || age >= SCORING.settleSeconds) return null;
  const entry = t.copy_entry_price ?? t.entry_price;
  if (!entry || !t.price_1h) return null;
  const ret = t.price_1h / entry - 1;
  return { read: ret <= -0.5 ? "collapsing" : ret >= 1 ? "running" : "flat", ageHours: age / 3600 };
}

/** A 2× was reachable within 24h for a follower with any exit discipline. Displayed, not scored. */
export function hadTwoXShot(t: { copy_peak_multiple?: number | null }): boolean {
  return (t.copy_peak_multiple ?? 0) >= SCORING.win.minPeakMultiple;
}

/**
 * The call gave followers a fair exit window: the price reached at least fairWindowMultiple× entry
 * within 24h, so anyone with a shred of exit discipline could have left whole or ahead before any
 * later collapse. A coin that offered this is not scored as a rug against the caller.
 */
export function gaveFairWindow(t: { copy_peak_multiple?: number | null }): boolean {
  return (t.copy_peak_multiple ?? 0) >= SCORING.win.fairWindowMultiple;
}

/**
 * Rug for TRUST-SCORING: the coin collapsed AND never gave a fair exit window. A collapse that
 * first ran to 1.5×+ wrecked only those who held through a real chance to leave, so it does not
 * count against the caller's scored rug RATE. The DISPLAY label (isRugged) is unchanged — receipts
 * still say RUG; only the scored rate uses this.
 */
export function isRuggedForTrust(t: { rugged?: boolean; label?: string | null; max_drop_from_peak_24h?: number | null; copy_peak_multiple?: number | null }): boolean {
  return isRugged(t) && !gaveFairWindow(t);
}

/**
 * Empirical-Bayes shrinkage: blend an observed rate with the population prior, weighted by how
 * much of the observed spread at this sample size is real rather than binomial noise.
 *
 *   w = tau² / (tau² + p(1−p)/n)
 *
 * tau² is the true between-caller variance; p(1−p)/n is the noise in one caller's estimate.
 * When the sample is thin, noise dominates, w → 0, and the estimate falls back to the market
 * average — which is the honest answer, because that is genuinely all we know. When the record
 * is long, w → 1 and the caller's own numbers speak for themselves. At n=10 a rug rate is
 * trusted about half; at n=30, about three quarters.
 */
export function shrink(observed: number, n: number, prior: TrustPrior): number {
  if (n <= 0) return prior.p;
  const noise = (prior.p * (1 - prior.p)) / n;
  const w = prior.tau ** 2 / (prior.tau ** 2 + noise);
  return w * observed + (1 - w) * prior.p;
}

/** Posterior SD of a shrunk rate — the width of what we actually know. Drives the karma band. */
export function posteriorSd(n: number, prior: TrustPrior): number {
  if (n <= 0) return prior.tau;
  return Math.sqrt(1 / (1 / prior.tau ** 2 + n / (prior.p * (1 - prior.p))));
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The score shape, on already-final rates. Separated so tests can hit it without shrinkage. */
function trustShape(dumpRate: number, rugRate: number): number {
  const { dumpExp, rugExp } = TRUST_PRIORS.weights;
  return 100 * (1 - clamp01(dumpRate)) ** dumpExp * (1 - clamp01(rugRate)) ** rugExp;
}

/**
 * Karma, 0–100. Higher = less likely to hurt you. Integrity only — this number makes no claim
 * about whether the caller picks winners, because we measured that and they don't.
 *
 * Deliberately harsh at the top: a caller at the market's own rug and dump rates scores ~26,
 * because following the average Solana caller is genuinely a bad idea. Nobody earns a 90.
 */
export function karmaTrust(m: { dumpRate: number; rugRate: number; n: number }): number {
  const d = shrink(m.dumpRate, m.n, TRUST_PRIORS.dump);
  const r = shrink(m.rugRate, m.n, TRUST_PRIORS.rug);
  return Math.round(trustShape(d, r));
}

/** Grade from the trust score alone, using the frozen absolute cut points. */
export function gradeFromKarma(karma: number): Grade {
  const g = SCORING.trustGrades;
  if (karma >= g.S) return "S";
  if (karma >= g.A) return "A";
  if (karma >= g.B) return "B";
  if (karma >= g.C) return "C";
  if (karma >= g.D) return "D";
  return "F";
}

const GRADE_ORDER: Grade[] = ["S", "A", "B", "C", "D", "F"];

/**
 * The published grade: the karma band, then the integrity floors.
 *
 * Because karma multiplies two axes, an exceptional record on one can carry a bad record on
 * the other into a passing grade. The floors say the quiet part out loud: a caller who cashes
 * out into the crash well above the market rate is capped at D no matter what the formula
 * produced. Rates passed here must already be shrunk.
 */
export function gradeWithFloor(karma: number, dumpRate: number, rugRate: number): { grade: Grade; floored: boolean } {
  const raw = gradeFromKarma(karma);
  const f = SCORING.integrityFloor;
  const breached = dumpRate / TRUST_PRIORS.dump.p >= f.dumpVsMarket || rugRate / TRUST_PRIORS.rug.p >= f.rugVsMarket;
  if (!breached) return { grade: raw, floored: false };
  const capped = GRADE_ORDER.indexOf(raw) < GRADE_ORDER.indexOf(f.cappedGrade) ? f.cappedGrade : raw;
  return { grade: capped, floored: capped !== raw };
}

export interface TrustBreakdown {
  karma: number;
  grade: Grade;
  title: string;
  n: number;
  /** Shrunk rates — what we actually believe about this caller. */
  dump_rate: number;
  rug_rate: number;
  /** Raw observed rates — what the receipts literally show. Both are displayed; they differ. */
  dump_rate_observed: number;
  rug_rate_observed: number;
  /** Rates as a multiple of the market. 1.0 = exactly average. The legible number. */
  dump_vs_market: number;
  rug_vs_market: number;
  /** 95% band on karma from the posterior SDs. A thin record gets a visibly wide band. */
  karma_low: number;
  karma_high: number;
  /** How much of the score is the caller's own record vs the population prior, 0–1. */
  evidence_weight: number;
  confidence: Confidence;
  /** The karma band would have graded higher; an integrity floor capped it. Shown on the card. */
  grade_floored: boolean;
  /** Displayed, never scored: reliability 0.20 means this does not predict. */
  opportunity: { two_x_rate: number; vs_market: number; reliability: number };
  verdict: string;
}

/**
 * Everything the card needs, in one honest object: the score, the band around it, how much of
 * it is evidence vs prior, and the un-scored opportunity stat with its reliability attached.
 */
export function trustBreakdown(m: { dumps: number; rugs: number; twoX: number; n: number }): TrustBreakdown {
  const { n } = m;
  const dObs = n ? m.dumps / n : TRUST_PRIORS.dump.p;
  const rObs = n ? m.rugs / n : TRUST_PRIORS.rug.p;
  const wObs = n ? m.twoX / n : TRUST_PRIORS.win.p;

  const d = shrink(dObs, n, TRUST_PRIORS.dump);
  const r = shrink(rObs, n, TRUST_PRIORS.rug);
  const karma = Math.round(trustShape(d, r));

  // Band on karma, by the delta method. Pushing BOTH rates to their 2.5% tail at once would be
  // a joint ~0.1% corner, not a 95% interval — it produced bands like "33–100" that said
  // nothing. Instead propagate each rate's posterior variance through the score's own slope:
  //   ∂k/∂d = −200(1−d)(1−r)^1.5     ∂k/∂r = −150(1−d)²(1−r)^0.5
  //   Var(k) ≈ (∂k/∂d)²σ_d² + (∂k/∂r)²σ_r²      (the two axes are estimated independently)
  const { dumpExp, rugExp } = TRUST_PRIORS.weights;
  const sdD = posteriorSd(n, TRUST_PRIORS.dump);
  const sdR = posteriorSd(n, TRUST_PRIORS.rug);
  const cd = clamp01(d), cr = clamp01(r);
  const dk_dd = -100 * dumpExp * (1 - cd) ** (dumpExp - 1) * (1 - cr) ** rugExp;
  const dk_dr = -100 * rugExp * (1 - cd) ** dumpExp * (1 - cr) ** (rugExp - 1);
  const sdK = Math.sqrt((dk_dd * sdD) ** 2 + (dk_dr * sdR) ** 2);
  const karmaHigh = Math.round(Math.min(100, karma + 1.96 * sdK));
  const karmaLow = Math.round(Math.max(0, karma - 1.96 * sdK));

  // Evidence weight: the dump axis's shrinkage weight, the tightest of the two.
  const noise = (TRUST_PRIORS.dump.p * (1 - TRUST_PRIORS.dump.p)) / Math.max(n, 1);
  const evidence = n ? TRUST_PRIORS.dump.tau ** 2 / (TRUST_PRIORS.dump.tau ** 2 + noise) : 0;

  const { grade, floored } = gradeWithFloor(karma, d, r);
  return {
    karma,
    grade,
    title: GRADE_TITLES[grade],
    grade_floored: floored,
    n,
    dump_rate: d,
    rug_rate: r,
    dump_rate_observed: dObs,
    rug_rate_observed: rObs,
    dump_vs_market: d / TRUST_PRIORS.dump.p,
    rug_vs_market: r / TRUST_PRIORS.rug.p,
    karma_low: karmaLow,
    karma_high: karmaHigh,
    evidence_weight: evidence,
    confidence: evidence >= 0.7 ? "high" : evidence >= 0.45 ? "medium" : "low",
    opportunity: { two_x_rate: wObs, vs_market: wObs / TRUST_PRIORS.win.p, reliability: TRUST_PRIORS.win.reliability },
    verdict: trustVerdict(m.dumps, m.rugs, n, d, r),
  };
}

/**
 * The verdict line. This is the single most-read sentence Karma produces: it headlines the
 * card and gets baked into the share image, so it speaks the reader's language (trenches, not
 * finance desk) while every number behind it stays the measured one. Always phrased against
 * the trench average rather than against zero — 45% of called coins rug on their own, so a
 * bare percentage would be a claim about Solana, not about this caller.
 */
function trustVerdict(dumps: number, rugs: number, n: number, d: number, r: number): string {
  if (!n) return "No settled calls on record. Nothing to read.";
  const dx = d / TRUST_PRIORS.dump.p;
  const rx = r / TRUST_PRIORS.rug.p;
  if (dx >= 1.5) return `Dumped into their own buyers on ${dumps} of ${n} calls. ${dx.toFixed(1)}× the trench average.`;
  if (rx >= 1.4) return `${rugs} of ${n} calls round-tripped to zero on whoever held. ${rx.toFixed(1)}× the trench rug rate.`;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (dx <= 0.6 && rx <= 0.8)
    return `${plural(dumps, "dump", "dumps")}, ${plural(rugs, "rug", "rugs")} in ${n} calls. Cleaner than the trenches on both counts.`;
  return `${plural(dumps, "dump", "dumps")}, ${plural(rugs, "rug", "rugs")} in ${n} calls. Trench average on both — you're gambling, not following.`;
}

function verdictFor(n: number, wins: number, dumps: number, rugs: number): string {
  if (n === 0) return "No scorable trades in the lookback window.";
  if (dumps > 0) return `Dumped on holders in ${dumps} of ${n} tokens.`;
  if (rugs > 0) return `Followers got rugged in ${rugs} of ${n} tokens.`;
  return `Copying their buys won ${wins} of ${n} times.`;
}

/** Longest run of consecutive WINs in entry order. */
function longestWinStreak(scored: TokenResult[]): number {
  const ordered = [...scored].sort((a, b) => (a.entry_time ?? 0) - (b.entry_time ?? 0));
  let best = 0;
  let run = 0;
  for (const t of ordered) {
    run = t.label === "WIN" ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

export function aggregate(wallet: string, tokens: TokenResult[], pending: number, cfg: ScoringConfig, now: number): WalletScore {
  const scored = tokens.filter((t) => t.status === "scored");
  const n = scored.length;
  const count = (l: Label) => scored.filter((t) => t.label === l).length;
  const [wins, losses, dumps, rugs, neutrals] = (["WIN", "LOSS", "DUMP", "RUG", "NEUTRAL"] as const).map(count);
  // Some scored tokens (pump.fun upside-only WINs) have a known peak but an unmeasured
  // 24h return — exclude their nulls from the median rather than coercing them to 0.
  const medianCopy = median(scored.map((t) => t.copy_return_24h).filter((x): x is number => x !== null));
  const pnl = scored.reduce((sum, t) => sum + (t.wallet_realized_pnl_sol ?? 0), 0);

  // Live-activity view: any status counts — a position too fresh to score is exactly the one worth flagging
  const active = tokens.filter((t) => t.last_trade_time !== null && now - t.last_trade_time <= cfg.activeWindowSeconds);
  const selling = active.filter((t) => t.last_trade_side === "sell");

  // The anti-DUMP: still in the position well past entry, most of the bag unsold, and it isn't a dead RUG bag
  const diamonds = tokens.filter(
    (t) =>
      t.position_open &&
      t.label !== "RUG" &&
      t.entry_time !== null &&
      now - t.entry_time >= cfg.diamondMinHoldSeconds &&
      (t.fraction_sold ?? 0) < cfg.diamondMaxFractionSold,
  );

  const unproven = n < cfg.unprovenMinTokens;
  const grade = unproven
    ? null
    : gradeFor({ hitRate: wins / n, medianCopyReturn: medianCopy ?? 0, dumpRate: dumps / n, rugRate: rugs / n, walletPnlSol: pnl }, cfg);

  const coverage = tokens.length ? n / tokens.length : 0;
  const confidence: Confidence =
    n >= 25 && coverage >= 0.8 ? "high" : n >= cfg.unprovenMinTokens && coverage >= 0.6 ? "medium" : "low";

  return {
    wallet,
    n_tokens: n,
    wins,
    losses,
    dumps,
    rugs,
    neutrals,
    follower_hit_rate: n ? wins / n : null,
    median_copy_return: medianCopy,
    dump_rate: n ? dumps / n : null,
    rug_rate: n ? rugs / n : null,
    wallet_realized_pnl_sol: pnl,
    longest_win_streak: longestWinStreak(scored),
    open_positions: tokens.filter((t) => t.position_open).length,
    active_now: active.map((t) => t.mint),
    selling_now: selling.map((t) => t.mint),
    diamond_hands: diamonds.map((t) => t.mint),
    unproven,
    karma_score: unproven
      ? null
      : karmaScore({ hitRate: wins / n, median: medianCopy ?? 0, dumpRate: dumps / n, rugRate: rugs / n }),
    grade,
    title: grade ? GRADE_TITLES[grade] : null,
    confidence,
    verdict: verdictFor(n, wins, dumps, rugs),
    coverage: {
      scored: n,
      incomplete: tokens.filter((t) => t.status === "incomplete").length,
      no_price_data: tokens.filter((t) => t.status === "no_price_data").length,
      pending,
    },
  };
}
