"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * The TRY ONE chips. Chad and Larper are drawn at random from the graded corpus on each load, so
 * the demo isn't the same two wallets forever. NO RECEIPTS / COLD WALLET stay fixed — they're
 * specific states to show, not a population to sample.
 *
 * SSR renders the first of each pool (deterministic, no hydration mismatch); the client re-rolls
 * after mount, so a refresh shows someone new.
 */
const pick = (ws: string[]): string | null => (ws.length ? ws[Math.floor(Math.random() * ws.length)] : null);

export default function TryOne({ chads, larpers, fixed }: { chads: string[]; larpers: string[]; fixed: { label: string; wallet: string }[] }) {
  const [chad, setChad] = useState<string | null>(chads[0] ?? null);
  const [larp, setLarp] = useState<string | null>(larpers[0] ?? null);

  useEffect(() => {
    if (chads.length > 1) setChad(pick(chads));
    if (larpers.length > 1) setLarp(pick(larpers));
  }, [chads, larpers]);

  const chips = [
    chad ? { label: "A CHAD", wallet: chad } : null,
    larp ? { label: "A LARPER", wallet: larp } : null,
    ...fixed,
  ].filter(Boolean) as { label: string; wallet: string }[];

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2">
      <span className="silk text-[10px] tracking-[0.1em] text-zinc-500">TRY ONE:</span>
      {chips.map((c) => (
        <Link
          key={c.label}
          href={`/w/${c.wallet}`}
          className="silk border-2 border-dashed border-foreground px-2.5 py-1 text-[10px] tracking-[0.08em] no-underline hover:bg-foreground hover:text-background"
        >
          {c.label}
        </Link>
      ))}
    </div>
  );
}
