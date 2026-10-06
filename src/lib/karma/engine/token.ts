import type { KV } from "../cache";
import type { ScoringConfig } from "../scoring.config";
import { MINUTE_1, MINUTE_15, getCandles } from "../sources/geckoterminal";
import type { Candle, MintActivity, PoolRef, TokenMeta, TokenResult } from "../types";
import { PriceSeries } from "./prices";
import { labelFor } from "./rules";

const DAY = 86400;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** §5.2: rebuild the wallet's position in one token from its swaps. */
export function reconstruct(act: MintActivity, meta: TokenMeta | undefined, cfg: ScoringConfig): TokenResult {
  const swaps = [...act.swaps].sort((a, b) => a.timestamp - b.timestamp);
  const buys = swaps.filter((s) => s.side === "buy");
  const sells = swaps.filter((s) => s.side === "sell");
  const sol_spent = sum(buys.map((s) => s.solAmount));
  const tokens_bought = sum(buys.map((s) => s.tokenAmount));
  const sol_received = sum(sells.map((s) => s.solAmount));
  const tokens_sold = sum(sells.map((s) => s.tokenAmount));
  const entry_price = tokens_bought > 0 ? sol_spent / tokens_bought : null;
  const exit_vwap = tokens_sold > 0 ? sol_received / tokens_sold : null;
  const fraction_sold = tokens_bought > 0 ? tokens_sold / tokens_bought : null;

  // Realized only: the sold portion against its share of the cost
  let wallet_roi: number | null = null;
  let pnl: number | null = null;
  if (entry_price !== null && exit_vwap !== null) {
    const qty = Math.min(tokens_sold, tokens_bought);
    const cost = qty * entry_price;
    pnl = qty * exit_vwap - cost;
    wallet_roi = cost > 0 ? pnl / cost : null;
  }

  const tokens_transferred_in = sum(act.transfers.filter((t) => t.amount > 0).map((t) => t.amount));
  const tokens_transferred_out = -sum(act.transfers.filter((t) => t.amount < 0).map((t) => t.amount));
  const tokens_held = Math.max(0, tokens_bought + tokens_transferred_in - tokens_sold - tokens_transferred_out);
  const lastSwap = swaps.at(-1);
  const notes: string[] = [];
  if (act.ignoredTxs) notes.push(`${act.ignoredTxs} multi-token tx ignored (non-SOL route)`);
  if (tokens_transferred_in > 0.05 * tokens_bought) notes.push("received tokens by transfer, wallet ROI may be off");
  if (tokens_transferred_out > 0.05 * tokens_bought) notes.push("sent tokens to another wallet, exits may be understated");

  return {
    mint: act.mint,
    symbol: meta?.symbol ?? null,
    name: meta?.name ?? null,
    logo_url: meta?.logoUrl ?? null,
    status: "incomplete",
    label: null,
    notes,
    entry_time: buys[0]?.timestamp ?? null,
    exit_time: sells.at(-1)?.timestamp ?? null,
    first_buy_sig: buys[0]?.signature ?? null,
    last_sell_sig: sells.at(-1)?.signature ?? null,
    n_buys: buys.length,
    n_sells: sells.length,
    sol_spent,
    tokens_bought,
    sol_received,
    tokens_sold,
    tokens_transferred_in,
    tokens_transferred_out,
    fraction_sold,
    fully_exited: fraction_sold !== null && fraction_sold >= cfg.fullyExitedFraction,
    tokens_held,
    position_open: tokens_bought > 0 && tokens_held >= (1 - cfg.fullyExitedFraction) * tokens_bought,
    last_trade_time: lastSwap?.timestamp ?? null,
    last_trade_side: lastSwap?.side ?? null,
    entry_price,
    exit_vwap,
    wallet_roi,
    wallet_realized_pnl_sol: pnl,
    entry_mcap_sol: meta?.supply && entry_price ? meta.supply * entry_price : null,
    pools: [],
    market_price_at_entry: null,
    price_1h: null,
    price_6h: null,
    price_24h: null,
    price_7d: null,
    peak_price_after_entry: null,
    drawdown_after_exit: null,
    drawdown_window_partial: false,
    max_drop_from_peak_24h: null,
    copy_entry_price: null,
    copy_return_24h: null,
    copy_peak_multiple: null,
    copy_return_follow_out: null,
  };
}

/** Time spans we need prices for: a week after entry, plus a day after the exit. */
function coarseRanges(entry: number, exit: number | null, cfg: ScoringConfig, now: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [[entry - 900, entry + 7 * DAY]];
  if (exit !== null) spans.push([exit - 3600, exit + cfg.dump.windowSeconds]);
  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans
    .map(([a, b]): [number, number] => [a, Math.min(b, now)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Pools already trading at entry first (deepest first), then the deepest overall. Falls back to the pump.fun curve. */
function choosePools(pools: PoolRef[], entry: number, cfg: ScoringConfig): PoolRef[] {
  const byLiquidity = [...pools].sort((a, b) => b.liquidityUsd - a.liquidityUsd);
  const liveAtEntry = byLiquidity.filter((p) => p.createdAt !== null && p.createdAt <= entry + 300);
  const curve = pools.filter((p) => p.dexId === "pumpfun");
  const ordered = liveAtEntry.length ? [...liveAtEntry, ...byLiquidity] : [...curve, ...byLiquidity];
  return [...new Map(ordered.map((p) => [p.address, p])).values()].slice(0, cfg.maxPoolsPerToken);
}

const fmtRatio = (x: number) => (x >= 1 ? `${x.toFixed(1)}x` : `1/${(1 / x).toFixed(1)}x`);

/** §5.2–5.5 for one token: trajectory, follower simulation, label. */
export async function evaluateToken(
  act: MintActivity,
  meta: TokenMeta | undefined,
  cfg: ScoringConfig,
  now: number,
  cache: KV,
): Promise<TokenResult> {
  const r = reconstruct(act, meta, cfg);
  const skip = (status: TokenResult["status"], why: string) => {
    r.status = status;
    r.notes.unshift(why);
    return r;
  };

  if (r.entry_time === null) return skip("incomplete", "no buy inside the lookback window");
  if (r.tokens_sold > (r.tokens_bought + r.tokens_transferred_in) * cfg.soldMoreThanBoughtTolerance)
    return skip("incomplete", "sold more than it bought in the window (earlier buys are outside the lookback)");
  if (!meta?.pools.length) return skip("no_price_data", "no SOL-quoted pool found");

  const entry = r.entry_time;
  const copyTs = entry + cfg.copyLatencySeconds;
  const fine: [number, number] = [entry - 600, Math.min(now, entry + cfg.fineWindowSeconds)];
  const coarse = coarseRanges(entry, r.exit_time, cfg, now);
  const coverage = [fine, ...coarse];
  const needUntil = Math.max(...coverage.map(([, b]) => b));

  const candles: Candle[] = [];
  let series = new PriceSeries(candles, coverage);
  for (const pool of choosePools(meta.pools, entry, cfg)) {
    if (series.priceAt(copyTs) === null)
      candles.push(...(await getCandles(pool.address, r.mint, MINUTE_1, fine[0], fine[1], cache)));
    for (const [a, b] of coarse) candles.push(...(await getCandles(pool.address, r.mint, MINUTE_15, a, b, cache)));
    r.pools.push(pool.address);
    series = new PriceSeries(candles, coverage);
    // Stop once we have the entry and trades up to near the end of the range (dead tokens just stop trading)
    if (series.priceAt(copyTs) !== null && (series.lastCloseTime ?? 0) >= needUntil - 6 * 3600) break;
  }

  r.market_price_at_entry = series.priceAt(entry);
  const copyPrice = series.priceAt(copyTs);
  if (copyPrice === null) return skip("no_price_data", "no market price around the wallet's first buy");
  if (r.entry_price !== null && r.market_price_at_entry) {
    const ratio = r.entry_price / r.market_price_at_entry;
    if (ratio > cfg.maxEntryPriceMismatch || ratio < 1 / cfg.maxEntryPriceMismatch)
      return skip("no_price_data", `wallet paid ${fmtRatio(ratio)} the market price: price data doesn't match this trade`);
  }

  const at = (t: number) => (t <= now ? series.priceAt(t) : null);
  r.copy_entry_price = copyPrice;
  r.price_1h = at(entry + 3600);
  r.price_6h = at(entry + 6 * 3600);
  r.price_24h = at(entry + DAY);
  r.price_7d = at(entry + 7 * DAY);
  if (r.price_24h === null) return skip("no_price_data", "no market price 24h after entry");

  // §5.3 follower book
  r.copy_return_24h = r.price_24h / copyPrice - 1;
  r.peak_price_after_entry = series.maxIn(copyTs, Math.min(now, copyTs + cfg.peakWindowSeconds));
  r.copy_peak_multiple = r.peak_price_after_entry !== null ? r.peak_price_after_entry / copyPrice : null;

  if (r.exit_time !== null) {
    const exitPrice = at(r.exit_time);
    r.copy_return_follow_out = exitPrice !== null ? exitPrice / copyPrice - 1 : null;
    if (r.exit_vwap) {
      const low = series.minIn(r.exit_time, Math.min(now, r.exit_time + cfg.dump.windowSeconds));
      r.drawdown_after_exit = low !== null ? (low - r.exit_vwap) / r.exit_vwap : null;
      r.drawdown_window_partial = r.exit_time + cfg.dump.windowSeconds > now;
    }
  }

  r.max_drop_from_peak_24h = series.maxDropFromPeak(entry, entry + cfg.rug.windowSeconds);
  r.status = "scored";
  r.label = labelFor(r, cfg);
  return r;
}
