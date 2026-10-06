"use client";

import { useState } from "react";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Claim-by-tweet. No login, no wallet signature: you post one tweet from your account containing
 * your wallet, and that post is the proof (only you can post from your handle). `npm run
 * verify-claims` sweeps X for the phrase and merges verified pairs. Handle and line are optional.
 */
const PHRASE = "is my Karma card";
const clean = (h: string) => h.trim().replace(/^@/, "").replace(/^(https?:\/\/)?(x|twitter)\.com\//i, "").replace(/\/.*$/, "");

export default function ClaimForm() {
  const [wallet, setWallet] = useState("");
  const [handle, setHandle] = useState("");
  const [quote, setQuote] = useState("");
  const valid = BASE58.test(wallet.trim());
  const h = clean(handle);

  const text =
    `${wallet.trim()} ${PHRASE}.\n\n` +
    (quote.trim() ? `"${quote.trim()}"\n\n` : "") +
    `karma.wtf reads who's calling, from the chain. check anyone:`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;

  return (
    <div className="flex flex-col gap-5">
      <Field label="YOUR PUMP.FUN WALLET">
        <input
          value={wallet}
          onChange={(e) => setWallet(e.target.value)}
          spellCheck={false}
          placeholder="paste it here"
          className="w-full border-2 border-foreground bg-background px-3 py-2.5 text-[15px] outline-none transition-colors focus:border-red-500 placeholder:text-zinc-600"
        />
        {wallet && !valid ? <p className="mt-1.5 text-xs text-red-500">not a Solana address.</p> : null}
      </Field>

      <Field label="X HANDLE" optional>
        <div className="flex items-center border-2 border-foreground bg-background transition-colors focus-within:border-red-500">
          <span className="pl-3 text-[15px] text-zinc-600">@</span>
          <input
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            spellCheck={false}
            placeholder="yourhandle"
            className="w-full bg-transparent px-1.5 py-2.5 text-[15px] outline-none placeholder:text-zinc-600"
          />
        </div>
      </Field>

      <Field label="A LINE FOR THE COOKIE JAR" optional>
        <input
          value={quote}
          onChange={(e) => setQuote(e.target.value.slice(0, 140))}
          placeholder="one line of trench wisdom"
          className="w-full border-2 border-foreground bg-background px-3 py-2.5 text-[15px] outline-none transition-colors focus:border-red-500 placeholder:text-zinc-600"
        />
        {quote ? <p className="mt-1 text-right text-[10px] tnum text-zinc-600">{quote.length}/140</p> : null}
      </Field>

      {valid ? (
        <div className="border-t-2 border-foreground pt-5">
          <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">POST THIS FROM {h ? `@${h}` : "YOUR ACCOUNT"} — THAT'S THE PROOF</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap border-2 border-foreground bg-foreground px-3 py-3 text-[13px] leading-relaxed text-background">
{text}
          </pre>
          <a href={tweetUrl} target="_blank" rel="noopener noreferrer" className="stamp-red mt-4 inline-block no-underline">
            POST IT ▲
          </a>
          <p className="mt-2 text-[11px] text-zinc-500">no wallet connect, ever. swept into the board within a day.</p>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="silk mb-1.5 block text-[10px] tracking-[0.1em] text-zinc-500">
        {label}
        {optional ? <span className="text-zinc-600"> · OPTIONAL</span> : null}
      </label>
      {children}
    </div>
  );
}
