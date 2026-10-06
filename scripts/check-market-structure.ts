/**
 * Run the market-structure read (LP pull risk, fake volume, even shares) on a set of coins and print
 * the numbers behind every signal. Usage: npx tsx scripts/check-market-structure.ts [mint ...]
 * With no args, runs the calibration set below plus the current top-3 GeckoTerminal trending coins (TRENDING=n for more).
 */
import { address, isOffCurveAddress } from "@solana/kit";
import { MemoryCache } from "../src/lib/karma/cache";
import { fetchJson } from "../src/lib/karma/http";
import { readMarketStructure } from "../src/lib/karma/sources/market-structure";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

const SET: [string, string][] = [
  ["pump grad (CACKLE)", "BQJfL1yiHbJQ8AciHLcKxaCbQrWP2ws8oZHHYgbBpump"],
  ["raydium launch (GO)", "D1YZZg9dBZ7AbfknZVbaeVLto36eySwoFYEVhZrD4F4n"],
  ["meteora launch (BP)", "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy"],
  ["KNOTS", "8RVBk8vxLiUHueLUW1f4izFVqN3nWippLhkohKg6EGkS"],
  ["GP", "HTmQz7My6MehV7bjhJ6jde8nDND1yvsz68d24LP7YgUQ"],
];

/** Top holders the way coin.ts sees them: DAS page 1, summed per owner, off-curve (program/PDA) owners dropped. */
async function topHolders(rpc: SolanaRpc, mint: string) {
  const [supply, das] = await Promise.all([
    rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint]),
    rpc.call<{ token_accounts?: { owner: string; amount: number | string }[] }>("getTokenAccounts", { mint, limit: 1000, page: 1 }),
  ]);
  const total = BigInt(supply.value.amount);
  const byOwner = new Map<string, bigint>();
  for (const a of das.token_accounts ?? []) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + BigInt(String(a.amount)));
  return [...byOwner]
    .filter(([o]) => !isOffCurveAddress(address(o)))
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, 50)
    .map(([wallet, amt]) => ({ wallet, pct_supply: total > 0n ? Number((amt * 1_000_000n) / total) / 10_000 : 0 }));
}

async function trending(n: number): Promise<[string, string][]> {
  const body = await fetchJson<{ data: { attributes: { name: string }; relationships: { base_token: { data: { id: string } } } }[] }>("https://api.geckoterminal.com/api/v2/networks/solana/trending_pools", {}, { retries: 3 });
  const out: [string, string][] = [];
  for (const p of body.data) {
    const mint = p.relationships.base_token.data.id.replace(/^solana_/, "");
    if (out.some(([, m]) => m === mint) || SET.some(([, m]) => m === mint)) continue;
    out.push([`trending ${p.attributes.name.split(" / ")[0]}`, mint]);
    if (out.length >= n) break;
  }
  return out;
}

(async () => {
  const cache = new MemoryCache();
  const rpc = SolanaRpc.fromEnv(cache);
  const coins: [string, string][] = process.argv.length > 2 ? process.argv.slice(2).map((m) => [m.slice(0, 6), m]) : [...SET, ...(await trending(Number(process.env.TRENDING ?? 3)))];
  const rows: string[] = [];
  for (const [label, mint] of coins) {
    const holders = await topHolders(rpc, mint).catch(() => []);
    const t = Date.now();
    const ms = await readMarketStructure(rpc, cache, mint, holders);
    const secs = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`\n━━ ${label}  ${mint}  (${secs}s, calls ${JSON.stringify(ms?.calls)})`);
    if (!ms) {
      console.log("  null");
      continue;
    }
    const { lp, volume: v, wash: w, even: e } = ms;
    if (lp) {
      console.log(`  LP: liq $${Math.round(lp.liquidity_usd).toLocaleString()} / mcap $${Math.round(lp.mcap_usd ?? 0).toLocaleString()} = ${((lp.liq_to_mcap ?? 0) * 100).toFixed(2)}%, pullable ${lp.pullable_share === null ? "?" : (lp.pullable_share * 100).toFixed(1) + "%"}`);
      for (const p of lp.pools)
        console.log(`    ${p.amm.padEnd(16)} ${p.quote.padEnd(6)} $${Math.round(p.liquidity_usd).toLocaleString().padStart(10)}  ${p.model.padEnd(8)} ${p.note}${p.holders.length ? "  [" + p.holders.map((h) => `${h.kind}${h.label ? ":" + h.label : ""} ${(h.share * 100).toFixed(1)}% ${h.owner.slice(0, 4)}`).join(", ") + "]" : ""}`);
    }
    if (v) console.log(`  VOL: 24h $${Math.round(v.volume_h24_usd).toLocaleString()}, ${v.txns_h24} txns (${v.buys_h24}b/${v.sells_h24}s), turnover ${v.turnover_h24?.toFixed(1)}×, avg trade $${v.avg_trade_usd?.toFixed(0)}, wash pools ${JSON.stringify(v.wash_pools.map((p) => `${p.dexId} $${Math.round(p.volume_h24_usd)} on $${Math.round(p.liquidity_usd)}`))}`);
    if (w) console.log(`  WASH: ${w.swaps} swaps / ${w.txs} txs over ${w.window_s}s, $${Math.round(w.volume_usd).toLocaleString()}, ${w.traders} traders, routed ${(w.routed_share * 100).toFixed(0)}%; same-tx ${(w.same_tx_share * 100).toFixed(1)}%, flips ${(w.quick_flip_share * 100).toFixed(1)}%, sandwich ${(w.sandwich_share * 100).toFixed(1)}%, wash ${(w.wash_share * 100).toFixed(1)}%, top-5 ${(w.top_traders_share * 100).toFixed(0)}%, micro ${(w.micro_share * 100).toFixed(0)}% median $${w.median_trade_usd?.toFixed(2)}${w.bump_size_usd ? " modal $" + w.bump_size_usd : ""}`);
    if (e) console.log(`  EVEN: n ${e.n}, cv ${e.cv?.toFixed(2)}, equal group ${e.group_size} (${e.group_pct.toFixed(1)}%) top: ${holders.slice(0, Number(process.env.SHOW ?? 8)).map((h) => h.pct_supply.toFixed(2)).join(" ")}`);
    console.log(`  => ${ms.severity.toUpperCase()}`);
    for (const s of ms.signals) console.log(`     [${s.severity}] ${s.text}`);
    const calls = ms.calls.dexscreener + ms.calls.rpc + ms.calls.enhanced;
    rows.push(`| ${label} | ${lp ? ((lp.liq_to_mcap ?? 0) * 100).toFixed(2) + "%" : "-"} | ${lp?.pullable_share === null || !lp ? "?" : (lp.pullable_share * 100).toFixed(0) + "%"} | ${v?.turnover_h24?.toFixed(1) ?? "-"}× | ${w ? `${(w.wash_share * 100).toFixed(0)}% (${w.swaps})` : "-"} | ${w ? (w.top_traders_share * 100).toFixed(0) + "%" : "-"} | ${w ? `${(w.micro_share * 100).toFixed(0)}% / $${w.median_trade_usd?.toFixed(1)}` : "-"} | ${e?.cv?.toFixed(2) ?? "-"} | ${ms.severity} | ${calls} | ${secs}s |`);
  }
  console.log("\n| coin | liq/mcap | pullable | turnover | wash (swaps) | top-5 | micro / median | even cv | severity | calls | time |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  process.exit(0);
})();
