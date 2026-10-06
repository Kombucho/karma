import Link from "next/link";
import { walletHistory, type WalletRole } from "@/lib/karma/history";

/** Roles worth a trader's attention, worst first, with the plain-English label the card uses. */
const ROLE_LABELS: [WalletRole, string, boolean][] = [
  ["cluster_purse", "funded a connected-wallet group", true],
  ["bundle_purse", "funded a sybil bundle", true],
  ["router", "moved tokens into top holders", true],
  ["cabal", "rotates with a cabal across coins", true],
  ["sniper", "sniped at launch", true],
  ["born_to_buy", "wallet born to buy", true],
  ["routed_in", "received its bag by transfer", true],
  ["cluster_member", "part of a connected group", true],
  ["bundle_member", "part of a sybil bundle", true],
  ["ecosystem_only", "trades only one launchpad's coins", true],
  ["reward_only", "only sells the rewards", true],
  ["fresh_buyer_1h", "fresh wallet loading a coin", true],
  ["launch_window", "bought in the first hour", false],
  ["kol", "known caller", false],
  ["dev", "deployed a coin", false],
  ["holder", "top holder", false],
];

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};

/**
 * The wallet's record across every coin Karma has scanned (append-only wallet_sightings): which coins it
 * showed up in and the role it played there. Server component, one indexed query; renders nothing when
 * the wallet has never been seen or the history tables aren't there yet.
 */
export default async function SeenInCoins({ wallet }: { wallet: string }) {
  const h = await walletHistory(wallet);
  if (!h || h.coins === 0) return null;
  const roles = ROLE_LABELS.filter(([r]) => (h.role_counts[r] ?? 0) > 0);
  const bad = roles.some(([r, , flag]) => flag && r !== "holder");
  return (
    <div className={`border-t border-white/15 px-6 py-4 ${bad ? "border-l-4 border-l-red-500" : ""}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <p className={`silk text-[10px] tracking-[0.1em] ${bad ? "text-red-400" : "text-zinc-500"}`}>{bad ? "⚑ SEEN IN THE WILD" : "SEEN IN THE WILD"}</p>
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">
          {h.coins} COIN{h.coins > 1 ? "S" : ""} · LAST {h.last_seen ? ago(h.last_seen).toUpperCase() : "?"} AGO
        </p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {roles.map(([r, label, flag]) => (
          <span key={r} className={flag ? "text-zinc-100" : "text-zinc-400"}>
            <span className={`tnum font-bold ${flag ? "text-red-400" : ""}`}>{h.role_counts[r]}</span> {label}
          </span>
        ))}
      </div>
      <details className="group mt-2">
        <summary className="cursor-pointer list-none text-[11px] text-zinc-500">
          coins <span className="group-open:hidden">▸</span>
        </summary>
        <div className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-zinc-400">
          {h.recent.map((c) => (
            <p key={c.mint}>
              <Link href={`/coin/${c.mint}`} className="text-zinc-200">
                {c.symbol ? `$${c.symbol}` : `${c.mint.slice(0, 4)}…${c.mint.slice(-4)}`}
              </Link>
              {c.pct !== null ? ` · ${c.pct.toFixed(2)}%` : ""}
              {c.rank !== null ? ` · #${c.rank}` : ""}
              {` · ${c.roles.filter((r) => r !== "holder").join(", ") || "holder"}`}
              {c.verdict && c.verdict !== "clean" ? ` · coin read ${c.verdict}` : ""}
              {` · ${ago(c.t)} ago`}
            </p>
          ))}
        </div>
      </details>
    </div>
  );
}
