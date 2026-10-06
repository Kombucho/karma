import type { KV } from "../cache";
import { MAJOR_MINTS } from "../constants";
import type { ScoringConfig } from "../scoring.config";
import { getTokenMeta } from "../sources/dexscreener";
import type { SolanaRpc } from "../sources/solana";

/** One token's activity inside the live window, ready to render as a chip. */
export interface LiveMint {
  mint: string;
  symbol: string | null;
  logo_url: string | null;
  last_side: "buy" | "sell";
  last_trade_time: number;
  n_buys: number;
  n_sells: number;
  sol_spent: number;
  sol_received: number;
  /** max(spent, received) ÷ current wallet SOL balance. Null when the balance fetch failed or is 0. */
  pct_of_balance: number | null;
  /** Position volume exceeds liveConvictionFraction of the wallet's balance — sized like they mean it. */
  conviction: boolean;
}

export interface LiveActivity {
  wallet: string;
  checked_at: number;
  window_seconds: number;
  /** Current SOL balance — the denominator for pct_of_balance. Note: this is the balance NOW, after the trades. */
  wallet_sol_balance: number | null;
  tokens: LiveMint[];
  /** Mints whose most recent trade in the window was a sell. */
  selling_now: string[];
  buying_now: string[];
  /** Conviction-size positions being built or held, not exited: net SOL still in the trade. */
  betting_now: string[];
  /** Probe hit its tx cap before reaching the window edge — a bot-like wallet, there may be more. */
  partial: boolean;
}

/**
 * Cheap freshness probe: walk only the last activeWindowSeconds of history (fits inside
 * PublicNode's ~2.5-day keyless ledger) and classify swaps. Deltas are cached forever,
 * so repeated probes only pay for transactions that are actually new.
 */
export async function probeLive(rpc: SolanaRpc, wallet: string, cfg: ScoringConfig, now: number, cache: KV): Promise<LiveActivity> {
  const cutoff = now - cfg.activeWindowSeconds;
  const CHUNK = 50;

  // Collect in-window signatures first (cheap), newest first, capped
  const sigs: Array<{ signature: string; blockTime: number | null }> = [];
  let partial = false;
  let before: string | undefined;
  scan: while (true) {
    const page = await rpc.getSignatures(wallet, before, Math.min(cfg.liveProbeMaxTx, 1000));
    if (!page.length) break;
    for (const sig of page) {
      if (sig.blockTime !== null && sig.blockTime < cutoff) break scan;
      if (sig.err) continue;
      if (sigs.length >= cfg.liveProbeMaxTx) {
        partial = true;
        break scan;
      }
      sigs.push(sig);
    }
    if (page.length < Math.min(cfg.liveProbeMaxTx, 1000)) break;
    before = page[page.length - 1].signature;
  }

  // Fetch deltas in parallel chunks (rate limiter spaces the requests), classify in newest-first order
  const byMint = new Map<string, Omit<LiveMint, "symbol" | "logo_url" | "pct_of_balance" | "conviction">>();
  for (let i = 0; i < sigs.length; i += CHUNK) {
    const chunk = sigs.slice(i, i + CHUNK);
    const deltas = await Promise.all(chunk.map((s) => rpc.getWalletDelta(s.signature, wallet, s.blockTime)));
    for (const d of deltas) {
      if (!d || !d.signer) continue;

      // Same shape as the scan classifier, but with the live-strip significance floor instead of the dust floor
      const entries = Object.entries(d.tokenDeltas);
      if (entries.length !== 1 || Math.abs(d.solDelta) < cfg.liveMinSwapSol) continue;
      const [mint, amount] = entries[0];
      if (MAJOR_MINTS.has(mint)) continue;
      const side = amount > 0 && d.solDelta < 0 ? "buy" : amount < 0 && d.solDelta > 0 ? "sell" : null;
      if (!side) continue;

      let m = byMint.get(mint);
      if (!m) {
        // Newest-first walk: the first swap seen for a mint is its latest
        m = { mint, last_side: side, last_trade_time: d.timestamp, n_buys: 0, n_sells: 0, sol_spent: 0, sol_received: 0 };
        byMint.set(mint, m);
      }
      if (side === "buy") {
        m.n_buys++;
        m.sol_spent += -d.solDelta;
      } else {
        m.n_sells++;
        m.sol_received += d.solDelta;
      }
    }
  }

  // A position someone could be dumped on, not micro-churn. Filtering before meta also saves Dexscreener calls.
  const significant = [...byMint.values()]
    .filter((m) => m.sol_spent + m.sol_received >= cfg.liveMinPositionSol)
    .sort((a, b) => b.last_trade_time - a.last_trade_time);

  const balance = await rpc.getBalance(wallet).catch(() => null);

  const tokens: LiveMint[] = [];
  for (const m of significant) {
    const meta = await getTokenMeta(m.mint, cache).catch(() => null);
    const pct = balance ? Math.max(m.sol_spent, m.sol_received) / balance : null;
    tokens.push({
      ...m,
      symbol: meta?.symbol ?? null,
      logo_url: meta?.logoUrl ?? null,
      pct_of_balance: pct,
      conviction: pct !== null && pct >= cfg.liveConvictionFraction,
    });
  }

  return {
    wallet,
    checked_at: now,
    window_seconds: cfg.activeWindowSeconds,
    wallet_sol_balance: balance,
    tokens,
    selling_now: tokens.filter((t) => t.last_side === "sell").map((t) => t.mint),
    buying_now: tokens.filter((t) => t.last_side === "buy").map((t) => t.mint),
    betting_now: tokens.filter((t) => t.conviction && t.last_side === "buy" && t.sol_received < t.sol_spent).map((t) => t.mint),
    partial,
  };
}
