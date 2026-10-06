import { BASE58_ADDRESS, getWalletReport, identityFor, resolveHandle } from "@/lib/karma/data";
import { GRADE_TITLES, TRUST_PRIORS } from "@/lib/karma/scoring.config";

/**
 * The public score endpoint. `GET /api/score/<wallet-or-@handle>`
 *
 * This is the surface Karma is actually differentiated on — an integrity read that any
 * terminal, bot or launchpad can call before putting a wallet in front of a user. It is
 * deliberately a thin, cacheable read over the scored corpus rather than a live chain scan:
 * the score is a 90-day behavioural measurement, so computing it per-request would be both
 * slow and wrong.
 *
 * The response always carries the market base rates and the model version alongside the score,
 * because a bare number is not interpretable — 0.43× only means something next to the 19.9%
 * it is 0.43 of. Consumers should render the band, not just the point estimate.
 */

const CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

export async function GET(_req: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet: raw } = await params;
  const input = decodeURIComponent(raw);

  // Accept @handle as well as an address, so the endpoint matches what people paste.
  const wallet = BASE58_ADDRESS.test(input) ? input : resolveHandle(input);
  if (!wallet) {
    return Response.json(
      { error: "not a Solana address, and no caller with that handle is in the index", input },
      { status: 400 },
    );
  }

  const report = getWalletReport(wallet);
  const identity = identityFor(wallet);
  const market = { dump: TRUST_PRIORS.dump.p, rug: TRUST_PRIORS.rug.p, two_x: TRUST_PRIORS.win.p };

  if (!report) {
    return Response.json(
      {
        wallet,
        handle: identity?.handle ?? null,
        scored: false,
        reason: "wallet is not in the scored corpus",
        market,
      },
      { status: 404, headers: { "cache-control": CACHE } },
    );
  }

  if (!report.trust) {
    // Scored the wallet, found nothing to grade. That is a real answer, not a failure — and it
    // is a different answer from "we never looked", so the two are never collapsed.
    return Response.json(
      {
        wallet,
        handle: report.handle ?? identity?.handle ?? null,
        scored: true,
        gradeable: false,
        reason:
          (report.scan?.callouts ?? 0) === 0
            ? "no public callouts found — this wallet does not appear to be a caller"
            : "too few settled calls to say anything",
        settled_calls: report.tokens.filter((t) => t.status === "scored").length,
        checked_at: report.computed_at,
        market,
      },
      { status: 200, headers: { "cache-control": CACHE } },
    );
  }

  const t = report.trust;
  return Response.json(
    {
      wallet,
      handle: report.handle ?? identity?.handle ?? null,
      source_url: identity?.source_url ?? null,
      scored: true,
      gradeable: true,

      karma: t.karma,
      karma_band: [t.karma_low, t.karma_high],
      grade: t.grade,
      title: GRADE_TITLES[t.grade],
      grade_floored: t.grade_floored,
      verdict: t.verdict,

      calls: t.n,
      confidence: t.confidence,
      /** 0–1: how much of the score is this caller's own record vs the population prior. */
      evidence_weight: t.evidence_weight,

      integrity: {
        dump_rate: t.dump_rate,
        dump_vs_market: t.dump_vs_market,
        rug_rate: t.rug_rate,
        rug_vs_market: t.rug_vs_market,
        observed: { dump_rate: t.dump_rate_observed, rug_rate: t.rug_rate_observed },
      },

      /** Reported, never scored — reliability 0.20 means it does not predict. See /methodology. */
      opportunity: t.opportunity,

      market,
      model: t.model,
      priors_version: t.priors_version,
      scored_at: t.as_of,
      disclaimer: "Summarises on-chain behaviour. Not financial advice, not an accusation of fraud.",
    },
    { headers: { "cache-control": CACHE } },
  );
}
