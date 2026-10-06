import type { ScoringConfig } from "../scoring.config";
import type { SolanaRpc } from "../sources/solana";
import type { MintActivity, ScanStats, TxDelta } from "../types";

const PAGE_SIZE = 1000;
const CHUNK = 50;

export const isoMinute = (ts: number | null) =>
  ts === null ? "?" : new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");

const latestSwap = (a: MintActivity) => Math.max(...a.swaps.map((s) => s.timestamp));

/** Sold more than bought (plus tokens received) means some buys sit outside what we've scanned. */
export function isBalanced(a: MintActivity, cfg: ScoringConfig) {
  let bought = 0;
  let sold = 0;
  for (const s of a.swaps) {
    if (s.side === "buy") bought += s.tokenAmount;
    else sold += s.tokenAmount;
  }
  const received = a.transfers.reduce((sum, t) => sum + Math.max(0, t.amount), 0);
  return sold <= (bought + received) * cfg.soldMoreThanBoughtTolerance;
}

/**
 * Walk the wallet's history newest → oldest and bucket swaps per token (§5.1).
 * Stops at the lookback window, or once the last 30 settled tokens are found
 * and their earlier buys have (probably) been reached.
 */
export async function collectActivity(
  rpc: SolanaRpc,
  wallet: string,
  cfg: ScoringConfig,
  now: number,
  log: (msg: string) => void,
): Promise<{ selected: MintActivity[]; stats: ScanStats }> {
  const cutoff = now - cfg.lookbackDays * 86400;
  const settleCutoff = now - cfg.settleSeconds;
  const mints = new Map<string, MintActivity>();
  const stats: ScanStats = {
    source: rpc.label,
    signaturesSeen: 0,
    txFetched: 0,
    failedTx: 0,
    swaps: 0,
    transfers: 0,
    airdrops: 0,
    multiTokenTxsIgnored: 0,
    unclassifiedTxs: 0,
    oldestScanned: null,
    stopReason: "end_of_history",
    pendingTokens: 0,
  };

  const touch = (mint: string) => {
    let a = mints.get(mint);
    if (!a) mints.set(mint, (a = { mint, swaps: [], transfers: [], ignoredTxs: 0 }));
    return a;
  };

  const record = (d: TxDelta) => {
    const entries = Object.entries(d.tokenDeltas);
    if (entries.length === 0) return;
    const base = { signature: d.signature, timestamp: d.timestamp };
    const hasSolLeg = Math.abs(d.solDelta) >= cfg.minSwapSol;
    // Tokens pushed onto the wallet in someone else's transaction: almost always airdrop spam.
    // Still recorded as transfers, in case it's the KOL moving tokens in from another wallet.
    if (!d.signer && !hasSolLeg && entries.every(([, amount]) => amount > 0)) {
      stats.airdrops++;
      for (const [mint, amount] of entries) touch(mint).transfers.push({ ...base, amount });
      return;
    }
    if (entries.length > 1) {
      stats.multiTokenTxsIgnored++;
      for (const [mint] of entries) touch(mint).ignoredTxs++;
      return;
    }
    const [mint, amount] = entries[0];
    const act = touch(mint);
    if (!hasSolLeg) {
      act.transfers.push({ ...base, amount });
      stats.transfers++;
    } else if (amount > 0 && d.solDelta < 0) {
      act.swaps.push({ ...base, side: "buy", tokenAmount: amount, solAmount: -d.solDelta });
      stats.swaps++;
    } else if (amount < 0 && d.solDelta > 0) {
      act.swaps.push({ ...base, side: "sell", tokenAmount: -amount, solAmount: d.solDelta });
      stats.swaps++;
    } else {
      stats.unclassifiedTxs++;
    }
  };

  // "Last 30 distinct tokens traded", counting only tokens with a trade older than the settle window
  const select = () =>
    [...mints.values()]
      .filter((a) => a.swaps.some((s) => s.timestamp <= settleCutoff))
      .sort((a, b) => latestSwap(b) - latestSwap(a))
      .slice(0, cfg.lookbackMaxTokens);

  let before: string | undefined;
  let fullAt: number | null = null;

  scan: while (true) {
    const page = await rpc.getSignatures(wallet, before, PAGE_SIZE);
    for (let i = 0; i < page.length; i += CHUNK) {
      const chunk = page.slice(i, i + CHUNK);
      stats.signaturesSeen += chunk.length;
      const inWindow = chunk.filter((s) => s.blockTime === null || s.blockTime >= cutoff);
      const live = inWindow.filter((s) => !s.err);
      stats.failedTx += inWindow.length - live.length;
      const deltas = await Promise.all(live.map((s) => rpc.getWalletDelta(s.signature, wallet, s.blockTime)));
      stats.txFetched += live.length;
      for (const d of deltas) if (d) record(d);

      const oldest = chunk[chunk.length - 1].blockTime ?? stats.oldestScanned;
      stats.oldestScanned = oldest;
      if (inWindow.length < chunk.length) {
        stats.stopReason = "lookback_days";
        break scan;
      }

      const selected = select();
      if (selected.length >= cfg.lookbackMaxTokens && oldest !== null) {
        fullAt ??= oldest;
        const past = fullAt - oldest;
        if ((past >= cfg.minExtraScanSeconds && selected.every((a) => isBalanced(a, cfg))) || past >= cfg.maxExtraScanSeconds) {
          stats.stopReason = "token_limit";
          break scan;
        }
      }
      if (stats.txFetched >= cfg.maxTxScan) {
        stats.stopReason = "tx_cap";
        break scan;
      }
      log(`scanned ${stats.txFetched} tx back to ${isoMinute(oldest)} · ${selected.length}/${cfg.lookbackMaxTokens} tokens`);
    }
    if (page.length < PAGE_SIZE) break;
    before = page[page.length - 1].signature;
  }

  stats.pendingTokens = [...mints.values()].filter(
    (a) => a.swaps.length > 0 && !a.swaps.some((s) => s.timestamp <= settleCutoff),
  ).length;
  return { selected: select(), stats };
}
