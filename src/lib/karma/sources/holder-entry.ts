import { address, isOffCurveAddress } from "@solana/kit";
import type { KV } from "../cache";
import type { ScoringConfig } from "../scoring.config";
import type { RpcTransaction, SolanaRpc } from "./solana";
import { funderGate, sigPage } from "./wallet-history";

/**
 * The entry lens: WHEN and HOW each top holder got this coin. The shared-funder lens can't see the
 * professional insider pattern, because it never shares a funder: each insider wallet is seeded by its
 * own exchange withdrawal (Coinbase, Bybit, a bridge), so "funded by" points at a crowd of strangers.
 * What can't be laundered is the timeline (the STONK-ecosystem case, 25 Sep 2026: $GP/$ZCAT/$KNOTS
 * insiders held ~half of supply):
 *
 *  - launch window: the wallet got its bag within the first hour of the coin (a sniper within minutes);
 *  - fresh at entry: the wallet was born just before it bought — a throwaway made for this coin, however
 *    "aged" it looks today (measuring age against NOW is the bug this fixes: a 31-day-old wallet that
 *    was 1 hour old when it bought at launch is a fresh wallet);
 *  - routed in: the bag arrived by token TRANSFER, not a buy — supply moved from another wallet into a
 *    side wallet so the book looks spread. The sender is a token edge the SOL-only graph never saw.
 *
 * Cost: per holder, one signature page of its token account (usually tiny) plus 1-2 transactions,
 * cached forever (a first acquisition never changes).
 */
export interface HolderEntry {
  wallet: string;
  pct_supply: number;
  /** Unix seconds of the first transaction that gave this wallet the coin. Null when unreadable. */
  entry_t: number | null;
  /** buy = the wallet itself acquired it (swap/curve); transfer = another wallet sent it the tokens. */
  via: "buy" | "transfer" | "unknown";
  /** For via=transfer: the wallet that sent the tokens. */
  from: string | null;
  /** Seconds after the coin's launch the wallet entered. Null when launch time or entry is unknown. */
  after_launch_s: number | null;
  /** The wallet's own first-ever activity was within entryFreshSeconds before this entry. */
  fresh_at_entry: boolean;
}

export interface EntryRead {
  entries: HolderEntry[];
  /** Launch time used (unix s) and where it came from. */
  launch_t: number | null;
  /** % of supply held by top holders that entered within the launch window / as snipers. */
  launch_window_pct: number;
  sniper_pct: number;
  /** % held by wallets that were fresh when they entered. */
  fresh_at_entry_pct: number;
  /** % held by wallets whose bag arrived by transfer from a non-service wallet. */
  routed_pct: number;
  /** Senders that routed tokens into ≥1 top holder, biggest first. */
  routers: { from: string; members: string[]; pct_total: number }[];
  /** Insider-shaped supply: snipers, wallets born to buy (fresh at entry), or bags routed in. Supply % and wallets. */
  cohort_pct: number;
  cohort_count: number;
}

interface TokenEntryTx {
  t: number | null;
  feePayer: string;
  /** Per-owner change in this mint's balance (raw units) in this tx. */
  deltas: Record<string, number>;
}

async function entryTx(rpc: SolanaRpc, sig: string, mint: string, cache: KV): Promise<TokenEntryTx | null> {
  const key = `entrytx:${mint}:${sig}`;
  const hit = await cache.get<{ v: TokenEntryTx }>(key);
  if (hit) return hit.v;
  const tx = await rpc
    .call<RpcTransaction | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }])
    .catch(() => null);
  if (!tx?.meta) return null;
  const deltas: Record<string, number> = {};
  const pre = new Map<number, { owner?: string; amt: number }>();
  for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint) pre.set(b.accountIndex, { owner: b.owner, amt: Number(b.uiTokenAmount.amount) });
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint !== mint || !b.owner) continue;
    const before = pre.get(b.accountIndex)?.amt ?? 0;
    deltas[b.owner] = (deltas[b.owner] ?? 0) + Number(b.uiTokenAmount.amount) - before;
    pre.delete(b.accountIndex);
  }
  for (const b of pre.values()) if (b.owner) deltas[b.owner] = (deltas[b.owner] ?? 0) - b.amt; // account closed in this tx
  const k0 = tx.transaction.message.accountKeys[0];
  const v: TokenEntryTx = { t: tx.blockTime, feePayer: typeof k0 === "string" ? k0 : k0.pubkey, deltas };
  await cache.set(key, { v });
  return v;
}

/** A real wallet is an ed25519 key (on the curve); pools, vaults and curve authorities are PDAs (off it). */
function isWallet(a: string): boolean {
  try {
    return !isOffCurveAddress(address(a));
  } catch {
    return false;
  }
}

async function readEntry(
  rpc: SolanaRpc,
  cache: KV,
  cfg: ScoringConfig,
  mint: string,
  h: { wallet: string; account: string | null; pct_supply: number },
  launchT: number | null,
): Promise<HolderEntry> {
  const out: HolderEntry = { wallet: h.wallet, pct_supply: h.pct_supply, entry_t: null, via: "unknown", from: null, after_launch_s: null, fresh_at_entry: false };
  if (!h.account) return out;
  const sigs = await rpc.getSignatures(h.account, undefined, 1000).catch(() => []);
  if (!sigs.length || sigs.length >= 1000) return out; // unreadable or too busy to reach the first acquisition

  // Oldest first: the account's creation tx normally IS the first buy/receipt; if it only created the
  // account (no balance change), the next one is.
  const oldest = sigs.slice(-2).reverse();
  for (const s of oldest) {
    const tx = await entryTx(rpc, s.signature, mint, cache);
    if (!tx) continue;
    const got = tx.deltas[h.wallet] ?? 0;
    if (got <= 0) continue;
    out.entry_t = tx.t;
    // Who gave up the tokens: the biggest loser of this mint in the tx.
    const [sender] = Object.entries(tx.deltas).filter(([o, d]) => o !== h.wallet && d < 0).sort((a, b) => a[1] - b[1]);
    // A pool/curve/vault (off-curve) giving up tokens = a buy. A real wallet giving them up = a transfer,
    // unless the holder itself signed and paid (a P2P swap/OTC it initiated still reads as a buy).
    if (sender && isWallet(sender[0]) && tx.feePayer !== h.wallet) {
      out.via = "transfer";
      out.from = sender[0];
    } else out.via = "buy";
    break;
  }
  if (out.entry_t !== null) {
    if (launchT !== null) out.after_launch_s = Math.max(0, out.entry_t - launchT);
    const page = await sigPage(rpc, h.wallet, cache).catch(() => null);
    // Birth is only knowable when the whole history fits one page; a busier wallet isn't a throwaway.
    if (page && page.count < 1000 && page.oldest_t !== null) out.fresh_at_entry = out.entry_t - page.oldest_t <= cfg.coin.entryFreshSeconds;
  }
  return out;
}

export async function readHolderEntries(
  rpc: SolanaRpc,
  cache: KV,
  cfg: ScoringConfig,
  mint: string,
  holders: { wallet: string; account: string | null; pct_supply: number }[],
  /** Best-known launch time (pump create / earliest pool). The earliest entry we see bounds it too. */
  launchHint: number | null,
  excludedFunders: Set<string>,
): Promise<EntryRead | null> {
  try {
    const top = holders.slice(0, cfg.coin.entryHolders);
    const entries = await Promise.all(top.map((h) => readEntry(rpc, cache, cfg, mint, h, launchHint)));
    // No hint (e.g. a launchpad coin whose DEX pool is the post-migration one): the earliest entry among
    // the top holders is the best available bound on launch.
    let launchT = launchHint;
    const earliest = Math.min(...entries.map((e) => e.entry_t ?? Infinity));
    if (Number.isFinite(earliest) && (launchT === null || earliest < launchT)) launchT = earliest;
    if (launchT !== null)
      for (const e of entries) if (e.entry_t !== null) e.after_launch_s = Math.max(0, e.entry_t - launchT);

    // A token transfer out of an exchange is a withdrawal, not routing — gate each sender once.
    const senders = [...new Set(entries.filter((e) => e.via === "transfer" && e.from).map((e) => e.from as string))];
    const serviceSender = new Map<string, boolean>();
    await Promise.all(
      senders.map(async (s) => {
        if (excludedFunders.has(s)) return serviceSender.set(s, true);
        const g = await funderGate(rpc, s, cache, {
          farmRecipients: cfg.coin.farmRecipients,
          exchangeBalanceSol: cfg.coin.exchangeBalanceSol,
          fanoutSampleTx: cfg.coin.fanoutSampleTx,
          serviceSpanHours: cfg.coin.serviceSpanHours,
        }).catch(() => null);
        serviceSender.set(s, !!g?.exchange);
      }),
    );
    const routed = (e: HolderEntry) => e.via === "transfer" && !!e.from && !serviceSender.get(e.from);
    const inWindow = (e: HolderEntry) => e.after_launch_s !== null && e.after_launch_s <= cfg.coin.entryLaunchWindowSeconds;

    const sum = (f: (e: HolderEntry) => boolean) => entries.filter(f).reduce((s, e) => s + e.pct_supply, 0);
    const byRouter = new Map<string, string[]>();
    for (const e of entries) if (routed(e)) byRouter.set(e.from!, [...(byRouter.get(e.from!) ?? []), e.wallet]);
    const pctOf = new Map(entries.map((e) => [e.wallet, e.pct_supply]));
    const routers = [...byRouter]
      .map(([from, members]) => ({ from, members, pct_total: members.reduce((s, w) => s + (pctOf.get(w) ?? 0), 0) }))
      .sort((a, b) => b.pct_total - a.pct_total);
    const sniper = (e: HolderEntry) => e.after_launch_s !== null && e.after_launch_s <= cfg.coin.entrySniperSeconds;
    const cohort = entries.filter((e) => sniper(e) || e.fresh_at_entry || routed(e));

    return {
      entries,
      launch_t: launchT,
      launch_window_pct: sum(inWindow),
      sniper_pct: sum(sniper),
      fresh_at_entry_pct: sum((e) => e.fresh_at_entry),
      routed_pct: sum(routed),
      routers,
      cohort_pct: cohort.reduce((s, e) => s + e.pct_supply, 0),
      cohort_count: cohort.length,
    };
  } catch {
    return null;
  }
}
