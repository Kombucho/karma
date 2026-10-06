import { MemoryCache, type KV } from "../cache";
import { SCORING, type ScoringConfig } from "../scoring.config";
import { getSolPriceUsd, getTokenMeta } from "../sources/dexscreener";
import { SolanaRpc } from "../sources/solana";
import type { TokenResult, WalletReport } from "../types";
import { collectActivity } from "./activity";
import { aggregate } from "./rules";
import { evaluateToken } from "./token";

export interface ScoreOptions {
  config?: ScoringConfig;
  cache?: KV;
  rpc?: SolanaRpc;
  /** Unix seconds. Pin it to make re-runs reproducible (and fully cached). */
  now?: number;
  onProgress?: (msg: string) => void;
}

/** Full pipeline for one wallet: history → per-token reconstruction → trajectories → labels → grade. */
export async function scoreWallet(wallet: string, opts: ScoreOptions = {}): Promise<WalletReport> {
  const cfg = opts.config ?? SCORING;
  const cache = opts.cache ?? new MemoryCache();
  const rpc = opts.rpc ?? SolanaRpc.fromEnv(cache);
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const log = opts.onProgress ?? (() => {});

  const { selected, stats } = await collectActivity(rpc, wallet, cfg, now, log);

  const tokens: TokenResult[] = [];
  for (const [i, act] of selected.entries()) {
    const meta = await getTokenMeta(act.mint, cache);
    log(`[${i + 1}/${selected.length}] ${meta.symbol ?? act.mint.slice(0, 8)}: price history`);
    tokens.push(await evaluateToken(act, meta, cfg, now, cache));
  }

  return {
    wallet,
    computed_at: now,
    config_version: cfg.version,
    sol_price_usd: await getSolPriceUsd(cache),
    scan: stats,
    score: aggregate(wallet, tokens, stats.pendingTokens, cfg, now),
    tokens,
  };
}
