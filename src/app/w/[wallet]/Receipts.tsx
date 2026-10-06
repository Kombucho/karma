"use client";

import { useState } from "react";
import type { TokenReceipt } from "@/lib/karma/data";
import { mult, pct, tokenOutcome } from "@/lib/karma/grade-ui";

/** Collapsible per-token receipts table. Only scored tokens carry a real outcome;
 *  incomplete / no-price rows are summarized, not padded into the grade. */
export default function Receipts({ tokens }: { tokens: TokenReceipt[] }) {
  const [open, setOpen] = useState(false);
  const scored = tokens.filter((t) => t.status === "scored");
  if (!scored.length) return null;

  return (
    <div className="border-t border-white/10">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-3.5 text-sm font-medium text-zinc-300 hover:bg-white/[0.03] transition-colors"
      >
        <span>Show receipts · {scored.length} tokens</span>
        <span className={`text-zinc-500 transition-transform ${open ? "rotate-180" : ""}`}>▾</span>
      </button>

      {open ? (
        <div className="overflow-x-auto px-2 pb-3">
          <table className="w-full min-w-[520px] text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 text-right font-medium">24h copy</th>
                <th className="px-3 py-2 text-right font-medium">Peak</th>
                <th className="px-3 py-2 text-right font-medium">Drop</th>
                <th className="px-3 py-2 text-center font-medium">Outcome</th>
                <th className="px-3 py-2 text-right font-medium">Links</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {scored.map((t) => {
                const out = tokenOutcome(t);
                const name = t.symbol || t.name || `${t.mint.slice(0, 4)}…${t.mint.slice(-4)}`;
                const isEvm = t.mint.startsWith("0x");
                return (
                  <tr key={t.mint} className="border-t border-white/5">
                    <td className="px-3 py-2.5">
                      <span className="font-medium">{name}</span>
                    </td>
                    <td className={`px-3 py-2.5 text-right ${retColor(t.copy_return_24h)}`}>
                      {pct(t.copy_return_24h)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-zinc-300">{mult(t.copy_peak_multiple)}</td>
                    <td className="px-3 py-2.5 text-right text-zinc-400">{pct(t.max_drop_from_peak_24h)}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${out.bg} ${out.text}`}>
                        {out.word}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      {!isEvm ? (
                        <a
                          href={`https://solscan.io/token/${t.mint}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-zinc-400 hover:text-white"
                        >
                          Solscan
                        </a>
                      ) : null}
                      <a
                        href={isEvm ? `/coin/${t.mint}` : `https://gmgn.ai/sol/token/${t.mint}`}
                        target={isEvm ? undefined : "_blank"}
                        rel={isEvm ? undefined : "noopener noreferrer"}
                        className="ml-2 text-zinc-400 hover:text-white"
                      >
                        {isEvm ? "Scan" : "Chart"}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="px-3 pt-2 text-[11px] text-zinc-600">
            &ldquo;24h copy&rdquo; simulates buying the callout and selling 24h later — a naive
            simulation, not a fill-accurate backtest.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function retColor(x: number | null): string {
  if (x === null) return "text-zinc-500";
  if (x > 0) return "text-green-400";
  if (x < 0) return "text-red-400";
  return "text-zinc-400";
}
