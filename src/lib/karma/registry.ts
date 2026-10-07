import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { FactCache } from "./fact-cache";
import { INFRA_OWNERS } from "./constants";
import type { WalletRegistry } from "./engine/coin";
import { GRADE_TITLES } from "./scoring.config";
import { SolanaRpc } from "./sources/solana";

/**
 * Shared server-side singletons for the live engine surfaces (coin scan page + API routes).
 *
 * The registry is every identity we can attach to a holder wallet before scanning anything:
 * seed handles + any v3 grade already computed into validation/. Built once per process —
 * the corpus only changes on a re-score, which is a redeploy.
 */

let _registry: WalletRegistry | null = null;

export function walletRegistry(): WalletRegistry {
  if (_registry) return _registry;
  const reg: WalletRegistry = new Map();
  try {
    const kols = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "kols.json"), "utf8"));
    for (const k of kols)
      reg.set(k.wallet_address, {
        handle: k.handle ?? null,
        verified: !!k.verified,
        source_url: k.source_url ?? null,
        grade: null,
        title: null,
      });
  } catch {}
  try {
    const dir = path.join(process.cwd(), "validation");
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        const grade = r.trust?.grade ?? r.score?.grade ?? null;
        if (!grade) continue;
        const title = GRADE_TITLES[grade as keyof typeof GRADE_TITLES]; // derive from grade; stored string may be a stale taxonomy
        const entry = reg.get(r.wallet);
        if (entry) {
          entry.grade = grade;
          entry.title = title;
        } else {
          // A scored wallet that fell out of the seed still deserves its grade on holder lists.
          reg.set(r.wallet, { handle: r.handle ?? null, verified: false, source_url: null, grade, title });
        }
      } catch {}
    }
  } catch {}
  _registry = reg;
  return reg;
}

let _excludedFunders: Set<string> | null = null;

/**
 * Funders that never make a holder a Sybil suspect: infra (burn/AMM) plus curated CEX hot wallets.
 * A shared-funder cluster pointing at one of these is a crowd of strangers who all cashed out of the
 * same exchange, not a coordinated bundle. Built once per process from seed/cex_funders.json.
 */
export function excludedFunders(): Set<string> {
  if (_excludedFunders) return _excludedFunders;
  const set = new Set<string>(INFRA_OWNERS);
  try {
    const raw = JSON.parse(readFileSync(path.join(process.cwd(), "seed", "cex_funders.json"), "utf8"));
    for (const f of raw.funders ?? []) if (f.address) set.add(f.address);
  } catch {}
  _excludedFunders = set;
  return set;
}

/** One process-wide cache + RPC client, so every live surface shares rate limits and warm entries. */
export const serverCache = new FactCache();
export const serverRpc = SolanaRpc.fromEnv(serverCache);
