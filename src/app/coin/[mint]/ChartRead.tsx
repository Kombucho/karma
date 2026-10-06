"use client";

import { useEffect, useState } from "react";
import type { ChartRead, HypothesisRead, LevelRead, PatternRead, TrackRecord, WeekRead } from "@/lib/karma/quant/chart-read";
import type { ChartHealth } from "@/lib/karma/sources/ta";

/**
 * JEV · CHART READ — one panel that answers "what is price likely to do next, and where" in a glance.
 * Headline call on top, the level ladder as the core (where price probably goes, and whether it holds
 * there), then the pattern in play and the crowd. The old indicator tiles are demoted to one muted line.
 *
 * Honesty rules: every probability is ink-gray until the chart-read questions have a graded record;
 * colour is only for BIAS (up = ledger green, down = rust), muted. Red/amber stay reserved for danger.
 */

const GMGN_CHAIN: Record<string, string> = { solana: "sol", bsc: "bsc", base: "base", eth: "eth" };
const UP = "text-green-400/80";
const DOWN = "text-orange-400/80";

/** Compact price for memecoin scales (1.3e-5 → "0.0000131"). */
function px(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toPrecision(3);
}
const pct = (p: number | null | undefined) => (p == null ? "—" : `${Math.round(p * 100)}%`);
const signed = (d: number) => `${d >= 0 ? "+" : "−"}${Math.abs(d * 100).toFixed(1)}%`;
function ago(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

type Load<T> = { state: "loading" } | { state: "ok"; data: T } | { state: "err"; status: number };

function useJson<T>(url: string | null): Load<T> {
  const [r, setR] = useState<{ url: string | null; load: Load<T> }>({ url, load: { state: "loading" } });
  useEffect(() => {
    if (!url) return;
    let live = true;
    fetch(url)
      .then(async (res) => {
        if (!live) return;
        if (!res.ok) return setR({ url, load: { state: "err", status: res.status } });
        const data = (await res.json()) as T;
        if (live) setR({ url, load: { state: "ok", data } });
      })
      .catch(() => live && setR({ url, load: { state: "err", status: 0 } }));
    return () => {
      live = false;
    };
  }, [url]);
  // A url change resets to loading without a synchronous setState inside the effect.
  return r.url === url ? r.load : { state: "loading" };
}

/**
 * `chartNetwork` is the GeckoTerminal network when the coin is old enough for candles (embed + the
 * demoted indicator line); null hides both. EVM coins read on their own chain's pool.
 */
export default function ChartReadPanel({ mint, chartNetwork }: { mint: string; chartNetwork: string | null }) {
  const read = useJson<ChartRead>(`/api/chart-read/${mint}`);
  const health = useJson<ChartHealth>(chartNetwork ? `/api/chart/${chartNetwork}/${mint}` : null);
  const h = chartNetwork && health.state === "ok" && health.data.enough ? health.data : null;
  const r = read.state === "ok" ? read.data : null;

  return (
    <div className="border-t-2 border-white/10 px-6 py-5">
      <div className="flex items-center justify-between gap-3">
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">▶ JEV · CHART READ</p>
        <span className="silk text-right text-[8px] tracking-[0.12em] text-zinc-500">
          {r ? `${r.timeframe.toUpperCase()} · ${r.graded ? `GRADED · ${r.rubric_version.toUpperCase()}` : "SHADOW"}` : "NOT FINANCIAL ADVICE"}
        </span>
      </div>

      {read.state === "loading" ? (
        <p className="mt-3 animate-pulse text-sm text-zinc-500">jev is reading the chart…</p>
      ) : !r ? (
        <p className="mt-3 text-sm text-zinc-600">
          {read.state === "err" && read.status === 404
              ? "not enough candles or posts to read yet."
              : "chart read unavailable right now, try again in a minute."}
        </p>
      ) : (
        <ReadBody r={r} />
      )}

      {h ? <IndicatorLine h={h} /> : null}

      {h?.pool && chartNetwork ? (
        <div className="mt-3 overflow-hidden rounded-sm border border-white/10" style={{ height: 320 }}>
          <iframe
            title="chart"
            src={`https://www.geckoterminal.com/${chartNetwork}/pools/${h.pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`}
            className="h-full w-full"
            loading="lazy"
            allow="clipboard-write"
          />
        </div>
      ) : null}

      <p className="mt-2 text-[11px] leading-snug text-zinc-600">
        {r ? <Record r={r} /> : null}
        {r ? `read ${ago(r.t)} · ` : ""}not financial advice
        {chartNetwork ? (
          <>
            {" "}· full chart on{" "}
            <a href={`https://gmgn.ai/${GMGN_CHAIN[chartNetwork] ?? "sol"}/token/${mint}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-400">
              GMGN
            </a>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

function ReadBody({ r }: { r: ChartRead }) {
  return (
    <>
      {r.headline ? (
        <p className="mt-3 text-lg font-bold leading-snug text-zinc-100 sm:text-xl">{r.headline}</p>
      ) : (
        <p className="mt-3 text-lg text-zinc-500">no clear pattern right now</p>
      )}
      <Today levels={r.levels} price={r.price} />
      {r.week && r.price != null ? <Week w={r.week} price={r.price} /> : null}

      {r.levels.length ? <Ladder levels={r.levels} price={r.price} /> : null}
      {r.young ? (
        <p className="mt-1 text-[10px] text-zinc-500">young coin (under ~60 days): backtests show its odds run a few points high until it has more history.</p>
      ) : null}
      {r.patterns.some((p) => p.kind !== "range") ? <Patterns patterns={r.patterns.filter((p) => p.kind !== "range")} /> : null}
      {r.hypotheses ? <Hypotheses hs={r.hypotheses} price={r.price} /> : null}
    </>
  );
}

// ── The week ─────────────────────────────────────────────────────────────────────────────────────────

/** The level most likely to be hit today, in words. */
function Today({ levels, price }: { levels: LevelRead[]; price: number | null }) {
  const best = levels.reduce<LevelRead | null>((b, l) => ((l.p_touch_24h ?? -1) > (b?.p_touch_24h ?? -1) ? l : b), null);
  if (!best || best.p_touch_24h == null) return price != null ? <p className="tnum mt-1 text-xs text-zinc-500">price ${px(price)}</p> : null;
  return (
    <p className="mt-2 text-sm text-zinc-400">
      <span className="silk mr-2 text-[9px] tracking-[0.1em] text-zinc-500">TODAY</span>
      most likely tests the {best.side} at <span className="tnum font-semibold text-zinc-100">${px(best.price)}</span>{" "}
      <span className="tnum text-zinc-500">
        ({signed(best.dist)}, {pct(best.p_touch_24h)} chance)
      </span>
    </p>
  );
}

/**
 * The week as one range a trader can read: where price typically ends 7 days out (±1σ of the coin's own
 * volatility, about 2 weeks in 3), with the ±25% odds as the fine print.
 */
function Week({ w, price }: { w: WeekRead; price: number }) {
  if (w.sigma_daily == null) return null;
  const s = 0.85 * w.sigma_daily * Math.sqrt(7);
  const lo = price * Math.exp(-s);
  const hi = price * Math.exp(s);
  return (
    <div className="mt-1.5 text-sm text-zinc-400">
      <p>
        <span className="silk mr-2 text-[9px] tracking-[0.1em] text-zinc-500">THIS WEEK</span>
        usually ends between <span className="tnum font-semibold text-zinc-100">${px(lo)}</span> and{" "}
        <span className="tnum font-semibold text-zinc-100">${px(hi)}</span>
      </p>
      {w.up25 != null && w.down25 != null ? (
        <p className="tnum mt-0.5 text-[11px] text-zinc-600">
          2 weeks in 3 end inside that range · a 25% move at some point: up {pct(w.up25)}, down {pct(w.down25)} · from its volatility, ~{Math.round(w.sigma_daily * 100)}% a day
        </p>
      ) : null}
    </div>
  );
}

// ── Hypotheses: the funnel ───────────────────────────────────────────────────────────────────────────

const tick = (ok: boolean) => (ok ? "✓" : "✗");

/**
 * 1h / 4h ideas that survived the daily and weekly checks. Each shows its odds next to what chance alone
 * gives for the same target and invalidation: in the lab the survivors' edge over chance was ~1–2 points,
 * and hiding the comparison would make geometry look like skill.
 */
function Hypotheses({ hs, price }: { hs: HypothesisRead[]; price: number | null }) {
  return (
    <div className="mt-5 border-t border-white/10 pt-3">
      <p className="silk text-[9px] tracking-[0.1em] text-zinc-500">IDEAS FROM 1H / 4H · CHECKED ON THE DAILY &amp; WEEKLY</p>
      {!hs.length ? (
        <p className="mt-1 text-[11px] text-zinc-500">no 1h / 4h idea survived the higher timeframes right now.</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-2">
          {hs.map((h, i) => {
            const b = BIAS[h.bias];
            const away = (x: number) => (price ? ` (${signed(x / price - 1)})` : "");
            return (
              <li key={i} className="text-[12px] leading-snug text-zinc-400">
                <span className={b.cls}>{b.arrow}</span> <span className="font-semibold text-zinc-100">{nice(h.kind)}</span>{" "}
                <span className="silk text-[9px] tracking-[0.1em] text-zinc-500">{h.tf.toUpperCase()}</span> · to ${px(h.target)}
                {away(h.target)} before ${px(h.stop)}
                {away(h.stop)} within {h.window_h < 48 ? `${h.window_h}h` : `${Math.round(h.window_h / 24)}d`}
                <span className="tnum ml-1 text-zinc-100">{pct(h.p)}</span>
                <span className="tnum text-zinc-600"> (chance alone {pct(h.p_chance)})</span>
                <span className="block text-[10px] text-zinc-600">
                  daily {tick(h.tests.daily)} · weekly {tick(h.tests.weekly)} · path clear {tick(h.tests.clear)} · stop guarded {tick(h.tests.protected)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Jev's record ─────────────────────────────────────────────────────────────────────────────────────

/** Jev's graded record for what this card claims, from its own ledger; "shadow" until a record exists. */
function Record({ r }: { r: ChartRead }) {
  const rec = r.record;
  const bits = (
    [
      ["today's levels", rec?.touch_24h],
      ["the week", rec?.move_7d],
      ["ideas", rec?.hypotheses],
    ] as [string, TrackRecord | null | undefined][]
  )
    .filter(([, t]) => t)
    .map(([name, t]) => `${name}: ${t!.n.toLocaleString()} calls graded, off by ${(t!.ece * 100).toFixed(1)} pts on average`);
  return <>{bits.length ? `Jev's record · ${bits.join(" · ")}. ` : "shadow: Jev's calls are being scored against price in its ledger; no track record yet. "}</>;
}

// ── The level ladder ─────────────────────────────────────────────────────────────────────────────────

const LADDER_COLS = "grid grid-cols-[5rem_3.5rem_1fr] items-center gap-x-3 sm:grid-cols-[5.5rem_4rem_1fr] sm:gap-x-4";

function Ladder({ levels, price }: { levels: LevelRead[]; price: number | null }) {
  const [open, setOpen] = useState<number | null>(null);
  // Resistances farthest-first so price sits in the middle; supports nearest-first below it.
  const res = levels.filter((l) => l.side === "resistance").sort((a, b) => b.dist - a.dist);
  const sup = levels.filter((l) => l.side === "support").sort((a, b) => b.dist - a.dist);
  // Jev's likeliest destination gets the emphasis: the rung with the highest 24h touch probability.
  const call = levels.reduce<LevelRead | null>((best, l) => ((l.p_touch_24h ?? -1) > (best?.p_touch_24h ?? -1) ? l : best), null);
  const rows = [...res, null, ...sup];

  return (
    <div className="mt-4">
      <div className={`${LADDER_COLS} silk pb-1 text-[8px] tracking-[0.1em] text-zinc-600`}>
        <span>LEVEL</span>
        <span className="text-right">AWAY</span>
        <span>CHANCE PRICE GETS THERE TODAY</span>
      </div>
      <div className="border-l-2 border-white/15">
        {rows.map((l, i) =>
          l === null ? (
            <div key="now" className={`${LADDER_COLS} -ml-[2px] border-y border-dashed border-white/40 border-l-2 border-l-foreground bg-white/[0.04] py-1.5 pl-2.5`}>
              <span className="tnum text-sm font-bold text-zinc-100">${px(price)}</span>
              <span className="silk text-right text-[8px] tracking-[0.1em] text-zinc-500">NOW</span>
              <span className="text-[10px] text-zinc-600">
                {res.length} above · {sup.length} below
              </span>
            </div>
          ) : (
            <Rung key={`${l.side}${l.price}`} l={l} isCall={l === call} open={open === i} toggle={() => setOpen(open === i ? null : i)} />
          ),
        )}
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">tap a level for why it&apos;s there.</p>
    </div>
  );
}

function Rung({ l, isCall, open, toggle }: { l: LevelRead; isCall: boolean; open: boolean; toggle: () => void }) {
  const up = l.side === "resistance";
  return (
    <div className="border-b border-white/[0.07] last:border-b-0">
      <button type="button" onClick={toggle} title={l.sources.join(" · ")} aria-expanded={open} className={`${LADDER_COLS} w-full py-1.5 pl-2.5 text-left hover:bg-white/[0.04]`}>
        <span className={`tnum text-xs ${isCall ? "font-bold text-zinc-100" : "text-zinc-300"}`}>
          <span className={`mr-1 ${up ? UP : DOWN}`}>{up ? "▲" : "▼"}</span>${px(l.price)}
        </span>
        <span className="tnum text-right text-[11px] text-zinc-500">{signed(l.dist)}</span>
        <Meter p={l.p_touch_24h} strong={isCall} />
      </button>
      {open ? (
        <p className="pb-2 pl-2.5 text-[11px] leading-snug text-zinc-500">
          {up ? "resistance" : "support"} from {l.sources.join(" · ") || "—"}
        </p>
      ) : null}
    </div>
  );
}

/** A probability as a thin ink bar + numeral. Never coloured: ungraded odds are a guess, not a signal. */
function Meter({ p, strong }: { p: number | null; strong?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="h-1.5 min-w-0 flex-1 bg-white/10">
        <span className={`block h-full ${strong ? "bg-zinc-100" : "bg-zinc-600"}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, p ?? 0)) * 100)}%` }} />
      </span>
      <span className={`tnum w-7 text-right text-[11px] ${strong ? "font-bold text-zinc-100" : "text-zinc-400"}`}>{pct(p)}</span>
    </span>
  );
}

// ── Pattern ──────────────────────────────────────────────────────────────────────────────────────────

const BIAS: Record<PatternRead["bias"], { arrow: string; cls: string; word: string }> = {
  bull: { arrow: "↗", cls: UP, word: "up" },
  bear: { arrow: "↘", cls: DOWN, word: "down" },
  neutral: { arrow: "→", cls: "text-zinc-500", word: "sideways" },
};
const nice = (kind: string) => kind.replace(/_/g, " ");

function Patterns({ patterns }: { patterns: PatternRead[] }) {
  const [top, ...rest] = patterns;
  const b = BIAS[top.bias];
  return (
    <div className="mt-5 border-t border-white/10 pt-3">
      <p className="silk text-[9px] tracking-[0.1em] text-zinc-500">PATTERN · 4H / 12H / 1D</p>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
        <span className={`text-lg font-bold leading-none ${b.cls}`}>{b.arrow}</span>
        <span className="text-base font-bold text-zinc-100">{nice(top.kind)}</span>
        {top.tf ? <span className="silk text-[9px] tracking-[0.1em] text-zinc-400">{top.tf.toUpperCase()}</span> : null}
        {top.weekly ? <span className="text-xs text-zinc-500">· weekly {top.weekly === "aligned" ? "agrees" : top.weekly === "against" ? "disagrees" : "flat"}</span> : null}
        {top.confirmed ? <span className="text-xs text-zinc-500">· confirmed</span> : top.tf ? <span className="text-xs text-zinc-500">· forming</span> : null}
      </div>
      {top.p_resolves != null ? (
        <p className="tnum mt-0.5 text-[11px] text-zinc-500">
          a random walk this volatile hits the target before the invalidation {pct(top.p_resolves)} of the time in 7 days — on memecoins, textbook patterns have done worse than that.
        </p>
      ) : null}
      <p className="mt-0.5 text-[11px] text-zinc-500">{top.label}</p>
      {top.levels.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {top.levels.map((k) => (
            <span key={k.name} className="tnum border border-white/15 px-1.5 py-0.5 text-[10px] text-zinc-400">
              {k.name} <span className="text-zinc-100">${px(k.price)}</span>
            </span>
          ))}
        </div>
      ) : null}
      {rest.length ? (
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-zinc-500 hover:text-zinc-100">
            <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span> {rest.length} other candidate{rest.length > 1 ? "s" : ""}
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 text-[11px] text-zinc-500">
            {rest.map((p) => (
              <li key={p.kind}>
                <span className={BIAS[p.bias].cls}>{BIAS[p.bias].arrow}</span> <span className="text-zinc-300">{nice(p.kind)}</span>{" "}
                {p.p_in_play != null ? <span className="tnum">{pct(p.p_in_play)} · </span> : null}
                {p.label}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

// ── Demoted indicators ───────────────────────────────────────────────────────────────────────────────

function IndicatorLine({ h }: { h: ChartHealth }) {
  const parts = [
    h.rsi != null ? `RSI ${h.rsi.toFixed(0)}` : null,
    h.macd ? `MACD ${h.macd.hist >= 0 ? "above" : "below"} signal` : null,
    h.bollinger ? `${Math.round(h.bollinger.pos * 100)}% of Bollinger band` : null,
    h.volume ? `volume ${h.volume.confirmed ? "active" : "thin"}, ${h.volume.direction}` : null,
  ].filter(Boolean);
  if (!parts.length) return null;
  return (
    <details className="group mt-4 border-t border-white/10 pt-2">
      <summary className="cursor-pointer list-none text-[11px] text-zinc-600 hover:text-zinc-100">
        <span className="group-open:hidden">▸</span>
        <span className="hidden group-open:inline">▾</span> indicators
      </summary>
      <p className="tnum mt-1 text-[11px] text-zinc-500">{parts.join(" · ")} · lagging, context not a call.</p>
    </details>
  );
}
