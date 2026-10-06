"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The paywall a visitor meets once their free fresh scans are spent for the day.
 *
 * Signing in is a message signature, not a transaction: the injected wallet (Phantom, Backpack,
 * Solflare) signs a plain-text line, the server checks it and reads the wallet's $KARMA balance.
 * No wallet-adapter dependency: every major Solana wallet injects connect() + signMessage().
 */

interface InjectedWallet {
  connect: () => Promise<{ publicKey: { toString(): string } } | void>;
  publicKey?: { toString(): string } | null;
  signMessage: (msg: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
}

declare global {
  interface Window {
    phantom?: { solana?: InjectedWallet };
    solana?: InjectedWallet;
    backpack?: InjectedWallet;
    solflare?: InjectedWallet;
  }
}

const MINT = process.env.NEXT_PUBLIC_KARMA_MINT ?? "";

const injected = () => window.phantom?.solana ?? window.backpack ?? window.solflare ?? window.solana ?? null;

// Must match signInMessage() in lib/karma/access.ts byte for byte.
const message = (wallet: string, host: string, issuedAt: string) =>
  `Karma: sign in to unlock coin scans.\nNo transaction, no fees.\n\nWallet: ${wallet}\nDomain: ${host}\nIssued: ${issuedAt}`;

export interface Tier { name: string; usd: number; daily: number }

export default function HoldToScan({
  used, daily, wallet, holdingUsd, tiers,
}: { used: number; daily: number; wallet: string | null; holdingUsd: number | null; tiers: Tier[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const signIn = async () => {
    setErr(null);
    const w = injected();
    if (!w) return setErr("no Solana wallet found in this browser. install Phantom, Backpack or Solflare.");
    setBusy(true);
    try {
      const res = await w.connect();
      const pk = (res && "publicKey" in res ? res.publicKey : w.publicKey)?.toString();
      if (!pk) throw new Error("wallet didn't share an address");
      const issuedAt = new Date().toISOString();
      const signed = await w.signMessage(new TextEncoder().encode(message(pk, window.location.host, issuedAt)), "utf8");
      const sig = signed instanceof Uint8Array ? signed : signed.signature;
      const r = await fetch("/api/auth", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet: pk, issuedAt, signature: btoa(String.fromCharCode(...sig)) }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "sign-in failed");
      router.refresh();
    } catch (e) {
      setErr((e as Error).message || "cancelled");
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    await fetch("/api/auth", { method: "DELETE" });
    router.refresh();
  };

  const ascending = [...tiers].sort((a, b) => a.usd - b.usd);

  return (
    <div className="px-6 py-8">
      <p className="silk text-sm tracking-[0.14em] text-zinc-300">OUT OF FRESH SCANS</p>
      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        you&apos;ve used {used} of {daily} fresh scans today. a fresh scan pulls every holder and funder live off
        the chain, and that costs real RPC. coins anyone scanned in the last 30 minutes, and every caller card,
        stay free.
      </p>

      <p className="mt-5 silk text-[10px] tracking-[0.08em] text-zinc-500">HOLD $KARMA, SCAN MORE</p>
      <ul className="mt-2 space-y-1 text-sm text-zinc-300">
        {ascending.map((t) => (
          <li key={t.name}>
            · hold ${t.usd}+ of $KARMA → <span className="font-semibold">{t.daily} fresh scans a day</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-zinc-600">nothing is spent or locked. you keep the tokens, the wallet just proves you hold them.</p>

      {wallet ? (
        <p className="mt-4 text-xs text-zinc-500">
          signed in as <span className="font-mono">{wallet.slice(0, 4)}…{wallet.slice(-4)}</span>
          {holdingUsd !== null ? ` · holds $${holdingUsd.toFixed(2)} of $KARMA` : ""}
          {" · "}
          <button onClick={signOut} className="cursor-pointer underline hover:text-zinc-300">sign out</button>
        </p>
      ) : null}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {MINT ? (
          <a href={`https://jup.ag/swap/SOL-${MINT}`} target="_blank" rel="noopener noreferrer" className="stamp-red no-underline">
            BUY $KARMA →
          </a>
        ) : (
          <span className="text-xs text-zinc-500">$KARMA isn&apos;t live yet. free scans reset at 00:00 UTC.</span>
        )}
        {/* Always offered, even pre-launch: it's also how owner wallets get in. */}
        <button onClick={signIn} disabled={busy} className="stamp cursor-pointer disabled:opacity-50">
          {busy ? "CHECK YOUR WALLET…" : wallet ? "RE-CHECK MY BAG" : MINT ? "I HOLD, SIGN IN" : "SIGN IN"}
        </button>
      </div>
      {err ? <p className="mt-3 text-xs text-red-400">{err}</p> : null}
    </div>
  );
}
