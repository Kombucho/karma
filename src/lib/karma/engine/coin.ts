import type { KV } from "../cache";
import { lowPriority } from "../http";
import { INFRA_OWNERS } from "../constants";
import type { ScoringConfig } from "../scoring.config";
import { getTokenMeta } from "../sources/dexscreener";
import { pumpFunCoin, pumpFunCurveAddress, pumpFunDevStats, pumpFunEvmCoin } from "../sources/pumpfun";
import { findEvmChain, findEvmCoin, type EvmCoinRecord, type EvmCoinSource } from "../sources/evm-lookup";
import { blockscoutHolders, evmBalanceOf, evmChain, evmChains, evmTotalSupply, evmWallet, reconstructHolders, type EvmHolderBook } from "../sources/evm";
import { tokenSafety, type TokenSafety } from "../sources/token-safety";
import { resolveHolderClusters, type HolderCluster } from "../sources/holder-clusters";
import { readHolderEntries, type EntryRead } from "../sources/holder-entry";
import { readHolderBehavior, type HolderBehavior } from "../sources/holder-behavior";
import { readMarketStructure, type MarketStructure } from "../sources/market-structure";
import { readFreshFlow, type FreshFlow } from "../sources/fresh-flow";
import { readSiblingOverlap, type SiblingOverlap } from "../sources/sibling-overlap";
import type { SolanaRpc } from "../sources/solana";
import { funderGate, sigPage, txBalances, type FunderGate } from "../sources/wallet-history";
import type { Grade } from "../types";

/** What we know about a wallet before ever scanning it: seed identity + any cached score. */
export interface KnownWallet {
  handle: string | null;
  verified: boolean;
  source_url: string | null;
  grade: Grade | null;
  title: string | null;
}
export type WalletRegistry = Map<string, KnownWallet>;

export type HolderKind = "lp_or_infra" | "bonding_curve" | "kol" | "fresh" | "wallet";

export interface CoinHolder {
  wallet: string;
  pct_supply: number;
  kind: HolderKind;
  /** Set when the wallet is in the KOL registry. */
  handle: string | null;
  verified: boolean;
  source_url: string | null;
  grade: Grade | null;
  title: string | null;
  /** Days since first on-chain activity. Null = history deeper than one signature page (an old wallet). */
  wallet_age_days: number | null;
  /** The wallet that seeded this one (funded its first transaction). Null when old or unresolved. */
  funder: string | null;
  /** SOL this wallet received in that seeding transaction — the "fan-out amount". */
  funded_sol: number | null;
  /** Fresh wallets sharing one immediate funder share an id — a coordinated Sybil bundle. */
  bundle_id: number | null;
}

/** A resolved Sybil bundle: the shared purse and why we believe it's coordinated, not coincidence. */
export interface CoinBundle {
  id: number;
  funder: string;
  /** True when the per-wallet seed amounts are near-identical — a scripted fan-out, not organic. */
  uniform_funding: boolean;
  /** True when the funder is itself a fresh throwaway distributor, not an aged exchange wallet. */
  funder_is_burner: boolean;
  /** How hard the purse has been spraying — the "is this guy funding 100 wallets" read. Null when unprobed. */
  fanout: FunderFanout | null;
  /** The funding tree: origin → purse → members, with timestamps and each member's recent activity. */
  tree: BundleTree | null;
}

export interface BundleMemberNode {
  wallet: string;
  pct_supply: number;
  /** SOL the purse seeded into this wallet. */
  funded_sol: number | null;
  /** First on-chain activity (unix seconds), the wallet's birth. Null if history is deeper than one page. */
  first_seen: number | null;
}

/** The funding tree behind a bundle: who seeded the purse, the purse, and the wallets it seeded. */
export interface BundleTree {
  /** The purse's own funder — the origin one hop up. Null when its history is too deep to trace in a page. */
  root: string | null;
  funder: string;
  funder_first_seen: number | null;
  members: BundleMemberNode[];
}

/** The reach of a funding purse: how many wallets it feeds, how much it has dispensed, how fast. */
export interface FunderFanout {
  /** Lifetime transaction count (free, from one signature page). Capped marker at 1000. */
  total_txs: number;
  total_txs_capped: boolean;
  /** Distinct wallets seeded, counted across `sampled_txs` of the funder's most recent transactions. */
  distinct_recipients: number;
  sampled_txs: number;
  /** SOL sent out across the sampled transactions. */
  dispensed_sol: number;
  /** Funder's current SOL balance — a near-empty distributor that has sprayed dozens of wallets is the tell. */
  balance_sol: number | null;
  /** Minutes spanned by the sampled transfers — a tight window is automation. */
  window_min: number | null;
  /** Up to 100 of the distinct wallets seeded — the actual farm members, for the cluster registry. */
  recipients_sample: string[];
}

/**
 * The dev, read the way a trader reads it: not "who deployed this" but "should I trust them with my
 * money". The graveyard (launches vs graduated) is the decisive number; the bag they still hold and
 * the wallets they've seeded are the two ways they take yours.
 */
export interface DevProfile {
  wallet: string;
  /** Dev's current holding of THIS coin, as a % of supply. 0 = holds nothing (never bought, or sold). */
  holds_pct: number;
  /** Dev wallet age in days, or null if its history is deeper than one signature page (an aged wallet). */
  age_days: number | null;
  /** Coins this dev has ever launched on pump.fun (null off pump.fun / on error). */
  launches: number | null;
  /** True when the launch count hit the fetch cap — the real number is at least `launches`. */
  launches_capped: boolean;
  /** How many of those graduated the bonding curve. Zero across many launches is the serial-rugger tell. */
  graduated: number | null;
  /** How many of those still carry a non-trivial market cap right now. */
  alive: number | null;
  /** The dev's own seeding reach — a farm faucet hiding a manufactured holder base in the long tail. */
  fanout: FunderFanout | null;
  /** EVM only: the dev wallet's lifetime transaction count (nonce) — a rough alive/active read. */
  tx_count?: number | null;
  /** EVM only: the dev's native-token (BNB/ETH) balance. */
  native_balance?: number | null;
  /** EVM only: symbol for that native balance. */
  native_symbol?: string | null;
}

/** The market read for an EVM coin — what pump.fun and the chain tell us without a holder index. */
export interface EvmMarket {
  chain_key: string;
  chain_label: string;
  native_symbol: string;
  protocol: string | null;
  mcap_usd: number | null;
  ath_mcap_usd: number | null;
  /** Fraction down from the all-time-high market cap, 0–1. The round-trip tell. */
  drawdown_from_ath: number | null;
  liquidity_usd: number | null;
  /** pump.fun's own token-trust verdict + one-word reason. */
  security_verdict: string | null;
  security_reason: string | null;
  pool_address: string | null;
  chart_url: string | null;
  /** The token's page on the chain explorer. */
  explorer_url: string;
  /** The explorer's base URL, for linking dev/holder accounts. */
  explorer_base: string;
  /** Where the coin's facts came from. Absent on scans cached before non-pump coins were read (= pump.fun). */
  source?: EvmCoinSource;
}

/** One sampled holder, read as a receipt: what their own on-chain life says about whether they're real. */
export interface HolderSampleMember {
  wallet: string;
  handle: string | null;
  grade: Grade | null;
  /** Lifetime transaction count (capped at one signature page). */
  tx_count: number;
  tx_capped: boolean;
  /** Days since first activity, or null if history is deeper than one page (an aged wallet). */
  age_days: number | null;
  /** From which stratum of the book this holder was drawn. */
  stratum: "top" | "tail";
  verdict: "known" | "real" | "fresh" | "farmed";
}

/**
 * The organic-vs-manufactured read on the holder crowd, from a stratified sample. The point is the
 * fraction and its honesty band, not a single wallet — "68% manufactured ±10 across 28 of 214",
 * with the receipts that got us there. Manufactured holders hide in the tail, so the sample reaches
 * past the top-N deliberately.
 */
export interface HolderSample {
  sampled: number;
  population: number;
  known: number;
  real: number;
  fresh: number;
  farmed: number;
  /** Distinct funding purses shared by ≥2 sampled holders — the coordination fingerprint. */
  shared_funders: number;
  /** (fresh + farmed) / sampled: the share of the crowd that looks manufactured. */
  manufactured_pct: number;
  /** 95% half-width of that estimate, finite-population corrected. Small = trust the number. */
  band: number;
  /** True when we widened past round 1 because the first look was borderline. */
  escalated: boolean;
  /** The receipts, capped for display. */
  members: HolderSampleMember[];
}

export interface CoinScan {
  mint: string;
  /** Which chain the mint lives on — decides the whole scan shape. */
  chain: "solana" | "evm";
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  checked_at: number;
  eligible: boolean;
  /** Why the scan was refused (empty when eligible). */
  refusal_reasons: string[];
  /** True for coins under an hour old: the holder book is still forming, read the scan as a snapshot. */
  provisional: boolean;
  /** Set by the layered cron when the scan's time budget ran out mid-read: stored so the next pass knows to
   * finish it, never served (every reader treats a partial scan as no scan). */
  partial?: boolean;
  age_seconds: number | null;
  volume_24h_usd: number;
  holders: CoinHolder[];
  /** Coordinated Sybil clusters found among the fresh holders (one shared funder each). */
  bundles: CoinBundle[];
  /** The deployer wallet (pump.fun mints only). */
  creator: string | null;
  /** The deployer's own reach: a dev that has seeded 100+ wallets is running a holder farm the
   * top-N holder lens can't see, because each manufactured holder is deliberately tiny. */
  creator_fanout: FunderFanout | null;
  /** The dev, profiled: launch record, the bag they hold, the wallets they seed. */
  dev: DevProfile | null;
  /** EVM only: the market read that stands in for the holder book we can't index for free off-Solana. */
  market: EvmMarket | null;
  /** EVM only: the holder book reconstructed from Transfer logs — concentration + acquisition signals. */
  evm_holder_book: EvmHolderBook | null;
  /** GeckoTerminal network + token mint for the chart-health read (pool resolved lazily client-side). */
  chart_ref: { network: string; mint: string } | null;
  /** The stratified organic-vs-manufactured read, run only on unproven young coins with a real crowd. */
  holder_sample: HolderSample | null;
  /** RugCheck-style token program + authority + Token-2022 extension check (honeypot/rug vectors). */
  token_safety: TokenSafety | null;
  /** Wallets that are secretly one actor: holders sharing a funding purse, any age. The bubble-map read. */
  holder_clusters: HolderCluster[];
  /** When and how each top holder got the coin: launch-window snipers, wallets born to buy, bags routed in by transfer. */
  holder_entry?: EntryRead | null;
  /** Top holders that trade only this coin's launch family, or never sell it and only cash out its rewards. */
  holder_behavior?: HolderBehavior | null;
  /** LP pull risk, wash/bump volume, equal-sized bags. */
  market_structure?: MarketStructure | null;
  /** Live warning: fresh wallets net-buying in the last hour. */
  fresh_flow?: FreshFlow | null;
  /** The same wallets across other coins we've scanned: a cabal rotating one wallet set. */
  sibling_overlap?: SiblingOverlap | null;
  summary: {
    top_n: number;
    /** Supply percentages over the analyzed top holders. */
    pct_kol: number;
    pct_bad_kol: number; // D/F graded
    pct_fresh: number;
    pct_bundled: number;
    pct_unknown: number;
    pct_infra_excluded: number;
    /** Holder concentration — the physiognomy of the book. Shares of the top real (non-infra) holders. */
    top1_pct: number;
    top5_pct: number;
    top10_pct: number;
    /** Distinct holder wallets seen on-chain (approximate on very large books). */
    holder_count: number;
    /** The individual findings, one per bullet. */
    signals: string[];
    /** The findings joined into one line — kept for meta/OG/API where a string is needed. */
    verdict: string;
    /** A 3-line synthesis: what it is, what's real, what to do. Rule-based, not an LLM. */
    readout: string[];
  } | null;
}

interface RawHolder {
  owner: string;
  amountRaw: bigint;
  /** The owner's largest token account for this mint — where its entry history lives. */
  account: string | null;
}

/**
 * Top token holders resolved to owner wallets, summed per owner and sorted by amount.
 *
 * Helius DAS `getTokenAccounts` enumerates every holder but is UNSORTED and needs object
 * params ({mint,limit,page}); passing an array errors "invalid type: map". We fetch up to
 * `maxPages` pages in parallel and sort client-side. If the coin is bigger than the cap (an unexhausted
 * enumeration), the client-sorted top could miss a whale outside our sample, so we merge in
 * getTokenLargestAccounts (the guaranteed true top 20 by amount). No DAS (older RPCs) → top 20 only.
 */
async function fetchHolders(rpc: SolanaRpc, mint: string, maxPages = 5): Promise<{ holders: RawHolder[]; supplyRaw: bigint }> {
  // Supply and every DAS page at once: Helius accepts page numbers as well as cursors, so the pages
  // needn't wait on each other (measured 1.5s vs 3.9s for 5 pages). An empty page past the end is cheap.
  const [supplyRes, pages] = await Promise.all([
    rpc.call<{ value: { amount: string } }>("getTokenSupply", [mint]),
    Promise.all(
      Array.from({ length: maxPages }, (_, i) =>
        rpc
          .call<{ token_accounts?: Array<{ address: string; owner: string; amount: number | string }> }>("getTokenAccounts", { mint, limit: 1000, page: i + 1 })
          .catch(() => null),
      ),
    ),
  ]);
  const supplyRaw = BigInt(supplyRes.value.amount);

  const byOwner = new Map<string, bigint>();
  const accountOf = new Map<string, { address: string; amount: bigint }>();
  // DAS unsupported on this endpoint (every page failed) → fall back entirely to largest-accounts.
  const dasOk = pages[0] !== null;
  let exhausted = false;
  for (const das of pages) {
    const accts = das?.token_accounts ?? [];
    for (const a of accts) {
      const amt = BigInt(String(a.amount));
      byOwner.set(a.owner, (byOwner.get(a.owner) ?? 0n) + amt);
      if (!accountOf.has(a.owner) || amt > accountOf.get(a.owner)!.amount) accountOf.set(a.owner, { address: a.address, amount: amt });
    }
    if (das && accts.length < 1000) { exhausted = true; break; }
  }

  // Guarantee the true top holders are present when DAS is absent or its enumeration was capped.
  if (!dasOk || !exhausted) {
    try {
      const largest = await rpc.call<{ value: Array<{ address: string; amount: string }> }>("getTokenLargestAccounts", [mint]);
      const accounts = largest.value.map((v) => v.address);
      const infos = await rpc.call<{ value: Array<{ data: { parsed?: { info?: { owner?: string } } } } | null> }>(
        "getMultipleAccounts",
        [accounts, { encoding: "jsonParsed" }],
      );
      infos.value.forEach((info, i) => {
        const owner = info?.data?.parsed?.info?.owner;
        // Keep the DAS-summed value when we already have the owner; only fill genuinely-missing whales.
        if (owner && !byOwner.has(owner)) {
          byOwner.set(owner, BigInt(largest.value[i].amount));
          accountOf.set(owner, { address: accounts[i], amount: BigInt(largest.value[i].amount) });
        }
      });
    } catch {
      // both paths failed — return whatever we have (possibly empty)
    }
  }

  return {
    holders: [...byOwner.entries()].map(([owner, amountRaw]) => ({ owner, amountRaw, account: accountOf.get(owner)?.address ?? null })).sort((a, b) => (b.amountRaw > a.amountRaw ? 1 : -1)),
    supplyRaw,
  };
}

/**
 * A wallet's origin: when it first acted and the signature of that first transaction.
 * If the full history overflows one signature page the wallet is old — first-seen is unknowable
 * from one page and its true funder is buried, so both are null. Immutable, cached forever.
 */
async function walletOrigin(rpc: SolanaRpc, wallet: string, cache: KV): Promise<{ t: number | null; sig: string | null }> {
  const key = `origin:${wallet}`;
  const hit = await cache.get<{ t: number | null; sig: string | null }>(key);
  if (hit) return hit;

  const page = await sigPage(rpc, wallet, cache);
  const full = page.count >= 1000;
  const origin = { t: full ? null : page.oldest_t, sig: full ? null : page.oldest_sig };
  await cache.set(key, origin);
  return origin;
}

/** Days since first activity if the full history fits one signature page, else null ("old wallet"). */
async function walletAgeDays(rpc: SolanaRpc, wallet: string, now: number, cache: KV): Promise<number | null> {
  const { t } = await walletOrigin(rpc, wallet, cache);
  return t === null ? null : (now - t) / 86400;
}

/**
 * Who seeded this wallet: the counterparty of its very first transaction. A Sybil can fake wallet
 * age (pre-warm wallets) and vary its buys, but every wallet needs gas, and the gas traces back to
 * one purse. That convergence is the fingerprint that doesn't wash off.
 *
 * The funder is the first transaction's fee payer (accountKeys[0]) — the "Funded by" a block
 * explorer shows — unless the wallet paid its own first fee, in which case it's the account that
 * lost the most SOL in that transaction. `funded_sol` is what this wallet received: the fan-out
 * amount whose uniformity across a cluster tells a script from a crowd.
 *
 * Costs nothing beyond the origin page already fetched for age, plus one getTransaction, cached
 * forever (a first funder never changes). Only resolve this for fresh wallets — old ones aren't Sybils.
 */
async function walletFunder(rpc: SolanaRpc, wallet: string, cache: KV): Promise<{ funder: string | null; funded_sol: number }> {
  const key = `funder:${wallet}`;
  const hit = await cache.get<{ funder: string | null; funded_sol: number }>(key);
  if (hit) return hit;

  const none = { funder: null, funded_sol: 0 };
  const { sig } = await walletOrigin(rpc, wallet, cache);
  if (!sig) {
    await cache.set(key, none); // resolved: old/unknowable, don't probe again
    return none;
  }

  const tx = await txBalances(rpc, sig, cache).catch(() => null);
  if (!tx) return none; // transient miss — leave uncached so it retries

  const keys = tx.keys;
  const wIdx = keys.indexOf(wallet);
  if (wIdx < 0) {
    await cache.set(key, none);
    return none;
  }
  const received = (tx.post[wIdx] - tx.pre[wIdx]) / 1e9;

  // Fee payer funds the account in the normal case; if the wallet paid its own fee, fall back to
  // whichever other account bled the most SOL (the true source of the seed transfer).
  let funder: string | null = keys[0] !== wallet ? keys[0] : null;
  if (!funder) {
    let biggestOut = 0;
    let idx = -1;
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] === wallet) continue;
      const out = tx.pre[i] - tx.post[i];
      if (out > biggestOut) { biggestOut = out; idx = i; }
    }
    funder = idx >= 0 ? keys[idx] : null;
  }

  const out = { funder, funded_sol: received };
  await cache.set(key, out);
  return out;
}

/** The shared exchange/faucet gate, with this scan's thresholds. */
function gateOf(rpc: SolanaRpc, funder: string, cache: KV, cfg: ScoringConfig): Promise<FunderGate> {
  return funderGate(
    rpc,
    funder,
    cache,
    { farmRecipients: cfg.coin.farmRecipients, exchangeBalanceSol: cfg.coin.exchangeBalanceSol, fanoutSampleTx: cfg.coin.fanoutSampleTx, serviceSpanHours: cfg.coin.serviceSpanHours },
    true, // the fan-out headline reads the purse's whole visible life, not just its newest txns
  );
}

/**
 * How far a funding purse reaches, read off the shared gate: lifetime tx count (one signature page),
 * distinct wallets it sprayed SOL to, SOL dispensed, balance, and the time window. A distributor
 * spraying gas to a wallet farm shows dozens of recipients; the near-empty balance after dispensing is
 * the classic drained-distributor tell.
 */
async function funderFanout(rpc: SolanaRpc, funder: string, cache: KV, cfg: ScoringConfig): Promise<{ fo: FunderFanout; exchange: boolean }> {
  const g = await gateOf(rpc, funder, cache, cfg);
  const count = g.page?.count ?? 0;
  return {
    exchange: g.exchange,
    fo: {
      total_txs: Math.min(count, 1000),
      total_txs_capped: count >= 1000,
      distinct_recipients: g.recipients,
      sampled_txs: g.spray?.sampled_txs ?? 0,
      dispensed_sol: g.spray?.out_sol ?? 0,
      balance_sol: g.balance_sol === null ? null : Math.round(g.balance_sol * 1000) / 1000,
      window_min: g.spray?.window_min ?? null,
      recipients_sample: (g.spray?.recipients ?? []).slice(0, 100),
    },
  };
}

/** Coefficient of variation of positive seed amounts — near-0 means a scripted, uniform fan-out. */
function coefficientOfVariation(xs: number[]): number {
  const vals = xs.filter((x) => x > 0);
  if (vals.length < 2) return Infinity;
  const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
  if (mean === 0) return Infinity;
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance) / mean;
}

/**
 * One holder's on-chain life, cheaply: lifetime tx count and age from a single signature page, plus
 * the funder (one more call) only when the wallet is fresh enough to be worth suspecting. Primes the
 * origin cache so walletFunder doesn't re-fetch the page.
 */
async function probeHolder(
  rpc: SolanaRpc,
  wallet: string,
  now: number,
  cache: KV,
  cfg: ScoringConfig,
): Promise<{ tx_count: number; tx_capped: boolean; age_days: number | null; funder: string | null }> {
  const page = await sigPage(rpc, wallet, cache);
  const tx_capped = page.count >= 1000;
  const age_days = !tx_capped && page.oldest_t ? (now - page.oldest_t) / 86400 : null;
  const fresh = age_days !== null && age_days * 86400 < cfg.coin.freshWalletSeconds;
  let funder: string | null = null;
  if (fresh) funder = (await walletFunder(rpc, wallet, cache).catch(() => ({ funder: null }))).funder;
  return { tx_count: Math.min(page.count, 1000), tx_capped, age_days, funder };
}

/**
 * Is the holder crowd organic, and by how much? A stratified, sequential sample: a few from the top
 * and the rest spread across the tail (where manufactured holders hide), classified by their own
 * on-chain life. We sample round 1, and widen toward sampleMax only when the split is borderline —
 * escalation buys precision, it isn't drama. The band is a real finite-population confidence interval,
 * so the card can say "±10" and mean it. Solana only for now; EVM rides the log-replay reconstructor.
 */
async function sampleHolderBehavior(
  rpc: SolanaRpc,
  cfg: ScoringConfig,
  now: number,
  cache: KV,
  registry: WalletRegistry,
  raw: RawHolder[],
  exclude: Set<string>,
): Promise<HolderSample | null> {
  const pool = raw.map((h) => h.owner).filter((o) => !exclude.has(o));
  const N = pool.length;
  if (N < cfg.coin.sampleMinHolders) return null;

  // The plan: a few off the top, the rest strided across the tail. Deterministic (no RNG) so a
  // re-scan agrees with itself and the cached result is stable.
  const topN = Math.min(cfg.coin.sampleTopStrata, pool.length);
  const tail = pool.slice(topN);
  const tailWanted = Math.max(0, cfg.coin.sampleMax - topN);
  const stride = tail.length > tailWanted ? Math.floor(tail.length / tailWanted) : 1;
  const tailPicks: string[] = [];
  for (let i = 0; i < tail.length && tailPicks.length < tailWanted; i += stride) tailPicks.push(tail[i]);
  const plan: { wallet: string; stratum: "top" | "tail" }[] = [
    ...pool.slice(0, topN).map((wallet) => ({ wallet, stratum: "top" as const })),
    ...tailPicks.map((wallet) => ({ wallet, stratum: "tail" as const })),
  ];

  // Drop tail addresses that are program-owned (other pools/lockers) — they'd read as "real" wrongly.
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const owners = new Map<string, string>();
  for (let i = 0; i < plan.length; i += 100) {
    const keys = plan.slice(i, i + 100).map((p) => p.wallet);
    const infos = await rpc
      .call<{ value: Array<{ owner: string } | null> }>("getMultipleAccounts", [keys, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])
      .catch(() => ({ value: [] as Array<{ owner: string } | null> }));
    infos.value.forEach((info, j) => owners.set(keys[j], info?.owner ?? SYSTEM_PROGRAM));
  }
  const realPlan = plan.filter((p) => (owners.get(p.wallet) ?? SYSTEM_PROGRAM) === SYSTEM_PROGRAM);
  if (realPlan.length < Math.min(cfg.coin.sampleRound1, cfg.coin.sampleMinHolders)) return null;

  const members: HolderSampleMember[] = [];
  const funderOf = new Map<string, string | null>();

  // Probe a slice of the plan all at once; the RPC limiter paces the calls.
  async function probeSlice(from: number, to: number) {
    const slice = realPlan.slice(from, to);
    {
      const probed = await Promise.all(
        slice.map((p) =>
          probeHolder(rpc, p.wallet, now, cache, cfg)
            .then((r) => ({ p, r }))
            .catch(() => null),
        ),
      );
      for (const item of probed) {
        if (!item) continue;
        const { p, r } = item;
        const known = registry.get(p.wallet);
        const fresh = r.age_days !== null && r.age_days * 86400 < cfg.coin.freshWalletSeconds;
        let verdict: HolderSampleMember["verdict"];
        if (known) verdict = "known";
        else if (r.age_days === null || r.tx_count >= cfg.coin.sampleRealTxCount) verdict = "real";
        else if (fresh && r.tx_count < cfg.coin.sampleThinTxCount) verdict = "fresh";
        else verdict = "real";
        members.push({
          wallet: p.wallet,
          handle: known?.handle ?? null,
          grade: known?.grade ?? null,
          tx_count: r.tx_count,
          tx_capped: r.tx_capped,
          age_days: r.age_days,
          stratum: p.stratum,
          // stash the funder on a side channel via a symbol-free trick: reuse handle? no — keep it local
          verdict,
        });
        funderOf.set(p.wallet, r.funder);
      }
    }
  }

  // Coordination + stats over whatever's been probed so far.
  const tally = () => {
    // Upgrade "fresh" holders that share a funding purse with another sampled holder → "farmed".
    const byFunder = new Map<string, string[]>();
    for (const m of members) {
      const f = funderOf.get(m.wallet);
      if (m.verdict === "fresh" && f) byFunder.set(f, [...(byFunder.get(f) ?? []), m.wallet]);
    }
    let sharedFunders = 0;
    const farmedWallets = new Set<string>();
    for (const [, ws] of byFunder) {
      if (ws.length >= 2) {
        sharedFunders++;
        ws.forEach((w) => farmedWallets.add(w));
      }
    }
    for (const m of members) if (farmedWallets.has(m.wallet)) m.verdict = "farmed";

    const n = members.length;
    const known = members.filter((m) => m.verdict === "known").length;
    const real = members.filter((m) => m.verdict === "real").length;
    const farmed = members.filter((m) => m.verdict === "farmed").length;
    const fresh = members.filter((m) => m.verdict === "fresh").length;
    const p = n ? (fresh + farmed) / n : 0;
    // 95% half-width, finite-population corrected.
    const se = n ? Math.sqrt((p * (1 - p)) / n) : 0.5;
    const fpc = N > 1 ? Math.sqrt(Math.max(0, (N - n) / (N - 1))) : 0;
    const band = Math.min(0.5, 1.96 * se * fpc);
    return { n, known, real, farmed, fresh, p, band, sharedFunders };
  };

  await probeSlice(0, cfg.coin.sampleRound1);
  let stats = tally();
  // Escalate only when the first look is both imprecise and genuinely on the fence.
  let escalated = false;
  if (stats.n < realPlan.length && stats.band > cfg.coin.sampleEscalateBand && stats.p > 0.2 && stats.p < 0.9) {
    escalated = true;
    await probeSlice(cfg.coin.sampleRound1, cfg.coin.sampleMax);
    stats = tally();
  }

  return {
    sampled: stats.n,
    population: N,
    known: stats.known,
    real: stats.real,
    fresh: stats.fresh,
    farmed: stats.farmed,
    shared_funders: stats.sharedFunders,
    manufactured_pct: stats.p,
    band: stats.band,
    escalated,
    members: members.slice(0, 14),
  };
}

/** Compact USD: 302362 → "302k", 4.1e6 → "4.1M". No currency symbol (callers add "$"). */
function fmtUsd(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

/**
 * EVM coin scan. Off Solana there's no free holder index, so this reads what we CAN get for nothing:
 * pump.fun's multichain record (mcap, ATH, liquidity, its own security verdict) and a few eth_calls
 * (the dev's live holding of THIS coin, their wallet's activity and gas balance). It is honest about
 * the gap — no top-holder concentration or Sybil bundles until an EVM holder source is wired.
 */
export async function scanEvmCoin(mint: string, cfg: ScoringConfig, now: number, cache: KV): Promise<CoinScan> {
  const scan: CoinScan = {
    mint, chain: "evm", symbol: null, name: null, logo_url: null, checked_at: now,
    eligible: true, refusal_reasons: [], provisional: false, age_seconds: null,
    volume_24h_usd: 0, holders: [], bundles: [], creator: null, creator_fanout: null,
    dev: null, market: null, evm_holder_book: null, chart_ref: null, holder_sample: null, token_safety: null, holder_clusters: [], holder_entry: null, summary: null,
  };

  // pump.fun's record first (richest: ATH, creator, its own security call). A coin pump doesn't carry
  // (a Robinhood coin launched elsewhere, or pump refusing us) is still found on DexScreener,
  // GeckoTerminal or the chain itself, and read with whatever those give.
  const pump = await pumpFunEvmCoin(mint, cache).catch(() => null);
  // pump's record without a chain id used to default to BSC — a Robinhood coin then read an empty
  // book off the wrong chain. Ask the chains instead of guessing.
  if (pump && !pump.chain_id) {
    const found = await findEvmChain(mint).catch(() => null);
    if (found) pump.chain_id = `eip155:${found.chain.id}`;
  }
  const coin: EvmCoinRecord | null = pump ? { ...pump, source: "pump.fun" } : await findEvmCoin(mint, cache).catch(() => null);
  if (!coin) {
    scan.eligible = false;
    scan.refusal_reasons.push(
      `couldn't find this contract on ${evmChains().map((c) => c.label).join(", ")} — no pump.fun record, no DEX pool, and no chain answers for it`,
    );
    return scan;
  }

  scan.symbol = coin.symbol;
  scan.name = coin.name;
  scan.creator = coin.creator;
  scan.age_seconds = coin.created_ms ? now - Math.floor(coin.created_ms / 1000) : null;
  scan.provisional = scan.age_seconds !== null && scan.age_seconds < cfg.coin.provisionalUnderSeconds;

  const chain = evmChain(coin.chain_id);
  const drawdown =
    coin.market_cap_usd !== null && coin.ath_market_cap_usd && coin.ath_market_cap_usd > 0
      ? Math.max(0, 1 - coin.market_cap_usd / coin.ath_market_cap_usd)
      : null;

  const market: EvmMarket = {
    chain_key: chain.key,
    chain_label: chain.label,
    native_symbol: chain.native,
    protocol: coin.protocol,
    mcap_usd: coin.market_cap_usd,
    ath_mcap_usd: coin.ath_market_cap_usd,
    drawdown_from_ath: drawdown,
    liquidity_usd: coin.liquidity_usd,
    security_verdict: coin.security_verdict,
    security_reason: coin.security_reason,
    pool_address: coin.pool_address,
    // Token page, not /pools/{addr}: pump's pool_address is sometimes the token itself, which renders
    // an empty pool. The token page always resolves to the coin's real chart.
    chart_url: `https://www.geckoterminal.com/${chain.gt}/tokens/${mint}`,
    explorer_url: `${chain.explorer}/token/${mint}`,
    explorer_base: chain.explorer,
    source: coin.source,
  };
  scan.market = market;
  scan.chart_ref = { network: chain.key, mint };

  // The dev, read through eth_calls: how much of THIS coin they still hold, and is the wallet alive.
  if (coin.creator) {
    const [bal, supply, w] = await Promise.all([
      evmBalanceOf(chain, mint, coin.creator).catch(() => null),
      coin.total_supply !== null ? Promise.resolve(coin.total_supply) : evmTotalSupply(chain, mint).catch(() => null),
      evmWallet(chain, coin.creator).catch(() => ({ tx_count: 0, native_balance: 0 })),
    ]);
    const holdsPct = bal !== null && supply && supply > 0n ? Number((bal * 1_000_000n) / supply) / 10_000 : 0;
    scan.dev = {
      wallet: coin.creator,
      holds_pct: holdsPct,
      age_days: null,
      launches: null,
      launches_capped: false,
      graduated: null,
      alive: null,
      fanout: null,
      tx_count: w.tx_count,
      native_balance: w.native_balance,
      native_symbol: chain.native,
    };
  }

  // The holder book, reconstructed from Transfer logs + one Multicall3 balance sweep. Free and
  // keyless; complete for coins scanned within the RPC's archive window (~6h on BSC), partial (last
  // ~6h of blocks) for older ones — we say which. This is what used to be "not indexed off Solana".
  // Blockscout's index first where the chain has one (Robinhood): the whole book in a couple of calls,
  // no archive RPC needed. The log replay stays as the fallback.
  const indexed = await blockscoutHolders(chain, mint, { poolAddress: coin.pool_address }).catch(() => null);
  const book = indexed ?? await reconstructHolders(chain, mint, {
    createdMs: coin.created_ms,
    poolAddress: coin.pool_address,
    creator: coin.creator,
    totalSupply: coin.total_supply,
  }).catch(() => null);
  // No launch time → the sweep only covered a recent window, so the count is a floor, not the book.
  if (book && book.source !== "blockscout" && coin.created_ms === null) book.partial = true;
  scan.evm_holder_book = book;

  const bits: string[] = [];
  const dev = scan.dev;
  if (coin.is_banned) bits.push("pump.fun has banned this coin");
  if (coin.security_verdict && coin.security_verdict !== "allow")
    bits.push(`pump's own security check flags this: ${coin.security_verdict}${coin.security_reason ? ` (${coin.security_reason})` : ""}`);
  if (drawdown !== null && drawdown >= 0.85 && coin.ath_market_cap_usd)
    bits.push(`already round-tripped, down ${Math.round(drawdown * 100)}% from a $${fmtUsd(coin.ath_market_cap_usd)} peak`);
  if (dev) {
    if (dev.holds_pct >= 5) bits.push(`the dev still holds ${dev.holds_pct.toFixed(1)}% of supply — a bag priced over your head`);
    else if (dev.holds_pct <= 0.01) bits.push("the dev holds none of it — they have already sold their entire allocation");
  }
  if (market.liquidity_usd !== null && market.liquidity_usd < 5000)
    bits.push(`thin liquidity, about $${fmtUsd(market.liquidity_usd)} — easy to move, easy to trap`);
  // Concentration from the reconstructed book — the unambiguous read. (Creator-sourced distribution
  // is NOT flagged: pre-graduation pump coins route nearly everything through the curve/creator, so
  // it would fire on every coin — a false positive we already learned to avoid.)
  if (book && book.holder_count > 0) {
    const spread = book.top10_pct > 60 ? " — tightly held by a few" : book.top10_pct < 25 ? " — widely spread" : "";
    bits.push(`${book.holder_count.toLocaleString()}${book.partial ? "+" : ""} holders, top 10 hold ${book.top10_pct.toFixed(1)}%${spread}`);
  }
  if (coin.source === "onchain") bits.push("no DEX pool found for it anywhere — no market to read, just the contract");
  if (!bits.length) bits.push(`a ${market.chain_label} coin on ${market.protocol ?? "an AMM"}, nothing loud in what we can read`);

  // THE READ synthesises; it must NOT restate THE DEV panel (right above it) verbatim. Lead with the
  // coin and its market, fold in concentration, and let the dev status live in its own panel + signals.
  const readout: string[] = [];
  {
    const p: string[] = [`A ${market.chain_label} coin${market.mcap_usd ? `, $${fmtUsd(market.mcap_usd)} mcap` : ""}`];
    if (drawdown !== null) p.push(`down ${Math.round(drawdown * 100)}% from its $${fmtUsd(coin.ath_market_cap_usd ?? 0)} peak`);
    if (book && book.holder_count > 0) {
      const conc = book.top10_pct > 60 ? "tightly held" : book.top10_pct > 35 ? "moderately spread" : "widely spread";
      p.push(`${book.holder_count.toLocaleString()}${book.partial ? "+" : ""} holders, top 10 hold ${book.top10_pct.toFixed(1)}% (${conc})`);
    }
    readout.push(p.join(", ") + ".");
  }
  if (book && book.holder_count > 0) {
    if (book.partial) readout.push(`Holder history is partial — the free RPC couldn't reach the coin's oldest transfers in time, so the count is a floor.`);
  } else {
    readout.push(`Holder book unavailable on this chain right now — dev and market read only.`);
  }
  readout.push(
    coin.is_banned || (coin.security_verdict && coin.security_verdict !== "allow")
      ? "pump.fun itself flagged it — treat it that way."
      : dev && dev.holds_pct <= 0.01 && drawdown !== null && drawdown >= 0.85
        ? "Dev gone, chart round-tripped — looks finished."
        : book && book.top10_pct > 70
          ? "A few wallets own most of it — thin float."
          : "Weigh the dev and the market read together.",
  );

  scan.summary = {
    top_n: book?.holder_count ?? 0,
    pct_kol: 0,
    pct_bad_kol: 0,
    pct_fresh: 0,
    pct_bundled: 0,
    pct_unknown: 0,
    pct_infra_excluded: 0,
    top1_pct: book?.top1_pct ?? 0,
    top5_pct: book?.top5_pct ?? 0,
    top10_pct: book?.top10_pct ?? 0,
    holder_count: book?.holder_count ?? 0,
    signals: bits,
    verdict: bits.join(" · ") + ".",
    readout,
  };
  return scan;
}

/**
 * §6.6 Coin Scan, free tier: identity + behavior heuristics for the top holders.
 * Reports the holders' track record where we have it — NOT a rug prediction.
 * Full karma scoring of unknown holders is the paid/gated path.
 */
export async function scanCoin(
  rpc: SolanaRpc,
  mint: string,
  cfg: ScoringConfig,
  now: number,
  cache: KV,
  registry: WalletRegistry,
  /** Funders that never make a wallet suspect: CEX hot wallets, pump.fun infra. See seed/cex_funders.json. */
  excludedFunders: Set<string> = new Set(),
): Promise<CoinScan> {
  // EVM mints (0x…) live on a chain our Solana RPC can't read. They get their own scan: pump.fun's
  // multichain record plus a couple of cheap eth_calls, honest about the holder book we can't index.
  if (mint.startsWith("0x")) return scanEvmCoin(mint, cfg, now, cache);

  // Pull pump's own record alongside the DEX meta: it carries the creator and, crucially, a launch
  // timestamp — so a brand-new pump mint no DEX has indexed yet is still readable and age-able from birth.
  // The holder book doesn't depend on the eligibility read, so it starts now instead of after it (it's
  // several sequential DAS pages, the longest pole at the start of a scan). A refused coin just drops it.
  const holdersP = fetchHolders(rpc, mint);
  holdersP.catch(() => null); // observed here so a refused coin's abandoned read never surfaces as unhandled
  const [meta, pump] = await Promise.all([
    getTokenMeta(mint, cache),
    mint.endsWith("pump") ? pumpFunCoin(mint, cache).catch(() => null) : Promise.resolve(null),
  ]);
  const scan: CoinScan = {
    mint,
    chain: "solana",
    symbol: meta.symbol,
    name: meta.name,
    logo_url: meta.logoUrl,
    checked_at: now,
    eligible: true,
    refusal_reasons: [],
    provisional: false,
    age_seconds: null,
    volume_24h_usd: meta.volume24hUsd,
    holders: [],
    bundles: [],
    creator: pump?.creator ?? null,
    creator_fanout: null,
    dev: null,
    market: null,
    evm_holder_book: null,
    chart_ref: { network: "solana", mint },
    holder_sample: null,
    token_safety: null,
    holder_clusters: [],
    holder_entry: null,
    summary: null,
  };

  // Eligibility gates: refuse only what we truly can't read. Young coins are scanned, not refused —
  // the structural signals are valid from birth; thin track record is flagged provisional instead.
  // Age from the DEX pool if there is one, else from pump's launch timestamp (the sub-5-min path).
  const dexCreated = meta.pools.map((p) => p.createdAt).filter((t): t is number => t !== null);
  const createdSec = dexCreated.length
    ? Math.min(...dexCreated)
    : pump?.created_ms
      ? Math.floor(pump.created_ms / 1000)
      : null;
  scan.age_seconds = createdSec !== null ? now - createdSec : null;
  scan.provisional = scan.age_seconds !== null && scan.age_seconds < cfg.coin.provisionalUnderSeconds;
  // A pump mint is readable straight off the chain (supply + holders) even before a DEX lists it, so
  // "no pool" only refuses non-pump mints we genuinely can't source.
  // Token safety needs only the mint, so it starts now and overlaps everything after it. It also tells a
  // mistyped address from a dead coin: no mint account at all is "not a token", not "$0 volume".
  const safetyP = tokenSafety(rpc, mint, cache).catch(() => null);
  if (!meta.pools.length && !pump) {
    const exists = await rpc
      .call<{ value: unknown | null }>("getAccountInfo", [mint, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }])
      .catch((e) => ({ value: /invalid/i.test(String(e)) ? null : {} })); // an RPC hiccup must not refuse a real coin
    if (!exists.value) {
      scan.refusal_reasons.push("no token exists at this address — check the mint");
      scan.eligible = false;
      return scan;
    }
    scan.refusal_reasons.push("no active pool found for this mint");
  }
  if (scan.age_seconds !== null && scan.age_seconds < cfg.coin.minAgeSeconds)
    scan.refusal_reasons.push("still forming — check back in a moment");
  // Dead-coin volume floor doesn't apply to coins too young to have earned a 24h number yet, nor to a
  // still-on-the-curve pump mint (no DEX volume by definition).
  if (!scan.provisional && !(pump && !pump.complete) && meta.volume24hUsd < cfg.coin.min24hVolumeUsd)
    scan.refusal_reasons.push(`24h volume $${Math.round(meta.volume24hUsd)} is below the $${cfg.coin.min24hVolumeUsd} floor — dead coin`);
  if (scan.refusal_reasons.length) {
    scan.eligible = false;
    return scan;
  }

  const [{ holders: raw, supplyRaw }, curve] = await Promise.all([
    holdersP,
    mint.endsWith("pump") ? pumpFunCurveAddress(mint) : Promise.resolve(null),
  ]);
  const poolAddrs = new Set(meta.pools.map((p) => p.address));
  const pct = (amt: bigint) => (supplyRaw > 0n ? Number((amt * 1_000_000n) / supplyRaw) / 10_000 : 0);

  // The decisive infra test: real wallets are System-Program accounts. Any program-owned holder
  // (AMM pool PDA, locker, vesting contract) is infra — covers pools quoted in other memecoins too.
  const SYSTEM_PROGRAM = "11111111111111111111111111111111";
  const pool = raw.slice(0, cfg.coin.topHolders + 30);
  const ownerPrograms = new Map<string, string>();
  await Promise.all(
    Array.from({ length: Math.ceil(pool.length / 100) }, async (_, c) => {
      const keys = pool.slice(c * 100, c * 100 + 100).map((h) => h.owner);
      const infos = await rpc.call<{ value: Array<{ owner: string } | null> }>("getMultipleAccounts", [keys, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
      infos.value.forEach((info, j) => ownerPrograms.set(keys[j], info?.owner ?? SYSTEM_PROGRAM));
    }),
  );

  let infraPct = 0;
  const candidates: RawHolder[] = [];
  for (const h of pool) {
    const isInfra =
      INFRA_OWNERS.has(h.owner) ||
      poolAddrs.has(h.owner) ||
      h.owner === curve ||
      ownerPrograms.get(h.owner) !== SYSTEM_PROGRAM;
    if (isInfra) infraPct += pct(h.amountRaw);
    else candidates.push(h);
    if (candidates.length >= cfg.coin.topHolders) break;
  }

  // From here every lens is independent, so they all run at once and share one rate-limited pipe:
  // the holder book (+ bundles), the dev, the connected-wallet clusters, and the crowd sample. They
  // also share each wallet's signature page and first transaction (sources/wallet-history.ts), so a
  // wallet two lenses care about costs its calls once. Wall time ≈ total calls ÷ the RPC's rate.
  const creator = scan.creator;
  const kolInTop = candidates.some((h) => registry.has(h.owner));

  // The entry lens: when and how the top holders got in (the CEX-laundered insider cohort shares no
  // funder, but it can't hide that its wallets were born to buy in the launch window).
  const entryP = readHolderEntries(
    rpc,
    cache,
    cfg,
    mint,
    candidates.map((h) => ({ wallet: h.owner, account: h.account, pct_supply: pct(h.amountRaw) })),
    createdSec,
    excludedFunders,
  ).catch(() => null);

  // The four behaviour/market lenses (sources/*): independent of each other, so they join the pile.
  const topInput = candidates.map((h) => ({ wallet: h.owner, pct_supply: pct(h.amountRaw) }));
  const behaviorP = readHolderBehavior(rpc, cache, mint, topInput.slice(0, 15)).catch(() => null);
  const marketP = readMarketStructure(rpc, cache, mint, topInput).catch(() => null);
  const freshP = readFreshFlow(rpc, cache, mint, { pools: meta.pools.map((p) => p.address).filter((a) => a !== curve), curve, supplyRaw, excludedFunders }).catch(() => null);
  // Database only (no RPC): the wallets this book shares with other coins we've scanned.
  const siblingP = readSiblingOverlap(mint, topInput, { creator: scan.creator, checkedAt: now }).catch(() => null);

  const clustersP = resolveHolderClusters(
    rpc,
    cache,
    cfg,
    candidates.map((h) => ({ wallet: h.owner, pct_supply: pct(h.amountRaw) })),
    excludedFunders,
  ).catch(() => [] as HolderCluster[]);

  // The dev, profiled: the bag they still hold in THIS coin, wallet age, launch graveyard (launches vs
  // graduated — the serial-rugger tell), and their seeding reach ("is this guy funding 100 wallets").
  // The fan-out flag is dropped only if the dev is itself exchange-scale — the same gate as every purse.
  const devP: Promise<void> = creator
    ? (async () => {
        const found = raw.find((h) => h.owner === creator);
        const [devAge, devStats, fan] = await Promise.all([
          walletAgeDays(rpc, creator, now, cache).catch(() => null),
          pumpFunDevStats(creator, cache, cfg.coin.devAliveMcapUsd).catch(() => null),
          funderFanout(rpc, creator, cache, cfg).catch(() => null),
        ]);
        const fo = fan && !fan.exchange ? fan.fo : null;
        if (fo) scan.creator_fanout = fo;
        scan.dev = {
          wallet: creator,
          holds_pct: found ? pct(found.amountRaw) : 0,
          age_days: devAge,
          launches: devStats?.launches ?? null,
          launches_capped: devStats?.capped ?? false,
          graduated: devStats?.graduated ?? null,
          alive: devStats?.alive ?? null,
          fanout: fo,
        };
      })()
    : Promise.resolve();

  // Organic-vs-manufactured crowd read — only on unproven young coins with a real crowd (no graded
  // caller in the book, or under an hour old, AND enough holders to sample).
  const sampleP =
    (scan.provisional || !kolInTop) && raw.length >= cfg.coin.sampleMinHolders
      ? (() => {
          const exclude = new Set<string>([...poolAddrs, ...INFRA_OWNERS]);
          if (curve) exclude.add(curve);
          if (creator) exclude.add(creator);
          // The pile, not the path: its ~12-28 probes only use capacity the critical chains leave idle.
          return lowPriority(() => sampleHolderBehavior(rpc, cfg, now, cache, registry, raw, exclude)).catch(() => null);
        })()
      : Promise.resolve(null);

  // Classify the top holders: registry lookup is free; the age probe is the wallet's signature page
  // (shared with the cluster lens); fresh unknowns also resolve their funder (a shared first tx).
  const holders: CoinHolder[] = await Promise.all(
    candidates.map(async (h) => {
      const known = registry.get(h.owner);
      const age = known ? undefined : await walletAgeDays(rpc, h.owner, now, cache).catch(() => undefined);
      const fresh = age !== undefined && age !== null && age * 86400 < cfg.coin.freshWalletSeconds;
      // A fresh, unknown holder is a Sybil candidate — resolve who seeded it.
      const fund = !known && fresh ? await walletFunder(rpc, h.owner, cache).catch(() => ({ funder: null, funded_sol: null as number | null })) : null;
      return {
        wallet: h.owner,
        pct_supply: pct(h.amountRaw),
        kind: known ? "kol" : fresh ? "fresh" : "wallet",
        handle: known?.handle ?? null,
        verified: known?.verified ?? false,
        source_url: known?.source_url ?? null,
        grade: known?.grade ?? null,
        title: known?.title ?? null,
        wallet_age_days: age === undefined ? null : age,
        funder: fund?.funder ?? null,
        funded_sol: fund?.funded_sol ?? null,
        bundle_id: null,
      } satisfies CoinHolder;
    }),
  );

  // Sybil bundle (the primary signal): fresh holders sharing one immediate funder. Birth time can
  // be staggered to dodge a time bucket; the purse that pays for gas cannot be hidden.
  const bundles: CoinBundle[] = [];
  let bundleId = 0;

  const byFunder = new Map<string, number[]>();
  holders.forEach((h, i) => {
    if (h.kind !== "fresh" || !h.funder || excludedFunders.has(h.funder)) return;
    byFunder.set(h.funder, [...(byFunder.get(h.funder) ?? []), i]);
  });
  const bundleCands = [...byFunder].filter(([, idxs]) => idxs.length >= cfg.coin.bundleMinCluster);
  const bundleReads = await Promise.all(
    bundleCands.map(([funder]) =>
      Promise.all([
        funderFanout(rpc, funder, cache, cfg).catch(() => null),
        walletAgeDays(rpc, funder, now, cache).catch(() => null),
      ]),
    ),
  );
  bundleCands.forEach(([funder, idxs], k) => {
    const [fan, funderAge] = bundleReads[k];
    // Decisive exclusion, the SAME gate the cluster lens uses: an exchange sprays farm-scale AND sits
    // on exchange-scale reserves. (Balance alone used to decide here — an insider purse that banked its
    // rug proceeds walked free. Fan-out alone clears a live faucet. It takes both.)
    if (fan?.exchange) return;
    // Corroboration against the remaining innocent-shared-funder case: a scripted fan-out seeds
    // near-identical amounts, OR the funder is itself a fresh throwaway distributor, OR it is a faucet
    // spraying farm-scale right now.
    const uniform = coefficientOfVariation(idxs.map((i) => holders[i].funded_sol ?? 0)) <= cfg.coin.bundleUniformCv;
    const funderBurner = funderAge !== null && funderAge * 86400 < cfg.coin.bundleFunderBurnerSeconds;
    const faucet = !!fan && fan.fo.distinct_recipients >= cfg.coin.farmRecipients;
    if (!uniform && !funderBurner && !faucet) return;
    bundleId++;
    for (const i of idxs) holders[i].bundle_id = bundleId;
    bundles.push({ id: bundleId, funder, uniform_funding: uniform, funder_is_burner: funderBurner, fanout: fan?.fo ?? null, tree: null });
  });

  // Fallback smell, only for holders whose funder never resolved (old-RPC miss): same first-activity
  // hour. Weaker and prone to lumping unrelated wallets, so it never overrides a funder verdict.
  const buckets = new Map<number, number[]>();
  holders.forEach((h, i) => {
    if (h.kind !== "fresh" || h.bundle_id !== null || h.funder || h.wallet_age_days === null) return;
    const bucket = Math.floor((now - h.wallet_age_days * 86400) / cfg.coin.bundleBucketSeconds);
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), i]);
  });
  for (const idxs of buckets.values()) {
    if (idxs.length < cfg.coin.bundleMinCluster) continue;
    bundleId++;
    for (const i of idxs) holders[i].bundle_id = bundleId;
    bundles.push({ id: bundleId, funder: "", uniform_funding: false, funder_is_burner: false, fanout: null, tree: null });
  }

  // Build the funding tree for each real-funder bundle: origin (the purse's own funder) → purse →
  // members, each with its birth time. Only for bundles (rare), members capped, reads shared.
  await Promise.all(
    bundles
      .filter((b) => b.funder)
      .map(async (b) => {
        const memberHolders = holders.filter((h) => h.bundle_id === b.id).slice(0, 6);
        const [root, funderOrigin] = await Promise.all([
          walletFunder(rpc, b.funder, cache).then((r) => r.funder).catch(() => null),
          walletOrigin(rpc, b.funder, cache).catch(() => ({ t: null })),
        ]);
        // No per-member tx fetch here: most people never expand a node. The card links each wallet to
        // an on-demand popover (/api/wallet-txs) instead.
        const members: BundleMemberNode[] = memberHolders.map((h) => ({
          wallet: h.wallet,
          pct_supply: h.pct_supply,
          funded_sol: h.funded_sol,
          first_seen: h.wallet_age_days !== null ? Math.round(now - h.wallet_age_days * 86400) : null,
        }));
        b.tree = { root, funder: b.funder, funder_first_seen: funderOrigin.t, members };
      }),
  );

  // Gather the parallel lenses.
  const [holderClusters, , holderSample, safety, entry, behavior, market, fresh, sibling] = await Promise.all([
    clustersP,
    devP,
    sampleP,
    safetyP,
    entryP,
    behaviorP,
    marketP,
    freshP,
    siblingP,
  ]);
  scan.holder_entry = entry;
  scan.holder_behavior = behavior;
  scan.market_structure = market;
  scan.fresh_flow = fresh;
  scan.sibling_overlap = sibling;
  // Token safety (RugCheck-style): a danger here (a transfer hook that blocks sells, a permanent
  // delegate that seizes tokens, a live mint/freeze authority) outranks everything else on the card.
  scan.token_safety = safety;
  // Relationship clustering (the bubble map): holders of ANY age that share one purse — the $Brim case.
  scan.holder_clusters = holderClusters;
  scan.holder_sample = holderSample;

  const sum = (f: (h: CoinHolder) => boolean) => holders.filter(f).reduce((s, h) => s + h.pct_supply, 0);
  const pctKol = sum((h) => h.kind === "kol");
  const pctBad = sum((h) => h.grade === "D" || h.grade === "F");
  const pctFresh = sum((h) => h.kind === "fresh");
  const pctBundled = sum((h) => h.bundle_id !== null);
  const pctUnknown = sum((h) => h.kind === "wallet");

  const bits: string[] = [];
  // Safety first, literally: a token-program hazard leads the read — nothing else matters if you can't sell.
  const ts = scan.token_safety;
  if (ts && ts.severity !== "clean" && ts.risks.length) {
    bits.push(`${ts.severity === "danger" ? "⚠ token risk" : "token caution"}: ${ts.risks.join("; ")}`);
  }
  // Connected wallets: holders that are secretly one actor. The relationship read the crowd sample can't
  // see — aged wallets that look like independent "real traders" but share one funding purse.
  const clusters = scan.holder_clusters;
  const topCluster = clusters[0];
  if (topCluster) {
    const others = clusters.length - 1;
    bits.push(
      `${topCluster.member_count} of the holders are one actor — funded by the same wallet (${topCluster.funder.slice(0, 4)}…${topCluster.funder.slice(-4)}), ${topCluster.pct_total.toFixed(1)}% of supply between them${topCluster.funder_is_faucet ? `; that purse is still seeding wallets in bursts (${topCluster.funder_recipients}+ recently)` : ""}${others > 0 ? `, plus ${others} more such cluster${others > 1 ? "s" : ""}` : ""}`,
    );
  }
  // The insider cohort from the entry lens: bags taken in the launch window by wallets born to take them,
  // or routed in by token transfer. Shares no funder, so the cluster lens is blind to it.
  const en = scan.holder_entry;
  // Snipers still sitting on a big bag weeks later are an insider tell on their own (KNOTS: 10% taken
  // within 2 minutes of launch by 3 wallets, still held 19 days on).
  const snipersHold = !!en && en.sniper_pct >= cfg.coin.entrySniperHoldPct;
  const cohortHit = !!en && (en.cohort_pct >= cfg.coin.entryCohortPct || snipersHold);
  if (en && en.cohort_pct >= 3) {
    const e = en.entries;
    const n = (f: (x: (typeof e)[number]) => boolean) => e.filter(f).length;
    const parts: string[] = [];
    const snipers = n((x) => x.after_launch_s !== null && x.after_launch_s <= cfg.coin.entrySniperSeconds);
    if (snipers) parts.push(`${snipers} sniper${snipers > 1 ? "s" : ""} from the first ${cfg.coin.entrySniperSeconds / 60} minutes still holding ${en.sniper_pct.toFixed(1)}%`);
    const born = n((x) => x.fresh_at_entry);
    if (born) parts.push(`${born} wallet${born > 1 ? "s" : ""} born within ${cfg.coin.entryFreshSeconds / 86400} days of buying (${en.fresh_at_entry_pct.toFixed(1)}%)`);
    const routedN = en.routers.reduce((k, r) => k + r.members.length, 0);
    if (routedN)
      parts.push(
        `${routedN} bag${routedN > 1 ? "s" : ""} (${en.routed_pct.toFixed(1)}%) moved in by token transfer from another wallet, not bought${en.routers[0] ? ` (biggest from ${en.routers[0].from.slice(0, 4)}…${en.routers[0].from.slice(-4)})` : ""}`,
      );
    bits.push(`insider-shaped supply ${en.cohort_pct.toFixed(1)}% of the top ${e.length}: ${parts.join("; ")}`);
  }
  // A dust-sized larper position isn't a signal ("2 graded larpers hold 0.0%" read as noise).
  // The four new lenses, each folded to one line and a red/amber call (thresholds from their test runs:
  // see each module's header).
  const hb = scan.holder_behavior;
  const ecoRed = !!hb && hb.ecosystem_only.length >= 4 && hb.ecosystem_only_pct >= 10;
  const rewardRed = !!hb && hb.reward_only.length >= 2 && hb.reward_only_pct >= 5;
  if (hb?.signal && (hb.ecosystem_only.length || hb.reward_only.length)) bits.push(hb.signal);
  const ms = scan.market_structure;
  const lpPull = !!ms?.lp && ms.lp.pullable_share !== null && ms.lp.pullable_share >= 0.5;
  const marketRed = ms?.severity === "danger";
  for (const sig of ms?.signals ?? []) bits.push(sig.text);
  const ff = scan.fresh_flow;
  const freshAlert = ff?.severity === "alert";
  if (ff?.signal && ff.severity !== "none") bits.push(`last hour: ${ff.signal}`);
  const sib = scan.sibling_overlap;
  const cabal = sib?.verdict === "cabal";
  if (sib && sib.verdict !== "none") bits.push(...sib.signals.slice(0, 1));
  const badKols = holders.filter((h) => (h.grade === "D" || h.grade === "F") && h.pct_supply >= 0.05);
  if (badKols.length)
    bits.push(
      `${badKols.length} of the top ${holders.length} ${badKols.length === 1 ? "is a graded larper" : "are graded larpers"}, sitting on ${pctBad.toFixed(1)}% of supply`,
    );
  if (pctBundled > 0) {
    const n = holders.filter((h) => h.bundle_id !== null).length;
    const funderClusters = bundles.filter((b) => b.funder).length;
    const scripted = bundles.some((b) => b.uniform_funding);
    if (funderClusters > 0) {
      const how = scripted ? ", seeded in near-identical amounts — a scripted fan-out" : "";
      bits.push(
        `${n} fresh holders on ${pctBundled.toFixed(1)}% of supply trace to ${funderClusters === 1 ? "one shared funder" : `${funderClusters} shared funders`}${how}. a manufactured holder base, not organic demand`,
      );
      // The purse's reach: the most prolific funder among the bundles.
      const reach = bundles
        .map((b) => b.fanout)
        .filter((f): f is FunderFanout => f !== null && f.distinct_recipients >= cfg.coin.farmRecipients)
        .sort((a, b) => b.distinct_recipients - a.distinct_recipients)[0];
      if (reach) {
        const count = reach.total_txs > reach.sampled_txs ? `${reach.distinct_recipients}+` : `${reach.distinct_recipients}`;
        const drained = reach.balance_sol !== null && reach.balance_sol < 0.05 ? ", now near-empty" : "";
        bits.push(`that purse has seeded ${count} wallets (${reach.total_txs}${reach.total_txs_capped ? "+" : ""} txns${drained}) — a farm faucet, not a buyer`);
      }
    } else {
      bits.push(`${n} wallets funded inside the same hour hold ${pctBundled.toFixed(1)}%`);
    }
  } else if (pctFresh > 0) bits.push(`fresh wallets (<7d old) hold ${pctFresh.toFixed(1)}%`);
  // Deployer fan-out fires independently of the top-N: the dead-holder farm lives in the long tail.
  if (scan.creator_fanout && scan.creator_fanout.distinct_recipients >= cfg.coin.farmRecipients) {
    const f = scan.creator_fanout;
    const count = f.total_txs > f.sampled_txs ? `${f.distinct_recipients}+` : `${f.distinct_recipients}`;
    bits.push(`the deployer wallet has seeded ${count} wallets (${f.total_txs}${f.total_txs_capped ? "+" : ""} txns, ${f.dispensed_sol} SOL out) — a manufactured holder farm, not organic buyers`);
  }
  // The dev's own record — the strongest single tell on a coin too fresh to have any other history.
  const dev = scan.dev;
  const serialLauncher = !!dev && dev.launches !== null && dev.launches >= 3 && (dev.graduated ?? 0) === 0;
  if (dev && dev.launches !== null && dev.launches > 1) {
    const cap = dev.launches_capped ? "+" : "";
    bits.push(
      serialLauncher
        ? `the dev has launched ${dev.launches}${cap} coins and graduated none — a serial launcher, not a builder`
        : `the dev has launched ${dev.launches}${cap} coins, ${dev.graduated ?? 0} graduated`,
    );
  }
  if (dev && dev.holds_pct >= 5)
    bits.push(`the dev still holds ${dev.holds_pct.toFixed(1)}% of supply — a bag priced over your head`);
  // The sampled crowd read: the answer to "are the N holders real, and by how much".
  const hs = scan.holder_sample;
  if (hs && hs.sampled > 0) {
    const mp = Math.round(hs.manufactured_pct * 100);
    const band = Math.round(hs.band * 100);
    const shared = hs.shared_funders ? `, ${hs.shared_funders} shared purse${hs.shared_funders > 1 ? "s" : ""}` : "";
    bits.push(
      `sampled ${hs.sampled} of ${hs.population} holders${hs.escalated ? ", widened" : ""}: ~${mp}% look manufactured ±${band}% (${hs.real + hs.known} real, ${hs.fresh + hs.farmed} fresh/farmed${shared})`,
    );
  }
  if (!bits.length) bits.push(`no graded larpers in the top ${holders.length}. ${pctUnknown.toFixed(1)}% sits with wallets we have no receipts on`);

  // The finishing 3-line read: what it is, what's real, what to do. Synthesised from the same facts,
  // rule-based, so the card can close with a verdict instead of leaving the reader to add it up.
  const farmScale = !!scan.creator_fanout && scan.creator_fanout.distinct_recipients >= cfg.coin.farmRecipients;
  const funderBundles = bundles.filter((b) => b.funder).length;
  // A connected-wallet cluster among the holders (the $Brim case) is manufactured demand, whatever the
  // wallets' age — this is what turns "12 real traders" into "4 faces, one actor".
  const connected = clusters.length > 0;
  const manufactured = farmScale || funderBundles > 0 || serialLauncher || connected || cohortHit || ecoRed || rewardRed || marketRed || freshAlert || cabal;
  const readout: string[] = [];

  if (manufactured) {
    const how = [
      connected && `${topCluster!.member_count} of the holders are one actor (${topCluster!.pct_total.toFixed(1)}% between them)`,
      ecoRed && `${hb!.ecosystem_only.length} top holders (${hb!.ecosystem_only_pct.toFixed(1)}%) trade only this coin's launch family`,
      rewardRed && `${hb!.reward_only.length} top holders never sell the coin, only its rewards`,
      cabal && `${sib!.core_wallets} wallets rotate through other coins we've scanned`,
      freshAlert && `fresh wallets are loading it right now`,
      lpPull && `one wallet can pull ${Math.round(ms!.lp!.pullable_share! * 100)}% of the liquidity`,
      marketRed && !lpPull && ms!.signals.find((x) => x.severity === "danger")?.text,
      cohortHit &&
        (snipersHold
          ? `snipers who bought in the first ${cfg.coin.entrySniperSeconds / 60} minutes still hold ${en!.sniper_pct.toFixed(1)}%`
          : `${en!.cohort_pct.toFixed(1)}% of the top book is insider-shaped (snipers, wallets born to buy, bags routed in)`),
      serialLauncher && `the dev has launched ${dev!.launches}${dev!.launches_capped ? "+" : ""} coins with none graduating`,
      farmScale && "the deployer farmed its own holders",
      funderBundles > 0 && `${funderBundles} funder-linked bundle${funderBundles > 1 ? "s" : ""} sit at the top of the book`,
    ].filter(Boolean).join(", and ");
    readout.push(`Manufactured or coordinated: ${how}.`);
  } else if (badKols.length) {
    readout.push(`${badKols.length} graded larper${badKols.length > 1 ? "s" : ""} hold ${pctBad.toFixed(1)}% of supply — known dumpers are in the book.`);
  } else {
    readout.push(`No manufactured-holder or graded-dumper signal in the top ${holders.length}.`);
  }
  const crowdFake = !!hs && hs.sampled > 0 && hs.manufactured_pct >= 0.55;
  if (hs && hs.sampled > 0) {
    const mp = Math.round(hs.manufactured_pct * 100);
    readout.push(
      `The crowd is about ${mp}% manufactured (±${Math.round(hs.band * 100)}, from ${hs.sampled} of ${hs.population} holders): mostly ${mp >= 55 ? "fresh and farmed wallets, not buyers" : "real traders with their own history"}${hs.shared_funders ? `, and ${hs.shared_funders} of them share a funding purse` : ""}.`,
    );
  } else {
    readout.push(
      `Real demand looks ${pctUnknown > 50 ? "thin" : pctKol >= 5 ? "mixed" : "unproven"}: ${pctKol.toFixed(1)}% known callers, ${pctUnknown.toFixed(1)}% with no track record${scan.provisional ? ", and the book is under an hour old" : ""}.`,
    );
  }
  readout.push(
    manufactured || pctBad > 5 || crowdFake
      ? "Read it as engineered exit liquidity, not organic demand."
      : pctBad > 0 || pctFresh > 15
        ? "Not clean, not damning — size any entry like the receipts are missing, because they are."
        : "Nothing here screams a trap, but no receipts is not the same as a clean bill.",
  );

  // Concentration — the physiognomy of the book. holders is already sorted by supply, infra removed.
  const cumPct = (n: number) => holders.slice(0, n).reduce((s, h) => s + h.pct_supply, 0);

  scan.holders = holders;
  scan.bundles = bundles;
  scan.summary = {
    top_n: holders.length,
    pct_kol: pctKol,
    pct_bad_kol: pctBad,
    pct_fresh: pctFresh,
    pct_bundled: pctBundled,
    pct_unknown: pctUnknown,
    pct_infra_excluded: infraPct,
    top1_pct: holders[0]?.pct_supply ?? 0,
    top5_pct: cumPct(5),
    top10_pct: cumPct(10),
    holder_count: raw.length,
    signals: bits,
    verdict: bits.join(" · ") + ".",
    readout,
  };
  return scan;
}
