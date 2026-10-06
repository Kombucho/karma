/** Dump one cold coin scan to the terminal (verdict, clusters, entry lens) and $TMPDIR/scan-<symbol>.json. Usage: npx tsx scripts/dump-scan.ts <mint> */
import { MemoryCache } from "../src/lib/karma/cache";
import { scanCoin } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { excludedFunders, walletRegistry } from "../src/lib/karma/registry";
import { SolanaRpc } from "../src/lib/karma/sources/solana";
(async () => {
  const c = new MemoryCache(); const t = Date.now();
  const s = await scanCoin(SolanaRpc.fromEnv(c), process.argv[2], SCORING, Math.floor(Date.now() / 1000), c, walletRegistry(), excludedFunders());
  console.log(s.symbol, `${((Date.now() - t) / 1000).toFixed(0)}s`, "eligible", s.eligible, s.refusal_reasons, "age h", Math.round((s.age_seconds ?? 0) / 3600), "creator", s.creator);
  console.log("safety", s.token_safety?.severity, s.token_safety?.risks);
  console.log("clusters", s.holder_clusters.map((c) => [c.funder.slice(0, 6), c.member_count, c.pct_total.toFixed(1), c.funder_is_faucet]), "bundles", s.bundles.length);
  console.log("top", s.holders.slice(0, 25).map((h) => `${h.kind[0]}:${h.pct_supply.toFixed(2)}:${h.wallet_age_days === null ? "old" : h.wallet_age_days.toFixed(0) + "d"}`).join(" "));
  const en = s.holder_entry;
  if (en) { console.log("entry", JSON.stringify({ ...en, entries: undefined })); console.log(en.entries.map((e) => `${e.via[0]}${e.fresh_at_entry ? "*" : ""}:${e.pct_supply.toFixed(2)}:${e.after_launch_s === null ? "?" : Math.round(e.after_launch_s / 60) + "m"}${e.from ? "<" + e.from.slice(0, 4) : ""}`).join(" ")); }
  console.log("behavior", s.holder_behavior?.signal, "| market", s.market_structure?.severity, JSON.stringify(s.market_structure?.signals.map((x) => x.text)), "| fresh", s.fresh_flow?.severity, s.fresh_flow?.signal, "| sibling", s.sibling_overlap?.verdict, s.sibling_overlap?.signals[0]);
  console.log("sample", JSON.stringify(s.holder_sample && { ...s.holder_sample, members: undefined }));
  console.log("READ", s.summary?.readout.join(" | "));
  const fs = await import("node:fs"); fs.writeFileSync(`${process.env.TMPDIR ?? "/tmp"}/scan-${s.symbol}.json`, JSON.stringify(s, null, 1));
  process.exit(0);
})();
