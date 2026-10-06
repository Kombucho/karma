/**
 * Throwaway: run the scanCoin holder-quality X-ray on specific mints passed as argv.
 *   npm exec tsx scripts/scan-mints.ts -- <mint> [<mint> ...]
 * Mirrors src/app/api/coin/[mint]/route.ts loadRegistry.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { scanCoin, type WalletRegistry } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) { try { process.loadEnvFile(f); } catch {} }

const ROOT = process.cwd();
const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

function loadRegistry(): WalletRegistry {
  const reg: WalletRegistry = new Map();
  try {
    const kols = JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8"));
    for (const k of kols)
      reg.set(k.wallet_address, { handle: k.handle ?? null, verified: !!k.verified, source_url: k.source_url ?? null, grade: null, title: null });
  } catch {}
  try {
    for (const f of readdirSync(path.join(ROOT, "validation"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(ROOT, "validation", f), "utf8"));
        const e = reg.get(r.wallet);
        if (e && r.score?.grade) { e.grade = r.score.grade; e.title = r.score.title ?? null; }
      } catch {}
    }
  } catch {}
  return reg;
}
const registry = loadRegistry();
const now = Math.floor(Date.now() / 1000);

async function main() {
  const mints = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  for (const mint of mints) {
    console.log(`\n════ ${mint} ════`);
    let scan;
    try { scan = await scanCoin(rpc, mint, SCORING, now, cache, registry); }
    catch (e) { console.log(`  scan error: ${(e as Error).message}`); continue; }
    console.log(`  ${scan.symbol ?? "?"} — ${scan.name ?? "?"}`);
    console.log(`  age: ${scan.age_seconds !== null ? (scan.age_seconds / 86400).toFixed(1) + "d" : "unknown"} · 24h vol: $${Math.round(scan.volume_24h_usd).toLocaleString()}`);
    if (!scan.eligible) { console.log(`  REFUSED: ${scan.refusal_reasons.join("; ")}`); continue; }
    const s = scan.summary!;
    console.log(`  top ${s.top_n} holders (infra excluded ${s.pct_infra_excluded.toFixed(1)}%):`);
    console.log(`    KOL ${s.pct_kol.toFixed(1)}% · D/F dumpers ${s.pct_bad_kol.toFixed(1)}% · fresh ${s.pct_fresh.toFixed(1)}% · bundled ${s.pct_bundled.toFixed(1)}% · unknown ${s.pct_unknown.toFixed(1)}%`);
    console.log(`  verdict: ${s.verdict}`);
    const graded = scan.holders.filter((h) => h.grade || h.handle);
    for (const h of graded)
      console.log(`    ${h.grade ?? "-"} @${h.handle ?? "?"} — ${h.pct_supply.toFixed(2)}%  ${h.wallet}`);
    const bundled = scan.holders.filter((h) => h.bundle_id !== null);
    if (bundled.length) console.log(`    ⚠ ${bundled.length} bundled fresh wallets: ${bundled.map((h) => h.pct_supply.toFixed(1) + "%").join(", ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
