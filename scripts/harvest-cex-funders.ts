/**
 * CEX-funder harvest: grow the exclusion list that stops exchange hot wallets from faking Sybil
 * bundles (the Binance false positive that bit the first live scan).
 *
 * It self-bootstraps from the same balance gate the detector already uses: scan a set of coins,
 * collect the funders of their fresh holders, and any purse still holding an exchange-sized balance
 * that ISN'T on the list yet is a candidate. A real Sybil distributor sprays and empties; only an
 * exchange sits on hundreds of SOL while having seeded many wallets. Candidates land in a REVIEW
 * queue (seed/cex_funder_candidates.json), not the live list — Kombucho promotes them by hand, so a
 * bad auto-add can never silently blind the detector.
 *
 * Usage:
 *   npm run harvest-cex -- <mint> [<mint> ...]   # explicit coins
 *   npm run harvest-cex                          # default: mints from seed/top_coin_scan.json + TURF
 *
 * Output: seed/cex_funder_candidates.json (merged) + console summary. Promote good ones into
 * seed/cex_funders.json with their evidence.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { INFRA_OWNERS } from "../src/lib/karma/constants";
import { scanCoin, type WalletRegistry } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile(f); } catch {}
}

const ROOT = process.cwd();
const now = Math.floor(Date.now() / 1000);
const CANDIDATES_PATH = path.join(ROOT, "seed", "cex_funder_candidates.json");
const TURF = "8xtP7TNqK7ND5w7aJjJ1StVzYHqCV98SXdXx6UMspump";
// Harvest floor: at or above this SOL a shared funder is an exchange, not a bundle purse.
const MIN_BALANCE_SOL = SCORING.coin.exchangeFunderMinBalanceSol;

const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

function loadRegistry(): WalletRegistry {
  const registry: WalletRegistry = new Map();
  try {
    const kols = JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8"));
    for (const k of kols) registry.set(k.wallet_address, { handle: k.handle ?? null, verified: !!k.verified, source_url: k.source_url ?? null, grade: null, title: null });
  } catch {}
  return registry;
}

function loadExcluded(): Set<string> {
  const set = new Set<string>(INFRA_OWNERS);
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, "seed", "cex_funders.json"), "utf8"));
    for (const f of raw.funders ?? []) if (f.address) set.add(f.address);
  } catch {}
  return set;
}

interface Candidate {
  address: string;
  balance_sol: number;
  tx_count: number;
  tx_count_capped: boolean;
  seen_on: string[];
  evidence: string;
  first_seen_at: number;
}

function loadCandidates(): Candidate[] {
  if (!existsSync(CANDIDATES_PATH)) return [];
  try { return (JSON.parse(readFileSync(CANDIDATES_PATH, "utf8")).candidates ?? []) as Candidate[]; } catch { return []; }
}

function defaultMints(): string[] {
  const mints = new Set<string>([TURF]);
  try {
    const scan = JSON.parse(readFileSync(path.join(ROOT, "seed", "top_coin_scan.json"), "utf8"));
    for (const s of scan.scans ?? []) if (s.mint) mints.add(s.mint);
  } catch {}
  return [...mints];
}

async function main() {
  const registry = loadRegistry();
  const excluded = loadExcluded();
  const byAddr = new Map<string, Candidate>(loadCandidates().map((c) => [c.address, c]));

  const argMints = process.argv.slice(2).filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
  const mints = argMints.length ? argMints : defaultMints();

  console.log(`\nKarma · CEX-funder harvest  (${mints.length} coin${mints.length === 1 ? "" : "s"} · ≥ ${MIN_BALANCE_SOL} SOL = exchange)\n`);

  // Distinct fresh-holder funders across all scanned coins → the pool of purses to weigh.
  const funderCoins = new Map<string, Set<string>>();
  for (const mint of mints) {
    let scan;
    try { scan = await scanCoin(rpc, mint, SCORING, now, cache, registry, excluded); }
    catch (e) { console.log(`  ✗ ${mint.slice(0, 8)}… ${(e as Error).message}`); continue; }
    if (!scan.eligible) { console.log(`  – ${mint.slice(0, 8)}… ${scan.refusal_reasons[0] ?? "ineligible"}`); continue; }
    const sym = scan.symbol ?? mint.slice(0, 6);
    let n = 0;
    for (const h of scan.holders) {
      if (h.kind !== "fresh" || !h.funder || excluded.has(h.funder)) continue;
      funderCoins.set(h.funder, (funderCoins.get(h.funder) ?? new Set()).add(sym));
      n++;
    }
    console.log(`  · ${sym.padEnd(10)} ${n} fresh-holder funder link(s)`);
  }

  // Weigh each distinct funder: an exchange-sized balance is the tell.
  let found = 0;
  for (const [funder, coins] of funderCoins) {
    const balance = await rpc.getBalance(funder).catch(() => null);
    if (balance === null || balance < MIN_BALANCE_SOL) continue;
    const sigs = await rpc.getSignatures(funder, undefined, 1000).catch(() => []);
    const capped = sigs.length >= 1000;
    const prev = byAddr.get(funder);
    const seenOn = [...new Set([...(prev?.seen_on ?? []), ...coins])];
    byAddr.set(funder, {
      address: funder,
      balance_sol: Math.round(balance),
      tx_count: Math.min(sigs.length, 1000),
      tx_count_capped: capped,
      seen_on: seenOn,
      evidence: `${Math.round(balance).toLocaleString()} SOL balance, ${sigs.length}${capped ? "+" : ""} txns, first-funded fresh holders on ${seenOn.join(", ")}`,
      first_seen_at: prev?.first_seen_at ?? now,
    });
    found++;
    console.log(`  ⚑ candidate ${funder.slice(0, 8)}…  ${Math.round(balance).toLocaleString()} SOL · ${sigs.length}${capped ? "+" : ""} txns · ${seenOn.join(", ")}`);
  }

  const candidates = [...byAddr.values()].sort((a, b) => b.balance_sol - a.balance_sol);
  const out = {
    _doc: "REVIEW QUEUE for seed/cex_funders.json. Exchange-scale funders (balance ≥ exchangeFunderMinBalanceSol) that first-funded fresh holders of scanned coins. The balance gate already excludes these live; promoting a verified one into cex_funders.json spares the RPC and documents it. Verify each (a whale is not an exchange) before promoting.",
    generated_at: new Date().toISOString(),
    candidates,
  };
  writeFileSync(CANDIDATES_PATH, JSON.stringify(out, null, 2));
  console.log(`\n  ${found} candidate(s) this run · ${candidates.length} on file → ${path.relative(ROOT, CANDIDATES_PATH)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
