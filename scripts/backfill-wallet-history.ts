/**
 * Seed wallet history (scan_runs + wallet_sightings) from the scans already in coin_scans, so a wallet's
 * record isn't empty on day one. Idempotent enough: recordScanRun skips a coin already recorded within
 * the hour of that scan. Needs db/schema.sql run first.
 *   npx tsx --env-file=.env.local scripts/backfill-wallet-history.ts [--dry]
 */
import { db } from "../src/lib/karma/db";
import type { CoinScan } from "../src/lib/karma/engine/coin";
import { recordScanRun, sightingsFromScan } from "../src/lib/karma/history";

(async () => {
  const dry = process.argv.includes("--dry");
  const c = db();
  if (!c) throw new Error("no SUPABASE_* env");
  const { data, error } = await c.from("coin_scans").select("mint, scan, updated_at").eq("eligible", true);
  if (error) throw error;
  let runs = 0;
  let sightings = 0;
  const roleTotals: Record<string, number> = {};
  for (const row of data ?? []) {
    const scan = row.scan as CoinScan;
    const s = sightingsFromScan(scan);
    sightings += s.length;
    for (const x of s) for (const r of x.roles) roleTotals[r] = (roleTotals[r] ?? 0) + 1;
    if (!dry) {
      const id = await recordScanRun(scan, "backfill", Math.floor(new Date(row.updated_at as string).getTime() / 1000));
      if (id) runs++;
    }
  }
  console.log(`${data?.length ?? 0} stored scans → ${dry ? "(dry) " : ""}${runs} runs recorded, ${sightings} sightings`);
  console.log("roles:", roleTotals);
  process.exit(0);
})();
