import type { KV } from "../cache";
import type { RpcTransaction, SolanaRpc } from "./solana";

/**
 * The shared reads a coin scan makes about a wallet, fetched ONCE per wallet no matter how many lenses
 * ask. Before this, the age probe, the cluster lens, the crowd sample and the exchange gate each pulled
 * the same signature page and the same first transaction on their own — ~40% of a cold scan's calls
 * were duplicates. In-flight promises are shared too, so two lenses asking at the same instant still
 * cost one call.
 */

const inflight = new Map<string, Promise<unknown>>();

async function once<T>(cache: KV, key: string, ttl: number | undefined, load: () => Promise<T | null>): Promise<T | null> {
  const hit = await cache.get<{ v: T }>(key);
  if (hit) return hit.v;
  const running = inflight.get(key);
  if (running) return running as Promise<T | null>;
  const p = load()
    .then(async (v) => {
      if (v !== null) await cache.set(key, { v }, ttl); // a miss (null) stays uncached so a later scan retries
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** A wallet's newest signature page (up to 1000), boiled down to what the scan lenses read from it. */
export interface SigPage {
  /** Signatures on the page (1000 = full page, the wallet has at least this many). */
  count: number;
  /** Oldest signature on the page and its time. When count < 1000 this is the wallet's first tx ever. */
  oldest_sig: string | null;
  oldest_t: number | null;
  newest_t: number | null;
  /** Up to 40 signatures strided across the page — a sample of the wallet's whole visible life. */
  strided: string[];
}

/** The newest signature page. Short TTL: it grows, but inside one scan every lens reads the same one. */
export function sigPage(rpc: SolanaRpc, wallet: string, cache: KV): Promise<SigPage> {
  return once(cache, `sigpage:${wallet}`, 600, async () => {
    const sigs = await rpc.getSignatures(wallet, undefined, 1000);
    const stride = Math.max(1, Math.floor(sigs.length / 40));
    return {
      count: sigs.length,
      oldest_sig: sigs.at(-1)?.signature ?? null,
      oldest_t: sigs.at(-1)?.blockTime ?? null,
      newest_t: sigs[0]?.blockTime ?? null,
      strided: sigs.filter((_, i) => i % stride === 0).slice(0, 40).map((s) => s.signature),
    };
  }) as Promise<SigPage>;
}

/** The oldest signature one page further back than `before`. For walking a busy wallet toward its birth. */
export function olderPage(rpc: SolanaRpc, wallet: string, before: string, cache: KV): Promise<{ count: number; oldest_sig: string | null } | null> {
  return once(cache, `sigolder:${wallet}:${before}`, undefined, async () => {
    const sigs = await rpc.getSignatures(wallet, before, 1000);
    return { count: sigs.length, oldest_sig: sigs.at(-1)?.signature ?? null };
  });
}

/** A finalized transaction reduced to account keys and SOL balances. Immutable → cached forever. */
export interface TxBalances {
  keys: string[];
  pre: number[];
  post: number[];
  t: number | null;
}

export function txBalances(rpc: SolanaRpc, sig: string, cache: KV): Promise<TxBalances | null> {
  return once(cache, `txbal:${sig}`, undefined, async () => {
    // Free-tier RPCs occasionally return null for a finalized tx that exists; one retry recovers most.
    for (let attempt = 0; attempt < 2; attempt++) {
      const tx = await rpc
        .call<RpcTransaction | null>("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }])
        .catch(() => null);
      if (tx?.meta)
        return {
          keys: tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey)),
          pre: tx.meta.preBalances,
          post: tx.meta.postBalances,
          t: tx.blockTime,
        };
    }
    return null;
  });
}

/** Program accounts SOL touches in passing — never a funder, never a "wallet it funded". */
export const NON_WALLET_ACCOUNTS = new Set([
  "11111111111111111111111111111111", // System
  "ComputeBudget111111111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // Associated Token
]);

/** Where SOL went out of `from` in one transaction: distinct recipients and SOL sent. */
export function outboundOf(tx: TxBalances, from: string): { recipients: string[]; out_sol: number } {
  const fIdx = tx.keys.indexOf(from);
  if (fIdx < 0 || tx.post[fIdx] - tx.pre[fIdx] >= 0) return { recipients: [], out_sol: 0 };
  const recipients: string[] = [];
  for (let i = 0; i < tx.keys.length; i++) {
    if (i === fIdx || NON_WALLET_ACCOUNTS.has(tx.keys[i])) continue;
    if (tx.post[i] - tx.pre[i] > 0) recipients.push(tx.keys[i]);
  }
  return { recipients, out_sol: (tx.pre[fIdx] - tx.post[fIdx]) / 1e9 };
}

/**
 * How widely a wallet sprays SOL: distinct recipients of plain SOL transfers, plus SOL sent and the
 * time window. Helius path: the newest 100 transactions plus 100 from the far end of the signature page
 * (a farm's funding burst is often early) — 2 calls instead of 40. Plain-RPC fallback: the strided
 * sample, fetched in parallel. Short-TTL cached: reach grows.
 */
export interface Spray {
  recipients: string[];
  out_sol: number;
  sampled_txs: number;
  window_min: number | null;
}

export function sprayOf(rpc: SolanaRpc, wallet: string, cache: KV, page: SigPage, sampleTx: number, deep: boolean): Promise<Spray> {
  return once(cache, `spray:${deep ? "deep" : "recent"}:${wallet}`, 300, async () => {
    const recipients = new Set<string>();
    let out = 0;
    let sampled = 0;
    const times: number[] = [];

    const enhanced = await Promise.all([
      rpc.enhancedTransactions(wallet).catch(() => null),
      // The far end of the page, where an early funding burst lives. Only worth it when the page is deep.
      deep && page.count > 100 && page.strided.length > 1
        ? rpc.enhancedTransactions(wallet, { before: page.strided[Math.floor(page.strided.length * 0.75)] }).catch(() => null)
        : Promise.resolve([]),
    ]);
    if (enhanced[0]) {
      const seen = new Set<string>();
      for (const tx of [...enhanced[0], ...(enhanced[1] ?? [])]) {
        if (seen.has(tx.signature)) continue;
        seen.add(tx.signature);
        sampled++;
        if (tx.timestamp) times.push(tx.timestamp);
        // Plain transfers only: a swap pays pools and fee vaults, which aren't wallets anyone "funded".
        if (tx.type !== "TRANSFER") continue;
        for (const n of tx.nativeTransfers ?? []) {
          if (n.fromUserAccount !== wallet || n.toUserAccount === wallet || NON_WALLET_ACCOUNTS.has(n.toUserAccount)) continue;
          recipients.add(n.toUserAccount);
          out += n.amount / 1e9;
        }
      }
    } else {
      const txs = await Promise.all(page.strided.slice(0, sampleTx).map((s) => txBalances(rpc, s, cache).catch(() => null)));
      for (const tx of txs) {
        if (!tx) continue;
        sampled++;
        if (tx.t) times.push(tx.t);
        const o = outboundOf(tx, wallet);
        o.recipients.forEach((r) => recipients.add(r));
        out += o.out_sol;
      }
    }
    return {
      recipients: [...recipients],
      out_sol: Math.round(out * 1000) / 1000,
      sampled_txs: sampled,
      window_min: times.length >= 2 ? Math.round((Math.max(...times) - Math.min(...times)) / 60) : null,
    };
  }) as Promise<Spray>;
}

/**
 * Is this funder a SERVICE — an exchange hot wallet, a bridge solver, a relayer — rather than a person?
 * The one question every shared-funder lens must answer before it calls a group "one actor", answered
 * the SAME way everywhere.
 *
 * Lesson paid for on 25 Sep 2026: every "faucet" we flagged that day was a service. F7p3dF, the "$Brim
 * insider purse", is Solscan's "Relay: Solver" (a cross-chain bridge that pays a newcomer's first SOL);
 * the others were Coinbase 1, Coinbase 2 and Bybit Wallet 10. Balance can't separate them — Bybit 10
 * held 132 SOL, the Relay solver 4.5k — but THROUGHPUT does: each burned through 1,000 transactions in
 * under 4 hours, around the clock. A hand-run insider purse seeds its dozen decoys and goes quiet.
 *
 * So: service = sprays SOL to farm-scale distinct recipients AND (a full 1,000-signature page inside
 * `serviceSpanHours`, OR exchange-scale reserves). A wallet sharing a service as first funder is a
 * stranger who used the same on-ramp — NOT evidence of coordination. The insider signal among such
 * wallets is timing (sources/holder-entry.ts), not the funder.
 */
export interface FunderGate {
  exchange: boolean;
  balance_sol: number | null;
  /** Distinct wallets it sent plain SOL to in the sampled window. */
  recipients: number;
  /** A non-service that sprays farm-scale in bursts: a genuine seeding purse, not an on-ramp. */
  faucet: boolean;
  /** Hours spanned by its newest 1,000 signatures (null when the page isn't full). */
  page_span_hours: number | null;
  spray: Spray | null;
  page: SigPage | null;
}

export function funderGate(
  rpc: SolanaRpc,
  funder: string,
  cache: KV,
  cfg: { farmRecipients: number; exchangeBalanceSol: number; fanoutSampleTx: number; serviceSpanHours: number },
  /** Also read the far end of the page (an early funding burst). The exchange test alone doesn't need it —
   * an exchange or live faucet shows in its newest 100 txns — and the deep read is the slowest call. */
  deep = false,
): Promise<FunderGate> {
  return once(cache, `gate3:${deep ? "deep" : "recent"}:${funder}`, 300, async () => {
    const [balance, page] = await Promise.all([
      rpc.getBalance(funder).catch(() => null),
      sigPage(rpc, funder, cache).catch(() => null),
    ]);
    // Below the farm floor in lifetime txns it can't have sprayed a farm — skip the transaction read.
    const spray = page && page.count >= cfg.farmRecipients ? await sprayOf(rpc, funder, cache, page, cfg.fanoutSampleTx, deep).catch(() => null) : null;
    const recipients = spray?.recipients.length ?? 0;
    const sprays = recipients >= cfg.farmRecipients;
    const rich = balance !== null && balance >= cfg.exchangeBalanceSol;
    const spanHours = page && page.count >= 1000 && page.newest_t && page.oldest_t ? (page.newest_t - page.oldest_t) / 3600 : null;
    const busy = spanHours !== null && spanHours <= cfg.serviceSpanHours;
    const service = sprays && (busy || rich);
    return { exchange: service, balance_sol: balance, recipients, faucet: sprays && !service, spray, page, page_span_hours: spanHours };
  }) as Promise<FunderGate>;
}
