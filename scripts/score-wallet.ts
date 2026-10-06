/**
 * Phase 1: score one wallet from on-chain history and print the receipts for hand-checking.
 *
 *   npm run score -- <wallet | @handle> [--now <unix>] [--max-tx <n>] [--no-cache] [--quiet]
 *
 * Handles resolve through seed/kols.json. The full report is saved to validation/<wallet>.json.
 * Pass --now with the computed_at of an earlier run to re-score from cache after tuning thresholds.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileCache, MemoryCache } from "../src/lib/karma/cache";
import { isoMinute } from "../src/lib/karma/engine/activity";
import { scoreWallet } from "../src/lib/karma/engine/score-wallet";
import { SCORING } from "../src/lib/karma/scoring.config";
import type { Label, TokenResult, WalletReport } from "../src/lib/karma/types";

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // optional
  }
}

interface Kol {
  handle: string | null;
  display_name: string;
  wallet_address: string;
  source_url: string;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BOOLEAN_FLAGS = new Set(["no-cache", "quiet"]);

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) positional.push(a);
    else if (BOOLEAN_FLAGS.has(a.slice(2))) flags.set(a.slice(2), true);
    else flags.set(a.slice(2), argv[++i]);
  }
  return { flags, positional };
}

async function resolveTarget(input: string): Promise<{ wallet: string; kol?: Kol }> {
  const raw = await readFile(path.join(process.cwd(), "seed/kols.json"), "utf8").catch(() => "[]");
  const kols = JSON.parse(raw) as Kol[];
  const byWallet = kols.find((k) => k.wallet_address === input);
  if (byWallet) return { wallet: input, kol: byWallet };
  if (BASE58.test(input)) return { wallet: input };
  const name = input.replace(/^@/, "").toLowerCase();
  const kol = kols.find((k) => k.handle?.toLowerCase() === name || k.display_name.toLowerCase() === name);
  if (!kol) throw new Error(`"${input}" is not a wallet address or a handle in seed/kols.json`);
  return { wallet: kol.wallet_address, kol };
}

// ── formatting ────────────────────────────────────────────────────────────────

const tty = process.stdout.isTTY;
const paint = (code: number, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const LABEL_COLOR: Record<Label, number> = { WIN: 32, NEUTRAL: 37, LOSS: 33, DUMP: 31, RUG: 35 };
const pct = (x: number | null) => (x === null ? "–" : `${x > 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
const times = (x: number | null) => (x === null ? "–" : `${x.toFixed(1)}x`);
const symbolOf = (t: TokenResult) => (t.symbol ?? t.mint.slice(0, 6)).slice(0, 10);

const COLUMNS: Array<[string, number, "l" | "r"]> = [
  ["#", 3, "r"],
  ["TOKEN", 10, "l"],
  ["ENTRY UTC", 16, "l"],
  ["SOL IN", 7, "r"],
  ["SOL OUT", 7, "r"],
  ["SOLD", 5, "r"],
  ["W.ROI", 7, "r"],
  ["COPY24H", 8, "r"],
  ["PEAK", 6, "r"],
  ["IN+OUT", 7, "r"],
  ["DD.EXIT", 8, "r"],
  ["DROP24H", 8, "r"],
  ["LABEL", 7, "l"],
];

const line = (cells: string[]) =>
  cells.map((c, i) => (COLUMNS[i][2] === "r" ? c.padStart(COLUMNS[i][1]) : c.padEnd(COLUMNS[i][1]))).join("  ");

function print(report: WalletReport) {
  const { scan, score, tokens } = report;
  console.log(
    `\n  source: ${scan.source} · ${scan.txFetched} tx scanned back to ${isoMinute(scan.oldestScanned)} · stop: ${scan.stopReason}`,
  );
  console.log(
    `  swaps ${scan.swaps} · transfers ${scan.transfers} · airdrop spam ${scan.airdrops} · ` +
      `multi-token tx ignored ${scan.multiTokenTxsIgnored} · failed tx ${scan.failedTx}`,
  );

  const scored = tokens.filter((t) => t.status === "scored").sort((a, b) => (a.entry_time ?? 0) - (b.entry_time ?? 0));
  console.log(`\n${paint(1, line(COLUMNS.map(([h]) => h)))}`);
  scored.forEach((t, i) => {
    const label = t.label ?? "–";
    const cells = [
      String(i + 1),
      symbolOf(t),
      isoMinute(t.entry_time),
      t.sol_spent.toFixed(2),
      t.sol_received.toFixed(2),
      pct(t.fraction_sold),
      pct(t.wallet_roi),
      pct(t.copy_return_24h),
      times(t.copy_peak_multiple),
      pct(t.copy_return_follow_out),
      pct(t.drawdown_after_exit) + (t.drawdown_window_partial ? "*" : ""),
      pct(t.max_drop_from_peak_24h),
      label,
    ];
    const row = line(cells);
    console.log(t.label ? row.replace(new RegExp(`${label}\\s*$`), paint(LABEL_COLOR[t.label], label)) : row);
  });
  if (scored.some((t) => t.drawdown_window_partial)) console.log("  * exit < 24h ago, drawdown window still open");

  const skipped = tokens.filter((t) => t.status !== "scored");
  if (skipped.length) {
    console.log(`\n${paint(1, "NOT SCORED")}`);
    for (const t of skipped) console.log(`  ${symbolOf(t).padEnd(10)}  ${t.status}: ${t.notes[0] ?? ""}  ${t.mint}`);
  }
  const noted = scored.filter((t) => t.notes.length);
  if (noted.length) {
    console.log(`\n${paint(1, "NOTES")}`);
    for (const t of noted) console.log(`  ${symbolOf(t).padEnd(10)}  ${t.notes.join("; ")}`);
  }

  const c = score.coverage;
  console.log(
    `\n${paint(1, "RESULT")}  n=${score.n_tokens} scored · ${c.incomplete} incomplete · ${c.no_price_data} no price data · ${c.pending} pending (<24h)`,
  );
  console.log(
    `  follower hit rate ${pct(score.follower_hit_rate)} · median copy return 24h ${pct(score.median_copy_return)} · ` +
      `dumps ${score.dumps} (${pct(score.dump_rate)}) · rugs ${score.rugs} (${pct(score.rug_rate)})`,
  );
  console.log(
    `  wins ${score.wins} · losses ${score.losses} · neutral ${score.neutrals} · wallet realized PnL ${score.wallet_realized_pnl_sol >= 0 ? "+" : ""}${score.wallet_realized_pnl_sol.toFixed(2)} SOL`,
  );
  const badge = score.unproven ? `UNPROVEN (n=${score.n_tokens})` : `GRADE ${score.grade} · ${score.title}`;
  console.log(`  ${paint(1, badge)}   confidence ${score.confidence}`);
  console.log(`  "${score.verdict}"`);
}

interface RunResult {
  input: string;
  handle: string | null;
  report?: WalletReport;
  error?: string;
  seconds: number;
}

function printSummary(results: RunResult[]) {
  const head = ["WALLET", "n", "HIT", "MEDIAN", "DUMPS", "RUGS", "PNL SOL", "GRADE", "CONF", "COVER", "TIME"];
  const widths = [18, 3, 5, 7, 5, 5, 8, 20, 6, 6, 5];
  const fmt = (cells: string[]) =>
    cells.map((c, i) => (i === 0 || i === 7 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");
  console.log(`\n${paint(1, "SUMMARY")}\n${paint(1, fmt(head))}`);
  for (const r of results) {
    const name = (r.handle ? `@${r.handle}` : r.input).slice(0, 18);
    if (!r.report) {
      console.log(`${name.padEnd(18)}  failed: ${r.error}`);
      continue;
    }
    const s = r.report.score;
    const c = s.coverage;
    console.log(
      fmt([
        name,
        String(s.n_tokens),
        pct(s.follower_hit_rate),
        pct(s.median_copy_return),
        String(s.dumps),
        String(s.rugs),
        s.wallet_realized_pnl_sol.toFixed(1),
        s.unproven ? "UNPROVEN" : `${s.grade} ${s.title}`,
        s.confidence,
        `${c.scored}/${c.scored + c.incomplete + c.no_price_data}`,
        `${r.seconds.toFixed(0)}s`,
      ]),
    );
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  if (!positional.length) {
    console.error("usage: npm run score -- <wallet | @handle>... [--now <unix>] [--max-tx <n>] [--no-cache] [--quiet]");
    process.exit(1);
  }
  const now = flags.has("now") ? Number(flags.get("now")) : undefined;
  const maxTx = flags.get("max-tx");
  const config = typeof maxTx === "string" ? { ...SCORING, maxTxScan: Number(maxTx) } : SCORING;
  const cache = flags.has("no-cache") ? new MemoryCache() : new FileCache();
  const progress = (msg: string) =>
    tty ? process.stdout.write(`\r\x1b[K  … ${msg}`) : console.log(`  … ${msg}`);
  const results: RunResult[] = [];

  for (const input of positional) {
    const started = Date.now();
    const seconds = () => (Date.now() - started) / 1000;
    try {
      const { wallet, kol } = await resolveTarget(input);
      console.log(`\nKarma · ${wallet}${kol?.handle ? ` (@${kol.handle})` : ""}`);
      if (kol) console.log(`  link source: ${kol.source_url}`);

      const report = await scoreWallet(wallet, { config, cache, now, onProgress: flags.has("quiet") ? undefined : progress });
      if (tty) process.stdout.write("\r\x1b[K");
      print(report);

      const out = path.join(process.cwd(), "validation", `${wallet}.json`);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, JSON.stringify({ handle: kol?.handle ?? null, ...report }, null, 2));
      console.log(`\n  saved ${path.relative(process.cwd(), out)} · ${seconds().toFixed(0)}s`);
      results.push({ input, handle: kol?.handle ?? null, report, seconds: seconds() });
    } catch (err) {
      if (tty) process.stdout.write("\r\x1b[K");
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\n  ${input} failed: ${message}`);
      results.push({ input, handle: null, error: message, seconds: seconds() });
    }
  }

  if (results.length > 1) printSummary(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
