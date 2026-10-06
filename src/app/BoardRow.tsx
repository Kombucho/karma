import Link from "next/link";
import type { BoardRow as Row } from "@/lib/karma/data";
import type { Grade } from "@/lib/karma/types";
import { GRADE_STYLE, karmaColor, rate, shortWallet, vsMarket, vsMarketColor } from "@/lib/karma/grade-ui";

/**
 * Behavioural buckets for wallets with no callout record. A wallet that never shills cannot
 * earn a trust grade, but it is never "unproven": it has a trading history, so it lands in a
 * bucket with a mark of its own. The mark is deliberately NOT a letter — a grade and a
 * behaviour read are different claims and must never look interchangeable.
 */
const BUCKET: Record<string, { mark: string; label: string; cls: string }> = {
  sniper: { mark: "▲", label: "Sniper", cls: "text-red-400" },
  "bot/scalper": { mark: "≡", label: "Bot", cls: "text-orange-400" },
  "bag-whale": { mark: "●", label: "Bagholder", cls: "text-amber-400" },
  "patient-trader": { mark: "◆", label: "Position trader", cls: "text-green-400" },
  mixed: { mark: "~", label: "Mixed", cls: "text-zinc-400" },
  "no-data": { mark: "·", label: "Cold wallet", cls: "text-zinc-600" },
};

/** One row of a board = a mini Karma Card that links to the full card. */
export default function BoardRow({
  row,
  rank,
  grade,
  title,
}: {
  row: Row;
  rank?: number;
  grade: Grade | null;
  title: string | null;
}) {
  const gs = grade ? GRADE_STYLE[grade] : null;
  const bucket = !grade && row.behavior ? BUCKET[row.behavior] : null;
  return (
    <Link
      href={`/w/${row.wallet}`}
      className="group flex items-center gap-3 border-2 border-foreground bg-transparent px-3.5 py-3 transition-colors hover:bg-foreground/5"
    >
      {rank !== undefined ? (
        <span className="w-5 shrink-0 text-right text-sm tnum text-zinc-500">{rank}</span>
      ) : null}

      <span
        className={`grid h-9 w-9 shrink-0 place-items-center text-lg font-bold ring-1 ${
          gs ? `${gs.text} ${gs.bg} ${gs.ring}` : "text-zinc-500 bg-white/5 ring-white/10"
        }`}
      >
        {grade ?? bucket?.mark ?? "?"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">
            {row.handle ? `@${row.handle}` : shortWallet(row.wallet)}
          </span>
          {title ? <span className="hidden truncate text-xs text-zinc-500 sm:inline">{title}</span> : null}
          {bucket ? <span className={`hidden truncate text-xs sm:inline ${bucket.cls}`}>{bucket.label}</span> : null}
        </div>
        <p className="truncate text-xs text-zinc-500">{row.verdict || row.behaviorVerdict}</p>
      </div>

      {/* vs-market multiples, not raw rates: 45% of every KOL-called coin collapses anyway,
          so "0.43×" says something about the caller where "19% rug rate" says something
          about the asset class. */}
      <div className="hidden shrink-0 gap-5 text-right text-xs tnum sm:flex">
        {bucket ? (
          <>
            <Stat
              label="hold"
              value={row.medianHoldMin === null ? "–" : row.medianHoldMin < 60 ? `${Math.round(row.medianHoldMin)}m` : `${(row.medianHoldMin / 60).toFixed(1)}h`}
            />
            <Stat label="trades/d" value={row.tradesPerDay === null ? "–" : String(Math.round(row.tradesPerDay))} />
            <Stat
              label="snipes"
              value={row.sniperSampled ? `${row.sniped}/${row.sniperSampled}` : "–"}
              accent={row.sniperSampled && row.sniped! / row.sniperSampled >= 0.5 ? "text-red-400" : undefined}
            />
            <Stat label="calls" value="0" accent="text-zinc-600" />
          </>
        ) : (
          <>
            <Stat label="dump" value={vsMarket(row.dumpVsMarket)} accent={vsMarketColor(row.dumpVsMarket)} />
            <Stat label="rug" value={vsMarket(row.rugVsMarket)} accent={vsMarketColor(row.rugVsMarket)} />
            <Stat label="2× shots" value={rate(row.twoXRate)} accent="text-zinc-500" />
            <Stat label="calls" value={String(row.n)} />
          </>
        )}
      </div>

      <span className="w-16 shrink-0 text-right">
        <span className={`block text-lg font-bold tnum leading-none ${karmaColor(row.karma)}`}>
          {row.karma === null ? "–" : row.karma}
        </span>
        {/* The band is the honesty: a 10-call record and a 40-call record are not the same claim. */}
        {row.karma_low !== null && row.karma_high !== null ? (
          <span className="mt-0.5 block text-[10px] tnum text-zinc-600">
            {row.karma_low}–{row.karma_high}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="w-10">
      <div className={`font-medium ${accent ?? "text-zinc-300"}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-600">{label}</div>
    </div>
  );
}
