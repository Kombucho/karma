import Link from "next/link";
import SearchBox from "./SearchBox";
import BoardRow from "./BoardRow";
import BuyKarma from "./BuyKarma";
import FortuneCookie from "./FortuneCookie";
import HeroGallery, { type GalleryPerson } from "./HeroGallery";
import TryOne from "./TryOne";
import { coverageStats, getLeaderboard, gradeIndex, getQuotes } from "@/lib/karma/data";
import { avatarUrlFor } from "@/lib/karma/grade-ui";

/**
 * Home, to the letter of Front-end/Karma v3.dc.html: two-panel hero (pitch + the guy who got
 * rugged), THE ORACLE check-in desk, chads/larpers teasers, THE SCALE with the fortune
 * cookie, HOW IT GRADES as the numbered grid, then the $KARMA counter. Pixel headings,
 * typewriter UI, serif prose — three textures, one paper.
 */

/** The fixed demo chips — specific states to show, not a population to sample from. Chad and
 *  Larper are drawn at random from the corpus in <TryOne>. */
const TRY_FIXED = [
  { label: "NO RECEIPTS", wallet: "CxgPWvH2GoEDENELne2XKAR2z2Fr4shG2uaeyqZceGve" },
  { label: "A COLD WALLET", wallet: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
];

const FIVE = [
  { n: "01", t: "THE CALL", d: "you bought when they called. did the coin give room to sell at a real profit before it turned? that window is the call, measured not vibed." },
  { n: "02", t: "THE DUMP", d: "they took that profit by selling into the buyers they called in, and left you the bag. the karma-defining event." },
  { n: "03", t: "THE RUG", d: "the coin round-tripped ≥80% off its peak in a day. dev, cabal or nobody pocketed it, you got wrecked either way." },
  { n: "04", t: "VS THE TRENCHES", d: "45% of called coins rug on their own, so every rate is a multiple of that. 2.97× means they dump three times the average caller." },
  { n: "05", t: "EVIDENCE WEIGHT", d: "thin records pull toward the trench average by how much could be luck. nobody buys an A on one good week." },
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ notfound?: string }>;
}) {
  const { notfound } = await searchParams;
  const board = getLeaderboard();
  const grades = gradeIndex();
  const stats = coverageStats();

  const chads = board.highest.slice(0, 3);
  const ruggers = board.shame.slice(0, 3);

  // The hero wall: real graded callers, chads and larpers alike, that carry a handle to show a face.
  // The faces swap daily — a date-seeded window over the rostered callers that advances at UTC
  // midnight, so the wall feels alive without the cron having to write anything. Balanced 6 chads,
  // 6 larpers; the whole roster cycles through over successive days.
  const daySeed = Math.floor(Date.now() / 86_400_000);
  const rotate = <T,>(arr: T[], n: number): T[] => {
    if (arr.length <= n) return arr;
    const start = (daySeed * 7) % arr.length; // step by a prime so consecutive days don't overlap much
    return Array.from({ length: n }, (_, i) => arr[(start + i) % arr.length]);
  };
  const withFace = (rows: typeof board.highest) => rows.filter((r) => r.handle);
  const seen = new Set<string>();
  const gallery: GalleryPerson[] = [...rotate(withFace(board.highest), 6), ...rotate(withFace(board.shame), 6)]
    .filter((r) => !seen.has(r.wallet) && seen.add(r.wallet))
    .map((r) => ({ handle: r.handle!, wallet: r.wallet, grade: r.grade, title: r.title, src: avatarUrlFor(r.handle) }));

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-3 pb-16 pt-4 sm:px-5">
      {/* ── hero: pitch + the guy who got rugged ── */}
      <div className="grid gap-3 sm:grid-cols-[3fr_2fr]">
        <div className="ink-box flex flex-col px-5 py-5">
          <p className="silk text-[clamp(13px,1.7vw,20px)] font-bold uppercase leading-relaxed tracking-[0.04em]">
            Karma is born to help you stop being exit liquidity. a{" "}
            <span className="text-green-400">trust layer</span> on who&apos;s calling, based on
            their on-chain activity.
          </p>
        </div>

        <HeroGallery people={gallery} />
      </div>

      {/* ── the oracle ── */}
      <section id="check" className="mt-3 border-2 border-foreground">
        <div className="silk flex items-center justify-between bg-foreground px-3 py-2 text-[10px] tracking-[0.1em] text-background">
          <span>▶ THE ORACLE</span>
          <span className="opacity-60">AWAITING INPUT</span>
        </div>
        <div className="bg-background px-4 py-5 sm:px-6">
          <SearchBox notfound={notfound} />
          <TryOne
            chads={board.highest.map((r) => r.wallet)}
            larpers={board.shame.map((r) => r.wallet)}
            fixed={TRY_FIXED}
          />
          <p className="mt-3 text-xs text-zinc-500">
            {stats.graded} callers graded · {stats.calls.toLocaleString()} calls · {stats.coins.toLocaleString()}{" "}
            coins · paste a CA instead and the oracle reads the holders · not financial advice
          </p>
        </div>
      </section>

      {/* ── boards teaser ── */}
      <div id="ledger" className="mt-3 grid min-w-0 gap-3 scroll-mt-4">
        <Teaser title="chads" subtitle="the chain matches the thread" href="/leaderboard?tab=highest">
          {chads.map((row, i) => (
            <BoardRow key={row.wallet} row={row} rank={i + 1} grade={grades.get(row.wallet)?.grade ?? null} title={grades.get(row.wallet)?.title ?? null} />
          ))}
        </Teaser>
        <Teaser title="larpers" subtitle="the thread says alpha, the chain says exit" href="/leaderboard?tab=shame">
          {ruggers.map((row, i) => (
            <BoardRow key={row.wallet} row={row} rank={i + 1} grade={grades.get(row.wallet)?.grade ?? null} title={grades.get(row.wallet)?.title ?? null} />
          ))}
        </Teaser>
      </div>

      {/* ── the scale + fortune cookie ── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="ink-box px-5 py-4">
          <p className="silk mb-3 text-[10px] tracking-[0.1em] text-zinc-500">THE SCALE</p>
          <ul className="space-y-2.5">
            {(
              [
                ["S", "Chad", "text-green-400", "you were never their exit liquidity"],
                ["A", "Solid", "text-green-400", "dumps and rugs at half the trench rate or less"],
                ["B", "Fair", "text-lime-400", "measurably cleaner than the average caller"],
                ["C", "Coinflip", "text-amber-400", "trench average. you are gambling, not following"],
                ["D", "Exit Liquidity", "text-orange-400", "they sell into the room they filled"],
                ["F", "Larper", "text-red-400", "your bags funded their exit, repeatedly"],
                ["—", "No record", "text-zinc-500", "under 3 settled calls. nothing to read, no grade"],
              ] as const
            ).map(([g, t, c, d]) => (
              <li key={t} className="flex items-baseline gap-3">
                <span className={`silk w-5 shrink-0 text-sm font-bold ${c}`}>{g}</span>
                <span className="serif w-32 shrink-0 text-lg font-bold">{t}</span>
                <span className="serif text-[15px] text-zinc-400">{d}</span>
              </li>
            ))}
          </ul>
        </div>
        <FortuneCookie community={getQuotes()} />
      </div>

      {/* ── how it grades ── */}
      <section id="judge" className="mt-3 border-2 border-foreground">
        <div className="silk bg-foreground px-3 py-2 text-[10px] tracking-[0.1em] text-background">
          ▶ HOW IT GRADES — FIVE NUMBERS, NOTHING ELSE
        </div>
        <div className="grid bg-background sm:grid-cols-2 lg:grid-cols-5">
          {FIVE.map((f, i) => (
            <div key={f.n} className={`px-4 py-4 ${i > 0 ? "border-t-2 border-foreground sm:border-t-0 sm:border-l-2" : ""}`}>
              <p className="silk text-[10px] tracking-[0.1em] text-zinc-500">{f.n}</p>
              <p className="silk mt-1.5 text-[11px] font-bold tracking-[0.06em]">{f.t}</p>
              <p className="serif mt-2 text-[15px] leading-snug text-zinc-400">{f.d}</p>
            </div>
          ))}
        </div>
        <div className="silk border-t-2 border-foreground px-3 py-2 text-[9px] tracking-[0.1em] text-zinc-500">
          FULL WORKING ON <Link href="/methodology" className="text-foreground">THE METHODOLOGY</Link> · WE GRADE OURSELVES TOO, ON <Link href="/audit" className="text-foreground">THE AUDIT</Link>
        </div>
      </section>

      <BuyKarma />
    </main>
  );
}

function Teaser({
  title,
  subtitle,
  href,
  children,
}: {
  title: string;
  subtitle: string;
  href: string;
  children: React.ReactNode;
}) {
  const rows = Array.isArray(children) ? children : [children];
  const hasRows = rows.filter(Boolean).length > 0;
  return (
    <section className="ink-box min-w-0 px-4 py-4">
      <div className="mb-3 flex items-end justify-between">
        <div>
          <h2 className={`text-base ${title === "larpers" ? "text-red-400" : "text-green-400"}`}>{title}</h2>
          <p className="silk text-[9px] tracking-[0.08em] text-zinc-500">{subtitle}</p>
        </div>
        <Link href={href} className="silk text-[10px] tracking-[0.08em]">
          SEE ALL →
        </Link>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {hasRows ? children : <p className="px-4 py-6 text-center text-sm text-zinc-500">nothing here.</p>}
      </div>
    </section>
  );
}
