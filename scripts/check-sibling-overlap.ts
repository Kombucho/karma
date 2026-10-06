/**
 * Run the sibling-overlap detector against stored scans (coin_scans), no RPC.
 *   npx tsx scripts/check-sibling-overlap.ts <mint> [<mint> ...]     one coin each, in detail
 *   npx tsx scripts/check-sibling-overlap.ts --all                    every stored Solana scan, one line each
 *   add --source=jsonb | --source=table to force a lookup path (default: table if it exists, else jsonb)
 */
import type { CoinScan } from "../src/lib/karma/engine/coin";
import { db, getStoredScan } from "../src/lib/karma/db";
import { readSiblingOverlap, type SiblingOverlap } from "../src/lib/karma/sources/sibling-overlap";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile(f); } catch {} }

const args = process.argv.slice(2);
const source = (args.find((a) => a.startsWith("--source="))?.split("=")[1] ?? "auto") as "auto" | "table" | "jsonb";
const all = args.includes("--all");
const mints = args.filter((a) => !a.startsWith("--"));

function detail(sym: string, r: SiblingOverlap) {
  console.log(`\n=== $${sym}  verdict ${r.verdict.toUpperCase()}  (${r.source}, ${r.ms}ms, corpus ${r.corpus}, checked ${r.checked}, ubiquity cutoff ${r.ubiquity_cutoff})`);
  console.log(`core wallets shared ${r.core_wallets} holding ${r.core_pct_here}% here, largest birth cohort ${r.cohort}`);
  for (const s of r.siblings)
    console.log(
      `  ${(s.symbol ?? s.mint.slice(0, 6)).padEnd(12)} shared ${s.shared} core ${s.core}  ${s.core_pct_here}% here / ${s.core_pct_there}% there  cohort ${s.cohort}` +
        `${s.same_creator ? "  SAME DEV" : ""}${s.same_launchpad ? `  same pad ${s.launchpad}` : ""}  launched ${s.launched_at ? new Date(s.launched_at * 1000).toISOString().slice(0, 10) : "?"}` +
        `\n      ${s.wallets.map((w) => `${w.wallet.slice(0, 6)}:${w.role[0]}:${w.pct_here}/${w.pct_there}:x${w.seen_in}`).join(" ")}`,
    );
  for (const x of r.signals) console.log(`  - ${x}`);
}

(async () => {
  const c = db();
  if (!c) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not set");
  const { count } = await c.from("coin_scans").select("mint", { count: "exact", head: true });
  console.log(`coin_scans rows: ${count}`);

  let targets = mints;
  if (all) {
    const { data } = await c.from("coin_scans").select("mint").order("updated_at", { ascending: true });
    targets = (data ?? []).map((r) => r.mint as string);
  }
  const times: number[] = [];
  const tally = { cabal: 0, linked: 0, none: 0, skipped: 0 };
  for (const mint of targets) {
    const stored = await getStoredScan<CoinScan>(mint);
    if (!stored) { console.log(`${mint}: not stored (run scripts/dump-scan.ts, then putStoredScan)`); continue; }
    const s = stored.scan;
    const t = Date.now();
    const r = await readSiblingOverlap(mint, s.holders ?? [], { creator: s.creator, checkedAt: s.checked_at, source });
    const wall = Date.now() - t;
    if (!r) {
      tally.skipped++;
      if (!all) console.log(`$${s.symbol}: no result (${s.chain ?? "?"} chain, ${s.holders?.length ?? 0} holders; with --source=table, is the migration applied?)`);
      continue;
    }
    times.push(wall);
    tally[r.verdict]++;
    if (all && mints.length === 0)
      console.log(
        `${(s.symbol ?? mint.slice(0, 6)).padEnd(12)} ${r.verdict.padEnd(6)} ${String(wall).padStart(4)}ms  core ${r.core_wallets} (${r.core_pct_here}%) cohort ${r.cohort}  ` +
          r.siblings.filter((x) => x.shared > 0 || x.same_creator).slice(0, 5).map((x) => `${x.symbol ?? x.mint.slice(0, 6)}:${x.core}/${x.shared}:${x.core_pct_here}%`).join(" "),
      );
    else detail(s.symbol ?? mint.slice(0, 6), r);
  }
  times.sort((a, b) => a - b);
  if (times.length) console.log(`\nverdicts ${JSON.stringify(tally)}  wall ms: median ${times[Math.floor(times.length / 2)]}, p90 ${times[Math.floor(times.length * 0.9)]}, max ${times.at(-1)}`);
  process.exit(0);
})();
