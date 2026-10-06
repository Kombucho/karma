/**
 * Run the behavior lens (sources/holder-behavior.ts) on one or more mints and print what it saw.
 * Usage: npx tsx scripts/check-holder-behavior.ts <mint> [<mint>…]   (needs HELIUS_API_KEY)
 *
 * Top holders come from Helius DAS getTokenAccounts, summed by owner. DAS is UNSORTED, so page 1 alone
 * misses the real top of a big book (KNOTS, 16k owners: page 1's biggest wallet held 1.4%, the true top
 * holds 4.2%) — we walk pages until the book ends (cap 20) and merge getTokenLargestAccounts as a floor.
 * Off-curve owners (pools, vaults, curve PDAs) are skipped: they aren't wallets with a trade tape.
 */
import { address, isOffCurveAddress } from "@solana/kit";
import { MemoryCache } from "../src/lib/karma/cache";
import { INFRA_OWNERS } from "../src/lib/karma/constants";
import { readHolderBehavior } from "../src/lib/karma/sources/holder-behavior";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

const MAX_PAGES = 20;

const onCurve = (a: string) => {
  try {
    return !isOffCurveAddress(address(a));
  } catch {
    return false;
  }
};

async function topHolders(rpc: SolanaRpc, mint: string, n: number) {
  const byOwner = new Map<string, bigint>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await rpc.call<{ token_accounts: { owner: string; amount: number | string }[] }>("getTokenAccounts", { mint, limit: 1000, page });
    for (const a of r.token_accounts) byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + BigInt(a.amount));
    if (r.token_accounts.length < 1000) break;
  }
  const [supply, largest] = await Promise.all([
    rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint]),
    rpc.call<{ value: { address: string; amount: string }[] }>("getTokenLargestAccounts", [mint]).catch(() => ({ value: [] })),
  ]);
  if (largest.value.length) {
    const infos = await rpc.call<{ value: ({ data: { parsed?: { info?: { owner?: string } } } } | null)[] }>("getMultipleAccounts", [
      largest.value.map((l) => l.address),
      { encoding: "jsonParsed" },
    ]);
    largest.value.forEach((l, i) => {
      const owner = infos.value[i]?.data.parsed?.info?.owner;
      if (owner && !byOwner.has(owner)) byOwner.set(owner, BigInt(l.amount));
    });
  }
  const total = BigInt(supply.value.amount);
  return {
    owners: byOwner.size,
    holders: [...byOwner]
      .filter(([o]) => onCurve(o) && !INFRA_OWNERS.has(o))
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .slice(0, n)
      .map(([wallet, amt]) => ({ wallet, pct_supply: Number((amt * 1_000_000n) / total) / 10_000 })),
  };
}

(async () => {
  const mints = process.argv.slice(2);
  if (!mints.length) throw new Error("usage: check-holder-behavior.ts <mint> [<mint>…]");
  for (const mint of mints) {
    // Fresh cache per mint: every run is a cold scan, so the call counts are honest.
    const cache = new MemoryCache();
    const rpc = SolanaRpc.fromEnv(cache);
    const { owners, holders } = await topHolders(rpc, mint, 15);

    // Count what the lens itself spends, independent of its own counter.
    let rpcCalls = 0;
    let enhanced = 0;
    const call = rpc.call.bind(rpc);
    const enh = rpc.enhancedTransactions.bind(rpc);
    rpc.call = ((m: string, p: unknown[] | Record<string, unknown>) => (rpcCalls++, call(m, p))) as typeof rpc.call;
    rpc.enhancedTransactions = ((a: string, o?: { before?: string; limit?: number }) => (enhanced++, enh(a, o))) as typeof rpc.enhancedTransactions;

    const t0 = Date.now();
    const r = await readHolderBehavior(rpc, cache, mint, holders);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== ${mint}  (${owners} owners; top-15 wallets hold ${holders.reduce((s, h) => s + h.pct_supply, 0).toFixed(1)}%)`);
    console.log(`calls: ${enhanced} enhanced + ${rpcCalls} rpc = ${enhanced + rpcCalls} (lens says ${r?.calls})  wall ${secs}s`);
    if (!r) {
      console.log("null");
      continue;
    }
    console.log("family", JSON.stringify(r.family.keys), "quotes", r.family.quotes.map((q) => q.slice(0, 6)), "symbols", r.family.symbols.join(","), `(${r.family.mints.length} family coins traded)`);
    console.log(`ecosystem-only: ${r.ecosystem_only.length} wallets, ${r.ecosystem_only_pct}%   reward coin: ${r.reward_coin}  reward-only: ${r.reward_only.length} wallets, ${r.reward_only_pct}%`);
    for (const d of r.distributors.slice(0, 5))
      console.log(`  payer ${d.address.slice(0, 8)} authority=${d.is_coin_authority} holders=${d.holders_paid} payouts=${d.payouts_seen} maxBatch=${d.max_batch} assets=${d.assets.map((a) => a.slice(-6)).join(",")}`);
    console.log("  wallet    pct   txs trades mints fam share sold bought moved pay rSale oSale  flags");
    for (const w of r.wallets)
      console.log(
        `  ${w.wallet.slice(0, 8)} ${w.pct_supply.toFixed(2).padStart(5)} ${String(w.txs).padStart(4)} ${String(w.trades).padStart(6)} ${String(w.traded_mints).padStart(5)} ${String(w.family_mints).padStart(3)} ${w.family_share.toFixed(2).padStart(5)} ${String(w.sold_coin).padStart(4)} ${String(w.bought_coin).padStart(6)} ${String(w.moved_coin_out).padStart(5)} ${String(w.payouts).padStart(3)} ${String(w.reward_sales).padStart(5)} ${String(w.other_sales).padStart(5)}  ${w.ecosystem_only ? `ECO(${w.ecosystem_path}) ` : ""}${w.reward_only ? "REWARD" : ""}`,
      );
    console.log("SIGNAL:", r.signal);
  }
  process.exit(0);
})();
