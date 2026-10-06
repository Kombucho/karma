/**
 * Sybil-cluster enrichment: the offline tree-walk that turns a live coin scan into a persistent
 * record, so a farm wallet carries its scar into its OWN wallet card, not just the coin's.
 *
 * The live coin scan (scanCoin) already does the hard part: it finds the deployer's fan-out and any
 * top-holder funder bundles. This script runs that over a set of mints and writes what it finds to
 * seed/sybil_clusters.json — deployer, funder, and the puppet wallets — deduped and merged. The
 * consumer is data.ts `sybilFor`, read by the wallet page as a flag ALONGSIDE the trust grade,
 * never folded into that calibrated number (a puppet has no callouts to dump on; the grade can't
 * speak to "manufactured", the flag does).
 *
 * Usage:
 *   npm run enrich-sybil -- <mint> [<mint> ...]     # explicit mints
 *   npm run enrich-sybil                            # default: re-check mints already on file + TURF
 *
 * Output: seed/sybil_clusters.json (merged, idempotent) + a console summary.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { FileCache } from "../src/lib/karma/cache";
import { INFRA_OWNERS } from "../src/lib/karma/constants";
import { scanCoin, type CoinHolder, type WalletRegistry } from "../src/lib/karma/engine/coin";
import { SCORING } from "../src/lib/karma/scoring.config";
import { SolanaRpc } from "../src/lib/karma/sources/solana";

for (const f of [".env.local", ".env"]) {
  try { process.loadEnvFile(f); } catch {}
}

const ROOT = process.cwd();
const now = Math.floor(Date.now() / 1000);
const CLUSTERS_PATH = path.join(ROOT, "seed", "sybil_clusters.json");
const TURF = "8xtP7TNqK7ND5w7aJjJ1StVzYHqCV98SXdXx6UMspump";

const cache = new FileCache();
const rpc = SolanaRpc.fromEnv(cache);

// ── registry + excluded funders (mirrors src/lib/karma/registry.ts, without importing it: that
//    module builds an RPC client at import time, before we've loaded the env file) ──
function loadRegistry(): WalletRegistry {
  const registry: WalletRegistry = new Map();
  try {
    const kols = JSON.parse(readFileSync(path.join(ROOT, "seed", "kols.json"), "utf8"));
    for (const k of kols) registry.set(k.wallet_address, { handle: k.handle ?? null, verified: !!k.verified, source_url: k.source_url ?? null, grade: null, title: null });
  } catch {}
  try {
    for (const f of readdirSync(path.join(ROOT, "validation"))) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(ROOT, "validation", f), "utf8"));
        const entry = registry.get(r.wallet);
        const grade = r.trust?.grade ?? r.score?.grade ?? null;
        if (entry && grade) { entry.grade = grade; entry.title = r.trust?.title ?? r.score?.title ?? null; }
      } catch {}
    }
  } catch {}
  return registry;
}

function loadExcludedFunders(): Set<string> {
  const set = new Set<string>(INFRA_OWNERS);
  try {
    const raw = JSON.parse(readFileSync(path.join(ROOT, "seed", "cex_funders.json"), "utf8"));
    for (const f of raw.funders ?? []) if (f.address) set.add(f.address);
  } catch {}
  return set;
}

interface Cluster {
  id: string;
  coin: string;
  coin_symbol: string | null;
  kind: "deployer-farm" | "top-holder-bundle";
  deployer: string | null;
  funder: string | null;
  members: string[];
  member_count_estimate: number;
  members_capped: boolean;
  evidence: string;
  detected_at: number;
  source: string;
}

function loadClusters(): Cluster[] {
  if (!existsSync(CLUSTERS_PATH)) return [];
  try { return (JSON.parse(readFileSync(CLUSTERS_PATH, "utf8")).clusters ?? []) as Cluster[]; } catch { return []; }
}

async function main() {
  const registry = loadRegistry();
  const excluded = loadExcludedFunders();
  const existing = loadClusters();

  // Mints: CLI args, else re-check what's already on file plus TURF (the reference specimen).
  const argMints = process.argv.slice(2).filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
  const mints = argMints.length ? argMints : [...new Set([TURF, ...existing.map((c) => c.coin)])];

  console.log(`\nKarma · sybil-cluster enrichment  (${mints.length} mint${mints.length === 1 ? "" : "s"})\n`);

  const byId = new Map<string, Cluster>(existing.map((c) => [c.id, c]));

  for (const mint of mints) {
    let scan;
    try { scan = await scanCoin(rpc, mint, SCORING, now, cache, registry, excluded); }
    catch (e) { console.log(`  ✗ ${mint.slice(0, 8)}… scan error: ${(e as Error).message}`); continue; }
    if (!scan.eligible) { console.log(`  – ${mint.slice(0, 8)}… ineligible: ${scan.refusal_reasons[0] ?? "?"}`); continue; }

    const sym = scan.symbol ?? mint.slice(0, 6);
    const found: Cluster[] = [];

    // Deployer farm: the dead-holder swarm the top-N lens can't see.
    const f = scan.creator_fanout;
    if (scan.creator && f && f.distinct_recipients >= SCORING.coin.farmRecipients) {
      const plus = f.total_txs > f.sampled_txs;
      found.push({
        id: `${sym}-deployer-${scan.creator.slice(0, 6)}`,
        coin: mint, coin_symbol: scan.symbol, kind: "deployer-farm",
        deployer: scan.creator, funder: null,
        members: f.recipients_sample,
        member_count_estimate: f.distinct_recipients, members_capped: plus,
        evidence: `deployer seeded ${f.distinct_recipients}${plus ? "+" : ""} wallets, ${f.total_txs}${f.total_txs_capped ? "+" : ""} txns, ${f.dispensed_sol} SOL out, ${f.balance_sol ?? "?"} SOL left`,
        detected_at: now, source: "enrich-sybil-clusters",
      });
    }

    // Top-holder bundles: coordinated snipers sharing one purse.
    for (const b of scan.bundles) {
      if (!b.funder) continue;
      const members = scan.holders.filter((h: CoinHolder) => h.bundle_id === b.id).map((h) => h.wallet);
      found.push({
        id: `${sym}-bundle-${b.funder.slice(0, 6)}`,
        coin: mint, coin_symbol: scan.symbol, kind: "top-holder-bundle",
        deployer: null, funder: b.funder,
        members,
        member_count_estimate: members.length, members_capped: false,
        evidence: `${members.length} top holders share funder ${b.funder.slice(0, 8)}…${b.uniform_funding ? ", near-identical seed amounts" : ""}${b.fanout ? `; purse seeded ${b.fanout.distinct_recipients}${b.fanout.total_txs > b.fanout.sampled_txs ? "+" : ""} wallets` : ""}`,
        detected_at: now, source: "enrich-sybil-clusters",
      });
    }

    if (!found.length) { console.log(`  · ${sym.padEnd(10)} clean (no farm or bundle)`); continue; }
    for (const c of found) {
      byId.set(c.id, c); // upsert: a re-run refreshes evidence/members for the same cluster id
      console.log(`  ⚑ ${sym.padEnd(10)} ${c.kind}: ${c.evidence}`);
    }
  }

  const clusters = [...byId.values()].sort((a, b) => b.detected_at - a.detected_at);
  const memberTotal = new Set(clusters.flatMap((c) => [c.deployer, c.funder, ...c.members].filter(Boolean))).size;
  const out = {
    _doc: "Recorded Sybil clusters: manufactured holder bases (deployer farms + top-holder bundles). Written by scripts/enrich-sybil-clusters.ts, read by data.ts sybilFor and shown on the wallet card as a flag SEPARATE from the trust grade. Members are a sample (the fan-out probe strides, it doesn't parse every tx), so member_count_estimate is the floor and members_capped marks 'more exist'.",
    generated_at: new Date().toISOString(),
    clusters,
  };
  writeFileSync(CLUSTERS_PATH, JSON.stringify(out, null, 2));
  console.log(`\n  ${clusters.length} cluster(s) · ${memberTotal} flagged wallets → ${path.relative(ROOT, CLUSTERS_PATH)}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
