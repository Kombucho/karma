/**
 * Callout-first Karma scorer.
 *
 * Starts from the wallet's public pump.fun callouts, not a transaction scan.
 * A callout IS the signal — it's when followers learned about the token, so
 * `calloutPrice` is the follower's real entry with zero simulation.
 *
 * Price model (maximise coverage, best-effort precision):
 *   - PRIMARY (every token, every chain, free): the pump.fun callout payload itself.
 *       maxMultiplier → copy_peak_multiple (peak ÷ entry)
 *       multiple      → settled return proxy (current ÷ entry; valid once callout > 24h old)
 *       multiple/maxMultiplier − 1 → drop from peak (the rug signal)
 *   - ENRICHMENT (Solana via Dexscreener+GeckoTerminal; EVM via GeckoTerminal robinhood):
 *       precise price@(callout+24h) and true 24h max-drop-from-peak, when the token
 *       resolves on an indexer. Overrides the pump.fun proxy and flips price_source.
 *
 * Each token records `price_source: "geckoterminal" | "pumpfun"` so precision is auditable.
 *
 * Usage:
 *   npm run score-callouts                    # all wallets in seed/kols.json
 *   npm run score-callouts -- @Chairman_DN   # single handle
 *   npm run score-callouts -- Be24G...       # single wallet address
 *
 * Output: validation/<wallet>.json
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileCache, type KV } from "../src/lib/karma/cache";
import { RateLimiter, HttpError, fetchJson } from "../src/lib/karma/http";
import { MINUTE_15, getCandles } from "../src/lib/karma/sources/geckoterminal";
import { getTokenMeta } from "../src/lib/karma/sources/dexscreener";
import { PriceSeries } from "../src/lib/karma/engine/prices";
import { aggregate, labelFor } from "../src/lib/karma/engine/rules";
import { SCORING } from "../src/lib/karma/scoring.config";
import type { Candle, TokenResult } from "../src/lib/karma/types";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile(f); } catch {}
}

const ROOT = process.cwd();
const VALIDATION_DIR = path.join(ROOT, "validation");
const KOLS_PATH = path.join(ROOT, "seed", "kols.json");

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
  "Origin": "https://pump.fun",
  "Referer": "https://pump.fun/",
};

// Global pacer for ALL pump.fun frontend calls (callouts + positions + sol-price). One shared
// limiter across the whole run so we don't trip Cloudflare — ~50 req/min, backing off hard on 429/530.
const pumpLimiter = new RateLimiter(1200);

async function pumpFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await pumpLimiter.take();
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      pumpLimiter.penalize(Math.min(30_000, 2000 * 2 ** attempt)); // 2s,4s,8s… whole-limiter cooldown
      continue;
    }
    return res; // hard non-retryable (e.g. 404) — let caller inspect status
  }
  return null; // exhausted retries → signal transient failure
}

const LOOKBACK_DAYS = SCORING.lookbackDays;
const MAX_CALLOUTS = SCORING.lookbackMaxTokens;
const DAY = 86400;

// pump.fun's EVM callouts live on Robinhood Chain (chainId 4663 = GeckoTerminal network "robinhood")
const EVM_NETWORK = "robinhood";
const isEvm = (mint: string) => mint.startsWith("0x");

interface Kol { handle: string | null; display_name: string; wallet_address: string; source_url: string; }

interface PumpCallout {
  calloutId: string;
  coinMint: string;
  createdAt: number;       // ms
  calloutPrice: number;    // SOL per token (entry)
  maxMultiplier: number;   // peak price ÷ callout price (all-time since callout)
  maxMultiplierAt: number; // ms, when the peak happened
  maxPriceSol: number;
  multiple: number;        // current price ÷ callout price (live)
  thesis: string | null;
}

// TokenResult plus audit flags: which source produced the trajectory, and the
// caller-book overlay that distinguishes a dumper from a caller who got rugged too.
type Scored = TokenResult & {
  price_source?: "geckoterminal" | "pumpfun";
  caller_book?: boolean;      // did we have the wallet's own position for this token
  caller_exited?: boolean;
  caller_pnl_usd?: number | null;
  caller_likely_lost?: boolean;
  held_through_rug?: boolean; // rugged AND the caller ate it too (victim, not perpetrator)
};

// One position (caller book) from pump.fun's own portfolio API — no Helius needed.
interface PumpPosition {
  coinMint: string;
  isExited: boolean;
  amountHeld: number;
  amountBought: number;
  pnlPercentage: number | null;
  realizedPnlUsd: number | null;
  likelyLost: boolean;
  updatedAt: string | null;
}

async function fetchPositions(wallet: string, mints: string[]): Promise<Map<string, PumpPosition>> {
  const map = new Map<string, PumpPosition>();
  // Chunk mints to keep the URL sane (~30 is fine in one shot, but be safe).
  for (let i = 0; i < mints.length; i += 40) {
    const chunk = mints.slice(i, i + 40);
    const qs = chunk.map((m) => `mints=${encodeURIComponent(m)}`).join("&");
    const url = `https://frontend-api-v3.pump.fun/user-positions/${wallet}?${qs}&updatesLimit=0`;
    try {
      const res = await pumpFetch(url);
      if (!res || !res.ok) continue;
      const data = await res.json() as { positions?: PumpPosition[] };
      for (const p of data.positions ?? []) map.set(p.coinMint, p);
    } catch {
      // caller book is best-effort; price-only labels still work without it
    }
  }
  return map;
}

async function fetchSolPrice(): Promise<number | null> {
  try {
    const res = await pumpFetch("https://frontend-api-v3.pump.fun/sol-price");
    if (!res || !res.ok) return null;
    return (await res.json() as { solPrice?: number }).solPrice ?? null;
  } catch { return null; }
}

/**
 * Caller-book-aware label. The finesse: when a called coin collapsed, split by what
 * the caller themselves did — cashed out at a profit (DUMP, perpetrator) vs held/lost
 * alongside followers (RUG, victim). Clean profit-taking on a coin that survived is
 * never penalised. Falls back to price-only labelFor when we have no position.
 */
function labelWithCaller(r: Scored, pos: PumpPosition | undefined, cfg: typeof SCORING): void {
  if (!pos) { r.label = labelFor(r, cfg); r.caller_book = false; return; }

  r.caller_book = true;
  r.caller_exited = pos.isExited;
  r.caller_pnl_usd = pos.realizedPnlUsd ?? null;
  r.caller_likely_lost = pos.likelyLost;

  const drop = r.max_drop_from_peak_24h;
  const collapsed = drop !== null && drop <= cfg.rug.dropFromPeak;            // ≤ -80%
  const midCollapse = drop !== null && drop <= cfg.dump.maxDrawdownAfterExit; // ≤ -50%
  const roi = pos.pnlPercentage !== null ? pos.pnlPercentage / 100 : null;
  const exitedProfit = pos.isExited && roi !== null && roi > cfg.dump.minWalletRoi;
  const ret = r.copy_return_24h ?? 0;

  // 1. Follower ended materially up → WIN, even if the caller took profit. Taking
  //    profit while your followers are also green is NOT dumping on them.
  if (ret >= cfg.win.minCopyReturn24h) { r.label = "WIN"; return; }

  // 2. Follower did NOT end up and the caller cashed out into a ≥50% fall → DUMP.
  //    This is exit liquidity: caller won, follower lost.
  if ((collapsed || midCollapse) && exitedProfit) { r.label = "DUMP"; return; }

  // 3. Full collapse with no profitable caller exit → RUG. Flag whether the caller
  //    ate it too (held / likelyLost / exited at a loss) — victim, not perpetrator.
  if (collapsed) {
    r.label = "RUG";
    r.held_through_rug = pos.likelyLost || !pos.isExited || (roi !== null && roi <= 0);
    return;
  }

  // 4. No collapse: could-have-doubled counts as a win, else loss/flat.
  if ((r.copy_peak_multiple ?? 0) >= cfg.win.minPeakMultiple) r.label = "WIN";
  else if (ret < cfg.loss.maxCopyReturn24h) r.label = "LOSS";
  else r.label = "NEUTRAL";
}

// ── pump.fun callouts ─────────────────────────────────────────────────────────

/** One page with retry/backoff on rate-limit (429) and edge/5xx (530). Throws on hard failure. */
async function fetchCalloutPage(url: string): Promise<{ callouts?: PumpCallout[] }> {
  const res = await pumpFetch(url);
  if (res === null) throw new Error("callout API rate-limited after retries");
  if (!res.ok) throw new Error(`callout API ${res.status}`);
  return await res.json() as { callouts?: PumpCallout[] };
}

/**
 * Fetch a wallet's callouts. Distinguishes a genuine empty (200 with [] → the wallet is
 * not a caller) from a transient failure (rate-limit/5xx → THROWS, so main() skips it for
 * a re-run instead of silently branding a real caller "not a caller").
 */
async function fetchCallouts(wallet: string, since: number): Promise<PumpCallout[]> {
  // pump.fun's callout API ignores `offset` (returns the same page), so dedupe by mint and
  // stop as soon as a page adds nothing new — otherwise the same calls get multiplied per page.
  const byMint = new Map<string, PumpCallout>();
  for (let offset = 0; offset < 500; offset += 100) {
    const url = `https://frontend-api-v3.pump.fun/callout/list/${wallet}?limit=100&offset=${offset}&sortBy=TIMESTAMP&sortOrder=DESC`;
    let data: { callouts?: PumpCallout[] };
    try {
      data = await fetchCalloutPage(url);
    } catch (e) {
      if (offset === 0) throw e;        // first page failed → propagate, don't fake "no calls"
      break;                             // later page failed → keep what we have
    }
    const raw = data.callouts ?? [];
    let added = 0;
    for (const c of raw) {
      if (c.createdAt / 1000 < since || !(c.calloutPrice > 0)) continue;
      const prev = byMint.get(c.coinMint);
      if (!prev) { byMint.set(c.coinMint, c); added++; }        // one entry per coin…
      else if (c.createdAt < prev.createdAt) byMint.set(c.coinMint, c); // …keep the earliest call
    }
    // No new coins this page, page wasn't full, or we've run past the window → done.
    if (added === 0 || raw.length < 100 || raw[raw.length - 1].createdAt / 1000 < since) break;
    await new Promise((r) => setTimeout(r, 350));
  }
  return [...byMint.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CALLOUTS);
}

// ── EVM (Robinhood Chain) candles via GeckoTerminal ─────────────────────────────

const evmLimiter = new RateLimiter(60_000 / 28);
type Row = [number, number, number, number, number, number];

async function evmCandles(mint: string, from: number, to: number, cache: KV): Promise<Candle[]> {
  const key = `rh-pool:${mint}`;
  let pool = await cache.get<string | null>(key);
  if (pool === undefined || pool === null) {
    try {
      const j = await fetchJson<{ data?: Array<{ attributes?: { address?: string } }> }>(
        `https://api.geckoterminal.com/api/v2/networks/${EVM_NETWORK}/tokens/${mint}/pools`,
        {}, { limiter: evmLimiter },
      );
      pool = j.data?.[0]?.attributes?.address ?? null;
    } catch (e) {
      if (e instanceof HttpError && [400, 401, 404].includes(e.status)) pool = null;
      else throw e;
    }
    await cache.set(key, pool, pool ? undefined : 3600);
  }
  if (!pool) return [];

  const before = Math.ceil(to / MINUTE_15.seconds) * MINUTE_15.seconds;
  const rkey = `rh-ohlcv:${pool}:${before}`;
  let rows = await cache.get<Row[]>(rkey);
  if (!rows) {
    try {
      const url = `https://api.geckoterminal.com/api/v2/networks/${EVM_NETWORK}/pools/${pool}/ohlcv/minute` +
        `?aggregate=15&before_timestamp=${before}&limit=1000&currency=token&token=${mint}`;
      const j = await fetchJson<{ data?: { attributes?: { ohlcv_list?: Row[] } } }>(url, {}, { limiter: evmLimiter });
      rows = j.data?.attributes?.ohlcv_list ?? [];
    } catch (e) {
      if (e instanceof HttpError && [400, 401, 404].includes(e.status)) rows = [];
      else throw e;
    }
    await cache.set(rkey, rows, before < Math.floor(Date.now() / 1000) - 3600 ? undefined : 600);
  }
  return rows
    .map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, res: MINUTE_15.seconds, pool: pool! }))
    .filter((c) => c.t + c.res > from && c.t < to)
    .sort((a, b) => a.t - b.t);
}

// ── evaluate one callout ────────────────────────────────────────────────────────

async function evaluateCallout(
  callout: PumpCallout,
  pos: PumpPosition | undefined,
  solPrice: number | null,
  cache: FileCache,
  now: number,
): Promise<Scored> {
  const cfg = SCORING;
  const callTime = Math.floor(callout.createdAt / 1000);
  const evm = isEvm(callout.coinMint);
  const meta = evm
    ? { symbol: null as string | null, name: null as string | null, pools: [] as Array<{ address: string }> }
    : await getTokenMeta(callout.coinMint, cache);

  const r: Scored = {
    mint: callout.coinMint,
    symbol: meta.symbol,
    name: meta.name,
    logo_url: "logoUrl" in meta ? meta.logoUrl : null,
    status: "incomplete",
    label: null,
    notes: [],
    entry_time: callTime,
    exit_time: null,
    first_buy_sig: null,
    last_sell_sig: null,
    n_buys: 0,
    n_sells: 0,
    sol_spent: 0,
    tokens_bought: 0,
    sol_received: 0,
    tokens_sold: 0,
    tokens_transferred_in: 0,
    tokens_transferred_out: 0,
    fraction_sold: null,
    fully_exited: false,
    tokens_held: 0,
    position_open: false,
    last_trade_time: null,
    last_trade_side: null,
    entry_price: callout.calloutPrice,
    exit_vwap: null,
    wallet_roi: null,
    wallet_realized_pnl_sol: null,
    entry_mcap_sol: null,
    pools: [],
    market_price_at_entry: callout.calloutPrice,
    price_1h: null,
    price_6h: null,
    price_24h: null,
    price_7d: null,
    peak_price_after_entry: callout.maxPriceSol || null,
    drawdown_after_exit: null,
    drawdown_window_partial: false,
    max_drop_from_peak_24h: null,
    copy_entry_price: callout.calloutPrice,
    copy_return_24h: null,
    copy_peak_multiple: callout.maxMultiplier || null,
    copy_return_follow_out: null,
    price_source: "pumpfun",
  };

  // Too fresh to have a settled outcome.
  if (callTime + DAY > now) {
    r.status = "incomplete";
    r.notes.push("called < 24h ago, outcome not settled");
    return r;
  }

  // ── PRIMARY: a true 24h window from an indexer. This is the ONLY basis for a full
  //    label set (WIN/LOSS/NEUTRAL/DUMP/RUG). pump.fun's lifetime `multiple` is NOT used
  //    to manufacture rugs — an eventually-dead coin ≠ a coin that hurt the 24h follower.
  const rangeEnd = Math.min(now, callTime + DAY + 3600);
  const coverage: Array<[number, number]> = [[callTime - 900, rangeEnd]];
  let candles: Candle[] = [];

  try {
    if (evm) {
      candles = await evmCandles(callout.coinMint, callTime - 900, rangeEnd, cache);
    } else if (meta.pools.length) {
      for (const pool of meta.pools.slice(0, cfg.maxPoolsPerToken)) {
        candles.push(...(await getCandles(pool.address, callout.coinMint, MINUTE_15, callTime - 900, rangeEnd, cache)));
        r.pools.push(pool.address);
      }
    }
  } catch {
    // indexer hiccup — fall through to the pump.fun upside-only path
  }

  let gecko24h = false;
  if (candles.length) {
    const series = new PriceSeries(candles, coverage);
    const entry = series.priceAt(callTime) ?? callout.calloutPrice;
    const price24h = series.priceAt(callTime + DAY);
    if (price24h !== null && entry > 0) {
      r.market_price_at_entry = entry;
      r.price_1h = series.priceAt(callTime + 3600);
      r.price_6h = series.priceAt(callTime + 6 * 3600);
      r.price_24h = price24h;
      r.copy_return_24h = price24h / entry - 1;
      r.max_drop_from_peak_24h = series.maxDropFromPeak(callTime, Math.min(now, callTime + DAY));
      const peak = series.maxIn(callTime, Math.min(now, callTime + DAY));
      r.peak_price_after_entry = peak;
      r.copy_peak_multiple = peak !== null && entry > 0 ? peak / entry : r.copy_peak_multiple;
      r.notes.push("24h trajectory from GeckoTerminal");
      r.price_source = "geckoterminal";
      r.status = "scored";
      gecko24h = true;
    }
  }

  // ── CALLER BOOK: overlay the wallet's own position (display + DUMP detection) ───
  if (pos) {
    r.tokens_held = pos.amountHeld ?? 0;
    r.fully_exited = pos.isExited;
    r.position_open = !pos.isExited && (pos.amountHeld ?? 0) > 0;
    r.fraction_sold = pos.amountBought > 0
      ? Math.min(1, Math.max(0, 1 - (pos.amountHeld ?? 0) / pos.amountBought))
      : pos.isExited ? 1 : null;
    r.wallet_roi = pos.pnlPercentage !== null ? pos.pnlPercentage / 100 : null;
    r.wallet_realized_pnl_sol = pos.realizedPnlUsd !== null && solPrice
      ? pos.realizedPnlUsd / solPrice
      : null;
    if (pos.updatedAt) r.last_trade_time = Math.floor(new Date(pos.updatedAt).getTime() / 1000);
  }

  if (gecko24h) {
    labelWithCaller(r, pos, cfg);
    if (r.held_through_rug) r.notes.push("caller held/lost through the rug — victim, not dumper");
    return r;
  }

  // ── pump.fun-only (no true 24h price): UPSIDE-ONLY. maxMultiplierAt tells us whether
  //    the ≥2x peak landed inside 24h — an honest WIN (the follower could have doubled).
  //    We never manufacture a RUG/DUMP from lifetime data, so everything else is left
  //    unscored (excluded from the grade), not branded a rug.
  const peakWithin24h = callout.maxMultiplierAt > 0 && callout.maxMultiplierAt / 1000 <= callTime + DAY;
  if ((callout.maxMultiplier ?? 0) >= cfg.win.minPeakMultiple && peakWithin24h) {
    r.copy_peak_multiple = callout.maxMultiplier;
    r.copy_return_24h = null;        // unmeasured; the ≥2x-in-24h peak alone qualifies
    r.max_drop_from_peak_24h = null; // never use lifetime drawdown
    r.price_source = "pumpfun";
    r.status = "scored";
    r.label = "WIN";
    r.notes.push("pump.fun upside: peaked ≥2x within 24h of callout (24h return unmeasured)");
    return r;
  }

  r.status = "no_price_data";
  r.notes.push("no true 24h price; pump.fun lifetime numbers excluded from grading");
  return r;
}

// ── formatting ────────────────────────────────────────────────────────────────

const pct = (x: number | null) => (x === null ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
const times = (x: number | null) => (x === null ? "–" : `${x.toFixed(1)}x`);

function printSummary(rows: Array<{ handle: string | null; wallet: string; score: ReturnType<typeof aggregate> }>) {
  const head = ["HANDLE", "n", "HIT%", "MEDIAN", "DUMPS", "RUGS", "GRADE", "CONF"];
  const w = [20, 3, 6, 8, 5, 5, 18, 6];
  const fmt = (c: string[]) => c.map((x, i) => (i === 0 || i === 6 ? x.padEnd(w[i]) : x.padStart(w[i]))).join("  ");
  const order = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 } as Record<string, number>;
  rows.sort((a, b) => {
    const ga = a.score.grade ? order[a.score.grade] : 9;
    const gb = b.score.grade ? order[b.score.grade] : 9;
    return ga - gb || (b.score.follower_hit_rate ?? 0) - (a.score.follower_hit_rate ?? 0);
  });
  console.log(`\n${fmt(head)}`);
  for (const r of rows) {
    const s = r.score;
    console.log(fmt([
      `@${r.handle ?? r.wallet.slice(0, 8) + "…"}`.slice(0, 20),
      String(s.n_tokens),
      pct(s.follower_hit_rate),
      pct(s.median_copy_return),
      String(s.dumps),
      String(s.rugs),
      s.unproven ? "UNPROVEN" : `${s.grade} ${s.title}`,
      s.confidence,
    ]));
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const arg = process.argv.slice(2)[0];
  const kols = JSON.parse(await readFile(KOLS_PATH, "utf8")) as Kol[];

  let targets: Array<{ wallet: string; handle: string | null; source_url: string }>;
  if (arg) {
    const input = arg.replace(/^@/, "");
    const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const kol = BASE58.test(input)
      ? kols.find((k) => k.wallet_address === input) ?? { wallet_address: input, handle: null, source_url: "" }
      : kols.find((k) => k.handle?.toLowerCase() === input.toLowerCase());
    if (!kol) { console.error(`"${arg}" not found`); process.exit(1); }
    targets = [{ wallet: (kol as Kol).wallet_address, handle: (kol as Kol).handle ?? null, source_url: (kol as Kol).source_url ?? "" }];
  } else {
    targets = kols.map((k) => ({ wallet: k.wallet_address, handle: k.handle, source_url: k.source_url }));
  }

  const cache = new FileCache();
  const now = Math.floor(Date.now() / 1000);
  const since = now - LOOKBACK_DAYS * DAY;
  await mkdir(VALIDATION_DIR, { recursive: true });
  const solPrice = await fetchSolPrice();

  // Bump this whenever the scoring model changes so prior-model files get re-scored.
  const MODEL_VERSION = SCORING.version + "-callout-24h";
  const incremental = !arg; // single-wallet runs always re-score; full runs converge

  const summary: Array<{ handle: string | null; wallet: string; score: ReturnType<typeof aggregate> }> = [];

  type Target = { wallet: string; handle: string | null; source_url: string };

  /**
   * Is this wallet's stored score still current?
   *
   * Model version alone is not enough. A call recorded as `incomplete` only means "called less
   * than 24h before we looked" — it settles on its own as time passes, and the stored file has
   * no idea. So a wallet holding incomplete calls whose settle window has since closed is
   * STALE by definition, however recent its config_version looks. Without this, a re-run skips
   * exactly the wallets that have new information waiting, which is the opposite of the point.
   */
  const doneOnCurrentModel = async (wallet: string) => {
    try {
      const d = JSON.parse(await readFile(path.join(VALIDATION_DIR, `${wallet}.json`), "utf8"));
      if (typeof d.config_version !== "string" || !d.config_version.includes("callout-24h")) return null;
      const settleable = (d.tokens ?? []).some(
        (t: { status?: string; entry_time?: number | null }) =>
          t.status === "incomplete" && t.entry_time && now - t.entry_time >= SCORING.settleSeconds,
      );
      if (settleable) return null; // has calls that have since settled — re-score it
      return d.score;
    } catch { /* missing/unreadable */ }
    return null;
  };

  // Score one wallet. Returns "done" (scored or genuine no-caller) or "failed" (transient — retry).
  async function scoreOne({ wallet, handle, source_url }: Target): Promise<"done" | "failed"> {
    console.log(`\nKarma · ${wallet}${handle ? ` (@${handle})` : ""}`);
    if (source_url) console.log(`  source: ${source_url}`);

    process.stdout.write("  fetching callouts…");
    let callouts: PumpCallout[];
    try {
      callouts = await fetchCallouts(wallet, since);
      console.log(` ${callouts.length} in last ${LOOKBACK_DAYS}d`);
    } catch (e) {
      console.log(` failed: ${(e as Error).message}`);
      return "failed"; // transient — do NOT write a false record; retry in a later pass
    }

    if (!callouts.length) {
      const score = aggregate(wallet, [], 0, SCORING, now);
      const report = {
        handle: handle ?? null, wallet, computed_at: now, config_version: MODEL_VERSION,
        scan: {
          source: "pump.fun callouts + GeckoTerminal enrichment", callouts: 0,
          scored: 0, from_pumpfun: 0, from_geckoterminal: 0, incomplete: 0, no_price_data: 0,
          caller_book: 0, dumped_before_rug: 0, held_through_rug: 0,
        },
        score: { ...score, verdict: "No public pump.fun callouts found — not a caller." },
        tokens: [],
      };
      await writeFile(path.join(VALIDATION_DIR, `${wallet}.json`), JSON.stringify(report, null, 2));
      console.log("  no callouts — UNPROVEN (no public calls)");
      summary.push({ handle, wallet, score: report.score });
      return "done";
    }

    process.stdout.write("  fetching caller positions…");
    const positions = await fetchPositions(wallet, callouts.map((c) => c.coinMint));
    console.log(` ${positions.size}/${callouts.length}`);

    const tokens: Scored[] = [];
    for (const [i, c] of callouts.entries()) {
      const res = await evaluateCallout(c, positions.get(c.coinMint), solPrice, cache, now);
      const sym = (res.symbol ?? res.mint.slice(0, 6)).padEnd(10);
      const tag = res.label === "DUMP" ? "DUMP←exited" : res.held_through_rug ? "RUG(victim)" : res.label;
      const detail = res.status === "scored"
        ? `${pct(res.copy_return_24h)} / peak ${times(res.copy_peak_multiple)}  ${tag}  [${res.price_source}]`
        : res.status;
      console.log(`  [${String(i + 1).padStart(2)}/${callouts.length}] ${sym} ${detail}`);
      tokens.push(res);
    }

    const score = aggregate(wallet, tokens, 0, SCORING, now);
    const report = {
      handle: handle ?? null, wallet, computed_at: now, config_version: MODEL_VERSION,
      scan: {
        source: "pump.fun callouts + GeckoTerminal enrichment", callouts: callouts.length,
        scored: tokens.filter((t) => t.status === "scored").length,
        from_pumpfun: tokens.filter((t) => t.price_source === "pumpfun" && t.status === "scored").length,
        from_geckoterminal: tokens.filter((t) => t.price_source === "geckoterminal" && t.status === "scored").length,
        incomplete: tokens.filter((t) => t.status === "incomplete").length,
        no_price_data: tokens.filter((t) => t.status === "no_price_data").length,
        caller_book: tokens.filter((t) => t.caller_book).length,
        dumped_before_rug: tokens.filter((t) => t.label === "DUMP").length,
        held_through_rug: tokens.filter((t) => t.held_through_rug).length,
      },
      score, tokens,
    };
    await writeFile(path.join(VALIDATION_DIR, `${wallet}.json`), JSON.stringify(report, null, 2));
    const badge = score.unproven ? `UNPROVEN (n=${score.n_tokens})` : `GRADE ${score.grade} · ${score.title}`;
    console.log(`  ${badge}   confidence ${score.confidence} · "${score.verdict}"`);
    summary.push({ handle, wallet, score });
    return "done";
  }

  // Build the work queue: skip wallets already scored on the current model (fold their
  // existing score into the summary), so re-runs only touch missing/stale/failed wallets.
  let queue: Target[] = [];
  for (const t of targets) {
    if (incremental) {
      const existing = await doneOnCurrentModel(t.wallet);
      if (existing) { summary.push({ handle: t.handle, wallet: t.wallet, score: existing }); continue; }
    }
    queue.push(t);
  }
  console.log(`\n${queue.length} to score · ${targets.length - queue.length} already on corrected model`);

  // Retry transient (rate-limit) failures in cooldown passes until none remain.
  for (let pass = 1; pass <= 8 && queue.length; pass++) {
    console.log(`\n${"━".repeat(60)}\n  PASS ${pass} — ${queue.length} wallets\n${"━".repeat(60)}`);
    const failed: Target[] = [];
    for (const t of queue) {
      if ((await scoreOne(t)) === "failed") failed.push(t);
    }
    queue = failed;
    if (queue.length) {
      console.log(`\n  ${queue.length} transient failures — cooling down 60s before pass ${pass + 1}`);
      await new Promise((r) => setTimeout(r, 60_000));
    }
  }
  if (queue.length) {
    console.log(`\n  ⚠ ${queue.length} wallets still failing after 8 passes: ${queue.map((t) => t.handle ?? t.wallet.slice(0, 8)).join(", ")}`);
  }

  if (summary.length > 1) printSummary(summary);
}

main().catch((e) => { console.error(e); process.exit(1); });
