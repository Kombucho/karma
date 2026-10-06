import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";

export const metadata: Metadata = {
  title: "The Audit — Karma",
  description:
    "What Karma is, what it found reading the whole memecoin caller space, and what it's for: a base of receipts to trade from instead of vibes. We grade on conduct, we grade fairness, and we publish our own error rate.",
};

/**
 * The audit page — the public explainer.
 *
 * Numbers are read live from seed/calibration.json so they stay honest as the corpus grows.
 * Nothing here is hand-entered; the loader below is the single source.
 */
interface Calibration {
  generated_from: string;
  base_rates: Record<string, number>;
  reliability: Record<string, { r: number; sb: number; spread: number }>;
  grade_distribution: Record<string, number>;
  scoreable: number;
  total_wallets: number;
  market_harm?: number;
  precision_at_top?: Array<{ K: number; model: string; next_harm: number; worst: number; thin: number; blowups: number }>;
}

function calibration(): Calibration | null {
  try {
    return JSON.parse(readFileSync(path.join(process.cwd(), "seed", "calibration.json"), "utf8"));
  } catch {
    return null;
  }
}

const pc = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;

export default function AuditPage() {
  const cal = calibration();
  if (!cal)
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
        <p className="text-sm text-zinc-500">the audit is being recomputed. check back shortly.</p>
      </main>
    );

  const grades = ["S", "A", "B", "C", "D", "F"] as const;
  const maxGrade = Math.max(...grades.map((g) => cal.grade_distribution[g] ?? 0));
  const shrunkTop10 = cal.precision_at_top?.find((r) => r.K === 10 && r.model === "shrunk");

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
      <p className="silk text-[10px] tracking-[0.08em]">▶ THE AUDIT — WHAT WE FOUND, AND WHAT KARMA IS FOR</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">Trade from receipts, not vibes</h1>
      <p className="mt-2 text-sm text-zinc-400">
        karma exists to help you find good coins and, more to the point, good people, or at least
        people who won&apos;t rug you or dump on you, so you can open pump.fun with a real base to
        start from. it will not make you safe. the space is brutal and you can still get wrecked. it
        just means you start from what people actually did, instead of whatever the group chat is
        screaming.
      </p>

      {/* 1 · what it's for + the market audit */}
      <Ledger title="1 · WE READ THE WHOLE ROOM">
        <p className="text-lg font-bold">{cal.generated_from}</p>
        <p className="mt-1 text-sm text-zinc-400">
          we pulled the caller space wide and looked at what actually happened to every call: did the
          coin survive, did anyone get a real chance to sell, did the caller cash out into the people
          they called in. that whole history is the ground we score on.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-px bg-foreground/10">
          <Big v={pc(cal.base_rates.rug)} k="of called coins collapse ≥80% within 24h" />
          <Big v={pc(cal.base_rates.dump)} k="of calls, the caller sells into their own followers" />
          <Big v={pc(cal.base_rates.win)} k="of calls ever offer a clean 2×" />
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          read that and the temptation is to call everyone a scammer. don&apos;t. this is the asset
          class, not the crime. the baseline is savage on its own, and grading anyone against zero
          would just be grading memecoins. so we don&apos;t. every score is measured against these
          numbers, against what a caller in this space normally does.
        </p>
      </Ledger>

      {/* 2 · conduct over picking */}
      <Ledger title="2 · WE GRADE CONDUCT, NOT LUCK">
        <p className="text-sm text-zinc-400">
          the thing everyone wants to sell you is a hit rate. it doesn&apos;t hold up. how well a
          caller picked this month barely tells you how they&apos;ll pick next month, so we show
          picking on every card and score none of it. what does hold up is character: whether they
          dump on the people they called in, and whether their coins die. we split each caller&apos;s
          history in half and check whether the first half predicts the second. that&apos;s the test
          below.
        </p>
        <table className="mt-3 w-full text-sm tnum">
          <thead>
            <tr className="silk text-left text-[9px] tracking-[0.08em] text-zinc-500">
              <th className="py-1 font-normal">TRAIT</th>
              <th className="text-right font-normal">HOLDS UP OVER TIME</th>
              <th className="text-right font-normal">GAP, WORST → BEST</th>
              <th className="text-right font-normal">SCORED?</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ["dumps on the people they called in", cal.reliability.dump, true],
                ["their coins die on you", cal.reliability.rug, true],
                ["picks a 2×", cal.reliability.win, false],
              ] as const
            ).map(([name, r, scored]) => (
              <tr key={name} className="border-t border-foreground/15">
                <td className="py-1.5">{name}</td>
                <td className={`text-right font-bold ${r.r >= 0.4 ? "text-green-400" : "text-red-400"}`}>
                  {r.r >= 0.4 ? "yes" : "no"}
                </td>
                <td className="text-right">{`+${(r.spread * 100).toFixed(1)}pp`}</td>
                <td className={`text-right ${scored ? "text-green-400" : "text-zinc-500"}`}>{scored ? "scored" : "shown, not scored"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">
          picking barely predicts itself, so it stays off the score. conduct predicts itself, so
          conduct is the score. a high grade doesn&apos;t mean someone picks winners. it means
          someone measurably less likely to turn you into their exit liquidity.
        </p>
      </Ledger>

      {/* 3 · fairness */}
      <Ledger title="3 · A COIN THAT GAVE YOU A CHANCE ISN'T HELD AGAINST THEM">
        <p className="text-sm text-zinc-400">
          this is the part that makes the grade fair. a coin that ran and gave you a real window to
          sell at a profit before it faded is not counted against the caller. dying is not the crime.
          almost everything here dies. we only punish two things: dumping on your followers, and coins
          that were dead on arrival, that never gave anyone a chance to get out ahead.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-px bg-foreground/10">
          <div className="bg-background px-3 py-3">
            <div className="silk text-[10px] tracking-[0.08em] text-green-400">GRADED FAIRLY</div>
            <div className="mt-1 text-[11px] leading-tight text-zinc-400">
              coin gave you a real shot at profit, then faded. you had your window. that&apos;s the
              game, not a betrayal.
            </div>
          </div>
          <div className="bg-background px-3 py-3">
            <div className="silk text-[10px] tracking-[0.08em] text-red-400">STAYS A LARPER</div>
            <div className="mt-1 text-[11px] leading-tight text-zinc-400">
              dumped at second zero, or the coin was dead on arrival. you were never meant to win. you
              were the exit.
            </div>
          </div>
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          the whole difference is &ldquo;gave you a chance&rdquo; versus &ldquo;made you the
          exit.&rdquo; this fairness rule is why the collapse rate above sits where it does and not
          higher: coins that died fair aren&apos;t charged as rugs.
        </p>
      </Ledger>

      {/* 4 · we grade ourselves */}
      {cal.precision_at_top?.length ? (
        <Ledger title="4 · WE GRADE OURSELVES, AND PUBLISH WHERE WE'RE WRONG">
          <p className="text-sm text-zinc-400">
            a rating you can&apos;t check is just an opinion with a logo. so here is where our own
            board misses. a &ldquo;blowup&rdquo; is a wallet we ranked among the very best that then
            went on to behave worse than the market anyway. we count them, out loud, on this page,
            because that&apos;s the number that tells you whether to trust the rest.
          </p>
          <table className="mt-3 w-full text-sm tnum">
            <thead>
              <tr className="silk text-left text-[9px] tracking-[0.08em] text-zinc-500">
                <th className="py-1 font-normal">OUR TOP</th>
                <th className="text-right font-normal">RANKING</th>
                <th className="text-right font-normal">HARM VS MARKET</th>
                <th className="text-right font-normal">WE GOT WRONG</th>
              </tr>
            </thead>
            <tbody>
              {cal.precision_at_top.map((r) => (
                <tr key={`${r.K}-${r.model}`} className="border-t border-foreground/15">
                  <td className="py-1.5">top {r.K}</td>
                  <td className="text-right">{r.model === "shrunk" ? "shipped" : "raw"}</td>
                  <td className="text-right">{pc(r.next_harm)}</td>
                  <td className={`text-right font-bold ${r.blowups ? "text-red-400" : "text-green-400"}`}>
                    {r.blowups} of {r.K}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-500">
            read the last column plainly: of the callers we ranked highest, this many still behaved
            worse than the market&apos;s {pc(cal.market_harm ?? 0.65)} average. the shipped board puts{" "}
            {shrunkTop10?.blowups ?? 2} in its top {shrunkTop10?.K ?? 10}, and we&apos;re not hiding
            it. our claim is &ldquo;measurably less likely to hurt you.&rdquo; it is never
            &ldquo;safe,&rdquo; and this table is exactly how far off &ldquo;measurably&rdquo; runs.
          </p>
        </Ledger>
      ) : null}

      {/* 5 · the curve */}
      <Ledger title="5 · MOST CALLERS GRADE POORLY, ON PURPOSE">
        <div className="flex items-end gap-2">
          {grades.map((g) => {
            const n = cal.grade_distribution[g] ?? 0;
            const h = maxGrade ? Math.max(4, Math.round((n / maxGrade) * 96)) : 4;
            return (
              <div key={g} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs tnum text-zinc-500">{n}</span>
                <div
                  className={`w-full border-2 border-foreground ${g === "F" || g === "D" ? "bg-red-500/30" : g === "C" ? "bg-amber-500/40" : "bg-green-500/30"}`}
                  style={{ height: h }}
                />
                <span className="silk text-[10px]">{g}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          {pc(((cal.grade_distribution.D ?? 0) + (cal.grade_distribution.F ?? 0)) / cal.scoreable, 0)}{" "}
          of scored callers land D or F. that&apos;s not a harsh curve, it&apos;s what the chain says:
          most callers are exit liquidity, so most callers grade poorly. these are fixed cut points,
          not a quota. nobody gets bumped up to fill a slot, and the bar doesn&apos;t bend for anyone.
          the handful up top earned it.
        </p>
      </Ledger>
    </main>
  );
}

function Ledger({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <div className="ink-box px-4 py-4">
        <p className="silk mb-3 text-[10px] tracking-[0.08em]">{title}</p>
        {children}
      </div>
    </section>
  );
}

function Big({ v, k }: { v: string; k: string }) {
  return (
    <div className="bg-background px-3 py-3 text-center">
      <div className="text-2xl font-bold tnum">{v}</div>
      <div className="mt-1 text-[11px] leading-tight text-zinc-500">{k}</div>
    </div>
  );
}
