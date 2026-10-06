import type { KV } from "../cache";
import type { ScoringConfig } from "../scoring.config";
import type { SolanaRpc } from "./solana";
import { NON_WALLET_ACCOUNTS, funderGate, olderPage, sigPage, txBalances } from "./wallet-history";

/**
 * An insider cluster among a coin's holders: several holder wallets that all trace back to ONE
 * funding purse, REGARDLESS OF AGE. This is the "bubble map" read — one actor wearing many faces.
 *
 * The Sybil-bundle detector in coin.ts only clusters FRESH (<7d) wallets, so an operator who
 * pre-warms aged, active wallets (hundreds of lifetime txns each) slips through as "N real traders".
 * The fingerprint that doesn't wash off is the first-transaction funder: every wallet needs gas, and
 * an aged decoy was still seeded by its master's purse the day it was born. We resolve that funder for
 * every top holder, no matter how old, and cluster on it — then gate hard against exchanges (a CEX hot
 * wallet is the first funder of thousands of strangers), so we flag the purse, not Binance.
 */
export interface HolderCluster {
  /** The shared funding purse — the one wallet that seeded every member's first transaction. */
  funder: string;
  /** The holder wallets funded by this purse (≥2). */
  members: string[];
  member_count: number;
  /** Sum of the members' supply percentages — how much of the coin this one actor controls. */
  pct_total: number;
  /** The purse's current SOL balance. A real insider purse sits modest; a CEX holds a fortune. */
  funder_balance_sol: number | null;
  /** Distinct wallets the purse sent plain SOL to in the sampled window. */
  funder_recipients?: number;
  /** The purse sprays SOL farm-scale without exchange-scale reserves: a Sybil faucet. */
  funder_is_faucet?: boolean;
}

/**
 * The oldest signature we can reach for a wallet — its first tx when history fits the first page.
 * Age is irrelevant here: we WANT the funder of aged wallets, that's the whole point. For a busy
 * wallet we walk ONE more page (2,000 txns covers the $Brim decoys at 438/557 with room to spare);
 * beyond that the true birth is out of bounded reach and a guessed "funder" would be noise, so null.
 */
async function firstSignature(rpc: SolanaRpc, wallet: string, cache: KV): Promise<string | null> {
  const page = await sigPage(rpc, wallet, cache);
  if (page.count < 1000 || !page.oldest_sig) return page.oldest_sig;
  const older = await olderPage(rpc, wallet, page.oldest_sig, cache);
  if (!older || older.count === 0) return page.oldest_sig;
  return older.count < 1000 ? older.oldest_sig : null;
}

/**
 * Who seeded this wallet: the fee payer of its first transaction (the "Funded by" a block explorer
 * shows), or, if the wallet paid its own first fee, the account that lost the most SOL in that tx.
 * Resolved for wallets of ANY age. The first tx itself is shared with coin.ts's fresh-wallet funder
 * read (txBalances), so a holder costs one getTransaction however many lenses ask.
 */
async function clusterFunder(rpc: SolanaRpc, wallet: string, cache: KV): Promise<string | null> {
  const key = `clfunder:${wallet}`;
  const hit = await cache.get<{ funder: string | null }>(key);
  if (hit) return hit.funder;

  const sig = await firstSignature(rpc, wallet, cache);
  if (!sig) return null;
  const tx = await txBalances(rpc, sig, cache);
  if (!tx) return null; // transient miss — leave uncached so a later scan retries

  const wIdx = tx.keys.indexOf(wallet);
  let funder: string | null = null;
  if (wIdx >= 0) {
    // Fee payer funds the account in the normal case; if the wallet paid its own fee (it's keys[0]),
    // fall back to whichever OTHER account bled the most SOL — the true source of the seed transfer.
    funder = tx.keys[0] !== wallet ? tx.keys[0] : null;
    if (!funder) {
      let biggestOut = 0;
      let idx = -1;
      for (let i = 0; i < tx.keys.length; i++) {
        if (tx.keys[i] === wallet || NON_WALLET_ACCOUNTS.has(tx.keys[i])) continue;
        const out = tx.pre[i] - tx.post[i];
        if (out > biggestOut) { biggestOut = out; idx = i; }
      }
      funder = idx >= 0 ? tx.keys[idx] : null;
    }
    // A wallet that funds itself, or whose first counterparty is a bare program, is not a purse.
    if (funder && (funder === wallet || NON_WALLET_ACCOUNTS.has(funder))) funder = null;
  }
  await cache.set(key, { funder });
  return funder;
}

/**
 * The all-ages holder-relationship clustering: group the top holders by their shared first-funder and
 * surface every purse that seeded ≥2 of them, after dropping exchanges/infra. This is what catches an
 * operator running aged, active decoys — the case the fresh-only bundle detector misses.
 *
 * Bounded (top ~40 holders by supply), chunked RPC, cached per wallet forever. Never throws — returns
 * [] on any failure so it can never break a scan.
 */
export async function resolveHolderClusters(
  rpc: SolanaRpc,
  cache: KV,
  cfg: ScoringConfig,
  holders: { wallet: string; pct_supply: number }[],
  /** CEX/infra funders that never make a wallet suspect (seed/cex_funders.json + resolved pool PDAs). */
  excludedFunders: Set<string>,
): Promise<HolderCluster[]> {
  try {
    // Bound the cost: the biggest holders are where an insider's controlled supply concentrates.
    const pool = [...holders].sort((a, b) => b.pct_supply - a.pct_supply).slice(0, 40);
    const pctByWallet = new Map(pool.map((h) => [h.wallet, h.pct_supply]));

    // Resolve every holder's funder at once — the RPC's rate limiter paces the calls, so firing them
    // together keeps the pipe full instead of paying each call's round-trip in series.
    const funderOf = new Map<string, string | null>();
    const resolved = await Promise.all(
      pool.map((h) => clusterFunder(rpc, h.wallet, cache).then((f) => ({ wallet: h.wallet, funder: f })).catch(() => ({ wallet: h.wallet, funder: null }))),
    );
    for (const r of resolved) funderOf.set(r.wallet, r.funder);

    // Group holders by funder. A candidate cluster = a funder shared by ≥2 holders, not excluded, and
    // not itself one of the clustered holders (a holder that seeded its own siblings would still be
    // the operator, but the interesting purse is the external one — this also drops self-loops).
    const byFunder = new Map<string, string[]>();
    for (const [wallet, funder] of funderOf) {
      if (!funder || excludedFunders.has(funder)) continue;
      byFunder.set(funder, [...(byFunder.get(funder) ?? []), wallet]);
    }

    // The mandatory exchange gate, all candidate purses in parallel: without it, this flags every
    // wallet Binance ever funded.
    const candidates = [...byFunder].filter(([, members]) => members.length >= 2);
    const gates = await Promise.all(
      candidates.map(([funder]) =>
        funderGate(rpc, funder, cache, { farmRecipients: cfg.coin.farmRecipients, exchangeBalanceSol: cfg.coin.exchangeBalanceSol, fanoutSampleTx: cfg.coin.fanoutSampleTx, serviceSpanHours: cfg.coin.serviceSpanHours }).catch(() => null),
      ),
    );
    const clusters: HolderCluster[] = [];
    candidates.forEach(([funder, members], i) => {
      const gate = gates[i];
      if (gate?.exchange) return;
      clusters.push({
        funder,
        members,
        member_count: members.length,
        pct_total: members.reduce((s, w) => s + (pctByWallet.get(w) ?? 0), 0),
        funder_balance_sol: gate?.balance_sol ?? null,
        funder_recipients: gate?.recipients ?? 0,
        funder_is_faucet: gate?.faucet ?? false,
      });
    });

    clusters.sort((a, b) => b.pct_total - a.pct_total);
    return clusters;
  } catch {
    return [];
  }
}
