export type Grade = "S" | "A" | "B" | "C" | "D" | "F";
export type Label = "RUG" | "DUMP" | "WIN" | "LOSS" | "NEUTRAL";
export type TokenStatus = "scored" | "incomplete" | "no_price_data";
export type Confidence = "high" | "medium" | "low";

/** One transaction reduced to what it did to the wallet's balances. */
export interface TxDelta {
  signature: string;
  timestamp: number;
  /** SOL + wSOL change for the wallet, network fee added back. */
  solDelta: number;
  /** mint → change in UI units (decimals applied), wSOL excluded. */
  tokenDeltas: Record<string, number>;
  /** The wallet signed this transaction (false = someone else's tx touched it, e.g. airdrop spam). */
  signer: boolean;
}

export interface WalletSwap {
  signature: string;
  timestamp: number;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
}

export interface TokenTransfer {
  signature: string;
  timestamp: number;
  /** Signed, UI units. */
  amount: number;
}

export interface MintActivity {
  mint: string;
  swaps: WalletSwap[];
  transfers: TokenTransfer[];
  /** Multi-token transactions touching this mint (e.g. token→USDC routes) that v1 can't price. */
  ignoredTxs: number;
}

export type StopReason = "end_of_history" | "lookback_days" | "token_limit" | "tx_cap";

export interface ScanStats {
  source: string;
  signaturesSeen: number;
  txFetched: number;
  failedTx: number;
  swaps: number;
  transfers: number;
  /** Tokens pushed onto the wallet by someone else's transaction, no SOL involved. */
  airdrops: number;
  multiTokenTxsIgnored: number;
  unclassifiedTxs: number;
  oldestScanned: number | null;
  stopReason: StopReason;
  /** Tokens traded only inside the settle window (last 24h): too fresh to score. */
  pendingTokens: number;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  /** Candle length in seconds. */
  res: number;
  pool: string;
}

export interface PoolRef {
  address: string;
  dexId: string;
  createdAt: number | null;
  liquidityUsd: number;
}

export interface TokenMeta {
  mint: string;
  symbol: string | null;
  name: string | null;
  supply: number | null;
  logoUrl: string | null;
  /** Summed across the mint's pairs on Dexscreener. */
  volume24hUsd: number;
  /** SOL-quoted pools only. */
  pools: PoolRef[];
}

/** Per-token receipt. Prices are SOL per whole token. */
export interface TokenResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  status: TokenStatus;
  label: Label | null;
  notes: string[];

  // §5.2 caller book
  entry_time: number | null;
  exit_time: number | null;
  first_buy_sig: string | null;
  last_sell_sig: string | null;
  n_buys: number;
  n_sells: number;
  sol_spent: number;
  tokens_bought: number;
  sol_received: number;
  tokens_sold: number;
  tokens_transferred_in: number;
  tokens_transferred_out: number;
  fraction_sold: number | null;
  fully_exited: boolean;
  /** bought + transferred in − sold − transferred out, floored at 0. */
  tokens_held: number;
  /** Still holds more than the fully-exited remainder of what it bought. */
  position_open: boolean;
  last_trade_time: number | null;
  last_trade_side: "buy" | "sell" | null;
  entry_price: number | null;
  exit_vwap: number | null;
  wallet_roi: number | null;
  wallet_realized_pnl_sol: number | null;
  entry_mcap_sol: number | null;

  // Token trajectory
  pools: string[];
  market_price_at_entry: number | null;
  price_1h: number | null;
  price_6h: number | null;
  price_24h: number | null;
  price_7d: number | null;
  peak_price_after_entry: number | null;
  drawdown_after_exit: number | null;
  /** Exit was less than 24h ago, so the drawdown window isn't complete yet. */
  drawdown_window_partial: boolean;
  max_drop_from_peak_24h: number | null;

  // §5.3 follower book
  copy_entry_price: number | null;
  copy_return_24h: number | null;
  copy_peak_multiple: number | null;
  copy_return_follow_out: number | null;
}

export interface WalletScore {
  wallet: string;
  n_tokens: number;
  wins: number;
  losses: number;
  dumps: number;
  rugs: number;
  neutrals: number;
  follower_hit_rate: number | null;
  median_copy_return: number | null;
  dump_rate: number | null;
  rug_rate: number | null;
  wallet_realized_pnl_sol: number;
  /** Longest run of consecutive WINs, in entry order, over scored tokens. */
  longest_win_streak: number;
  /** Tokens (any status) the wallet still meaningfully holds. */
  open_positions: number;
  /** Mints with any swap inside the active window (config activeWindowSeconds, default 48h). */
  active_now: string[];
  /** Subset of active_now whose most recent trade was a sell — what they're exiting right now. */
  selling_now: string[];
  /** Open positions held ≥ diamondMinHoldSeconds with under diamondMaxFractionSold sold, not RUGs.
      The anti-DUMP receipt: they stayed in the trade they put followers into. */
  diamond_hands: string[];
  unproven: boolean;
  /** The headline: 0–10, higher = safer to follow. null when unproven (no fake precision). */
  karma_score: number | null;
  grade: Grade | null;
  title: string | null;
  confidence: Confidence;
  verdict: string;
  coverage: { scored: number; incomplete: number; no_price_data: number; pending: number };
}

export interface WalletReport {
  wallet: string;
  computed_at: number;
  config_version: string;
  /** Current SOL/USD at compute time, for displaying PnL in dollars. Null if the price fetch failed. */
  sol_price_usd: number | null;
  scan: ScanStats;
  score: WalletScore;
  tokens: TokenResult[];
}
