import type { KV } from "../cache";
import { RateLimiter } from "../http";

/**
 * Live behaviour read for wallets with NO public callouts — the answer to "most pastes
 * aren't in the corpus". A wallet with no audience cannot earn the trust score (there are
 * no followers to dump on), so this is deliberately a DIFFERENT object with a different
 * name: a behavioural fingerprint, never a Karma grade. The card labels it as such.
 *
 * Lifted from scripts/trade-fingerprint.ts (same thresholds — retune there first, then
 * mirror): one keyless pump.fun request per wallet returns the last 200 trades, and hold
 * time is the discriminator between a human position trader and a bot. On top of that,
 * a sniper sample: for a handful of the wallet's mints, was their first buy within a
 * minute of the coin's creation? Buying at t=0 repeatedly is coordination, not luck.
 */

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  Origin: "https://pump.fun",
  Referer: "https://pump.fun/",
};

// Mirror of scripts/trade-fingerprint.ts TH — keep in lockstep.
const TH = {
  page: 200,
  botTradesPerDay: 40,
  botHoldMin: 5,
  patientHoldMinLo: 30,
  patientHoldMinHi: 14 * 24 * 60,
  patientMaxTradesPerDay: 25,
  patientMinSellRatio: 0.25,
  whaleMaxSellRatio: 0.12,
  sniperWindowSec: 60,   // first buy within this of coin creation = a snipe
  sniperSampleMints: 8,  // budget: at most this many coin lookups per wallet
};

// Shared keyless budget with everything else that talks to pump.fun from the server.
const limiter = new RateLimiter(1200);

async function pumpFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await limiter.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      limiter.penalize(Math.min(15_000, 2000 * 2 ** attempt));
      continue;
    }
    return res;
  }
  return null;
}

interface Trade { isBuy: boolean; timestamp: string; mint: string; amountUsd: number; }

export type BehaviorClass = "bot/scalper" | "sniper" | "patient-trader" | "bag-whale" | "mixed" | "no-data";

export interface BehaviorRead {
  wallet: string;
  klass: BehaviorClass;
  n_trades: number;
  window_hours: number;
  trades_per_day: number;
  distinct_mints: number;
  sell_ratio: number;
  median_hold_min: number | null;
  round_trips: number;
  /** Snipe sample: of `sniper_sampled` coins checked, first buy landed <60s after creation. */
  sniped: number;
  sniper_sampled: number;
  /** One plain sentence the card can show. */
  verdict: string;
  checked_at: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function classify(f: { n_trades: number; trades_per_day: number; sell_ratio: number; median_hold_min: number | null; sniped: number; sniper_sampled: number }): BehaviorClass {
  if (!f.n_trades) return "no-data";
  // Sniping outranks everything: repeated t=0 entries are coordination, whatever the hold time.
  if (f.sniper_sampled >= 3 && f.sniped / f.sniper_sampled >= 0.5) return "sniper";
  if (f.trades_per_day >= TH.botTradesPerDay) return "bot/scalper";
  if (f.median_hold_min !== null && f.median_hold_min < TH.botHoldMin) return "bot/scalper";
  if (f.sell_ratio <= TH.whaleMaxSellRatio) return "bag-whale";
  if (
    f.median_hold_min !== null &&
    f.median_hold_min >= TH.patientHoldMinLo &&
    f.median_hold_min <= TH.patientHoldMinHi &&
    f.sell_ratio >= TH.patientMinSellRatio &&
    f.trades_per_day <= TH.patientMaxTradesPerDay
  ) return "patient-trader";
  return "mixed";
}

function verdictFor(k: BehaviorClass, f: { trades_per_day: number; median_hold_min: number | null; sniped: number; sniper_sampled: number; sell_ratio: number }): string {
  const hold = f.median_hold_min === null ? "unknown hold time" : f.median_hold_min < 60 ? `${Math.round(f.median_hold_min)}min median hold` : `${(f.median_hold_min / 60).toFixed(1)}h median hold`;
  switch (k) {
    case "sniper": return `Aped ${f.sniped} of ${f.sniper_sampled} sampled coins inside the first minute. Entries that early, that often, aren't luck — that's a cabal seat.`;
    case "bot/scalper": return `${Math.round(f.trades_per_day)} trades a day, ${hold}. That's a bot farming the curve, not a trader. Nothing here for a human to copy.`;
    case "bag-whale": return `Buys and basically never sells (${Math.round(f.sell_ratio * 100)}% of trades). Either conviction or a bagholder who hasn't capitulated. No exit to read yet.`;
    case "patient-trader": return `Human pace: ${hold}, and they actually take profit. The style is copyable. Whether it pays is not something we measured.`;
    case "mixed": return `No clean pattern. ${hold}, ${Math.round(f.trades_per_day)} trades a day. Read the raw trades before you trust anything.`;
    case "no-data": return "No pump.fun trades on record. Cold wallet, or it trades somewhere we can't see.";
  }
}

/** ≤ 1 + sniperSampleMints keyless requests per uncached wallet. Cache upstream, always. */
export async function fingerprintWallet(wallet: string, cache: KV, now: number): Promise<BehaviorRead> {
  const res = await pumpFetch(`https://frontend-api-v3.pump.fun/user-trades/${wallet}?limit=${TH.page}`);
  if (!res || !res.ok) throw new Error(`pump.fun user-trades unavailable (${res?.status ?? "network"})`);
  const j = (await res.json()) as { trades?: Trade[] } | Trade[];
  const trades = (Array.isArray(j) ? j : j.trades ?? []).filter((t) => t.timestamp && t.mint);

  const ts = trades.map((t) => new Date(t.timestamp).getTime() / 1000).filter((x) => Number.isFinite(x));
  const windowHours = ts.length >= 2 ? (Math.max(...ts) - Math.min(...ts)) / 3600 : 0;

  // Per-mint first buy / first sell → round-trip hold times.
  const firstBuy = new Map<string, number>();
  const firstSellAfterBuy = new Map<string, number>();
  for (const t of [...trades].sort((a, b) => +new Date(a.timestamp) - +new Date(b.timestamp))) {
    const at = new Date(t.timestamp).getTime() / 1000;
    if (t.isBuy) {
      if (!firstBuy.has(t.mint)) firstBuy.set(t.mint, at);
    } else if (firstBuy.has(t.mint) && !firstSellAfterBuy.has(t.mint)) {
      firstSellAfterBuy.set(t.mint, at);
    }
  }
  const holds = [...firstSellAfterBuy.entries()].map(([m, sell]) => (sell - firstBuy.get(m)!) / 60);

  // Sniper sample: check the wallet's most recently entered mints against coin creation time.
  // Creation timestamps never change → cached forever; the per-wallet cost amortises to ~0.
  const sampled = [...firstBuy.entries()].sort((a, b) => b[1] - a[1]).slice(0, TH.sniperSampleMints);
  let sniped = 0;
  let sniperSampled = 0;
  for (const [mint, buyAt] of sampled) {
    try {
      const key = `pump_created:${mint}`;
      let created = await cache.get<number>(key);
      if (created === null || created === undefined) {
        const cRes = await pumpFetch(`https://frontend-api-v3.pump.fun/coins/${mint}`);
        if (!cRes || !cRes.ok) continue;
        const coin = (await cRes.json()) as { created_timestamp?: number };
        if (!coin.created_timestamp) continue;
        created = coin.created_timestamp > 1e12 ? coin.created_timestamp / 1000 : coin.created_timestamp;
        await cache.set(key, created);
      }
      sniperSampled++;
      if (buyAt - created <= TH.sniperWindowSec && buyAt >= created) sniped++;
    } catch {
      // sampling is best-effort; a failed lookup just shrinks the sample, never fakes a result
    }
  }

  const sells = trades.filter((t) => !t.isBuy).length;
  const f = {
    n_trades: trades.length,
    trades_per_day: windowHours > 0 ? trades.length / (windowHours / 24) : trades.length,
    distinct_mints: new Set(trades.map((t) => t.mint)).size,
    sell_ratio: trades.length ? sells / trades.length : 0,
    median_hold_min: median(holds),
    round_trips: holds.length,
    sniped,
    sniper_sampled: sniperSampled,
  };
  const klass = classify(f);
  return { wallet, klass, ...f, window_hours: Math.round(windowHours * 10) / 10, verdict: verdictFor(klass, f), checked_at: now };
}
