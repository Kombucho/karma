import type { KV } from "../cache";
import { MAJOR_MINTS, WSOL_MINT } from "../constants";
import type { EnhancedTx, SolanaRpc } from "./solana";

/**
 * The behavior lens: what the top holders DO with their wallets, read from one Helius Enhanced
 * Transactions page each (their newest 100 txns, already parsed into token and SOL movements).
 *
 * Built from the STONK-ecosystem insider thread (@MidCurveMortal, 25 Sep 2026): the insiders on
 * $GP/$ZCAT/$KNOTS "exclusively traded STONK ecosystem tokens" and "only ever sold accrued rewards".
 * Neither shows in a funder graph or an entry timeline, both show in the trade tape:
 *
 *  1. Ecosystem-only wallets. A normal trader's tape is a spray of unrelated coins; an insider's is a
 *     closed loop of one team's launches. "Same team" is free and exact for these coins: every STONK
 *     launch is a Token-2022 mint whose transfer-fee `withdrawWithheldAuthority` is the same wallet
 *     (5KXDF6…, which also pays the rewards) and whose metadata `updateAuthority` is the same wallet
 *     (WLHv2U…). Verified 25 Sep 2026 on KNOTS, GP, ZCAT, PURR, MASK, BUTT, INU, CRACKER, PONZI…
 *     One getMultipleAccounts (jsonParsed, 100 mints) resolves every traded mint's family at once.
 *     The coin's own quote asset joins the family too: KNOTS trades against STONK, not SOL, so a
 *     STONK↔KNOTS tape IS the ecosystem. Classic SPL mints carry no such keys, so a second path catches
 *     them: a small, closed set of coins that several top holders all trade.
 *
 *  2. Reward-only sellers. Reward coins (3% transfer fee, withheld and redistributed) pay holders in
 *     batches: one transaction, one sender, a dozen-plus recipients (5KXDF6 pays wSOL and a rotating
 *     reward token to 10-17 KNOTS holders per tx). The insider tell is a holder that never sells the
 *     coin itself but steadily sells what it's paid — income extraction without ever showing a sell on
 *     the chart. The payer is characterised (reach, batch size, whether it IS the coin's fee authority).
 *
 * Deliberately NOT a family: launchpad-wide markers. Every memecoin trader's tape is ~all "…pump"
 * mints; treating pump.fun or letsbonk as an "ecosystem" would flag the whole market.
 *
 * Cost: one enhanced call per holder (≤15), plus 1-2 getMultipleAccounts for mint families (cached a
 * day). The per-holder tape is reduced to a mint-agnostic ledger and cached 5 min, so any lens that
 * asks again inside a scan costs nothing. Window caveat: "never sold" means in the newest 100 txns.
 */

/** Top holders read. Each costs one Enhanced Transactions call (~5/s bucket, 1-2 s latency). */
const BEHAVIOR_HOLDERS = 15;
/** The ledger grows; inside one scan every lens reads the same page. */
const LEDGER_TTL_S = 300;
/** A mint's authorities essentially never change after launch. */
const FAMILY_TTL_S = 86_400;
/** getMultipleAccounts takes 100 keys per call; 2 calls covers the long tail of a busy sample. */
const MINT_LOOKUP_CAP = 200;
/** SOL moves below this in a tx are rent and fees, not a trade leg (ATA rent is 0.00204). */
const SOL_DUST = 0.005;
/** Quote assets: trading in or out of these says nothing about which coins a wallet likes. */
const BASE_ASSETS = new Set(["SOL", ...MAJOR_MINTS, "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"]);
/** Launchpad vanity suffixes shared by thousands of unrelated teams — never an "ecosystem". */
const BROAD_SUFFIXES = new Set(["pump", "bonk", "BAGS", "moon", "boop", "daos", "jups"]);

/** Ecosystem-only: enough trades to mean something… */
const ECO_MIN_TRADES = 3;
/** …and ≥ this share of them touch only family coins (trade-weighted: one sold airdrop is noise). */
const ECO_SHARE = 0.8;
/** Distinct family coins traded, counting the scanned coin and its quote. 3 = at least one OTHER launch;
 * 2 would flag every plain buyer of a STONK-quoted coin. */
const ECO_MIN_FAMILY_MINTS = 3;
/** A counter-asset seen this many times swapped directly against the scanned coin is its quote. */
const PAIR_MIN_TRADES = 2;
/** …by at least this many holders (one wallet routing GP→X twice is its taste, not GP's quote). */
const PAIR_MIN_HOLDERS = 2;
/** Closed-set path: a coin traded by this many sampled holders is part of the shared loop… */
const CLOSED_SHARED_BY = 3;
/** …a wallet trading only a handful of such coins is inside the loop… */
const CLOSED_MAX_MINTS = 6;
/** …and it's only a loop with at least this many wallets in it. A lone wallet co-trading this week's
 * trending pump coins with its neighbours fired on a pump.fun control (PEPENOM, 25 Sep 2026). */
const CLOSED_MIN_WALLETS = 3;

/** A payout = one sender moving one asset to at least this many wallets in one transaction. */
const BATCH_RECIPIENTS = 5;
/** Reward-only: at least this many payouts received in the window. */
const REWARD_MIN_PAYOUTS = 2;
/** …at least one realised (a reward asset sold) — collecting alone is what every passive holder does. */
const REWARD_MIN_SALES = 1;
/** …and ≥ this share of its token sales are of reward assets. */
const REWARD_SALE_SHARE = 0.8;
/** A batch sender is a distributor for THIS holder base when it paid at least this many sampled holders. */
const DISTRIBUTOR_MIN_HOLDERS = 2;

// ---------------------------------------------------------------------------------------------

/** Helius's parsed fields that solana.ts's minimal EnhancedTx doesn't declare. */
interface ParsedTx extends EnhancedTx {
  tokenTransfers?: { fromUserAccount: string | null; toUserAccount: string | null; mint: string; tokenAmount: number }[];
}

/** One transaction as it touched the wallet: net change per asset ("SOL" folds in wSOL) and any payouts received. */
interface LedgerTx {
  t: number;
  d: Record<string, number>;
  /** Batch payouts this wallet was one recipient of: asset, sender, batch size. */
  p?: { a: string; from: string; n: number }[];
}

export interface WalletBehavior {
  wallet: string;
  pct_supply: number;
  /** Txns read (≤100) and how many were trades (the wallet gave one asset and got another). */
  txs: number;
  trades: number;
  /** Distinct non-quote coins traded, and how many of them are the scanned coin's family. */
  traded_mints: number;
  family_mints: number;
  /** Share of trades touching only family coins (0-1). */
  family_share: number;
  /** Trades with the scanned coin going out / coming in; transfers of it out. */
  sold_coin: number;
  bought_coin: number;
  moved_coin_out: number;
  payouts: number;
  reward_sales: number;
  other_sales: number;
  ecosystem_only: boolean;
  /** Why it was flagged ecosystem-only: family keys, or the closed loop of co-traded coins. */
  ecosystem_path: "family" | "closed_set" | null;
  reward_only: boolean;
}

export interface RewardDistributor {
  address: string;
  /** Assets it paid (mint, or "SOL" for SOL/wSOL). */
  assets: string[];
  /** Sampled top holders it paid, and payout txns seen across them. */
  holders_paid: number;
  payouts_seen: number;
  /** Largest recipient count seen in one of its transactions. */
  max_batch: number;
  /** It IS the scanned coin's fee-withdraw / fee-config / metadata authority: the coin's own reward engine. */
  is_coin_authority: boolean;
}

export interface HolderBehavior {
  /** Holders whose tape was read, and the supply they hold. */
  sampled: number;
  sampled_pct: number;
  /** The scanned coin's family: its keys (e.g. "fee:5KXDF6…"), quote assets, and the family coins seen traded. */
  family: { keys: string[]; quotes: string[]; mints: string[]; symbols: string[] };
  ecosystem_only: string[];
  ecosystem_only_pct: number;
  /** The coin pays rewards (transfer fee, or its own authority pays batches). False = reward-only never fires. */
  reward_coin: boolean;
  reward_only: string[];
  reward_only_pct: number;
  /** Batch payers of THIS holder base, biggest reach first. */
  distributors: RewardDistributor[];
  wallets: WalletBehavior[];
  /** One-line read for the verdict, or null when nothing fired. */
  signal: string | null;
  calls: number;
}

// ---------------------------------------------------------------------------------------------

const assetOf = (mint: string) => (mint === WSOL_MINT ? "SOL" : mint);

/** Reduce the newest 100 parsed txns to what this lens reads. Mint-agnostic, so it's cacheable per wallet. */
function toLedger(wallet: string, txs: ParsedTx[]): LedgerTx[] {
  const out: LedgerTx[] = [];
  for (const tx of txs) {
    const d: Record<string, number> = {};
    const add = (a: string, v: number) => (d[a] = (d[a] ?? 0) + v);
    for (const x of tx.tokenTransfers ?? []) {
      if (!(x.tokenAmount > 0)) continue;
      if (x.fromUserAccount === wallet) add(assetOf(x.mint), -x.tokenAmount);
      if (x.toUserAccount === wallet) add(assetOf(x.mint), x.tokenAmount);
    }
    for (const n of tx.nativeTransfers ?? []) {
      if (n.fromUserAccount === wallet) add("SOL", -n.amount / 1e9);
      if (n.toUserAccount === wallet) add("SOL", n.amount / 1e9);
    }
    if (Math.abs(d.SOL ?? 0) < SOL_DUST) delete d.SOL;
    for (const k of Object.keys(d)) if (d[k] === 0) delete d[k];

    // Payouts: group by (asset, sender); a group that reaches ≥ BATCH_RECIPIENTS wallets including this
    // one is a distribution, not a trade. (Helius names the owner wallets, so ATAs don't split a batch.)
    const groups = new Map<string, Set<string>>();
    for (const x of tx.tokenTransfers ?? []) {
      if (!(x.tokenAmount > 0) || !x.fromUserAccount || !x.toUserAccount || x.fromUserAccount === x.toUserAccount) continue;
      const k = `${assetOf(x.mint)}|${x.fromUserAccount}`;
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k)!.add(x.toUserAccount);
    }
    for (const n of tx.nativeTransfers ?? []) {
      // Plain SOL rewards; the ~0.002 SOL rent a batch pays to open recipients' token accounts is not one.
      if (n.amount / 1e9 < SOL_DUST || n.fromUserAccount === n.toUserAccount) continue;
      const k = `SOL|${n.fromUserAccount}`;
      if (!groups.has(k)) groups.set(k, new Set());
      groups.get(k)!.add(n.toUserAccount);
    }
    const p: LedgerTx["p"] = [];
    for (const [k, rs] of groups) {
      const [a, from] = k.split("|");
      if (from !== wallet && rs.has(wallet) && rs.size >= BATCH_RECIPIENTS) p.push({ a, from, n: rs.size });
    }
    if (!Object.keys(d).length && !p.length) continue;
    out.push({ t: tx.timestamp, d, ...(p.length ? { p } : {}) });
  }
  return out;
}

async function ledgerOf(rpc: SolanaRpc, cache: KV, wallet: string, count: () => void): Promise<{ n: number; l: LedgerTx[] } | null> {
  const key = `hbledger1:${wallet}`;
  const hit = await cache.get<{ v: { n: number; l: LedgerTx[] } }>(key);
  if (hit) return hit.v;
  count();
  const txs = (await rpc.enhancedTransactions(wallet).catch(() => null)) as ParsedTx[] | null;
  if (!txs || !Array.isArray(txs)) return null;
  const v = { n: txs.length, l: toLedger(wallet, txs) };
  await cache.set(key, { v }, LEDGER_TTL_S);
  return v;
}

/** A mint's family keys: shared fee-withdraw / fee-config / metadata authorities. Null = unreadable. */
interface MintFamily {
  keys: string[];
  symbol: string | null;
}

interface ParsedMint {
  data?: {
    parsed?: {
      info?: {
        extensions?: { extension: string; state?: Record<string, unknown> }[];
      };
    };
  };
}

function familyOf(acc: ParsedMint | null): MintFamily {
  const keys = new Set<string>();
  let symbol: string | null = null;
  for (const e of acc?.data?.parsed?.info?.extensions ?? []) {
    const s = e.state ?? {};
    if (e.extension === "transferFeeConfig") {
      for (const a of [s.withdrawWithheldAuthority, s.transferFeeConfigAuthority]) if (typeof a === "string") keys.add(`fee:${a}`);
    }
    if (e.extension === "tokenMetadata") {
      if (typeof s.updateAuthority === "string") keys.add(`ua:${s.updateAuthority}`);
      if (typeof s.symbol === "string") symbol = s.symbol;
    }
  }
  return { keys: [...keys], symbol };
}

async function mintFamilies(rpc: SolanaRpc, cache: KV, mints: string[], count: () => void): Promise<Map<string, MintFamily>> {
  const out = new Map<string, MintFamily>();
  const todo: string[] = [];
  for (const m of mints) {
    const hit = await cache.get<{ v: MintFamily }>(`mintfam1:${m}`);
    if (hit) out.set(m, hit.v);
    else todo.push(m);
  }
  for (let i = 0; i < todo.length; i += 100) {
    const chunk = todo.slice(i, i + 100);
    count();
    const res = await rpc
      .call<{ value: (ParsedMint | null)[] }>("getMultipleAccounts", [chunk, { encoding: "jsonParsed" }])
      .catch(() => null);
    if (!res) continue;
    await Promise.all(
      chunk.map(async (m, j) => {
        const f = familyOf(res.value[j] ?? null);
        out.set(m, f);
        await cache.set(`mintfam1:${m}`, { v: f }, FAMILY_TTL_S);
      }),
    );
  }
  return out;
}

const short = (a: string) => `${a.slice(0, 6)}…`;

export async function readHolderBehavior(
  rpc: SolanaRpc,
  cache: KV,
  mint: string,
  holders: { wallet: string; pct_supply: number }[],
): Promise<HolderBehavior | null> {
  try {
    let calls = 0;
    const count = () => void calls++;
    const top = holders.slice(0, BEHAVIOR_HOLDERS);
    const ledgers = await Promise.all(top.map((h) => ledgerOf(rpc, cache, h.wallet, count)));
    const read = top.map((h, i) => ({ ...h, led: ledgers[i] })).filter((h) => h.led !== null) as {
      wallet: string;
      pct_supply: number;
      led: { n: number; l: LedgerTx[] };
    }[];
    if (!read.length) return null;

    // Trades: the wallet gave one asset and got a different one. Parsed "type" isn't trusted — pump.fun
    // curve trades come back UNKNOWN and relayed bot swaps as TRANSFER — the balance deltas are.
    const tradesOf = (l: LedgerTx[]) =>
      l.filter((x) => {
        const v = Object.values(x.d);
        return !x.p && v.some((n) => n < 0) && v.some((n) => n > 0);
      });
    const nonBase = (d: Record<string, number>) => Object.keys(d).filter((a) => !BASE_ASSETS.has(a));

    // How many sampled holders trade each coin, and what the scanned coin is swapped against directly.
    const holdersPerMint = new Map<string, number>();
    const pairCount = new Map<string, number>();
    const pairHolders = new Map<string, Set<string>>();
    for (const h of read) {
      const seen = new Set<string>();
      for (const x of tradesOf(h.led.l)) {
        for (const a of nonBase(x.d)) seen.add(a);
        const c = x.d[mint];
        if (c) {
          const other = nonBase(x.d).filter((a) => a !== mint && Math.sign(x.d[a]) === -Math.sign(c));
          if (other.length === 1) {
            pairCount.set(other[0], (pairCount.get(other[0]) ?? 0) + 1);
            pairHolders.set(other[0], (pairHolders.get(other[0]) ?? new Set()).add(h.wallet));
          }
        }
      }
      for (const a of seen) holdersPerMint.set(a, (holdersPerMint.get(a) ?? 0) + 1);
    }
    const quotes = [...pairCount].filter(([a, n]) => n >= PAIR_MIN_TRADES && pairHolders.get(a)!.size >= PAIR_MIN_HOLDERS).map(([a]) => a);

    // Resolve families for the scanned coin, its quotes, and the most-traded coins (cap: 2 calls).
    const counterAssets = [...pairCount].filter(([, n]) => n >= PAIR_MIN_TRADES).map(([a]) => a);
    const lookup = [mint, ...counterAssets, ...[...holdersPerMint.keys()].sort((a, b) => holdersPerMint.get(b)! - holdersPerMint.get(a)!)]
      .filter((m, i, arr) => arr.indexOf(m) === i)
      .slice(0, MINT_LOOKUP_CAP);
    const fams = await mintFamilies(rpc, cache, lookup, count);

    // The family: the coin's own keys, plus a narrow vanity suffix it shares with another traded coin
    // (never a launchpad-wide one). Quote assets are members, but keys are only borrowed from direct
    // counter-assets when the coin has none: STONK is a plain SPL mint, and it's the coins swapped against
    // STONK that carry the launchpad's keys. Borrowing when the coin has its own keys is how GP, partly
    // quoted in GLDx, briefly adopted every tokenized stock sharing GLDx's metadata authority. A borrowed
    // key must also be the crowd's — carried by coins ≥ CLOSED_SHARED_BY sampled holders trade — because
    // STONK's only direct counter-asset came from one wallet's tape.
    const seeds = [mint, ...quotes];
    const ownKeys = fams.get(mint)?.keys ?? [];
    const holdersPerKey = new Map<string, number>();
    for (const h of read) {
      const keys = new Set(tradesOf(h.led.l).flatMap((x) => nonBase(x.d).flatMap((m) => fams.get(m)?.keys ?? [])));
      for (const k of keys) holdersPerKey.set(k, (holdersPerKey.get(k) ?? 0) + 1);
    }
    const borrowed = counterAssets.flatMap((q) => fams.get(q)?.keys ?? []).filter((k) => (holdersPerKey.get(k) ?? 0) >= CLOSED_SHARED_BY);
    const familyKeys = new Set(ownKeys.length ? ownKeys : borrowed);
    const traded = [...holdersPerMint.keys()];
    for (const s of seeds) {
      const sfx = s.slice(-4);
      if (!BROAD_SUFFIXES.has(sfx) && traded.some((m) => m !== s && m.endsWith(sfx))) familyKeys.add(`sfx:${sfx}`);
    }
    const inFamily = (m: string) =>
      seeds.includes(m) || (fams.get(m)?.keys ?? []).some((k) => familyKeys.has(k)) || [...familyKeys].some((k) => k.startsWith("sfx:") && m.endsWith(k.slice(4)));

    // Closed-set path: coins several top holders all trade (the scanned coin and plain quotes excluded).
    const shared = new Set([...holdersPerMint].filter(([m, n]) => n >= CLOSED_SHARED_BY && m !== mint).map(([m]) => m));

    // Distributors: batch payers, with their reach across the sample.
    const dist = new Map<string, { assets: Set<string>; holders: Set<string>; payouts: number; max: number }>();
    for (const h of read)
      for (const x of h.led.l)
        for (const p of x.p ?? []) {
          const r = dist.get(p.from) ?? { assets: new Set(), holders: new Set(), payouts: 0, max: 0 };
          r.assets.add(p.a);
          r.holders.add(h.wallet);
          r.payouts++;
          r.max = Math.max(r.max, p.n);
          dist.set(p.from, r);
        }
    const coinAuthorities = new Set((fams.get(mint)?.keys ?? []).map((k) => k.slice(k.indexOf(":") + 1)));
    const isDistributor = (from: string) => coinAuthorities.has(from) || (dist.get(from)?.holders.size ?? 0) >= DISTRIBUTOR_MIN_HOLDERS;
    // Reward assets: whatever a distributor of this holder base pays out.
    // Only a coin that pays rewards can have reward-only holders: a transfer-fee mint, or one whose own
    // authority pays batches. Elsewhere "rewards" are airdrops, and selling airdropped junk is universal.
    const rewardCoin = ownKeys.some((k) => k.startsWith("fee:")) || [...dist.keys()].some((f) => coinAuthorities.has(f));
    const rewardAssets = new Set<string>();
    for (const [from, r] of dist) if (isDistributor(from)) r.assets.forEach((a) => rewardAssets.add(a));

    const wallets: WalletBehavior[] = read.map((h) => {
      const trades = tradesOf(h.led.l);
      const tradedSet = new Set(trades.flatMap((x) => nonBase(x.d)));
      const famTrades = trades.filter((x) => {
        const nb = nonBase(x.d);
        return nb.length > 0 && nb.every(inFamily);
      }).length;
      const famMints = [...tradedSet].filter(inFamily).length;
      const share = trades.length ? famTrades / trades.length : 0;

      let path: WalletBehavior["ecosystem_path"] = null;
      if (trades.length >= ECO_MIN_TRADES && share >= ECO_SHARE && famMints >= ECO_MIN_FAMILY_MINTS) path = "family";
      else if (trades.length >= ECO_MIN_TRADES && tradedSet.size <= CLOSED_MAX_MINTS) {
        const loop = [...tradedSet].filter((m) => m === mint || shared.has(m) || inFamily(m));
        const others = loop.filter((m) => m !== mint && shared.has(m));
        const loopTrades = trades.filter((x) => nonBase(x.d).length > 0 && nonBase(x.d).every((m) => loop.includes(m))).length;
        if (others.length >= 2 && loopTrades / trades.length >= ECO_SHARE) path = "closed_set";
      }

      // Sales: a non-quote token given up in a trade. Giving up a quote coin to BUY the scanned coin is a buy.
      let rewardSales = 0;
      let otherSales = 0;
      let sold = 0;
      let bought = 0;
      for (const x of trades) {
        if ((x.d[mint] ?? 0) < 0) sold++;
        if ((x.d[mint] ?? 0) > 0) bought++;
        for (const a of nonBase(x.d)) {
          if (x.d[a] >= 0 || a === mint) continue;
          if ((x.d[mint] ?? 0) > 0 && quotes.includes(a)) continue;
          if (rewardAssets.has(a)) rewardSales++;
          else otherSales++;
        }
      }
      // SOL rewards can't be "sold"; a wallet cashing them out shows as withdrawals, which we don't count.
      const moved = h.led.l.filter((x) => !tradesOf([x]).length && (x.d[mint] ?? 0) < 0).length;
      const payouts = h.led.l.reduce((s, x) => s + (x.p ?? []).filter((p) => isDistributor(p.from)).length, 0);
      const reward =
        rewardCoin &&
        sold === 0 &&
        moved === 0 &&
        payouts >= REWARD_MIN_PAYOUTS &&
        rewardSales >= REWARD_MIN_SALES &&
        rewardSales / (rewardSales + otherSales) >= REWARD_SALE_SHARE;

      return {
        wallet: h.wallet,
        pct_supply: h.pct_supply,
        txs: h.led.n,
        trades: trades.length,
        traded_mints: tradedSet.size,
        family_mints: famMints,
        family_share: Math.round(share * 100) / 100,
        sold_coin: sold,
        bought_coin: bought,
        moved_coin_out: moved,
        payouts,
        reward_sales: rewardSales,
        other_sales: otherSales,
        ecosystem_only: path !== null,
        ecosystem_path: path,
        reward_only: reward,
      };
    });

    const distributors: RewardDistributor[] = [...dist]
      .filter(([from]) => isDistributor(from))
      .map(([address, r]) => ({
        address,
        assets: [...r.assets],
        holders_paid: r.holders.size,
        payouts_seen: r.payouts,
        max_batch: r.max,
        is_coin_authority: coinAuthorities.has(address),
      }))
      .sort((a, b) => Number(b.is_coin_authority) - Number(a.is_coin_authority) || b.holders_paid - a.holders_paid);

    // A closed set is a loop only when several wallets sit inside it.
    if (wallets.filter((w) => w.ecosystem_path === "closed_set").length < CLOSED_MIN_WALLETS)
      for (const w of wallets)
        if (w.ecosystem_path === "closed_set") {
          w.ecosystem_path = null;
          w.ecosystem_only = false;
        }
    const eco = wallets.filter((w) => w.ecosystem_only);
    const rew = wallets.filter((w) => w.reward_only);
    const pct = (ws: WalletBehavior[]) => Math.round(ws.reduce((s, w) => s + w.pct_supply, 0) * 100) / 100;
    // Family coins seen, most widely held first, so the label names the loop's core, not its long tail.
    const famMints = traded.filter((m) => m !== mint && inFamily(m)).sort((a, b) => holdersPerMint.get(b)! - holdersPerMint.get(a)!);
    const symbols = [...new Set([mint, ...famMints].map((m) => fams.get(m)?.symbol).filter((s): s is string => !!s))].slice(0, 12);

    const bits: string[] = [];
    if (eco.length) {
      const label = familyKeys.size ? `its launch family (${symbols.slice(0, 4).join("/") || short([...familyKeys][0].split(":")[1])})` : "a closed loop of the same few coins";
      bits.push(`${eco.length} of ${read.length} top holders (${pct(eco).toFixed(1)}% of supply) trade only ${label}`);
    }
    if (rew.length) {
      const d = distributors[0];
      const payer = d ? ` paid out by ${short(d.address)}${d.is_coin_authority ? " (the coin's own fee authority)" : ""}` : "";
      bits.push(`${rew.length} (${pct(rew).toFixed(1)}%) never sell the coin, only the rewards${payer}`);
    }

    return {
      sampled: read.length,
      sampled_pct: pct(wallets),
      family: { keys: [...familyKeys], quotes, mints: famMints, symbols },
      ecosystem_only: eco.map((w) => w.wallet),
      ecosystem_only_pct: pct(eco),
      reward_coin: rewardCoin,
      reward_only: rew.map((w) => w.wallet),
      reward_only_pct: pct(rew),
      distributors,
      wallets,
      signal: bits.length ? `${bits.join("; ")}.` : null,
      calls,
    };
  } catch {
    return null;
  }
}
