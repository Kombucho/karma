"use client";

import { useState } from "react";

/**
 * A tree-member row whose wallet expands, on click, into its last transactions, fetched lazily from
 * /api/wallet-txs. Keeps that history off the cold coin scan: only the wallets someone actually
 * inspects cost a request.
 */
type Tx = { sig: string; t: number | null };

const ago = (t: number | null): string => {
  if (!t) return "?";
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

export default function WalletTxs({ wallet, label, branch, meta }: { wallet: string; label: string; branch: string; meta: string }) {
  const [open, setOpen] = useState(false);
  const [txs, setTxs] = useState<Tx[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && txs === null && !loading) {
      setLoading(true);
      setErr(false);
      try {
        const r = await fetch(`/api/wallet-txs/${wallet}`);
        if (!r.ok) throw new Error();
        const j = await r.json();
        setTxs(j.txs ?? []);
      } catch {
        setErr(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="mt-1.5">
      <p className="text-zinc-400">
        {branch}
        {"  "}
        <button onClick={toggle} className="cursor-pointer text-zinc-300 underline-offset-2 hover:text-zinc-100 hover:underline">
          {label}
        </button>
        <span className="text-zinc-500">{meta}</span>
        <span className="ml-1 text-zinc-600">{open ? "▾" : "▸ txns"}</span>
      </p>
      {open ? (
        <p className="pl-[18px] text-zinc-600">
          {loading ? (
            "loading…"
          ) : err ? (
            "couldn't load txns"
          ) : txs && txs.length ? (
            <>
              last {txs.length}:{" "}
              {txs.map((t, i) => (
                <span key={t.sig}>
                  {i > 0 ? " · " : ""}
                  <a href={`https://solscan.io/tx/${t.sig}`} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400">
                    {t.sig.slice(0, 4)}…
                  </a>{" "}
                  {ago(t.t)}
                </span>
              ))}
            </>
          ) : (
            "no recent txns"
          )}
        </p>
      ) : null}
    </div>
  );
}
