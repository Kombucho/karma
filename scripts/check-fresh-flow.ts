/* eslint-disable @typescript-eslint/no-explicit-any -- counts calls by monkeypatching rpc.call / enhancedTransactions */
/**
 * Run the live fresh-flow lens (sources/fresh-flow.ts) on a handful of coins and print what it sees,
 * with call counts and wall time. With no args it picks its own sample from GeckoTerminal: the busiest
 * pump.fun curves launched in the last 2 hours and the current trending pools. Extra mints can be passed
 * (e.g. a quiet older coin as a control).
 *
 * Usage: set -a; source .env.local; set +a; npx tsx scripts/check-fresh-flow.ts [--no-discover] [--new=3] [--trending=3] [mint ...]
 */
import { MemoryCache } from "../src/lib/karma/cache";
import { excludedFunders } from "../src/lib/karma/registry";
import { getTokenMeta } from "../src/lib/karma/sources/dexscreener";
import { readFreshFlow, type FreshFlow } from "../src/lib/karma/sources/fresh-flow";
import { pumpFunCoin, pumpFunCurveAddress } from "../src/lib/karma/sources/pumpfun";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

const GT = "https://api.geckoterminal.com/api/v2/networks/solana";

interface GtPool {
  attributes: { address: string; name: string; pool_created_at: string; volume_usd: { h1: string }; transactions: { h1: { buys: number } } };
  relationships: { dex: { data: { id: string } }; base_token: { data: { id: string } } };
}

async function gt(path: string): Promise<GtPool[]> {
  const r = await fetch(`${GT}/${path}`, { headers: { accept: "application/json" } }).catch(() => null);
  return r?.ok ? (((await r.json()) as { data: GtPool[] }).data ?? []) : [];
}

interface Target {
  mint: string;
  label: string;
  kind: string;
  onCurve?: boolean;
}

async function discover(nNew: number, nTrending: number): Promise<Target[]> {
  const out: Target[] = [];
  // Trending first: the new-pool paging below can exhaust GeckoTerminal's ~30/min keyless budget.
  const trending = nTrending > 0 ? (await gt("trending_pools?page=1")).slice(0, 8) : [];
  // new_pools is ~20 pools a page and pump.fun mints dozens a minute: read a few pages to reach coins old
  // enough (10 min – 2 h) to have an hour of trading worth reading.
  const pages: GtPool[] = [];
  for (let i = 1; i <= 10 && nNew > 0; i++) pages.push(...(await gt(`new_pools?page=${i}`)));
  const seen = new Set<string>();
  const fresh = pages
    .filter((p) => p.relationships.dex.data.id === "pump-fun")
    .filter((p) => {
      const age = Date.now() - Date.parse(p.attributes.pool_created_at);
      return age > 10 * 60_000 && age < 2 * 3600_000;
    })
    .filter((p) => !seen.has(p.relationships.base_token.data.id) && !!seen.add(p.relationships.base_token.data.id))
    .sort((a, b) => Number(b.attributes.volume_usd.h1) - Number(a.attributes.volume_usd.h1))
    .slice(0, nNew);
  for (const p of fresh)
    out.push({ mint: p.relationships.base_token.data.id.replace("solana_", ""), label: p.attributes.name, kind: "new pump curve", onCurve: true });
  for (const p of trending) {
    const mint = p.relationships.base_token.data.id.replace("solana_", "");
    if (out.some((t) => t.mint === mint)) continue;
    out.push({ mint, label: p.attributes.name, kind: `trending (${p.relationships.dex.data.id})`, onCurve: p.relationships.dex.data.id === "pump-fun" });
    if (out.filter((t) => t.kind.startsWith("trending")).length >= nTrending) break;
  }
  return out;
}

const cache = new MemoryCache();
const rpc = SolanaRpc.fromEnv(cache);
let rpcCalls = 0;
let enhCalls = 0;
const origCall = rpc.call.bind(rpc);
(rpc as any).call = (m: string, p: any) => {
  rpcCalls++;
  return origCall(m, p);
};
const origEnh = rpc.enhancedTransactions.bind(rpc);
(rpc as any).enhancedTransactions = (a: string, o: any) => {
  enhCalls++;
  return origEnh(a, o);
};

(async () => {
  const args = process.argv.slice(2);
  const extra: Target[] = args.filter((a) => !a.startsWith("--")).map((m) => ({ mint: m, label: "", kind: "given" }));
  const opt = (k: string, d: number) => Number(args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d);
  const targets = [...(args.includes("--no-discover") ? [] : await discover(opt("new", 3), opt("trending", 3))), ...extra];
  const excluded = excludedFunders();
  const rows: string[] = [];
  for (const t of targets) {
    const meta = await getTokenMeta(t.mint, cache).catch(() => null);
    const pump = await pumpFunCoin(t.mint, cache).catch(() => null);
    // A pump coin reads its curve AND any AMM pool: one that graduated inside the hour traded on both,
    // and a dead curve costs one call before the module drops it.
    const isPump = t.onCurve || !!pump || t.mint.endsWith("pump");
    const curve = isPump && !(pump?.complete && !t.onCurve) ? await pumpFunCurveAddress(t.mint) : null;
    const pools = (meta?.pools ?? []).filter((p) => p.dexId !== "pumpfun").sort((a, b) => b.liquidityUsd - a.liquidityUsd).map((p) => p.address);
    const label = t.label || meta?.symbol || t.mint.slice(0, 6);
    const [r0, e0, t0] = [rpcCalls, enhCalls, Date.now()];
    const ff: FreshFlow | null = await readFreshFlow(rpc, cache, t.mint, { pools, curve, excludedFunders: excluded });
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    const calls = `${enhCalls - e0} enh + ${rpcCalls - r0} rpc`;
    console.log(`\n=== ${label} (${t.kind}) ${t.mint}`);
    console.log(`    source: ${curve ? `curve ${curve}` : `pools ${pools.slice(0, 2).join(", ") || "-"}`}  |  ${calls}, ${wall}s`);
    if (!ff) {
      console.log("    no read (no trades in the last hour or no source)");
      rows.push(`| ${label} | ${t.kind} | - | - | - | - | - | - | - | none | ${calls} | ${wall}s |`);
      continue;
    }
    console.log(
      `    window ${ff.window_min} min${ff.truncated ? " (truncated)" : ""}, ${ff.txs_read} txs, ${ff.buys} buys / ${ff.sells} sells, ${ff.distinct_buyers} buyers, net ${ff.net_buy_sol} SOL`,
    );
    console.log(
      `    probed ${ff.probed}, fresh ${ff.fresh_count}: ${ff.fresh_net_sol} SOL (${(ff.fresh_share_of_buying * 100).toFixed(0)}% of net buying), ${ff.fresh_pct_supply ?? "?"}% supply, ${ff.fresh_service_funded} exchange/bridge-funded; burst ${ff.burst ? `${ff.burst.count} in ${ff.burst.seconds}s` : "-"}`,
    );
    for (const b of ff.fresh_buyers.slice(0, 5))
      console.log(
        `      fresh ${b.wallet} ${b.net_sol} SOL ${b.pct_supply ?? "?"}% txs=${b.tx_count} age=${b.born_t ? ((Date.now() / 1000 - b.born_t) / 3600).toFixed(1) + "h" : "?"} funder=${b.funder ?? "-"}`,
      );
    for (const f of ff.shared_funders) console.log(`      shared funder ${f.funder} x${f.members.length} ${f.net_sol} SOL ${f.service ? "(service)" : "(NOT a service)"}`);
    console.log(`    => ${ff.severity.toUpperCase()}: ${ff.signal ?? "-"}`);
    console.log(`    module calls: ${JSON.stringify(ff.calls)}`);
    rows.push(
      `| ${label} | ${t.kind} | ${ff.window_min}${ff.truncated ? "*" : ""} | ${ff.buys}/${ff.sells} | ${ff.net_buy_sol} | ${ff.fresh_count}/${ff.probed} | ${ff.fresh_net_sol} (${(ff.fresh_share_of_buying * 100).toFixed(0)}%) | ${ff.fresh_pct_supply ?? "?"}% | ${ff.burst?.count ?? 0} | ${ff.shared_funders.map((f) => `${f.members.length}${f.service ? "svc" : "!"}`).join(",") || "-"} | ${ff.severity} | ${calls} | ${wall}s |`,
    );
  }
  console.log("\n| coin | kind | window min | buys/sells | net SOL | fresh/probed | fresh SOL (share) | fresh % supply | burst | shared funders | severity | calls | wall |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  process.exit(0);
})();
