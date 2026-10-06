import type { KV } from "../cache";
import { WSOL_MINT } from "../constants";
import { QuotaError, RateLimiter, fetchJson, sleep } from "../http";
import type { TxDelta } from "../types";

const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
// Measured 14 Sep 2026: getTransaction allows 10 calls per 10s per IP on the public endpoint
const PUBLIC_RPS = 0.9;
// Fast and keyless, but its ledger only reaches back ~2.5 days. Used for recent transactions when there's no Helius key.
const PUBLICNODE_RPC = "https://solana-rpc.publicnode.com";
const PUBLICNODE_RPS = 10;
const PUBLICNODE_WINDOW_SECONDS = 2 * 86400;
// Measured 25 Sep 2026: 10/s sustained draws ~15% 429s on getSignaturesForAddress/getTransaction, 8/s ~6%.
// JSON-RPC batches count per item, so they buy nothing here.
const HELIUS_FREE_RPS = 8;
// Helius Enhanced Transactions (100 parsed txs per call) sits on its own, slower bucket.
const HELIUS_ENHANCED_RPS = 5;

/**
 * Standard methods any ARCHIVAL Solana RPC serves identically, so a pool can spread them across providers.
 * DAS stays on Helius. A peer in SOLANA_RPC_EXTRA_URLS must keep full history: a truncated one would make
 * old wallets look newborn.
 */
const POOLABLE = new Set(["getSignaturesForAddress", "getTransaction", "getBalance", "getMultipleAccounts", "getAccountInfo"]);

/**
 * Methods that read CURRENT state, which a non-archival node serves as well as an archival one. These go
 * to the state node (PUBLICNODE_SOLANA_URL) when set. Measured from Vercel 25 Sep 2026 with a personal
 * PublicNode token: 40 calls/s with zero errors (5x Helius free), but getSignaturesForAddress only reaches
 * back ~2 days and old transactions come back null. So history NEVER goes there; getTransaction tries it
 * first and falls back to Helius on a miss.
 */
const STATE_METHODS = new Set(["getBalance", "getMultipleAccounts", "getAccountInfo", "getTokenSupply", "getTokenLargestAccounts"]);
const STATE_RPS = 30;

/** History reads: only an archival node may answer these, or old wallets look newborn. */
const HISTORY_METHODS = new Set(["getSignaturesForAddress", "getTransaction"]);
/** Helius-only (DAS). No fallback serves them; the caller already degrades (top-20 holders via largest accounts). */
const DAS_METHODS = new Set(["getTokenAccounts", "getAsset", "getAssetsByOwner"]);

/**
 * Last-resort keyless endpoints, tried in order when the primary throws or its quota is spent (measured
 * 6 Oct 2026 with Helius at "max usage reached"). Tatum serves current state (supply, largest accounts) but
 * not history; mainnet-beta is archival but ~1 call/s and throttles getTokenLargestAccounts hard; keyless
 * PublicNode is fast but keeps ~2 days of ledger, so it never answers history.
 */
const FALLBACKS: { url: string; label: string; rps: number; archival: boolean }[] = [
  { url: PUBLICNODE_RPC, label: "PublicNode (fallback)", rps: PUBLICNODE_RPS, archival: false },
  { url: "https://solana-mainnet.gateway.tatum.io", label: "Tatum (fallback)", rps: 3, archival: false },
  { url: PUBLIC_RPC, label: "public Solana RPC (fallback)", rps: PUBLIC_RPS, archival: true },
];

/** A provider whose quota is spent sits out this long, process-wide, instead of failing every call slowly. */
const DEAD_FOR_MS = 10 * 60_000;
const UNREACHABLE_FOR_MS = 2 * 60_000;
const deadUntil = new Map<string, number>();

/** One native SOL movement in a Helius-parsed transaction. */
export interface EnhancedTx {
  signature: string;
  timestamp: number;
  type: string;
  nativeTransfers?: { fromUserAccount: string; toUserAccount: string; amount: number }[];
}

export interface SignatureInfo {
  signature: string;
  blockTime: number | null;
  err: unknown;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface RpcTransaction {
  blockTime: number | null;
  meta: {
    err: unknown;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
  } | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: (string | { pubkey: string })[];
      header?: { numRequiredSignatures: number };
    };
  };
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

export class SolanaRpc {
  private readonly limiter: RateLimiter;
  private nextId = 1;
  /** Optional faster endpoint for transactions younger than PUBLICNODE_WINDOW_SECONDS. */
  recent?: SolanaRpc;
  /**
   * Extra providers (Alchemy, QuickNode, Triton… free tiers) for the standard methods. Each has its own
   * rate budget, so N providers ≈ N× the calls per second a cold scan can spend. SOLANA_RPC_EXTRA_URLS.
   */
  peers: SolanaRpc[] = [];
  /** A fast non-archival node for current-state reads and recent transactions. PUBLICNODE_SOLANA_URL. */
  state?: SolanaRpc;
  /** Keyless endpoints tried in order when this one fails or is out of quota. See FALLBACKS. */
  fallbacks: SolanaRpc[] = [];
  /** Whether this node keeps full ledger history (fallbacks only; the primary is assumed archival). */
  archival = true;
  /** Helius key, when present: unlocks the Enhanced Transactions API (100 parsed txs in one call). */
  heliusKey?: string;
  /** A secondary node fails fast (one retry, 8s timeout) so the primary picks the call up quickly. */
  maxRetries = 6;
  private readonly enhancedLimiter = new RateLimiter(1000 / HELIUS_ENHANCED_RPS);

  constructor(
    private readonly url: string,
    readonly label: string,
    rps: number,
    private readonly cache: KV,
  ) {
    this.limiter = new RateLimiter(1000 / rps);
  }

  static fromEnv(cache: KV): SolanaRpc {
    const { SOLANA_RPC_URL, SOLANA_RPC_RPS, HELIUS_API_KEY, SOLANA_RPC_EXTRA_URLS } = process.env;
    const withPeers = (rpc: SolanaRpc) => {
      if (process.env.PUBLICNODE_SOLANA_URL) {
        rpc.state = new SolanaRpc(process.env.PUBLICNODE_SOLANA_URL, "PublicNode (state)", STATE_RPS, cache);
        rpc.state.maxRetries = 1;
      }
      rpc.fallbacks = FALLBACKS.map((f) => {
        const fb = new SolanaRpc(f.url, f.label, f.rps, cache);
        fb.archival = f.archival;
        fb.maxRetries = 1;
        return fb;
      });
      // "url|rps,url|rps" — each extra free-tier provider adds its own budget to the pool.
      for (const entry of (SOLANA_RPC_EXTRA_URLS ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
        const [url, rps] = entry.split("|");
        rpc.peers.push(new SolanaRpc(url, "peer RPC", Number(rps ?? 5), cache));
      }
      return rpc;
    };
    if (SOLANA_RPC_URL) return withPeers(new SolanaRpc(SOLANA_RPC_URL, "custom RPC", Number(SOLANA_RPC_RPS ?? 5), cache));
    if (HELIUS_API_KEY) {
      // Paying for a higher Helius tier is a one-var upgrade: set SOLANA_RPC_RPS to the plan's
      // RPS (Developer ≈ 50) and every scan gets proportionally faster. Default = free tier.
      const rpc = new SolanaRpc(
        `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`,
        "Helius RPC",
        Number(SOLANA_RPC_RPS ?? HELIUS_FREE_RPS),
        cache,
      );
      rpc.heliusKey = HELIUS_API_KEY;
      return withPeers(rpc);
    }
    const rpc = new SolanaRpc(PUBLIC_RPC, "public Solana RPC + PublicNode for recent tx (set HELIUS_API_KEY)", PUBLIC_RPS, cache);
    rpc.recent = new SolanaRpc(PUBLICNODE_RPC, "PublicNode", PUBLICNODE_RPS, cache);
    return rpc;
  }

  // params is usually a positional array, but DAS methods (getTokenAccounts) take a named-arg object.
  async call<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    if (this.state && STATE_METHODS.has(method)) return this.state.callDirect<T>(method, params).catch(() => this.callDirect<T>(method, params));
    // A transaction the state node still has (recent) costs Helius nothing; an old one comes back null there.
    if (this.state && method === "getTransaction") {
      const hit = await this.state.callDirect<T | null>(method, params).catch(() => null);
      if (hit) return hit;
    }
    // Route a standard call to whichever provider in the pool has the shortest queue right now.
    if (this.peers.length && POOLABLE.has(method)) {
      const best = [this, ...this.peers].reduce((a, b) => (b.limiter.backlogMs() < a.limiter.backlogMs() ? b : a));
      if (best !== this) return best.callDirect<T>(method, params).catch(() => this.withFallbacks<T>(method, params));
    }
    return this.withFallbacks<T>(method, params);
  }

  /** The primary, then each eligible fallback in order. A fallback's null transaction is a miss, not an answer. */
  private async withFallbacks<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    let lastErr: unknown;
    try {
      return await this.callDirect<T>(method, params);
    } catch (e) {
      lastErr = e;
    }
    if (DAS_METHODS.has(method)) throw lastErr;
    for (const fb of this.fallbacks) {
      if (HISTORY_METHODS.has(method) && !fb.archival) continue;
      try {
        const res = await fb.callDirect<T>(method, params);
        if (res === null && method === "getTransaction") continue;
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  private isDead(): boolean {
    return (deadUntil.get(this.url) ?? 0) > Date.now();
  }

  private markIfSpent(e: unknown) {
    if (e instanceof QuotaError || (e instanceof Error && /max usage|quota/i.test(e.message))) {
      if (!this.isDead()) console.warn(`[rpc] ${this.label} out of quota, skipping it for ${DEAD_FOR_MS / 60_000} min`);
      deadUntil.set(this.url, Date.now() + DEAD_FOR_MS);
    }
  }

  private async callDirect<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    if (this.isDead()) throw new Error(`${method}: ${this.label} out of quota`);
    try {
      return await this.callOnce<T>(method, params);
    } catch (e) {
      this.markIfSpent(e);
      // A secondary node that can't be reached at all (timeout, refused, blocked) sits out briefly too,
      // so a dead fallback costs one 8s timeout per scan rather than one per call.
      if (this.maxRetries < 6 && e instanceof Error && (e.name === "TimeoutError" || e.name === "TypeError"))
        deadUntil.set(this.url, Math.max(deadUntil.get(this.url) ?? 0, Date.now() + UNREACHABLE_FOR_MS));
      throw e;
    }
  }

  private async callOnce<T>(method: string, params: unknown[] | Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchJson<RpcResponse<T>>(
        this.url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
        },
        { limiter: this.limiter, retries: this.maxRetries, timeoutMs: this.maxRetries < 6 ? 8_000 : undefined },
      );
      if (!res.error) return res.result as T;
      const retryable = res.error.code === -32429 || /rate|too many/i.test(res.error.message);
      if (!retryable || attempt >= this.maxRetries) throw new Error(`${method}: ${res.error.message}`);
      const wait = Math.min(30_000, 1000 * 2 ** attempt);
      this.limiter.penalize(Math.min(wait, 750)); // see fetchJson: never freeze the whole queue
      await sleep(wait);
    }
  }

  /**
   * Helius Enhanced Transactions: up to 100 of an address's transactions, already parsed into native
   * transfers, in ONE call — what would otherwise cost 100 getTransaction calls. Newest first; `before`
   * pages back. Null when there's no Helius key, so callers fall back to plain RPC.
   */
  async enhancedTransactions(address: string, opts: { before?: string; limit?: number } = {}): Promise<EnhancedTx[] | null> {
    if (!this.heliusKey || this.isDead()) return null;
    const q = new URLSearchParams({ "api-key": this.heliusKey, limit: String(opts.limit ?? 100) });
    if (opts.before) q.set("before", opts.before);
    try {
      return await fetchJson<EnhancedTx[]>(`https://api-mainnet.helius-rpc.com/v0/addresses/${address}/transactions?${q}`, {}, { limiter: this.enhancedLimiter, retries: 3 });
    } catch (e) {
      // Same key, same quota: a spent key sends callers down their plain-RPC path instead of failing the scan.
      if (e instanceof QuotaError) {
        this.markIfSpent(e);
        return null;
      }
      throw e;
    }
  }

  getSignatures(address: string, before?: string, limit = 1000) {
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, { limit, ...(before ? { before } : {}) }]);
  }

  /** Current SOL balance in whole SOL. */
  async getBalance(address: string): Promise<number> {
    const res = await this.call<{ value: number }>("getBalance", [address]);
    return res.value / 1e9;
  }

  /** What a finalized transaction did to `wallet`. Transactions are immutable, so this is cached forever. */
  async getWalletDelta(signature: string, wallet: string, blockTime: number | null = null): Promise<TxDelta | null> {
    const key = `delta2:${wallet}:${signature}`;
    const hit = await this.cache.get<{ d: TxDelta | null }>(key);
    if (hit) return hit.d;

    const params = [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }];
    const isRecent = blockTime !== null && Date.now() / 1000 - blockTime < PUBLICNODE_WINDOW_SECONDS;
    let tx: RpcTransaction | null = null;
    if (this.recent && isRecent)
      tx = await this.recent.call<RpcTransaction | null>("getTransaction", params).catch(() => null);
    tx ??= await this.call<RpcTransaction | null>("getTransaction", params);
    if (!tx) return null; // not available yet, don't cache the miss

    const d = extractWalletDelta(tx, wallet);
    await this.cache.set(key, { d });
    return d;
  }
}

/**
 * Reduce a transaction to the wallet's SOL and token balance changes.
 * wSOL counts as SOL; the network fee is added back when the wallet paid it,
 * so the SOL leg reflects the trade rather than the fee.
 */
export function extractWalletDelta(tx: RpcTransaction, wallet: string): TxDelta | null {
  const meta = tx.meta;
  if (!meta || meta.err || !tx.blockTime) return null;

  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  if (meta.loadedAddresses && keys.length < meta.preBalances.length)
    keys.push(...meta.loadedAddresses.writable, ...meta.loadedAddresses.readonly);

  const idx = keys.indexOf(wallet);
  // Signers come first in the static key list; loaded (lookup-table) addresses never sign
  const signer = idx >= 0 && idx < (tx.transaction.message.header?.numRequiredSignatures ?? 1);
  let lamports = 0;
  if (idx >= 0) {
    lamports = meta.postBalances[idx] - meta.preBalances[idx];
    if (idx === 0) lamports += meta.fee;
  }

  const accounts = new Map<number, { mint: string; owner?: string; decimals: number; pre: number; post: number }>();
  for (const b of meta.preTokenBalances ?? [])
    accounts.set(b.accountIndex, {
      mint: b.mint,
      owner: b.owner,
      decimals: b.uiTokenAmount.decimals,
      pre: Number(b.uiTokenAmount.amount),
      post: 0,
    });
  for (const b of meta.postTokenBalances ?? []) {
    const a = accounts.get(b.accountIndex);
    if (a) {
      a.post = Number(b.uiTokenAmount.amount);
      a.owner ??= b.owner;
    } else {
      accounts.set(b.accountIndex, {
        mint: b.mint,
        owner: b.owner,
        decimals: b.uiTokenAmount.decimals,
        pre: 0,
        post: Number(b.uiTokenAmount.amount),
      });
    }
  }

  let wsol = 0;
  const tokenDeltas: Record<string, number> = {};
  for (const a of accounts.values()) {
    if (a.owner !== wallet || a.post === a.pre) continue;
    const ui = (a.post - a.pre) / 10 ** a.decimals;
    if (a.mint === WSOL_MINT) wsol += ui;
    else tokenDeltas[a.mint] = (tokenDeltas[a.mint] ?? 0) + ui;
  }

  if (idx < 0 && wsol === 0 && Object.keys(tokenDeltas).length === 0) return null;
  return {
    signature: tx.transaction.signatures[0],
    timestamp: tx.blockTime,
    solDelta: lamports / 1e9 + wsol,
    tokenDeltas,
    signer,
  };
}
