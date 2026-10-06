import type { Grade, Label } from "./types";

/** Grade → screenshottable colour + human title. Kept in one place so the card,
 *  the boards and the OG image never drift. Tailwind classes are static strings
 *  (no interpolation) so the JIT keeps them. */
export const GRADE_STYLE: Record<Grade, { title: string; text: string; ring: string; bg: string; chip: string }> = {
  S: { title: "Chad",          text: "text-emerald-400", ring: "ring-emerald-500/40", bg: "bg-emerald-500/10", chip: "bg-emerald-500/15 text-emerald-300" },
  A: { title: "Solid",         text: "text-green-400",   ring: "ring-green-500/40",   bg: "bg-green-500/10",   chip: "bg-green-500/15 text-green-300" },
  B: { title: "Fair",          text: "text-lime-400",    ring: "ring-lime-500/40",    bg: "bg-lime-500/10",    chip: "bg-lime-500/15 text-lime-300" },
  C: { title: "Coinflip",      text: "text-amber-400",   ring: "ring-amber-500/40",   bg: "bg-amber-500/10",   chip: "bg-amber-500/15 text-amber-300" },
  D: { title: "Exit Liquidity", text: "text-orange-400", ring: "ring-orange-500/40",  bg: "bg-orange-500/10",  chip: "bg-orange-500/15 text-orange-300" },
  F: { title: "Larper",        text: "text-red-400",     ring: "ring-red-500/40",     bg: "bg-red-500/10",     chip: "bg-red-500/15 text-red-300" },
};

/** Per-token label → colour for the receipts + sparkline. */
export const LABEL_STYLE: Record<Label, { text: string; bg: string; dot: string; word: string }> = {
  WIN:     { text: "text-green-400",  bg: "bg-green-500/15",  dot: "bg-green-500",  word: "Win" },
  LOSS:    { text: "text-zinc-400",   bg: "bg-zinc-500/15",   dot: "bg-zinc-500",   word: "Loss" },
  NEUTRAL: { text: "text-zinc-400",   bg: "bg-zinc-500/10",   dot: "bg-zinc-600",   word: "Flat" },
  DUMP:    { text: "text-red-400",    bg: "bg-red-500/15",    dot: "bg-red-500",    word: "Dump" },
  RUG:     { text: "text-red-500",    bg: "bg-red-600/15",    dot: "bg-red-600",    word: "Rug" },
};

/**
 * The opportunity model splits two axes: OPPORTUNITY (`label` = did the call offer a
 * reachable 2× within 24h) and INTEGRITY (`dumped`/`rugged` flags). A single call can be
 * both a great shot and a rug ("good pick, bad hands"). This collapses both into one
 * display outcome for the receipts + sparkline, integrity taking precedence because that's
 * the karma-defining signal — the peak column still shows the upside that was on the table.
 */
export function tokenOutcome(t: {
  label?: Label | null;
  dumped?: boolean;
  rugged?: boolean;
  held_through_rug?: boolean;
  max_drop_from_peak_24h?: number | null;
}): { word: string; text: string; bg: string; dot: string } {
  // Robust to both models: the opportunity recompute stores integrity as `dumped`/`rugged`
  // flags with an opportunity `label` (WIN/NEUTRAL/LOSS); the older callout scorer stores
  // RUG/DUMP directly in `label` with no flags. Honour whichever is present.
  const dumped = t.dumped || t.label === "DUMP";
  const rugged =
    t.rugged || t.label === "RUG" || (t.max_drop_from_peak_24h != null && t.max_drop_from_peak_24h <= -0.8);
  if (dumped) return { word: "Dump", ...pick("red") };
  if (rugged) return { word: t.held_through_rug ? "Rug (victim)" : "Rug", ...pick("red600") };
  if (t.label === "WIN") return { word: "2× shot", ...pick("green") };
  if (t.label === "LOSS") return { word: "Loss", ...pick("zinc") };
  return { word: "Flat", ...pick("zinc") };
}

function pick(k: "red" | "red600" | "green" | "zinc") {
  const m = {
    red: { text: "text-red-400", bg: "bg-red-500/15", dot: "bg-red-500" },
    red600: { text: "text-red-500", bg: "bg-red-600/15", dot: "bg-red-600" },
    green: { text: "text-green-400", bg: "bg-green-500/15", dot: "bg-green-500" },
    zinc: { text: "text-zinc-400", bg: "bg-zinc-500/10", dot: "bg-zinc-600" },
  } as const;
  return m[k];
}

export const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;

/** A signed CHANGE, e.g. a 24h return. The leading + is meaningful here. */
export const pct = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`;

/** A RATE — a share of calls. Never signed: "26% of calls", not "+26% of calls". */
export const rate = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : `${(x * 100).toFixed(0)}%`;

export const mult = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : `${x.toFixed(1)}×`;

/**
 * Colour a v3 karma number (0–100) for board rows. Bands mirror SCORING.trustGrades so the
 * colour and the letter can never disagree.
 */
export function karmaColor(k: number | null): string {
  if (k === null) return "text-zinc-500";
  if (k >= 56) return "text-emerald-400"; // S/A
  if (k >= 46) return "text-lime-400";    // B
  if (k >= 36) return "text-amber-400";   // C
  if (k >= 24) return "text-orange-400";  // D
  return "text-red-400";                  // F
}

/**
 * A rate as a multiple of the market's own rate. This is the legible unit: "1.4× the market"
 * lands where a bare "63% rug rate" does not, because 45% of ALL called coins collapse anyway.
 */
export const vsMarket = (x: number | null | undefined) =>
  x === null || x === undefined ? "–" : `${x.toFixed(2)}×`;

/** Colour a vs-market multiple: below 1 is better than average, above 1 is worse. */
export function vsMarketColor(x: number | null | undefined): string {
  if (x === null || x === undefined) return "text-zinc-500";
  if (x <= 0.6) return "text-emerald-400";
  if (x <= 0.9) return "text-lime-400";
  if (x < 1.15) return "text-zinc-300";
  if (x < 1.5) return "text-orange-400";
  return "text-red-400";
}

/** X profile picture via unavatar (keyless); null = no social, the UI falls back to the frog. */
export const avatarUrlFor = (handle: string | null | undefined): string | null =>
  handle ? `https://unavatar.io/x/${encodeURIComponent(handle)}` : null;
