"use client";

import { useState } from "react";

/**
 * The fortune cookie from the design: a black panel, one serif-italic line of trench wisdom,
 * a yellow button for the next one. Every fortune is the model's own findings in aphorism
 * form — the cookie is the methodology page wearing a bathrobe.
 */
const FORTUNES = [
  "a fresh wallet funded by a known deployer is not a coincidence. it is a schedule.",
  "45% of called coins round-trip to zero. that is the trenches, not the caller.",
  "alpha does not persist. character does. we tested both.",
  "one lucky 40x does not move a median. that is the entire reason we use the median.",
  "a caller who is wrong with you is a gambler. a caller who profits against you is a larper.",
  "the wallet remembers what the thread deletes.",
  "if the top ten already show 0% remaining, you are not early. you are the exit.",
  "a spotless record on six calls is not a record. it is a weather report.",
  "the fastest way to top a pnl board is to sell into the people who copied you.",
  "trust no CA that is not on this page.",
  "buying at second zero, repeatedly, is not luck. it is a cabal seat.",
  "we do not call someone a jeet on a thin sample. we wait for the receipts.",
  "bundled supply is just a group chat with a deployer.",
  "nobody posts the calls that rugged. the chain does.",
  "the larp is free. the wallet is not. karma reads the wallet.",
];

export default function FortuneCookie({ community = [] }: { community?: Array<{ text: string; handle: string }> }) {
  // House lines and claimed community lines share one jar; a credited line is the better
  // draw, so they are interleaved rather than appended behind 14 house fortunes.
  const jar = [
    ...FORTUNES.map((text) => ({ text, handle: null as string | null })),
    ...community.map((c) => ({ text: c.text, handle: c.handle })),
  ];
  const [i, setI] = useState(0);
  const cur = jar[i % jar.length];
  return (
    <div className="flex h-full flex-col bg-foreground px-5 py-4 text-background">
      <p className="silk text-[10px] tracking-[0.08em] opacity-70">FORTUNE COOKIE</p>
      <div key={i} className="pop my-auto py-6">
        <p className="serif text-xl italic leading-snug">{cur.text}</p>
        {cur.handle ? (
          <a
            href={`https://x.com/${cur.handle}`}
            target="_blank"
            rel="noopener noreferrer"
            className="silk mt-2 inline-block text-[9px] tracking-[0.1em] text-amber-500 no-underline"
          >
            — @{cur.handle.toUpperCase()}
          </a>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <button className="stamp-yellow cursor-pointer" onClick={() => setI((i + 1) % jar.length)}>
          GIMME A NEW ONE ▲
        </button>
        <a href="/claim" className="silk text-[10px] tracking-[0.08em] text-amber-500 no-underline">ADD YOURS, FREE →</a>
      </div>
    </div>
  );
}
