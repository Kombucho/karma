import { runQuant } from "@/lib/karma/quant/pipeline";

/**
 * The Jev quant loop's daily cron (07:30 UTC, after the 06:00 warm cron has stored fresh scans):
 * seed rubric → snapshot ~30 coins under live + shadow rubrics → measure elapsed outcomes → grade →
 * on Sundays (UTC) evolve a challenger rubric and replay it on held-out snapshots. Everything is in
 * src/lib/karma/quant/pipeline.ts; this handler only authenticates and returns the JSON summary.
 *
 * Secured by CRON_SECRET when set (Vercel sends it as a Bearer token). `?evolve=1` forces the evolve
 * step on a weekday (still subject to its data guard and once-a-week check), `?evolve=0` skips it.
 * Self-bounding: a wall-clock deadline ends every step before the 300s function limit.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const evolve = new URL(req.url).searchParams.get("evolve");
  const summary = await runQuant({ forceEvolve: evolve === "1", skipEvolve: evolve === "0" });
  return Response.json(summary);
}
