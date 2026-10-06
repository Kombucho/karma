import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Receipts from "./Receipts";
import ShareButtons from "./ShareButtons";
import BehaviorCard from "./BehaviorCard";
import SeenInCoins from "./SeenInCoins";
import Avatar from "../../Avatar";
import {
  BASE58_ADDRESS,
  getWalletReport,
  identityFor,
  sybilFor,
  type SybilMembership,
  type TokenReceipt,
} from "@/lib/karma/data";
import { provisionalRead } from "@/lib/karma/engine/rules";
import { GRADE_STYLE, avatarUrlFor, karmaColor, mult, pct, rate, shortWallet, tokenOutcome, vsMarket, vsMarketColor } from "@/lib/karma/grade-ui";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ wallet: string }>;
}): Promise<Metadata> {
  const { wallet } = await params;
  const report = getWalletReport(wallet);
  const who = report?.handle ? `@${report.handle}` : shortWallet(wallet);
  const t = report?.trust;
  const title = t ? `${who} — Karma ${t.karma}/100, grade ${t.grade} (${GRADE_STYLE[t.grade].title})` : `${who} — Karma`;
  return { title, description: t?.verdict ?? "On-chain reputation for Solana callers." };
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ wallet: string }>;
}) {
  const { wallet } = await params;
  if (!BASE58_ADDRESS.test(wallet)) notFound();

  const report = getWalletReport(wallet);
  const identity = identityFor(wallet);
  const handle = report?.handle ?? identity?.handle ?? null;
  const sybil = sybilFor(wallet);
  // Reach from the pump.fun profile (enrich-identities). Validation block covers every scored
  // caller; kols.json is the fallback for seed-listed ones. Never touches the grade.
  const reach = report?.identity?.followers ?? identity?.followers ?? null;

  // Uncovered wallet: in the universe but not yet scored.
  if (!report) {
    return (
      <Shell handle={handle} wallet={wallet} source={identity?.source_url} sybil={sybil} followers={reach}>
        <div className="px-6 pt-8 pb-2 text-center">
          <p className="text-2xl font-bold text-zinc-400">NO RECEIPTS</p>
          <p className="mt-2 text-sm text-zinc-500">
            No public calls on record, so there is nobody to dump on and no karma to grade.
            Here is what their own trading says instead:
          </p>
        </div>
        <BehaviorCard wallet={wallet} />
        <SeenInCoins wallet={wallet} />
      </Shell>
    );
  }

  const s = report.score;
  const scored = report.tokens.filter((t) => t.status === "scored");

  // ── No score. v3 has no UNPROVEN cliff — shrinkage lets a thin record be scored honestly
  // with a wide band — so the only wallets without a grade are ones with essentially no
  // public record at all. Say which of the two it is, never guess. ──
  if (!report.trust) {
    const reason =
      (report.scan?.callouts ?? 0) === 0
        ? "No public pump.fun calls found. This wallet doesn't shill, it just trades."
        : `Only ${scored.length} settled call${scored.length === 1 ? "" : "s"} on record. Too thin to read, so we don't pretend.`;
    return (
      <Shell handle={handle} wallet={wallet} source={identity?.source_url} sybil={sybil} followers={reach}>
        <div className="px-6 py-8">
          <div className="flex items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-xl bg-white/5 text-3xl font-bold text-zinc-500 ring-1 ring-white/10">
              ?
            </span>
            <div>
              <p className="text-2xl font-bold text-zinc-300">TOO THIN TO CALL</p>
              <p className="text-sm text-zinc-500">{reason}</p>
            </div>
          </div>
          {scored.length ? (
            <div className="mt-6">
              <Sparkline tokens={scored} />
            </div>
          ) : null}
        </div>
        <div className="border-t-2" style={{ borderColor: "#2a2823" }}>
          <BehaviorCard wallet={wallet} />
        </div>
        <Receipts tokens={report.tokens} />
      <SeenInCoins wallet={wallet} />
        <SeenInCoins wallet={wallet} />
      </Shell>
    );
  }

  const t = report.trust!;
  const grade = t.grade;
  const gs = GRADE_STYLE[grade];
  const shareText =
    `${handle ? `@${handle}` : shortWallet(wallet)} is a Karma ${grade} — ${gs.title}, ${t.karma}/100.\n\n` +
    `dumps on you at ${vsMarket(t.dump_vs_market)} and rugs at ${vsMarket(t.rug_vs_market)} the trench average, over ${t.n} calls.\n\n` +
    `receipts, not vibes:`;

  return (
    <Shell handle={handle} wallet={wallet} source={identity?.source_url} sybil={sybil} followers={reach}>
      {/* headline grade */}
      <div className={`flex items-stretch gap-0 border-b-2 ${gs.bg}`} style={{ borderColor: "#2a2823" }}>
        <div
          className={`silk grid w-28 shrink-0 place-items-center border-r-2 text-6xl font-bold ${gs.text}`}
          style={{ borderColor: "#2a2823" }}
        >
          {grade}
        </div>
        <div className="min-w-0 px-5 py-5">
          <p className={`silk text-2xl font-bold tracking-tight ${gs.text}`}>{gs.title.toUpperCase()}</p>
          <p className="mt-2 text-[15px] leading-snug text-zinc-300">{t.verdict}</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className={`kscore text-3xl tnum ${karmaColor(t.karma)}`}>
              {t.karma}
              <span className="text-sm font-normal text-zinc-600">/100</span>
            </span>
            {/* The band, always shown. A 6-call read and a 40-call read are not the same claim,
                and hiding that behind a single number is how every other tracker overclaims. */}
            <span className="text-xs tnum text-zinc-500">
              95% band {t.karma_low}–{t.karma_high} · {t.confidence} confidence · {t.n} calls
            </span>
          </div>
          {t.grade_floored ? (
            <p className="mt-2 border-2 border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-300">
              Grade capped at {grade}: they dump into their own buyers well above the trench rate.
              The formula alone would have graded them higher. It does not get to.
            </p>
          ) : null}
        </div>
      </div>

      {/* What the score is actually made of. Rates against the market, because 45% of every
          KOL-called coin collapses anyway — an absolute rug rate grades the asset class. */}
      <div className="grid grid-cols-1 border-b-2 sm:grid-cols-3" style={{ borderColor: "#2a2823" }}>
        <Stat
          label="Dumps on you"
          value={vsMarket(t.dump_vs_market)}
          sub={`${s.dumps} of ${t.n} calls`}
          accent={vsMarketColor(t.dump_vs_market)}
        />
        <Stat
          label="Calls that rug"
          value={vsMarket(t.rug_vs_market)}
          sub={`${s.rugs} of ${t.n} calls`}
          accent={vsMarketColor(t.rug_vs_market)}
        />
        <Stat
          label="Evidence"
          value={
            <>
              {Math.round(t.evidence_weight * 100)}
              <span className="font-sans text-base font-normal">%</span>
            </>
          }
          sub={`their own record, ${t.n} calls`}
          accent="text-zinc-100"
        />
      </div>
      <p className="border-b-2 px-6 py-2 text-center text-[11px] text-zinc-600" style={{ borderColor: "#2a2823" }}>
        1.00× is the trench average: {rate(0.199)} of calls dumped into, {rate(0.45)} that rug on
        their own. Evidence is how much of the score is their own record versus the trench baseline.
      </p>

      {/* The un-scored axis, stated as such. This is the whole epistemic posture of the product
          in one box: we measured picking skill, it does not persist, so it does not move the
          grade — but you get to see it, with its reliability attached. */}
      <div className="border-b-2 px-6 py-4" style={{ borderColor: "#2a2823" }}>
        <div className="flex items-baseline justify-between gap-3">
          <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">THE 2× RATE — MEASURED, NEVER SCORED</p>
          <span className="text-xs text-zinc-600">reliability {t.opportunity.reliability.toFixed(2)}</span>
        </div>
        <p className="mt-1.5 text-sm text-zinc-300">
          <span className="text-lg font-bold tnum text-zinc-100">{rate(t.opportunity.two_x_rate)}</span> of their
          calls put a 2× on the table inside 24h. {vsMarket(t.opportunity.vs_market)} the trench rate
          of {rate(0.256)}.
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-zinc-500">
          This moves nothing. Across 245 callers, last period&apos;s 2× rate barely predicts the next
          (r = 0.11): the best third goes on to hit 26.1% against the worst third&apos;s 22.0%. Alpha
          is a coin flip out here. Character is not, so character is what Karma scores.{" "}
          <Link href="/methodology" className="underline hover:text-zinc-400">See the working</Link>.
        </p>
      </div>

      {/* sparkline */}
      <div className="px-6 py-5">
        <p className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          EVERY CALL, OLDEST FIRST · BAR HEIGHT = THE UPSIDE THAT WAS ON THE TABLE
        </p>
        <Sparkline tokens={scored} />
      </div>

      {/* Calls too fresh to score, read off the 1h price. Never counted in the grade. */}
      {(() => {
        const nowS = Math.floor(Date.now() / 1000);
        const fresh = report.tokens
          .map((tk) => ({ tk, p: provisionalRead(tk, nowS) }))
          .filter((x) => x.p !== null);
        if (!fresh.length) return null;
        const style = { collapsing: "text-red-400", running: "text-green-400", flat: "text-zinc-400" } as const;
        const word = { collapsing: "collapsing", running: "running", flat: "flat" } as const;
        return (
          <div className="border-b-2 px-6 py-4" style={{ borderColor: "#2a2823" }}>
            <div className="flex items-baseline justify-between gap-3">
              <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">
                CALLED IN THE LAST 24H — PROVISIONAL
              </p>
              <span className="text-xs text-zinc-600">not in the grade</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {fresh.map(({ tk, p }) => (
                <span key={tk.mint} className="border-2 px-2 py-1 text-xs" style={{ borderColor: "#2a2823" }}>
                  <span className="text-zinc-300">{tk.symbol || `${tk.mint.slice(0, 4)}…`}</span>{" "}
                  <span className={style[p!.read!]}>{word[p!.read!]}</span>{" "}
                  <span className="tnum text-zinc-600">{p!.ageHours.toFixed(0)}h</span>
                </span>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              A 1h read, worth less than a settled one: it agrees with the final verdict 58% of
              the time, because at an hour a dip and a death look alike. These upgrade to real
              calls once 24h closes.
            </p>
          </div>
        );
      })()}

      <Receipts tokens={report.tokens} />

      <div className="border-t-2 px-6 py-5" style={{ borderColor: "#2a2823" }}>
        <ShareButtons text={shareText} wallet={wallet} />
        <p className="mt-3 text-center text-[11px] text-zinc-600">
          Scored {new Date(t.as_of * 1000).toISOString().slice(0, 10)} · from on-chain history
        </p>
      </div>
    </Shell>
  );
}

// ── layout shell ───────────────────────────────────────────────────────────────

function SybilBanner({ sybil }: { sybil: SybilMembership }) {
  const role =
    sybil.role === "deployer"
      ? "This wallet DEPLOYED a manufactured holder farm"
      : sybil.role === "funder"
        ? "This wallet FUNDED a manufactured holder bundle"
        : `This wallet is a puppet in a manufactured holder farm`;
  return (
    <div className="mb-3 border-2 border-red-500/60 bg-red-500/10 px-4 py-3">
      <p className="silk text-[10px] tracking-[0.1em] text-red-500">⚑ SYBIL FLAG · SEPARATE FROM THE GRADE</p>
      <p className="mt-1 text-sm text-zinc-200">
        {role}
        {sybil.coin_symbol ? ` on $${sybil.coin_symbol}` : ""}. {sybil.evidence}.
      </p>
      <p className="mt-1 text-[11px] text-zinc-500">
        A manufactured wallet has no audience to dump on, so the karma grade can&apos;t speak to this. The flag does.
      </p>
    </div>
  );
}

function Shell({
  handle,
  wallet,
  source,
  sybil,
  followers,
  children,
}: {
  handle: string | null;
  wallet: string;
  source?: string | null;
  sybil?: SybilMembership | null;
  followers?: number | null;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-5 py-10">
      <div className="mb-3 flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <Avatar src={avatarUrlFor(handle)} alt={handle ? `@${handle}` : "unlinked wallet"} size={44} />
          <span className="silk text-base font-bold">
            {handle ? `@${handle}` : "Unlinked wallet"}
          </span>
          {followers ? (
            <span className="silk shrink-0 text-xs font-bold text-zinc-400">
              {followers.toLocaleString()} followers
            </span>
          ) : null}
          <a
            href={`https://solscan.io/account/${wallet}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-zinc-500 hover:text-zinc-300"
          >
            {shortWallet(wallet)}
          </a>
        </div>
        {source ? (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            source ↗
          </a>
        ) : (
          <span className="text-xs text-amber-500/70">verify this is their trading wallet</span>
        )}
      </div>

      {sybil ? <SybilBanner sybil={sybil} /> : null}

      {/* The card itself: dark receipt on the paper page, hard 3px rule, nothing rounded. */}
      <div className="kcard overflow-hidden">
        <div className="kcard-bar silk flex items-center justify-between gap-3 px-3.5 py-2.5 text-[9px] tracking-[0.14em] text-zinc-600">
          <span className="text-background">KARMA CARD</span>
          <span>RECEIPTS, NOT VIBES</span>
        </div>
        {children}
      </div>

      <p className="mt-4 text-center text-xs text-zinc-600">
        reads on-chain behaviour, not an accusation of fraud.{" "}
        <Link href="/methodology" className="underline hover:text-zinc-400">
          How grades work
        </Link>
      </p>
    </main>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: React.ReactNode; sub?: string; accent?: string }) {
  return (
    <div
      className="border-b-2 px-4 py-3 text-center last:border-b-0 sm:border-b-0 sm:border-r-2 sm:last:border-r-0"
      style={{ borderColor: "#2a2823" }}
    >
      <div className={`silk text-xl font-bold tnum ${accent ?? "text-zinc-100"}`}>{value}</div>
      <div className="silk mt-1.5 text-[9px] tracking-[0.14em] text-zinc-600">{label.toUpperCase()}</div>
      {sub ? <div className="mt-1 text-[10px] tnum text-zinc-600">{sub}</div> : null}
    </div>
  );
}

function Sparkline({ tokens }: { tokens: TokenReceipt[] }) {
  const ordered = [...tokens].sort((a, b) => (a.entry_time ?? 0) - (b.entry_time ?? 0));
  if (!ordered.length) return <p className="text-sm text-zinc-600">No scored calls.</p>;
  return (
    <div className="flex items-end gap-1">
      {ordered.map((t) => {
        const out = tokenOutcome(t);
        // Bar height encodes the upside that was on the table (peak multiple), clamped.
        const mag = Math.min(1, ((t.copy_peak_multiple ?? 1) - 1) / 3);
        const h = 8 + Math.round(mag * 32);
        const label = t.symbol || `${t.mint.slice(0, 4)}…`;
        return (
          <div
            key={t.mint}
            title={`${label}: peak ${mult(t.copy_peak_multiple)}, 24h ${pct(t.copy_return_24h)} — ${out.word}`}
            className={`w-2.5 rounded-sm ${out.dot}`}
            style={{ height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}
