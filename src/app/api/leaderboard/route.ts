import { getLeaderboard, gradeIndex } from "@/lib/karma/data";

/** Cached board data (PRD §9). Reads the pre-built leaderboard.json and backfills
 *  the letter grade per row. No live scoring on request. */
export function GET() {
  const board = getLeaderboard();
  const grades = gradeIndex();
  const withGrades = (rows: typeof board.highest) =>
    rows.map((r) => ({ ...r, grade: grades.get(r.wallet)?.grade ?? null, title: grades.get(r.wallet)?.title ?? null }));

  return Response.json(
    {
      generated_at: board.generated_at,
      highest: withGrades(board.highest),
      shame: withGrades(board.shame),
      unproven: withGrades(board.unproven),
    },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=60" } },
  );
}
