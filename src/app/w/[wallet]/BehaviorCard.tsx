"use client";

import { useEffect, useState } from "react";

/** The budget loader. The oracle is slow because the dev is on the free tier, and says so. */
const LOADER_LINES = [
  "READING THE CHAIN…",
  "PULLING THE LAST 200 TRADES…",
  "CHECKING WHO APED AT SECOND ZERO…",
  "DEV IS ON A BUDGET. SCANS RUN AT FREE-TIER SPEED.",
  "WANT IT FASTER? BUY $KARMA. IT LITERALLY PAYS THE RPC BILL.",
  "STILL READING. THE CHAIN IS LONG AND THE BUDGET IS SHORT.",
  "NO, IT HASN'T FROZEN. THE ORACLE IS JUST POOR.",
];

/**
 * Live behaviour read for wallets outside the scored corpus — what the majority of pasted
 * wallets get instead of a dead end. Fetched client-side so the page itself stays instant;
 * the read costs up to ~9 upstream requests cold and arrives in a few seconds.
 *
 * Hard product line, repeated in the copy: this is a fingerprint, NOT a Karma grade. Karma
 * measures whether following a caller hurts; a wallet with no public callouts has no
 * followers, so there is no trust to measure — but its trading style is still readable.
 */

interface Read {
  klass: string;
  verdict: string;
  n_trades: number;
  trades_per_day: number;
  distinct_mints: number;
  sell_ratio: number;
  median_hold_min: number | null;
  round_trips: number;
  sniped: number;
  sniper_sampled: number;
  error?: string;
}

const KLASS_STYLE: Record<string, { label: string; cls: string }> = {
  sniper: { label: "SNIPER", cls: "bg-red-500/15 text-red-300 ring-red-500/40" },
  "bot/scalper": { label: "BOT", cls: "bg-orange-500/15 text-orange-300 ring-orange-500/40" },
  "bag-whale": { label: "BAGHOLDER", cls: "bg-amber-500/15 text-amber-300 ring-amber-500/40" },
  "patient-trader": { label: "POSITION TRADER", cls: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40" },
  mixed: { label: "MIXED", cls: "bg-zinc-500/15 text-zinc-300 ring-zinc-500/40" },
  "no-data": { label: "COLD WALLET", cls: "bg-zinc-500/15 text-zinc-500 ring-zinc-500/30" },
};

const holdFmt = (m: number | null) =>
  m === null ? "–" : m < 60 ? `${Math.round(m)}min` : m < 1440 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`;

export default function BehaviorCard({ wallet }: { wallet: string }) {
  const [read, setRead] = useState<Read | null>(null);
  const [failed, setFailed] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [line, setLine] = useState(0);

  useEffect(() => {
    if (read || failed) return;
    const t = setInterval(() => setLine((l) => Math.min(l + 1, LOADER_LINES.length - 1)), 2600);
    return () => clearInterval(t);
  }, [read, failed]);

  useEffect(() => {
    fetch(`/api/behavior/${wallet}`)
      .then(async (r) => {
        if (r.status === 429) { setRateLimited(true); setFailed(true); return; }
        const j = (await r.json()) as Read;
        if (j.error) setFailed(true); else setRead(j);
      })
      .catch(() => setFailed(true));
  }, [wallet]);

  if (failed)
    return (
      <p className="px-6 py-4 text-sm text-zinc-500">
        {rateLimited
          ? "The oracle is at capacity. dev is on a budget, scans are metered by the minute. wait a beat, or buy $KARMA and fund a faster tier."
          : "pump.fun\u2019s trade feed didn\u2019t answer. try again in a minute."}
      </p>
    );

  if (!read)
    return (
      <div className="px-6 py-4">
        <p className="silk text-[10px] tracking-[0.08em] text-zinc-500">
          THE ORACLE IS READING<span className="blink">▍</span>
        </p>
        <p key={line} className="pop mt-1.5 text-sm text-zinc-400">{LOADER_LINES[line]}</p>
      </div>
    );

  const k = KLASS_STYLE[read.klass] ?? KLASS_STYLE.mixed;

  return (
    <div className="px-6 py-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">BEHAVIOUR READ · NOT A KARMA GRADE</p>
        <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ${k.cls}`}>{k.label}</span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-zinc-300">{read.verdict}</p>

      {read.n_trades > 0 ? (
        <div className="mt-3 grid grid-cols-2 gap-2 text-xs tnum sm:grid-cols-4">
          <Mini label="median hold" value={holdFmt(read.median_hold_min)} />
          <Mini label="trades / day" value={String(Math.round(read.trades_per_day))} />
          <Mini label="coins aped" value={String(read.distinct_mints)} />
          <Mini
            label="snipes"
            value={read.sniper_sampled ? `${read.sniped}/${read.sniper_sampled} sampled` : "–"}
            danger={read.sniper_sampled > 0 && read.sniped / read.sniper_sampled >= 0.5}
          />
        </div>
      ) : null}

      <p className="mt-3 text-[11px] leading-relaxed text-zinc-600">
        Style only, from the last {read.n_trades} pump.fun trades. Karma grades need public calls:
        no audience, nobody to dump on, nothing to grade.
      </p>
    </div>
  );
}

function Mini({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-center">
      <div className={`font-semibold ${danger ? "text-red-400" : "text-zinc-200"}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
    </div>
  );
}
