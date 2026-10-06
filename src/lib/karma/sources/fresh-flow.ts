import { address, isOffCurveAddress } from "@solana/kit";
import type { KV } from "../cache";
import { WSOL_MINT } from "../constants";
import type { EnhancedTx, SolanaRpc } from "./solana";
import { funderGate, txBalances, type SigPage } from "./wallet-history";

/**
 * The live lens: fresh wallets accumulating RIGHT NOW. The entry lens (holder-entry.ts) reads how the
 * top holders got in; this one reads the last hour of trades, because the pre-pump loading pattern
 * happens before those wallets are top holders. Insiders load through throwaway wallets — born hours
 * ago, a handful of transactions, often seeded by one purse — in the quiet stretch before a parabolic
 * move (the STONK ecosystem, 25 Sep 2026). A crowd of fresh wallets net-BUYING in a short window, with
 * a real share of supply, is the warning; several of them sharing a non-service funder is the alert.
 *
 * Cost (Helius free tier): up to MAX_TRADE_PAGES Enhanced Transactions pages on the curve/pool(s), one
 * short signature page per probed buyer (≤ MAX_PROBES, biggest net buyers first; free when the scan
 * already holds the wallet's full page), one cached first transaction per fresh buyer (≤ MAX_FUNDER_PROBES)
 * and the shared exchange gate for funders two or more fresh buyers share (≤ MAX_GATES). Measured 25 Sep
 * 2026 on ~25 live coins: 2-19 calls, 2-16 s.
 *
 * Coverage is honest, not promised: a quiet coin's hour fits one page; a coin mid-pump trades 100 times
 * in 30 seconds (and a DLMM pool's history is mostly market-maker bin updates), so `window_min` says how
 * much of the hour was actually read. The loading phase this hunts is by nature the quiet one, where
 * coverage is full. Only SOL-paid trades count: a buy routed from USDC, and micro "volume bot" trades
 * under MIN_TRADE_SOL, are invisible (buy/sell counts match GeckoTerminal's h1 on curves without them).
 *
 * False-positive trap: a hype hour onboards genuinely new users — bridged in (Relay), withdrawn from an
 * exchange (Coinbase, Bybit) — and they are fresh too. Freshness alone is only a WARN; the ALERT needs
 * concentration (a real slice of supply), a burst, or a shared funder that passed the service gate.
 */

const WINDOW_SECONDS = 3600;
/** Enhanced Transactions pages across all sources (100 parsed txs each). */
const MAX_TRADE_PAGES = 4;
/** Pools read besides the curve: the first (deepest) ones the caller passes. */
const MAX_POOLS = 2;
/** Below this SOL leg a token movement is a transfer paying rent/fees, not a trade. */
const MIN_TRADE_SOL = 0.005;
/** Wallet-age probes on the biggest net buyers. */
const MAX_PROBES = 12;
/** Signatures per probe. Fresh needs < FRESH_MAX_TXS, or a young wallet under this many — so a short page
 * answers it (a full 1,000 page on a busy wallet is the slowest RPC response there is). */
const PROBE_PAGE = 100;
/** A buyer below this net SOL isn't worth a probe (dust, bots testing the pool). */
const MIN_PROBE_SOL = 0.05;
/** First-transaction reads to find a fresh buyer's funder, freshest-biggest first. */
const MAX_FUNDER_PROBES = 4;
/** Exchange/bridge gates on funders that ≥ 2 fresh buyers share. */
const MAX_GATES = 2;

/** Fresh = fewer than FRESH_MAX_TXS lifetime signatures, or born within FRESH_AGE_SECONDS with fewer than
 * PROBE_PAGE (a day-old wallet with 200 txns is a trading bot, not a throwaway). */
const FRESH_AGE_SECONDS = 48 * 3600;
const FRESH_MAX_TXS = 15;

/** Burst: this many fresh buyers making their first in-window buy inside BURST_SECONDS. */
const BURST_SECONDS = 300;
const BURST_MIN = 4;

/** Severity thresholds (see scripts/check-fresh-flow.ts for the runs they were set on). */
const WARN_MIN_FRESH = 3;
const WARN_MIN_FRESH_SOL = 3;
const WARN_MIN_FRESH_SHARE = 0.3;
const ALERT_MIN_FRESH = 5;
const ALERT_MIN_FRESH_SUPPLY_PCT = 3;
const ALERT_MIN_FRESH_SOL = 10;

/** Same gate thresholds the coin scan uses (scoring.config coin.*), kept here so this lens stands alone. */
const GATE_CFG = { farmRecipients: 20, exchangeBalanceSol: 50_000, fanoutSampleTx: 40, serviceSpanHours: 48 };

export interface FreshBuyer {
  wallet: string;
  /** SOL spent net of SOL received back in the window. */
  net_sol: number;
  /** Tokens acquired net (UI units) and as % of supply (null when supply is unknown). */
  net_tokens: number;
  pct_supply: number | null;
  buys: number;
  sells: number;
  first_buy_t: number;
  /** Probe result: signatures seen (PROBE_PAGE or 1000 = at least that many) and first-activity time. */
  tx_count: number;
  born_t: number | null;
  /** The wallet's first transaction, when the probe reached it. */
  oldest_sig: string | null;
  fresh: boolean;
  funder: string | null;
}

export interface FreshFunder {
  funder: string;
  members: string[];
  net_sol: number;
  pct_supply: number | null;
  /** Passed the exchange/bridge gate as a service (or listed in seed/cex_funders.json): a crowd, not one actor. */
  service: boolean;
}

export interface FreshFlow {
  /** Seconds of trading actually covered, ending now (≤ WINDOW_SECONDS; less on a busy coin). */
  window_min: number;
  /** True when the page budget ran out before reaching back a full hour. */
  truncated: boolean;
  txs_read: number;
  buys: number;
  sells: number;
  distinct_buyers: number;
  /** SOL in minus SOL out across every trader in the window (positive = net buying). */
  net_buy_sol: number;
  /** Net buyers probed for age, and how many of them were fresh. */
  probed: number;
  fresh_count: number;
  fresh_net_sol: number;
  /** Fresh buyers' share of the window's gross net-buying (sum over net buyers), 0-1. */
  fresh_share_of_buying: number;
  fresh_pct_supply: number | null;
  /** Largest fresh accumulators, biggest net SOL first. */
  fresh_buyers: FreshBuyer[];
  /** Funders shared by ≥ 2 fresh buyers (services included, flagged). */
  shared_funders: FreshFunder[];
  /** Fresh buyers seeded straight from a known service (exchange/bridge): newcomers onboarding, or an
   * insider laundering through a CEX — freshness can't tell which, so they still count as fresh. */
  fresh_service_funded: number;
  /** Most fresh first-buys inside any BURST_SECONDS stretch. */
  burst: { count: number; start_t: number; seconds: number } | null;
  severity: "alert" | "warn" | "none";
  signal: string | null;
  /** Calls this read issued (cache hits included in the probe counts — they cost nothing). */
  calls: { trade_pages: number; probes: number; funder_probes: number; gates: number; supply: number };
}

interface TradeTx extends EnhancedTx {
  feePayer?: string;
  transactionError?: unknown;
  tokenTransfers?: { fromUserAccount: string; toUserAccount: string; tokenAmount: number; mint: string }[];
  accountData?: {
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
  }[];
}

/** A real wallet is an ed25519 key (on the curve); pools, vaults and curve authorities are PDAs. */
function isWallet(a: string): boolean {
  try {
    return !isOffCurveAddress(address(a));
  } catch {
    return false;
  }
}

interface Flow {
  tokens: number;
  sol: number;
  buys: number;
  sells: number;
  first_buy_t: number | null;
}

/**
 * Per-wallet token and SOL deltas in one trade (wSOL counts as SOL; SOL includes fees, tips and rent).
 * Read from balance CHANGES, not transfers: a wSOL swap wraps (native → own wSOL account) and then pays
 * (wSOL → pool), so summing transfers counts the same SOL twice. Only wallets whose token balance moved.
 */
function tradeDeltas(tx: TradeTx, mint: string, infra: Set<string>): Map<string, { tokens: number; sol: number }> {
  const tok = new Map<string, number>();
  const sol = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  if (tx.accountData) {
    for (const a of tx.accountData) {
      if (a.nativeBalanceChange) add(sol, a.account, a.nativeBalanceChange / 1e9);
      for (const c of a.tokenBalanceChanges ?? []) {
        const m = c.mint === mint ? tok : c.mint === WSOL_MINT ? sol : null;
        if (m && c.userAccount) add(m, c.userAccount, Number(c.rawTokenAmount.tokenAmount) / 10 ** c.rawTokenAmount.decimals);
      }
    }
  } else {
    // Older/partial responses: transfers only. Good for curve trades (native SOL), approximate for wSOL.
    for (const t of tx.tokenTransfers ?? []) {
      if (t.mint !== mint) continue;
      if (t.fromUserAccount) add(tok, t.fromUserAccount, -t.tokenAmount);
      if (t.toUserAccount) add(tok, t.toUserAccount, t.tokenAmount);
    }
    for (const n of tx.nativeTransfers ?? []) {
      add(sol, n.fromUserAccount, -n.amount / 1e9);
      add(sol, n.toUserAccount, n.amount / 1e9);
    }
  }
  const out = new Map<string, { tokens: number; sol: number }>();
  for (const [w, d] of tok) {
    if (Math.abs(d) < 1e-9 || infra.has(w) || !isWallet(w)) continue;
    out.set(w, { tokens: d, sol: sol.get(w) ?? 0 });
  }
  return out;
}

interface Probe {
  count: number;
  /** The page was full: the wallet has at least `count` signatures and its birth is out of reach. */
  full: boolean;
  oldest_sig: string | null;
  oldest_t: number | null;
  /** An RPC call was spent (vs a cache hit). */
  paid: boolean;
}

/** A buyer's age: the scan's full signature page when it's already cached, else a short page of our own. */
async function probe(rpc: SolanaRpc, cache: KV, wallet: string): Promise<Probe> {
  const full = await cache.get<{ v: SigPage }>(`sigpage:${wallet}`);
  if (full) return { count: full.v.count, full: full.v.count >= 1000, oldest_sig: full.v.oldest_sig, oldest_t: full.v.oldest_t, paid: false };
  const key = `sigpage${PROBE_PAGE}:${wallet}`;
  const hit = await cache.get<Probe>(key);
  if (hit) return { ...hit, paid: false };
  const sigs = await rpc.getSignatures(wallet, undefined, PROBE_PAGE);
  const p = { count: sigs.length, full: sigs.length >= PROBE_PAGE, oldest_sig: sigs.at(-1)?.signature ?? null, oldest_t: sigs.at(-1)?.blockTime ?? null, paid: true };
  await cache.set(key, p, 600);
  return p;
}

export async function readFreshFlow(
  rpc: SolanaRpc,
  cache: KV,
  mint: string,
  opts: {
    pools: string[];
    curve: string | null;
    supplyRaw?: bigint;
    decimals?: number;
    /** Known service funders (seed/cex_funders.json + infra): never a coordinated group. */
    excludedFunders?: Set<string>;
  },
): Promise<FreshFlow | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const start = now - WINDOW_SECONDS;
    const calls = { trade_pages: 0, probes: 0, funder_probes: 0, gates: 0, supply: 0 };
    const excluded = opts.excludedFunders ?? new Set<string>();
    const sources = [...new Set([opts.curve, ...opts.pools.slice(0, MAX_POOLS)].filter((s): s is string => !!s))];
    if (!sources.length) return null;
    const infra = new Set([...sources, ...opts.pools]);

    // Supply for % figures: from the caller, else one getTokenSupply.
    const supplyP: Promise<number | null> = (async () => {
      if (opts.supplyRaw !== undefined && opts.decimals !== undefined) return Number(opts.supplyRaw) / 10 ** opts.decimals;
      calls.supply++;
      const s = await rpc.call<{ value: { amount: string; decimals: number } }>("getTokenSupply", [mint]).catch(() => null);
      return s ? Number(s.value.amount) / 10 ** s.value.decimals : null;
    })();

    // Page 1 of every source at once; a dead source (a graduated coin's curve) drops out after one call.
    const page = (src: string, before?: string) => {
      calls.trade_pages++;
      return rpc.enhancedTransactions(src, { before }).then((r) => (r ?? []) as TradeTx[]).catch(() => [] as TradeTx[]);
    };
    const state = await Promise.all(sources.map(async (src) => ({ src, txs: await page(src), done: false })));
    for (const s of state) s.done = !s.txs.length || s.txs.length < 100 || (s.txs.at(-1)?.timestamp ?? 0) < start;
    // Keep paging while the budget lasts, always the unfinished source reaching back least far: it is the
    // one capping the common window.
    while (calls.trade_pages < MAX_TRADE_PAGES) {
      const open = state.filter((s) => !s.done && s.txs.some((t) => t.timestamp >= start));
      if (!open.length) break;
      const s = open.sort((a, b) => b.txs.at(-1)!.timestamp - a.txs.at(-1)!.timestamp)[0];
      const more = await page(s.src, s.txs.at(-1)!.signature);
      s.txs.push(...more);
      s.done = more.length < 100 || (more.at(-1)?.timestamp ?? 0) < start;
    }
    // A source that ran out of budget mid-window caps the common window, so every source is read over
    // the same stretch (else the busy pool is undercounted relative to the quiet one).
    let from = start;
    let truncated = false;
    for (const s of state) {
      if (s.done || !s.txs.length) continue;
      truncated = true;
      from = Math.max(from, s.txs.at(-1)!.timestamp);
    }
    if (!state.some((s) => s.txs.some((t) => t.timestamp >= start))) return null;

    // Net flow per wallet over the window. A route through two of our pools appears in both histories.
    const seen = new Set<string>();
    const flows = new Map<string, Flow>();
    let txsRead = 0;
    let buys = 0;
    let sells = 0;
    for (const tx of state.flatMap((s) => s.txs)) {
      if (tx.timestamp < from || seen.has(tx.signature) || tx.transactionError) continue;
      seen.add(tx.signature);
      txsRead++;
      for (const [w, d] of tradeDeltas(tx, mint, infra)) {
        // A trade moves tokens and SOL in opposite directions. Tokens AND SOL in is a liquidity pull or
        // an arb leg; tokens in for only a fee is a transfer/airdrop. Neither is buying.
        if (Math.sign(d.tokens) === Math.sign(d.sol) || Math.abs(d.sol) < MIN_TRADE_SOL) continue;
        const f = flows.get(w) ?? { tokens: 0, sol: 0, buys: 0, sells: 0, first_buy_t: null };
        f.tokens += d.tokens;
        f.sol += d.sol;
        if (d.tokens > 0) {
          f.buys++;
          buys++;
          f.first_buy_t = Math.min(f.first_buy_t ?? Infinity, tx.timestamp);
        } else {
          f.sells++;
          sells++;
        }
        flows.set(w, f);
      }
    }
    const supply = await supplyP;
    const pctOf = (tokens: number) => (supply ? (tokens / supply) * 100 : null);
    const netBuyers = [...flows].filter(([, f]) => f.tokens > 0 && f.first_buy_t !== null);
    const netBuySol = -[...flows.values()].reduce((s, f) => s + f.sol, 0);
    const grossNetBuying = netBuyers.reduce((s, [, f]) => s + Math.max(0, -f.sol), 0);

    // Probe the biggest net buyers' age: one short signature page each.
    const toProbe = netBuyers
      .filter(([, f]) => -f.sol >= MIN_PROBE_SOL)
      .sort((a, b) => a[1].sol - b[1].sol)
      .slice(0, MAX_PROBES);
    const probed: FreshBuyer[] = await Promise.all(
      toProbe.map(async ([w, f]) => {
        const p = await probe(rpc, cache, w).catch(() => null);
        if (p?.paid) calls.probes++;
        const count = p?.count ?? PROBE_PAGE;
        const bornT = p && !p.full ? p.oldest_t : null;
        const fresh = !!p && (count < FRESH_MAX_TXS || (bornT !== null && now - bornT <= FRESH_AGE_SECONDS));
        return {
          wallet: w,
          net_sol: round(-f.sol, 3),
          net_tokens: Math.round(f.tokens),
          pct_supply: roundN(pctOf(f.tokens), 3),
          buys: f.buys,
          sells: f.sells,
          first_buy_t: f.first_buy_t!,
          tx_count: count,
          oldest_sig: p && !p.full ? p.oldest_sig : null,
          born_t: bornT,
          fresh,
          funder: null,
        };
      }),
    );
    const fresh = probed.filter((b) => b.fresh);

    // Funders of the biggest fresh buyers: the first transaction's fee payer (else the biggest SOL loser),
    // the same read the scan's walletFunder makes, cached forever under the same key.
    await Promise.all(
      fresh.slice(0, MAX_FUNDER_PROBES).map(async (b) => {
        const known = await cache.get<{ funder: string | null }>(`funder:${b.wallet}`); // the scan's walletFunder
        if (known?.funder) return void (b.funder = known.funder);
        if (!b.oldest_sig) return;
        calls.funder_probes++;
        const tx = await txBalances(rpc, b.oldest_sig, cache).catch(() => null);
        if (!tx) return;
        let funder: string | null = tx.keys[0] !== b.wallet ? tx.keys[0] : null;
        if (!funder) {
          let best = 0;
          tx.keys.forEach((k, i) => {
            const out = tx.pre[i] - tx.post[i];
            if (k !== b.wallet && out > best) [best, funder] = [out, k];
          });
        }
        b.funder = funder;
      }),
    );
    const byFunder = new Map<string, FreshBuyer[]>();
    for (const b of fresh) if (b.funder) byFunder.set(b.funder, [...(byFunder.get(b.funder) ?? []), b]);
    const shared = [...byFunder]
      .filter(([, m]) => m.length >= 2)
      .map(([funder, m]) => ({
        funder,
        members: m.map((b) => b.wallet),
        net_sol: round(m.reduce((s, b) => s + b.net_sol, 0), 3),
        pct_supply: supply ? roundN(m.reduce((s, b) => s + (b.pct_supply ?? 0), 0), 3) : null,
        service: excluded.has(funder),
      }))
      .sort((a, b) => b.net_sol - a.net_sol);
    // Gate the unlisted ones: a bridge solver or exchange hot wallet seeding newcomers is a crowd.
    await Promise.all(
      shared
        .filter((f) => !f.service)
        .slice(0, MAX_GATES)
        .map(async (f) => {
          calls.gates++;
          const g = await funderGate(rpc, f.funder, cache, GATE_CFG).catch(() => null);
          f.service = !!g?.exchange;
        }),
    );

    // Burst: most fresh first-buys inside any BURST_SECONDS stretch.
    const times = fresh.map((b) => b.first_buy_t).sort((a, b) => a - b);
    let burst: FreshFlow["burst"] = null;
    for (let i = 0, j = 0; j < times.length; j++) {
      while (times[j] - times[i] > BURST_SECONDS) i++;
      const n = j - i + 1;
      if (n >= 2 && (!burst || n > burst.count)) burst = { count: n, start_t: times[i], seconds: times[j] - times[i] };
    }

    const freshSol = fresh.reduce((s, b) => s + b.net_sol, 0);
    const freshShare = grossNetBuying > 0 ? freshSol / grossNetBuying : 0;
    const freshPct = supply ? fresh.reduce((s, b) => s + (b.pct_supply ?? 0), 0) : null;
    const windowMin = Math.round((now - from) / 60);
    const coordinated = shared.some((f) => !f.service);
    const services = new Set([...excluded, ...shared.filter((f) => f.service).map((f) => f.funder)]);
    const bursty = !!burst && burst.count >= BURST_MIN;

    const warn = fresh.length >= WARN_MIN_FRESH && freshSol >= WARN_MIN_FRESH_SOL && freshShare >= WARN_MIN_FRESH_SHARE;
    const alert =
      warn &&
      fresh.length >= ALERT_MIN_FRESH &&
      ((freshPct ?? 0) >= ALERT_MIN_FRESH_SUPPLY_PCT || freshSol >= ALERT_MIN_FRESH_SOL) &&
      (coordinated || bursty || (freshPct ?? 0) >= ALERT_MIN_FRESH_SUPPLY_PCT * 2);
    const severity = alert ? "alert" : warn ? "warn" : "none";

    let signal: string | null = null;
    if (fresh.length) {
      const pctTxt = freshPct !== null ? ` (${freshPct.toFixed(1)}% of supply)` : "";
      signal = `${fresh.length} fresh wallet${fresh.length === 1 ? "" : "s"} bought ${fmtSol(freshSol)} SOL${pctTxt} in the last ${windowMin} min`;
      if (bursty)
        signal += `, ${burst!.count} within ${burst!.seconds < 60 ? `${burst!.seconds}s` : `${Math.round(burst!.seconds / 60)} min`}`;
      const top = shared.find((f) => !f.service);
      if (top) signal += `; ${top.members.length} share one funder`;
    }

    return {
      window_min: windowMin,
      truncated,
      txs_read: txsRead,
      buys,
      sells,
      distinct_buyers: [...flows.values()].filter((f) => f.buys > 0).length,
      net_buy_sol: round(netBuySol, 2),
      probed: probed.length,
      fresh_count: fresh.length,
      fresh_net_sol: round(freshSol, 2),
      fresh_share_of_buying: round(freshShare, 3),
      fresh_pct_supply: roundN(freshPct, 2),
      fresh_buyers: fresh.sort((a, b) => b.net_sol - a.net_sol),
      shared_funders: shared,
      fresh_service_funded: fresh.filter((b) => b.funder && services.has(b.funder)).length,
      burst,
      severity,
      signal,
      calls,
    };
  } catch {
    return null;
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const roundN = (v: number | null, d: number) => (v === null ? null : round(v, d));
const fmtSol = (v: number) => (v >= 10 ? Math.round(v).toString() : v.toFixed(1));
