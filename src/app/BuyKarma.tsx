"use client";

import { useState } from "react";

/**
 * The $KARMA support section, straight from the design ("SUPPORT THE BUILD").
 *
 * One line on where fees go, then a single button. Buying opens the Jupiter Plugin as a modal —
 * it ships its own wallet connection (Phantom, Backpack, Solflare…), quoting and transaction
 * sending, so the user signs in their own wallet and we never touch keys or RPC. The plugin loads
 * lazily on the first click, not for every visitor. Everything is gated on NEXT_PUBLIC_KARMA_MINT:
 * until the token launches the button says so instead of pretending, and setting the env var is
 * the launch switch.
 */

declare global {
  interface Window {
    Jupiter?: { init: (opts: Record<string, unknown>) => void };
  }
}

const MINT = process.env.NEXT_PUBLIC_KARMA_MINT ?? "";
const PLUGIN_SRC = "https://plugin.jup.ag/plugin-v1.js";

export default function BuyKarma() {
  const [failed, setFailed] = useState(false);
  const [notLive, setNotLive] = useState(false);
  const [copied, setCopied] = useState(false);

  const buy = () => {
    if (!MINT) return setNotLive(true);
    const open = () =>
      window.Jupiter?.init({ displayMode: "modal", formProps: { initialOutputMint: MINT, swapMode: "ExactIn" } });
    if (window.Jupiter) return open();
    const s = document.createElement("script");
    s.src = PLUGIN_SRC;
    s.async = true;
    s.onload = open;
    s.onerror = () => setFailed(true);
    document.head.appendChild(s);
  };

  return (
    <section id="token" className="mt-14 min-w-0 scroll-mt-6">
      <div className="ink-box px-4 py-5 sm:px-6">
        <p className="silk text-[10px] tracking-[0.08em]">▶ SUPPORT THE BUILD</p>
        <h2 className="mt-2 text-xl font-bold">LIKE THE PROJECT? BUY $KARMA.</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
          fees keep improving the tech, pay for the servers, and buy the dev coffee. that&apos;s the whole pitch.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {MINT && failed ? (
            <a href={`https://jup.ag/swap/SOL-${MINT}`} target="_blank" rel="noopener noreferrer" className="stamp-red no-underline">
              BUY $KARMA →
            </a>
          ) : (
            <button onClick={buy} className="stamp-red cursor-pointer">
              BUY $KARMA →
            </button>
          )}
          {MINT ? (
            <span className="text-[11px] text-zinc-600">pay from your own wallet · we never hold keys or routes</span>
          ) : null}
        </div>

        {/* Launched: show the CA to copy. Not launched: the button explains itself on click. */}
        {MINT ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="silk text-[10px] tracking-[0.08em] text-zinc-500">CA</span>
            <code className="break-all border border-foreground/30 px-2 py-1 text-xs">{MINT}</code>
            <button
              className="stamp cursor-pointer"
              onClick={() => navigator.clipboard.writeText(MINT).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}
            >
              {copied ? "COPIED ✓" : "COPY"}
            </button>
          </div>
        ) : notLive ? (
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-zinc-400">
            not live yet. when $KARMA launches the CA appears here first and nowhere else, so trust no address that isn&apos;t on this page. anything earlier is someone making you their exit liquidity.
          </p>
        ) : null}
      </div>
    </section>
  );
}
