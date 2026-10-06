"use client";

import { useEffect, useState } from "react";
import type { ChartHealth } from "@/lib/karma/sources/ta";

/**
 * Chart health, loaded lazily on mount so the fragile GeckoTerminal call never slows the scan and
 * only fires when someone actually looks at an old-enough coin. Descriptive indicators, a 2h-window
 * volume-trend read, and support/resistance levels, under a loud NOT FINANCIAL ADVICE banner. It's
 * here to be read and roasted, not traded on.
 */

const GMGN_CHAIN: Record<string, string> = { solana: "sol", bsc: "bsc", base: "base", eth: "eth" };

/** Compact price for memecoin scales (e.g. 1.3e-5 → "0.0000131"). */
function px(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toPrecision(3);
}
function compactVol(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${Math.round(n)}`;
}

export default function ChartHealthPanel({ network, mint }: { network: string; mint: string }) {
  const [h, setH] = useState<ChartHealth | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");

  useEffect(() => {
    let live = true;
    fetch(`/api/chart/${network}/${mint}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: ChartHealth) => {
        if (!live) return;
        setH(data);
        setState("ok");
      })
      .catch(() => live && setState("err"));
    return () => {
      live = false;
    };
  }, [network, mint]);

  const gmgnChain = GMGN_CHAIN[network] ?? "sol";

  return (
    <div className="border-t-2 border-white/10 px-6 py-5">
      <div className="flex items-center justify-between">
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">▶ CHART HEALTH</p>
        <span className="silk text-[8px] tracking-[0.12em] text-zinc-500">NOT FINANCIAL ADVICE</span>
      </div>

      {state === "loading" ? (
        <p className="mt-3 animate-pulse text-sm text-zinc-500">reading the candles…</p>
      ) : state === "err" || !h ? (
        <p className="mt-3 text-sm text-zinc-600">chart data unavailable right now — the free candle feed rate-limits, try again in a minute.</p>
      ) : !h.enough ? (
        <p className="mt-3 text-sm text-zinc-500">{h.reason}</p>
      ) : (
        <>
          {/* indicators */}
          <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-white/10 sm:grid-cols-4">
            <Metric label="RSI (14)" value={h.rsi != null ? h.rsi.toFixed(0) : "—"} sub={rsiWord(h.rsi)} tone={rsiTone(h.rsi)} />
            <Metric label="MACD" value={macdWord(h.macd)} sub={h.macd ? (h.macd.hist >= 0 ? "above signal" : "below signal") : ""} tone={h.macd ? (h.macd.hist >= 0 ? "up" : "down") : "flat"} />
            <Metric label="Bollinger" value={bbWord(h.bollinger?.pos ?? null)} sub={h.bollinger ? `${Math.round((h.bollinger.pos ?? 0) * 100)}% of band` : ""} tone={bbTone(h.bollinger?.pos ?? null)} />
            <Metric label="Volume 2h×3" value={h.volume?.confirmed ? "active" : "thin"} sub={h.volume ? `${h.volume.direction}` : ""} tone={h.volume?.confirmed ? "up" : "flat"} />
          </div>

          {/* what each indicator means, given today's numbers — one tap away, the tiles above are the read */}
          <details className="group mt-2.5">
            <summary className="cursor-pointer list-none text-[11px] text-zinc-500 hover:text-zinc-100">
              <span className="group-open:hidden">▸</span>
              <span className="hidden group-open:inline">▾</span> what this means
            </summary>
            <div className="mt-1.5 flex flex-col gap-1 text-[11px] leading-snug text-zinc-400">
              <p><span className="text-zinc-500">RSI</span> {rsiMeaning(h.rsi)}</p>
              <p><span className="text-zinc-500">MACD</span> {macdMeaning(h.macd)}</p>
              <p><span className="text-zinc-500">Bollinger</span> {bbMeaning(h.bollinger)}</p>
              <p><span className="text-zinc-500">Volume</span> {volMeaning(h.volume)}</p>
              {h.volume ? (
                <p>
                  <span className="text-zinc-500">last three 2h windows</span>{" "}
                  <span className="tnum text-zinc-300">{h.volume.windows.map((v) => `$${compactVol(v)}`).join(" · ")}</span>{" "}
                  {h.volume.confirmed ? "— sustained, a real trend not a single candle" : "— one or more windows went quiet, treat the trend as unconfirmed"}
                </p>
              ) : null}
            </div>
          </details>

          {/* levels */}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <span className="text-zinc-400">last support <span className="tnum font-semibold text-green-400">{px(h.levels?.support)}</span></span>
            <span className="text-zinc-400">probable support <span className="tnum font-semibold text-lime-400">{px(h.levels?.probable_support)}</span></span>
            <span className="text-zinc-400">resistance <span className="tnum font-semibold text-red-400">{px(h.levels?.resistance)}</span></span>
            <span className="text-zinc-500">price <span className="tnum text-zinc-300">{px(h.price)}</span></span>
          </div>

          {/* the chart itself, embedded from GeckoTerminal — SAME pool we pulled the candles from, so it
              always resolves (DexScreener uses different pool IDs and sat on "Loading pair…" forever). */}
          {h.pool ? (
            <div className="mt-3 overflow-hidden rounded-sm border border-white/10" style={{ height: 320 }}>
              <iframe
                title="chart"
                src={`https://www.geckoterminal.com/${network}/pools/${h.pool}?embed=1&info=0&swaps=0&grayscale=0&light_chart=0`}
                className="h-full w-full"
                loading="lazy"
                allow="clipboard-write"
              />
            </div>
          ) : null}

          <p className="mt-2 text-[11px] text-zinc-600">
            lagging indicators, context not a call. full chart on{" "}
            <a href={`https://gmgn.ai/${gmgnChain}/token/${mint}`} target="_blank" rel="noopener noreferrer" className="underline hover:text-zinc-400">
              GMGN
            </a>
            . roast it: @KombuchoBuild.
          </p>
        </>
      )}
    </div>
  );
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: "up" | "down" | "hot" | "cold" | "flat" }) {
  const color =
    tone === "up" ? "text-green-400" : tone === "down" ? "text-red-400" : tone === "hot" ? "text-red-400" : tone === "cold" ? "text-lime-400" : "text-zinc-100";
  return (
    <div className="bg-background px-3 py-2.5 text-center">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-0.5 text-sm font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-zinc-600">{sub}</div>
    </div>
  );
}

// One-line, number-aware interpretation per indicator — plain language, what the current value means.
function rsiMeaning(r: number | null): string {
  if (r == null) return "not enough data yet.";
  if (r >= 70) return `at ${r.toFixed(0)}, overbought — buyers in control but stretched, pullbacks get sharper up here.`;
  if (r <= 30) return `at ${r.toFixed(0)}, oversold — sellers may be spent, bounces often start from levels like this.`;
  if (r >= 55) return `at ${r.toFixed(0)}, firm — momentum leans to buyers, not yet extreme.`;
  if (r <= 45) return `at ${r.toFixed(0)}, soft — momentum leans to sellers, not yet extreme.`;
  return `at ${r.toFixed(0)}, neutral — no momentum edge either way.`;
}
function macdMeaning(m: { hist: number } | null): string {
  if (m == null) return "not enough data yet.";
  return m.hist >= 0
    ? "line is above its signal — short-term momentum is turning up."
    : "line is below its signal — short-term momentum is turning down.";
}
function bbMeaning(b: { pos: number } | null): string {
  if (b == null) return "not enough data yet.";
  if (b.pos >= 0.85) return "riding the upper band — extended, often precedes a cool-off or a strong trend day.";
  if (b.pos <= 0.15) return "pinned to the lower band — beaten down, watch for a snap-back or a breakdown.";
  return "sitting mid-band — ranging, no volatility signal right now.";
}
function volMeaning(v: { confirmed: boolean; direction: string } | null): string {
  if (v == null) return "not enough data yet.";
  if (!v.confirmed) return "one or more 2h windows went quiet — not a confirmed trend, could be a single-candle blip.";
  return v.direction === "rising"
    ? "three straight 2h windows with rising volume — real, sustained interest."
    : v.direction === "falling"
      ? "still active but volume is fading window over window — the move may be tiring."
      : "three straight 2h windows all active — steady, genuine participation.";
}

const rsiWord = (r: number | null) => (r == null ? "" : r >= 70 ? "overbought" : r <= 30 ? "oversold" : "neutral");
const rsiTone = (r: number | null): "hot" | "cold" | "flat" => (r == null ? "flat" : r >= 70 ? "hot" : r <= 30 ? "cold" : "flat");
const macdWord = (m: { hist: number } | null) => (m == null ? "—" : m.hist >= 0 ? "bullish" : "bearish");
const bbWord = (pos: number | null) => (pos == null ? "—" : pos >= 0.85 ? "at upper" : pos <= 0.15 ? "at lower" : "mid-band");
const bbTone = (pos: number | null): "hot" | "cold" | "flat" => (pos == null ? "flat" : pos >= 0.85 ? "hot" : pos <= 0.15 ? "cold" : "flat");
