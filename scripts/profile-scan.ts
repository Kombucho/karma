/* eslint-disable @typescript-eslint/no-explicit-any -- a profiler monkeypatches fetch and rpc.call */
/**
 * Profile one cold coin scan: wall time, RPC calls by caller, 429s, and a 2-second throughput timeline.
 * Usage: set -a; source .env.local; set +a; npx tsx scripts/profile-scan.ts <mint>
 */
import { MemoryCache } from "../src/lib/karma/cache";
import { scanCoin } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { excludedFunders, walletRegistry } from "../src/lib/karma/registry";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

const mint = process.argv[2];
const cache = new MemoryCache();
const rpc = SolanaRpc.fromEnv(cache);
const t0 = Date.now();
const statuses: Record<string, number> = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, i: any) => { const ts = Date.now(); const r = await realFetch(u, i); if (!String(u).includes("mainnet.helius-rpc.com/?")) console.log(`  ext ${((ts-t0)/1000).toFixed(1)}s +${Date.now()-ts}ms ${r.status} ${String(u).replace(/api-key=[^&]+/,"").slice(0,90)}`); const host = String(u).includes("/v0/addresses") ? "enh" : String(u).includes("helius") ? "rpc" : "ext"; statuses[host + ":" + r.status] = (statuses[host + ":" + r.status] ?? 0) + 1; if (host==="rpc"||host==="enh") marks.push([Date.now()-t0, host+r.status]); return r; }) as any;
const marks: [number, string][] = [];
const byCaller = new Map<string, number>();
const orig = rpc.call.bind(rpc);
let n = 0, inflight = 0, maxInflight = 0;
(rpc as any).call = async (method: string, params: any) => {
  const stack = (new Error().stack ?? "").split("\n").slice(2).map((l) => l.trim().split(" ")[1]).filter((f) => f && !/^(SolanaRpc|Object|async|process|new)/.test(f) && !f.startsWith("file:"));
  const k = `${method} <- ${stack.slice(0, 2).join(" < ")}`;
  byCaller.set(k, (byCaller.get(k) ?? 0) + 1);
  n++; inflight++; maxInflight = Math.max(maxInflight, inflight);
  try { return await orig(method, params); } finally { inflight--; }
};
setInterval(() => console.error(`t=${((Date.now() - t0) / 1000).toFixed(0)}s calls=${n} inflight=${inflight}`), 5000).unref();
(async () => {
const scan = await scanCoin(rpc, mint, SCORING, Math.floor(Date.now() / 1000), cache, walletRegistry(), excludedFunders());
console.log(`\n${scan.symbol} total ${((Date.now() - t0) / 1000).toFixed(1)}s, ${n} rpc calls, max inflight ${maxInflight}, eligible=${scan.eligible}`);
console.log(`holders=${scan.holders.length} bundles=${scan.bundles.length} clusters=${scan.holder_clusters.length} sample=${scan.holder_sample?.sampled ?? "-"} dev=${!!scan.dev}`);
console.log(statuses);
const bins: Record<number, string[]> = {}; for (const [t, k] of marks) (bins[Math.floor(t/2000)] ??= []).push(k);
console.log(Object.entries(bins).map(([b, ks]) => `${Number(b)*2}s:${ks.length}${ks.some(k=>k.endsWith("429"))?"!"+ks.filter(k=>k.endsWith("429")).length:""}`).join(" "));
for (const c of scan.holder_clusters) console.log("cluster", c.funder, c.member_count, c.pct_total.toFixed(2)+"%", "bal", c.funder_balance_sol, "rcpt", c.funder_recipients, c.funder_is_faucet ? "FAUCET" : "");
for (const [k, v] of [...byCaller].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(4), k);
process.exit(0);
})();
