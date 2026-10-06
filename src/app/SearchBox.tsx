"use client";

import { useState } from "react";

export default function SearchBox({ notfound }: { notfound?: string }) {
  const [q, setQ] = useState(notfound ?? "");

  return (
    <form action="/go" method="GET" className="w-full">
      <div className="flex items-stretch gap-2 border-2 border-foreground bg-background p-1.5">
        <input
          name="q"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder="paste a CA, a wallet, or @handle"
          className="min-w-0 flex-1 bg-transparent px-3 py-2.5 text-[15px] outline-none placeholder:text-zinc-500"
        />
        <button type="submit" className="stamp-red shrink-0 cursor-pointer">
          GRADE IT ▲
        </button>
      </div>
      {notfound ? (
        <p className="mt-2 px-1 text-sm text-amber-400">
          no wallet linked to <span className="font-mono">{notfound}</span> yet. paste the address
          directly and the oracle will read it cold.
        </p>
      ) : null}
    </form>
  );
}
