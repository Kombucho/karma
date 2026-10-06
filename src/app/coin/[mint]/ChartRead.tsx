"use client";

import { useEffect, useState } from "react";
import type { ChartRead, LevelRead, PatternRead, TrackRecord, WeekRead } from "@/lib/karma/quant/chart-read";
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
        <details className="group mt-2">
          <summary className="cursor-pointer list-none text-[11px] text-zinc-600 hover:text-zinc-100">
            <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span> live chart
          </summary>
        <div className="mt-2 overflow-hidden rounded-sm border border-white/10" style={{ height: 320 }}>
          <iframe
            title="chart"
            src={`https://www.geckoterminal.com/${chartNetwork}/pools/${h.pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`}
            className="h-full w-full"
            loading="lazy"
            allow="clipboard-write"
          />
        </div>
        </details>
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

      {r.levels.length && r.price != null ? <LevelChart levels={r.levels} price={r.price} candles={r.candles ?? []} /> : null}
      {r.patterns.some((p) => p.kind !== "range") ? <Patterns patterns={r.patterns.filter((p) => p.kind !== "range")} /> : null}
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

// ── Jev's record ─────────────────────────────────────────────────────────────────────────────────────

/** Jev's graded record for what this card claims, from its own ledger; "shadow" until a record exists. */
function Record({ r }: { r: ChartRead }) {
  const rec = r.record;
  const bits = (
    [
      ["today's levels", rec?.touch_24h],
      ["the week", rec?.move_7d],
    ] as [string, TrackRecord | null | undefined][]
  )
    .filter(([, t]) => t)
    .map(([name, t]) => `${name}: ${t!.n.toLocaleString()} calls graded, off by ${(t!.ece * 100).toFixed(1)} pts on average`);
  return <>{bits.length ? `Jev's record · ${bits.join(" · ")}. ` : "shadow: Jev's calls are being scored against price in its ledger; no track record yet. "}</>;
}


// ── The level chart ──────────────────────────────────────────────────────────────────────────────────

type Bar = NonNullable<ChartRead["candles"]>[number];
const CHART_H = 240;
const CHART_W = 600;
/** Labels closer than this (share of chart height) get pushed apart so they never print over each other. */
const LABEL_GAP = 0.075;

/**
 * Where price can go, drawn: the last 3 days of 1h candles, green zones up to each resistance and red zones
 * down to each support. Zones stack, so a band's depth is how likely price is to reach it today: the near,
 * likely levels read dark, the far, unlikely ones barely tinted. The numbers sit on the right.
 */
function LevelChart({ levels, price, candles }: { levels: LevelRead[]; price: number; candles: Bar[] }) {
  const [open, setOpen] = useState<LevelRead | null>(null);
  const call = levels.reduce<LevelRead | null>((b, l) => ((l.p_touch_24h ?? -1) > (b?.p_touch_24h ?? -1) ? l : b), null);

  // Log scale: a memecoin's +50% and −33% are the same distance, which is how the move feels. The axis
  // frames the levels and the last day, not the whole 3 days: an old spike would squash every level into
  // a sliver. Older candles past the frame are clipped.
  const prices = [price, ...levels.map((l) => l.price), ...candles.slice(-24).flatMap((c) => [c.h, c.l])].filter((v) => v > 0);
  const lo = Math.log(Math.min(...prices));
  const hi = Math.log(Math.max(...prices));
  const pad = (hi - lo || 0.1) * 0.06;
  const frac = (v: number) => 1 - (Math.log(v) - (lo - pad)) / (hi - lo + 2 * pad); // 0 = top
  const y = (v: number) => frac(v) * CHART_H;

  const yNow = y(price);
  // Nearest first: each band runs from now to its level, so stacking deepens the zone price reaches first.
  const near = (a: LevelRead, b: LevelRead) => Math.abs(a.dist) - Math.abs(b.dist);
  const zones = [...levels].sort(near).reverse();
  const depth = (p: number | null) => 0.05 + 0.2 * (p ?? 0.25);

  const step = candles.length ? CHART_W / candles.length : 0;
  const labels = spread([{ key: "now", at: frac(price) }, ...levels.map((l) => ({ key: `${l.side}${l.price}`, at: frac(l.price) }))]);

  return (
    <div className="mt-4">
      <div className="flex gap-2">
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} preserveAspectRatio="none" className="h-[240px] min-w-0 flex-1 overflow-hidden" role="img" aria-label={`price ${px(price)} with ${levels.length} levels`}>
          {zones.map((l) => (
            <rect
              key={`z${l.side}${l.price}`}
              x={0}
              width={CHART_W}
              y={Math.min(yNow, y(l.price))}
              height={Math.abs(yNow - y(l.price))}
              className={l.side === "resistance" ? "text-green-400" : "text-red-400"}
              fill="currentColor"
              fillOpacity={depth(l.p_touch_24h)}
            />
          ))}
          {candles.map((c, i) => {
            const up = c.c >= c.o;
            const x = i * step + step / 2;
            return (
              <g key={c.t} className={up ? "text-green-400" : "text-red-400"} opacity={0.55}>
                <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke="currentColor" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                <rect x={x - step * 0.32} width={step * 0.64} y={Math.min(y(c.o), y(c.c))} height={Math.max(1, Math.abs(y(c.o) - y(c.c)))} fill="currentColor" />
              </g>
            );
          })}
          {levels.map((l) => (
            <line
              key={`l${l.side}${l.price}`}
              x1={0}
              x2={CHART_W}
              y1={y(l.price)}
              y2={y(l.price)}
              className={l.side === "resistance" ? "text-green-400" : "text-red-400"}
              stroke="currentColor"
              strokeWidth={l === call ? 2 : 1}
              strokeDasharray="5 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line x1={0} x2={CHART_W} y1={yNow} y2={yNow} className="text-zinc-100" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>

        <div className="relative h-[240px] w-[9.5rem] shrink-0 sm:w-[10.5rem]">
          <span className="tnum absolute right-0 -translate-y-1/2 text-right text-xs font-bold leading-tight text-zinc-100" style={{ top: `${labels.get("now")! * 100}%` }}>
            <span className="silk mr-1 text-[8px] tracking-[0.1em] text-zinc-500">NOW</span>${px(price)}
          </span>
          {levels.map((l) => {
            const up = l.side === "resistance";
            const isCall = l === call;
            return (
              <button
                key={`t${l.side}${l.price}`}
                type="button"
                onClick={() => setOpen(open === l ? null : l)}
                aria-expanded={open === l}
                title={l.sources.join(" · ")}
                className="tnum absolute right-0 -translate-y-1/2 text-right leading-tight hover:opacity-70"
                style={{ top: `${labels.get(`${l.side}${l.price}`)! * 100}%` }}
              >
                <span className={`whitespace-nowrap text-[11px] ${isCall ? "font-bold text-zinc-100" : "text-zinc-300"}`}>
                  ${px(l.price)} <span className={`text-[10px] ${up ? UP : DOWN}`}>{signed(l.dist)}</span>{" "}
                  <span className={isCall ? "font-bold text-zinc-100" : "text-zinc-500"}>{pct(l.p_touch_24h)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <p className="mt-1.5 text-[10px] text-zinc-600">
        <span className={UP}>green</span>: room to the upside · <span className={DOWN}>red</span>: what you lose if it breaks down · % = chance price gets
        there today · tap a level for why it&apos;s there.
      </p>
      {open ? (
        <p className="mt-1 text-[11px] leading-snug text-zinc-500">
          ${px(open.price)} {open.side} from {open.sources.join(" · ") || "—"}
        </p>
      ) : null}
    </div>
  );
}

/** Nudge label positions (0–1, top-down) apart so no two sit closer than LABEL_GAP, keeping their order. */
function spread(items: { key: string; at: number }[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.at - b.at).map((i) => ({ ...i }));
  for (let i = 1; i < sorted.length; i++) sorted[i].at = Math.max(sorted[i].at, sorted[i - 1].at + LABEL_GAP);
  // Pushed off the bottom: shift the whole stack back up, then clamp the top.
  const over = sorted.length ? sorted.at(-1)!.at - (1 - LABEL_GAP / 2) : 0;
  if (over > 0) for (const s of sorted) s.at -= over;
  for (let i = 0; i < sorted.length; i++) sorted[i].at = Math.max(sorted[i].at, i ? sorted[i - 1].at + LABEL_GAP : LABEL_GAP / 2);
  return new Map(sorted.map((s) => [s.key, s.at]));
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
