import Link from "next/link";
import BoardRow from "../BoardRow";
import { getLeaderboard, gradeIndex } from "@/lib/karma/data";

type Tab = "highest" | "shame" | "unproven";

const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: "shame", label: "Larpers", sub: "the thread said alpha, the chain says they sold into you. worst first." },
  { key: "highest", label: "Chads", sub: "the record matches the posting. best first, 95% band beside every score." },
  { key: "unproven", label: "No calls", sub: "they don't shill, they just trade. bucketed by how they trade instead." },
];

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: tabParam } = await searchParams;
  const tab: Tab = tabParam === "highest" || tabParam === "unproven" ? tabParam : "shame";

  const board = getLeaderboard();
  const grades = gradeIndex();
  const rows = board[tab] ?? [];
  const active = TABS.find((t) => t.key === tab)!;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10">
      <h1 className="text-2xl font-bold tracking-tight">Leaderboard</h1>

      <div className="mt-4 flex gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/leaderboard?tab=${t.key}`}
            className={`flex-1 rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors ${
              t.key === tab ? "bg-white text-black" : "text-zinc-400 hover:text-white"
            }`}
          >
            {t.label}
            <span className="ml-1.5 text-xs opacity-60">{(board[t.key] ?? []).length}</span>
          </Link>
        ))}
      </div>

      <p className="mt-3 text-sm text-zinc-500">{active.sub}</p>

      <div className="mt-4 flex flex-col gap-2">
        {rows.length ? (
          rows.map((row, i) => (
            <BoardRow
              key={row.wallet}
              row={row}
              rank={tab === "unproven" ? undefined : i + 1}
              grade={grades.get(row.wallet)?.grade ?? null}
              title={grades.get(row.wallet)?.title ?? null}
            />
          ))
        ) : (
          <p className="rounded-xl border border-white/10 px-4 py-10 text-center text-sm text-zinc-500">
            {tab === "highest" ? "no chads at the top band yet. the bar is absolute, not a curve." : "nothing here."}
          </p>
        )}
      </div>
    </main>
  );
}
