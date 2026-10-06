import { SCORING } from "../scoring.config";
import type { CoinHolder, CoinScan, EvmMarket } from "./coin";

/**
 * The coin page's one-glance verdict, as a pure function of the scan. The page renders it and the
 * quant features record it, so both must read the same word from the same scan: keep every threshold
 * here, never re-derive it at a call site.
 */
export type Verdict = "danger" | "coordinated" | "caution" | "clean";

type Summary = NonNullable<CoinScan["summary"]>;

/** The Solana verdict plus every intermediate flag the page builds its chips from. */
export function solanaVerdict(scan: CoinScan, s: Summary) {
  const kols = scan.holders.filter((h) => h.kind === "kol");
  const badKols = kols.filter((h) => (h.grade === "D" || h.grade === "F") && h.pct_supply >= 0.05);
  const bundles = new Map<number, CoinHolder[]>();
  for (const h of scan.holders) {
    if (h.bundle_id !== null) bundles.set(h.bundle_id, [...(bundles.get(h.bundle_id) ?? []), h]);
  }
  // A deployer farm hides in the long tail (pct_bundled stays 0), so it must drive the alarm on its own.
  const farm = !!scan.creator_fanout && scan.creator_fanout.distinct_recipients >= SCORING.coin.farmRecipients;
  const dev = scan.dev;
  const serialLauncher = !!dev && dev.launches !== null && dev.launches >= 3 && (dev.graduated ?? 0) === 0;
  const devBag = !!dev && dev.holds_pct >= 5;
  const clusters = scan.holder_clusters ?? [];
  const ts = scan.token_safety;
  const hs = scan.holder_sample;
  const clusterPct = clusters.reduce((x, c) => x + c.pct_total, 0);
  const connectedPct = clusterPct + s.pct_bundled;
  const crowdFake = !!hs && hs.sampled > 0 && hs.manufactured_pct >= 0.55;
  // The entry lens: snipers still holding, wallets born to buy, bags routed in. Same thresholds as the engine.
  const en = scan.holder_entry ?? null;
  const snipersHold = !!en && en.sniper_pct >= SCORING.coin.entrySniperHoldPct;
  const insiders = !!en && (en.cohort_pct >= SCORING.coin.entryCohortPct || snipersHold);
  // The four behaviour/market lenses, same red lines as the engine readout.
  const hb = scan.holder_behavior ?? null;
  const ecoRed = !!hb && hb.ecosystem_only.length >= 4 && hb.ecosystem_only_pct >= 10;
  const rewardRed = !!hb && hb.reward_only.length >= 2 && hb.reward_only_pct >= 5;
  const ecoAmber = !!hb && (hb.ecosystem_only.length >= 3 || hb.ecosystem_only_pct >= 3 || hb.reward_only.length > 0);
  const ms = scan.market_structure ?? null;
  const lpPull = !!ms?.lp && ms.lp.pullable_share !== null && ms.lp.pullable_share >= 0.5;
  const ff = scan.fresh_flow ?? null;
  const sib = scan.sibling_overlap ?? null;
  const lensRed = ecoRed || rewardRed || ms?.severity === "danger" || ff?.severity === "alert" || sib?.verdict === "cabal";
  const lensAmber = ecoAmber || ms?.severity === "caution" || ff?.severity === "warn" || sib?.verdict === "linked";

  const verdict: Verdict =
    ts?.severity === "danger" || lpPull
      ? "danger"
      : clusters.length || bundles.size || farm || serialLauncher || insiders || lensRed
        ? "coordinated"
        : lensAmber || ts?.severity === "caution" || badKols.length || devBag || crowdFake || s.top10_pct > 60 || s.pct_fresh > 10
          ? "caution"
          : "clean";

  return {
    verdict, kols, badKols, bundles, farm, dev, serialLauncher, devBag, clusters, ts, hs, clusterPct, connectedPct,
    crowdFake, en, snipersHold, insiders, hb, ecoRed, rewardRed, ecoAmber, ms, lpPull, ff, sib, lensRed, lensAmber,
  };
}

/** The EVM verdict: no holder index off Solana, so it's the dev-and-market read. */
export function evmVerdict(scan: CoinScan, s: Summary, market: EvmMarket) {
  const dev = scan.dev;
  const bag = !!dev && dev.holds_pct >= 5;
  const flagged = !!market.security_verdict && market.security_verdict !== "allow";
  const dd = market.drawdown_from_ath;
  const thin = market.liquidity_usd != null && market.liquidity_usd < 5000;
  const roundTrip = dd != null && dd >= 0.85;
  const verdict: Verdict = flagged ? "danger" : bag || roundTrip || thin || s.top10_pct > 70 ? "caution" : "clean";
  return { verdict, dev, bag, flagged, dd, thin, roundTrip };
}

/** The verdict the page shows for this scan, or null when the page shows none (ineligible / no summary). */
export function coinVerdict(scan: CoinScan): Verdict | null {
  if (!scan.eligible || !scan.summary) return null;
  if (scan.chain === "evm" && scan.market) return evmVerdict(scan, scan.summary, scan.market).verdict;
  return solanaVerdict(scan, scan.summary).verdict;
}
