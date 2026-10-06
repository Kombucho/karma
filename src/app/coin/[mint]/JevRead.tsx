"use client";

import { useEffect, useState } from "react";
import type { JevAnswer } from "@/lib/karma/quant/types";
import type { JevGradeSummary, JevRead } from "@/app/api/jev/[mint]/route";

/**
 * Jev's read: the live rubric's answers as numerals, loaded lazily like the chart panel. The honesty rule
 * is the whole design: until a question has a graded track record it's labelled SHADOW in muted ink and
 * never coloured, because an ungraded probability is a guess wearing a decimal point. Once graded, each
 * number carries its own record (hit rate or Brier skill, with n) and only then may red mean something.
 */

const SETUP_WORD: Record<string, string> = {
  accumulation: "accumulation",
  breakout: "breakout",
  distribution: "distribution",
  dead_cat: "dead-cat bounce",
  chop: "chop",
};
const TREND_WORD = ["collapsing", "weak", "flat", "healthy", "strong"];
const UNCLEAR = 0.3;

const pct = (p: number | undefined | null) => (p == null ? "—" : `${Math.round(p * 100)}%`);

function ago(t: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - t);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function JevReadPanel({ mint }: { mint: string }) {
  const [r, setR] = useState<JevRead | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");

  useEffect(() => {
    let live = true;
    fetch(`/api/jev/${mint}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: JevRead) => {
        if (!live) return;
        setR(data);
        setState("ok");
      })
      .catch(() => live && setState("err"));
    return () => {
      live = false;
    };
  }, [mint]);

  if (state !== "ok" || !r) {
    return (
      <div className="border-t-2 border-white/10 px-6 py-4">
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">▶ JEV&apos;S READ</p>
        <p className={`mt-2 text-sm text-zinc-600 ${state === "loading" ? "animate-pulse" : ""}`}>
          {state === "loading" ? "jev is reading the coin…" : "jev's read unavailable right now."}
        </p>
      </div>
    );
  }

  const a = r.answers;
  const g = r.grades;
  // Smallest n across the graded questions: the honest headline number for "how much record is there".
  const minN = r.targeted.length ? Math.min(...r.targeted.map((q) => g[q]?.n ?? 0)) : 0;
  const setup = a.setup;
  const unclear = !setup?.choice || (setup.confidence ?? 0) < UNCLEAR;
  const setupP = setup?.choice ? setup.probabilities?.[setup.choice] : undefined;
  const trend = a.trend?.score;

  return (
    <div className="border-t-2 border-white/10 px-6 py-5">
      <div className="flex items-center justify-between gap-3">
        <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">▶ JEV&apos;S READ</p>
        {r.graded ? (
          <span className="silk text-right text-[8px] tracking-[0.12em] text-zinc-400">GRADED · RUBRIC {r.rubric_version.toUpperCase()}</span>
        ) : (
          <span className="silk text-right text-[8px] tracking-[0.12em] text-zinc-500">SHADOW · NOT YET GRADED (n={minN})</span>
        )}
      </div>

      {/* the setup call: one word, its probability, its record */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">setup</span>
        <span className={`text-xl font-bold leading-none ${unclear ? "text-zinc-500" : "text-zinc-100"}`}>
          {unclear ? "unclear" : (SETUP_WORD[setup.choice!] ?? setup.choice)}
        </span>
        {!unclear ? <span className="tnum text-sm text-zinc-400">{pct(setupP)}</span> : null}
        <span className="tnum text-[11px] text-zinc-600">
          {unclear && setup?.choice ? `best guess ${SETUP_WORD[setup.choice] ?? setup.choice} · ` : ""}confidence {pct(setup?.confidence)}
        </span>
        <Record grade={g.setup} kind="hit" />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-sm bg-white/10 sm:grid-cols-5">
        <Prob label="−30% in 24h" a={a.dump_24h} grade={g.dump_24h} targeted={r.targeted.includes("dump_24h")} bad />
        <Prob label="−50% in 7d" a={a.dump_7d} grade={g.dump_7d} targeted={r.targeted.includes("dump_7d")} bad />
        <Prob label="2× in 7d" a={a.pump_7d} grade={g.pump_7d} targeted={r.targeted.includes("pump_7d")} />
        <Prob label="insider exit" a={a.insider_exit} grade={g.insider_exit} targeted={r.targeted.includes("insider_exit")} bad />
        <div className="col-span-2 bg-background px-3 py-2.5 text-center sm:col-span-1">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500">trend</div>
          <div className="tnum mt-0.5 text-lg font-bold leading-tight text-zinc-100">
            {trend == null ? "—" : trend.toFixed(1)}
            <span className="text-xs font-normal text-zinc-500">/4</span>
          </div>
          <Bar p={trend == null ? null : trend / 4} />
          <div className="mt-1 text-[10px] text-zinc-600">{trend == null ? "" : TREND_WORD[Math.round(trend)]}</div>
        </div>
      </div>

      <p className="mt-2 text-[11px] leading-snug text-zinc-600">
        {r.graded
          ? "each number carries its own record: how often it was right, n = graded outcomes."
          : `shadow mode: these calls are being logged and scored against what the price does next. no record yet, so read them as a guess, not a signal (needs ${r.min_graded_n}+ graded outcomes per question).`}{" "}
        rubric {r.rubric_version} · read {ago(r.t)} · not financial advice.
      </p>
    </div>
  );
}

/** One probability: numeral, thin bar, and its track record. Red only when graded, skilful and ≥50%. */
function Prob({ label, a, grade, targeted, bad }: { label: string; a: JevAnswer | undefined; grade?: JevGradeSummary; targeted: boolean; bad?: boolean }) {
  const p = a?.noul ?? null;
  const earned = !!grade?.graded && (grade.brier_skill ?? 0) > 0;
  const hot = bad && earned && p != null && p >= 0.5;
  return (
    <div className="bg-background px-3 py-2.5 text-center">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`tnum mt-0.5 text-lg font-bold leading-tight ${hot ? "text-red-400" : "text-zinc-100"}`}>{pct(p)}</div>
      <Bar p={p} hot={hot} />
      <div className="mt-1 text-[10px] leading-tight">
        {targeted ? <Record grade={grade} kind="skill" /> : <span className="text-zinc-600">descriptive · ungraded</span>}
      </div>
    </div>
  );
}

function Bar({ p, hot }: { p: number | null; hot?: boolean }) {
  return (
    <div className="mx-auto mt-1.5 h-1 w-full max-w-[7rem] bg-white/10">
      <div className={`h-full ${hot ? "bg-red-400" : "bg-zinc-400"}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, p ?? 0)) * 100)}%` }} />
    </div>
  );
}

/** The record beside a number. Shadow (n under the bar) reads as muted n only; graded shows the score. */
function Record({ grade, kind }: { grade?: JevGradeSummary; kind: "hit" | "skill" }) {
  const n = grade?.n ?? 0;
  if (!grade?.graded) return <span className="tnum whitespace-nowrap text-[10px] text-zinc-600">shadow · n={n}</span>;
  if (kind === "hit" && grade.hit_rate != null)
    return <span className="tnum text-[10px] text-zinc-400">right {pct(grade.hit_rate)} of the time · n={n}</span>;
  if (grade.brier_skill != null) {
    const s = Math.round(grade.brier_skill * 100);
    return (
      <span className="tnum text-[10px] text-zinc-400">
        {s > 0 ? `${s}% better than base rate` : "no better than base rate"} · n={n}
      </span>
    );
  }
  return <span className="tnum text-[10px] text-zinc-600">n={n}</span>;
}
