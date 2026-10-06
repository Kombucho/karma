import type { Metadata } from "next";
import Link from "next/link";
import { readFileSync } from "node:fs";
import path from "node:path";

export const metadata: Metadata = {
  title: "How Karma works — Karma",
  description:
    "Every other tracker ranks Solana callers by profit, which rewards dumping on the people who copied you. Karma scores the opposite: whether following someone tends to hurt you.",
};

/**
 * The methodology page — the one-second pitch. Numbers are read live from seed/calibration.json
 * (written by `npm run calibrate` off the corpus on disk) so the page cannot drift from the model.
 * Same loader pattern as src/app/audit/page.tsx.
 */
interface Calibration {
  generated_from: string;
  base_rates: Record<string, number>;
}

function calibration(): Calibration | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "seed", "calibration.json"), "utf8"));
  } catch {
    return null;
  }
}

const pc = (x: number, d = 0) => `${(x * 100).toFixed(d)}%`;

// Mirrors THE SCALE on src/app/page.tsx — same titles, same colours.
const SCALE = [
  ["S", "Chad", "text-green-400", "green", "you were never their exit liquidity"],
  ["A", "Solid", "text-green-400", "green", "dumps and rugs at half the trench rate or less"],
  ["B", "Fair", "text-lime-400", "lime", "measurably cleaner than the average caller"],
  ["C", "Coinflip", "text-amber-400", "amber", "trench average. you are gambling, not following"],
  ["D", "Exit Liquidity", "text-orange-400", "orange", "they sell into the room they filled"],
  ["F", "Larper", "text-red-400", "red", "your bags funded their exit, repeatedly"],
] as const;

export default function MethodologyPage() {
  const cal = calibration();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
      <p className="silk text-[10px] tracking-[0.08em]">▶ HOW KARMA WORKS</p>

      {/* 1 · THE MESSAGE — the whole argument, in one read. */}
      <section className="mt-3 border-2 border-foreground">
        <div className="silk bg-foreground px-3 py-2 text-[10px] tracking-[0.1em] text-background">
          THE MESSAGE
        </div>
        <div className="bg-background px-5 py-6">
          <h1 className="serif text-[clamp(22px,3.6vw,32px)] font-bold leading-tight">
            every other tracker ranks callers by{" "}
            <span className="text-green-400">profit</span>. that rewards the one thing that wrecks
            you.
          </h1>
          <p className="mt-4 serif text-[15px] leading-relaxed text-zinc-300">
            the fastest way to top a pnl board is to{" "}
            <strong className="rounded bg-red-500/10 px-1 font-bold text-red-500">
              sell into the people who copied you
            </strong>
            . so a profit board is a leaderboard of the callers most willing to dump on their own
            followers.
          </p>
          <p className="mt-3 serif text-[17px] font-bold leading-relaxed">
            karma scores the opposite thing:{" "}
            <span className="text-green-400">whether following someone tends to hurt you.</span>
          </p>
        </div>
      </section>

      {/* 2 · HOW IT WORKS — 3-step flow. */}
      <p className="silk mt-8 text-[10px] tracking-[0.08em] text-zinc-500">HOW IT WORKS</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <Step
          n="1"
          tint="green"
          head="read the chain"
          body="pull a caller's real on-chain history, every single call, no self-reported wins."
        />
        <Step
          n="2"
          tint="red"
          head="grade the conduct"
          body="not luck. do they dump on you? do their coins die on arrival? that's what we score."
        />
        <Step
          n="3"
          tint="green"
          head="a grade you can check"
          body="one letter, S to F, backed by the receipts. we grade ourselves too and publish the misses."
        />
      </div>

      {/* 3 · THE MARKET WE AUDITED — 3 big colored stat cards, read live. */}
      <p className="silk mt-8 text-[10px] tracking-[0.08em] text-zinc-500">
        THE MARKET WE AUDITED
      </p>
      {cal ? (
        <>
          <div className="mt-3 grid grid-cols-3 gap-3">
            <Stat
              tint="red"
              v={pc(cal.base_rates.rug)}
              k="of called coins collapse ≥80% within 24h"
            />
            <Stat
              tint="red"
              v={pc(cal.base_rates.dump)}
              k="of calls, the caller dumps into their own followers"
            />
            <Stat
              tint="green"
              v={pc(cal.base_rates.win)}
              k="of calls ever offer a clean 2×"
            />
          </div>
          <div className="mt-3 ink-box px-4 py-3">
            <p className="serif text-[15px] leading-relaxed text-zinc-300">
              measured across <strong className="text-foreground">{cal.generated_from}</strong>.
              read that and you want to call everyone a scammer.{" "}
              <strong className="text-foreground">don&apos;t.</strong> this is the asset class, not
              the crime. that&apos;s why we score against the market,{" "}
              <span className="rounded bg-green-500/10 px-1 font-bold text-green-400">
                never against zero
              </span>
              .
            </p>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-zinc-500">the audit is being recomputed. check back shortly.</p>
      )}

      {/* 4 · HOW IT SCORES — the two things that move a grade. */}
      <p className="silk mt-8 text-[10px] tracking-[0.08em] text-zinc-500">
        HOW IT SCORES — TWO THINGS MOVE A GRADE
      </p>
      <div className="mt-3 space-y-3">
        <Sin
          tag="DUMP"
          weight="the cardinal sin — weighted heaviest"
          body="they took profit, then the price fell ≥50% on whoever still held. clean profit-taking into a coin that survives is never a dump."
        />
        <Sin
          tag="RUG"
          weight="dead on arrival"
          body="the coin gave nobody a real window to get out ahead. it was never meant to run, you were always the exit."
        />
      </div>

      {/* The fairness rule — its own green block. */}
      <div className="mt-3 border-2 border-green-500/40 bg-green-500/10 px-4 py-4">
        <p className="silk text-[10px] tracking-[0.08em] text-green-400">THE FAIRNESS RULE</p>
        <p className="mt-2 serif text-[16px] leading-relaxed text-zinc-200">
          a coin that ran and gave you a{" "}
          <strong className="text-green-400">real window to sell at a profit</strong> before it died
          is <strong className="text-green-400">not</strong> held against the caller. dying isn&apos;t
          the crime — almost everything here dies. only dumping and dead-on-arrival get you.
        </p>
      </div>

      <p className="mt-3 serif text-[13px] leading-relaxed text-zinc-500">
        whether a caller picks 2× winners is shown on every card and{" "}
        <strong className="text-zinc-400">never scored</strong> — because picking doesn&apos;t
        survive the test, character does.
      </p>

      {/* 5 · THE GRADE SCALE — the bam payoff. */}
      <p className="silk mt-8 text-[10px] tracking-[0.08em] text-zinc-500">THE GRADE SCALE</p>
      <div className="mt-3 overflow-hidden border-2 border-foreground">
        {SCALE.map(([g, t, c, tint, mean], i) => (
          <div
            key={g}
            className={`flex items-baseline gap-3 px-4 py-3 ${i > 0 ? "border-t-2 border-foreground" : ""} ${TINT_BG[tint]}`}
          >
            <span className={`silk w-6 shrink-0 text-lg font-bold ${c}`}>{g}</span>
            <span className={`serif w-32 shrink-0 text-lg font-bold ${c}`}>{t}</span>
            <span className="serif text-[15px] leading-snug text-zinc-400">{mean}</span>
          </div>
        ))}
      </div>

      {/* Single closing line to /audit. */}
      <p className="mt-8 text-center">
        <Link href="/audit" className="silk text-[11px] tracking-[0.08em] text-green-400 underline">
          we grade ourselves too, and publish where we&apos;re wrong →
        </Link>
      </p>
    </main>
  );
}

const TINT_BG: Record<string, string> = {
  green: "bg-green-500/10",
  lime: "bg-lime-500/10",
  amber: "bg-amber-500/10",
  orange: "bg-orange-500/10",
  red: "bg-red-500/10",
};

const TINT_TEXT: Record<string, string> = {
  green: "text-green-400",
  red: "text-red-500",
  amber: "text-amber-400",
};

const TINT_BORDER: Record<string, string> = {
  green: "border-green-500/40",
  red: "border-red-500/40",
  amber: "border-amber-500/40",
};

function Step({ n, tint, head, body }: { n: string; tint: string; head: string; body: string }) {
  return (
    <div className={`border-2 ${TINT_BORDER[tint]} ${TINT_BG[tint]} px-4 py-4`}>
      <div className={`silk text-2xl font-bold ${TINT_TEXT[tint]}`}>{n}</div>
      <p className="silk mt-2 text-[11px] font-bold tracking-[0.06em] text-foreground">{head}</p>
      <p className="serif mt-2 text-[14px] leading-snug text-zinc-400">{body}</p>
    </div>
  );
}

function Stat({ tint, v, k }: { tint: string; v: string; k: string }) {
  return (
    <div className={`border-2 ${TINT_BORDER[tint]} ${TINT_BG[tint]} px-3 py-4 text-center`}>
      <div className={`text-3xl font-bold tnum ${TINT_TEXT[tint]}`}>{v}</div>
      <div className="mt-1.5 serif text-[12px] leading-tight text-zinc-500">{k}</div>
    </div>
  );
}

function Sin({ tag, weight, body }: { tag: string; weight: string; body: string }) {
  return (
    <div className="flex items-start gap-3 border-2 border-red-500/40 bg-red-500/10 px-4 py-3">
      <span className="silk mt-0.5 shrink-0 rounded bg-red-500/20 px-2 py-1 text-[11px] font-bold tracking-[0.08em] text-red-500">
        {tag}
      </span>
      <div>
        <p className="serif text-[15px] leading-relaxed text-zinc-200">{body}</p>
        <p className="silk mt-1 text-[9px] tracking-[0.08em] text-red-500/80">{weight}</p>
      </div>
    </div>
  );
}
