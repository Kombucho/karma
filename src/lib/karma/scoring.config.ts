/**
 * Karma scoring thresholds (PRD §5).
 * Every number that shapes a label or a grade lives here so Phase 1 validation
 * can tune them without touching engine code. Aggregates use the median, never the mean.
 */
export const SCORING = {
  version: "v1-defaults",

  // §5.1 lookback: last 90 days OR last 30 distinct tokens, whichever is smaller
  lookbackDays: 90,
  lookbackMaxTokens: 30,
  // A token needs 24h of post-entry history before it can be scored (copy_return_24h)
  settleSeconds: 24 * 3600,
  // After 30 tokens are found, keep scanning back at least this far to catch their earlier buys...
  minExtraScanSeconds: 3600,
  // ...and at most this far, even if some positions still look unbalanced
  maxExtraScanSeconds: 48 * 3600,
  // Hard cap on transactions fetched per wallet, so a bot-like wallet can't blow the credit budget
  maxTxScan: 6000,

  // §5.2 reconstruction
  fullyExitedFraction: 0.9,
  // A SOL leg smaller than this is a transfer/airdrop, not a swap
  minSwapSol: 0.001,
  // Sold more than bought × this means the buys happened before the lookback window
  soldMoreThanBoughtTolerance: 1.02,

  // §5.3 follower simulation
  copyLatencySeconds: 120,
  // Window for peak_price_after_entry / copy_peak_multiple (PRD leaves it open; 24h matches copy_return_24h)
  peakWindowSeconds: 24 * 3600,

  // §5.4 DUMP detector: wallet took profit, meaningfully exited, price then fell ≥50%
  dump: { minWalletRoi: 0, minFractionSold: 0.5, maxDrawdownAfterExit: -0.5, windowSeconds: 24 * 3600 },

  // §5.5 labels
  rug: { dropFromPeak: -0.8, windowSeconds: 24 * 3600 },
  win: { minCopyReturn24h: 0.5, minPeakMultiple: 2.0, fairWindowMultiple: 1.5 },
  loss: { maxCopyReturn24h: 0 },

  // §5.8 sample-size floor (v1/v2 models — a hard UNPROVEN cliff at n<10)
  unprovenMinTokens: 10,

  // v3 trust model: no cliff. Shrinkage (see TRUST_PRIORS) pulls a thin record toward the
  // population mean in proportion to how thin it is, so n=4 scores honestly near average
  // instead of being hidden. This floor only excludes wallets with nothing to measure at all.
  minCallsToScore: 3,

  // v3 grade cut points on the 0–100 trust score. Absolute, frozen, versioned — NOT percentile
  // bands, so the grades still move if the whole population gets worse. Calibrated against the
  // 733-wallet corpus by `npm run calibrate` (section 5); re-run it before ever touching these.
  trustGrades: { S: 66, A: 56, B: 46, C: 36, D: 24, F: 0 },

  /**
   * Non-negotiable integrity floors, applied AFTER the karma formula.
   *
   * The score is multiplicative, so a caller with an exceptional rug record can carry a bad
   * dump record into a passing grade — 1.5× the market dump rate with zero rugs comes out at
   * karma 49, a "Fair / worth following" B. That is the exact contradiction the old model was
   * attacked for, just relocated, and no amount of threshold tuning removes it: it is a
   * property of multiplying two axes. So it gets stated as a rule instead of tuned away.
   *
   * A caller who cashes out into the crash meaningfully more often than the market does is
   * never "worth following", whatever else is true about them. This is the single source of
   * truth for that rule (leaderboard.ts used to patch it at board-build time).
   *
   * These multiples are read against the SHRUNK rate, i.e. against what we actually believe
   * about the caller rather than what one thin sample suggested. That has a deliberate
   * consequence: the raw record needed to trip the floor falls as evidence accumulates —
   * ~1.7× the market dump rate at 20 calls, ~1.5× at 50, ~1.43× at 200. We do not brand
   * someone a dumper until the sample can carry the claim.
   */
  integrityFloor: { dumpVsMarket: 1.4, rugVsMarket: 1.5, cappedGrade: "D" as const },

  // A token counts as "active now" if the wallet swapped it within this window
  activeWindowSeconds: 48 * 3600,
  // Tx cap for the live probe (/api/activity): bot wallets return partial=true instead of blowing the budget.
  // (Can't pre-filter by size: signatures carry no amounts, so the cap bounds fetches, filters run after.)
  liveProbeMaxTx: 150,
  // Live-strip significance: ignore swaps below this (SOL), and drop tokens whose total volume in the window
  // stays below liveMinPositionSol — micro-churn isn't a position anyone is being dumped on
  liveMinSwapSol: 0.05,
  liveMinPositionSol: 1,
  // A live position whose SOL volume exceeds this fraction of the wallet's current balance is "conviction size"
  liveConvictionFraction: 0.1,
  // Diamond hands: still holding a conviction-entered position this long after entry, having sold under half
  diamondMinHoldSeconds: 7 * 86400,
  diamondMaxFractionSold: 0.5,

  // §5.7 grades, checked in order F → D → S → A → B → C
  grades: {
    F: { minRugRate: 0.3, minDumpRate: 0.6 },
    D: { minDumpRate: 0.4, profitableMaxMedian: -0.25 },
    S: { minHitRate: 0.55, minMedian: 0.25, maxDumpRate: 0.1, maxRugRate: 0.1 },
    A: { minHitRate: 0.45, minMedian: 0, maxDumpRate: 0.2, maxRugRate: 0.15 },
    B: { minHitRate: 0.35, maxDumpRate: 0.3 },
    C: { maxDumpRate: 0.4 },
  },

  // §6.6 Coin Scan gates and depth
  coin: {
    topHolders: 50,
    // Eligibility: the market moves in seconds, so we scan from birth. The structural signals
    // (dev record, holder concentration, bundles, fan-out) are the whole point of a fresh scan —
    // they're valid the instant the coin exists. Thin track record is flagged "provisional", not
    // refused. 0 = no age gate; a pump mint with no DEX pool yet is aged from pump's own timestamp.
    minAgeSeconds: 0,
    // A dev's coin still carrying at least this market cap counts as "alive" (vs a dead launch).
    devAliveMcapUsd: 5000,
    // Under this age the holder book is still forming: mark the scan provisional and skip the
    // volume floor (a 10-minute-old coin can't have a meaningful 24h number yet).
    provisionalUnderSeconds: 3600,
    // Dead-coin floor, only enforced once the coin is old enough for 24h volume to mean something.
    min24hVolumeUsd: 1000,
    // A holder wallet younger than this (full history fits one signature page) is flagged fresh
    freshWalletSeconds: 7 * 86400,
    // Fresh wallets whose first activity falls in the same bucket get clustered as "created together".
    // This is the FALLBACK smell only — used when a holder's funder can't be resolved. The primary
    // signal is the funding graph below: birth time can be staggered to evade, the purse cannot.
    bundleBucketSeconds: 3600,
    // Sybil bundle detection (the TURF pattern): fresh holders sharing one immediate funder wallet.
    // A cluster needs at least this many members to count — one funded wallet isn't a bundle.
    bundleMinCluster: 2,
    // Corroboration gate against the innocent-shared-funder false positive (a CEX hot wallet is the
    // first funder of thousands of unrelated people). A real Sybil fan-out seeds near-identical
    // amounts from a script; a CEX sends varied amounts. Accept a cluster only when the per-wallet
    // seed amounts are this uniform (coefficient of variation ≤ this) OR the funder is itself a
    // fresh burner (see bundleFunderBurnerSeconds). Ship corroboration-first; the CEX list is belt-and-braces.
    bundleUniformCv: 0.25,
    // A funder whose own full history fits one signature page and is this young is a throwaway
    // distributor, not an exchange — its own freshness corroborates the cluster.
    bundleFunderBurnerSeconds: 14 * 86400,
    // Fan-out probe: sample up to this many of the funder's transactions, STRIDED across its whole
    // life (not the most recent — a distributor's funding burst is early and recency bias would miss
    // it), to count distinct wallets seeded. Lifetime tx count and balance are free; this is the
    // refinement, and it only runs when a wallet has enough history to possibly be a farm.
    fanoutSampleTx: 40,
    // At or above this many distinct funded wallets, the purse is a farm faucet, not a person.
    farmRecipients: 20,
    // The decisive tell between a Sybil distributor and an exchange: a distributor sprays its SOL
    // and sits near-empty; an exchange hot wallet holds a fortune. A funder still holding more than
    // this many SOL is an exchange, never a bundle purse — reject the cluster even if it isn't yet
    // on the CEX list and even if the seed amounts looked uniform (round withdrawals coincide).
    exchangeFunderMinBalanceSol: 500,
    // The live exchange gate (sources/wallet-history.ts funderGate): an exchange must spray farm-scale
    // AND hold at least this much. Binance's hot wallet ~1.23M SOL; the $Brim insider purse ~4.7k SOL
    // while spraying 47 wallets. Fan-out without this balance is a faucet, not an exchange.
    exchangeBalanceSol: 50_000,
    // …or an around-the-clock one: a full 1,000-signature page inside this many hours. Measured 25 Sep
    // 2026: Relay solver 0.01h, Binance 0.9h, Coinbase 1/2 ~3.4h. An insider purse seeds and goes quiet.
    serviceSpanHours: 48,
    // ── Entry lens (sources/holder-entry.ts): when and how each top holder got the coin ──
    entryHolders: 20, // top holders whose entry we reconstruct (~2-3 calls each)
    entryLaunchWindowSeconds: 3600, // bought within this long of launch = launch-window cohort
    entrySniperSeconds: 120, // …within this long = sniper
    entryFreshSeconds: 2 * 86400, // wallet born this soon before its first acquisition = fresh at entry
    // A cohort (launch-window + fresh-at-entry, or routed in by token transfer) holding this much
    // supply turns the verdict to coordinated.
    entryCohortPct: 15,
    // Snipers (entrySniperSeconds) still holding this much supply = coordinated on its own.
    entrySniperHoldPct: 8,

    // ── Holder-behaviour sampling: "is this crowd organic, and by how much?" ──
    // Manufactured holders hide in the TAIL (each kept tiny to sink below top-N), so a top-10 look
    // misses them — we stratify: a few from the top, the rest drawn across the tail. Sequential:
    // sample round 1, and only widen to sampleMax when the split is borderline (buying precision,
    // not drama). Gated to unproven young coins with a real crowd — the only place it earns its cost.
    sampleMinHolders: 30, // below this the "crowd" question is moot; skip sampling
    sampleRound1: 12, // first-look sample size
    sampleMax: 28, // hard ceiling after escalation (protects the free-tier RPC budget)
    sampleTopStrata: 4, // how many of the sample come from the top holders vs the tail
    sampleRealTxCount: 50, // ≥ this many lifetime txns → a real trader, not inventory
    sampleThinTxCount: 15, // fresh AND under this many txns → manufactured-leaning
    // Escalate only when the 95% half-width is wider than this AND the estimate is near the line.
    sampleEscalateBand: 0.15,
  },

  // Price data
  maxPoolsPerToken: 2,
  // 1-minute candles around entry, 15-minute candles elsewhere
  fineWindowSeconds: 6 * 3600,
  // Wallet VWAP this many times off the market price means the price series doesn't match the trade
  maxEntryPriceMismatch: 20,
};

export type ScoringConfig = typeof SCORING;

/**
 * Population priors for the v3 trust model — measured, not chosen.
 *
 * `p`   the base rate across every scored call in the corpus: what a KOL-called coin does on
 *       average. Grading a caller against 0 instead of against p means grading the asset class.
 * `tau` the TRUE between-caller standard deviation once binomial noise is subtracted
 *       (observed variance − mean p(1−p)/n). This is how much callers genuinely differ.
 * `reliability` split-half correlation, Spearman-Brown corrected. THE gate on whether a metric
 *       is allowed into the score at all. Measured on wallets with ≥12 calls, same samples for
 *       every metric, so the differences between them are not a sample-size artifact.
 *
 * Reproduce every number here with `npm run calibrate`. They are frozen on purpose: a score
 * whose priors drift with the corpus is not a score. Calibrate reports the drift; bump the
 * version deliberately when the market has genuinely moved.
 *
 * Source: 733 wallets · 5,667 scored calls · 3,890 distinct coins · 2026-09-22.
 */
export const TRUST_PRIORS = {
  version: "trust-v3-fairwindow-2026-09",
  corpus: { wallets: 733, calls: 5667, coins: 3890, as_of: "2026-09-24" },

  /** The coin collapsed ≥80% from its 24h peak. Persistent trait — scored. */
  rug: { p: 0.251, tau: 0.083, reliability: 0.69 },
  /** The caller exited profitably into the collapse. Most persistent trait — scored heaviest. */
  dump: { p: 0.199, tau: 0.099, reliability: 0.67 },
  /**
   * A 2× was reachable within 24h. reliability 0.20 — this does NOT persist. Callers have
   * essentially no repeatable picking skill: sort them by last period's 2× rate and the top
   * third hits 26.1% next period against the bottom third's 22.0%, on a 25.6% base rate.
   * Kept as a DISPLAYED statistic with its reliability shown, and deliberately excluded from
   * the trust score — putting weight on it measurably widened nothing and diluted the signal.
   */
  win: { p: 0.256, tau: 0.075, reliability: 0.2 },

  /** Karma shape: dump squared (predatory, the cardinal sin), rug to the 1.5 (reckless/complicit). */
  weights: { dumpExp: 2, rugExp: 1.5 },
} as const;

export type TrustPrior = { p: number; tau: number; reliability: number };

export const GRADE_TITLES = {
  S: "Chad",
  A: "Solid",
  B: "Fair",
  C: "Coinflip",
  D: "Exit Liquidity",
  F: "Larper",
} as const;
