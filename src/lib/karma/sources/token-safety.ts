import type { KV } from "../cache";
import type { SolanaRpc } from "./solana";

/**
 * RugCheck-style token-safety check, one RPC call deep.
 *
 * A memecoin's mint account is the deed to the whole supply: who can still print it, who can
 * freeze it in your wallet, and — under Token-2022 — a grab-bag of "extensions" that can quietly
 * tax, block, or seize your position. Ordinary scans never look at the token program at all, so a
 * honeypot like a coin whose transfer hook rejects every sell sails straight through. This module
 * fixes that: one `getAccountInfo` on the mint, decoded into the concrete hazards a buyer cares
 * about, plus a blunt severity so the caller can colour it red without re-deriving the logic.
 *
 * Design constraints (match the rest of `sources/`): dependency-free, defensive, never throws.
 * On any failure it returns a benign "other / clean" verdict rather than blowing up a scan.
 */

// The two SPL token programs. Owner of the mint account tells us which one minted the coin.
const SPL_TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// A fee this steep is punitive enough to treat as an outright rug rather than a mere caution.
const DANGER_FEE_BPS = 500; // 5%

/** How alarmed the caller should be. "danger" = likely honeypot/seizure; "caution" = revocable-but-live risk. */
export type Severity = "clean" | "caution" | "danger";

export interface TokenSafety {
  /** Which token program owns the mint. "other" also covers "couldn't tell" (missing/failed lookup). */
  program: "spl" | "token2022" | "other";
  /** A live mint authority means the supply can still be inflated under you. Null once revoked. */
  mint_authority: string | null;
  /** A live freeze authority can freeze your token account, locking you out of selling. Null once revoked. */
  freeze_authority: string | null;
  /** Token-2022 transfer tax, in basis points (100 bps = 1%). 0 when there's no fee. */
  transfer_fee_bps: number;
  /** True when the transfer-fee config still has an authority that can *raise* the fee later. */
  transfer_fee_can_change: boolean;
  /** Token-2022 transfer hook with a real program set: arbitrary code runs on every transfer and can reject sells. */
  has_transfer_hook: boolean;
  /** Token-2022 permanent delegate: a wallet that can move (seize) anyone's tokens at will. Null when unset. */
  permanent_delegate: string | null;
  /** Token-2022 default account state = frozen: brand-new holders land frozen and can't sell. Classic honeypot. */
  default_frozen: boolean;
  /** Token-2022 non-transferable ("soulbound"): the token literally can't be sent — you can never exit. */
  non_transferable: boolean;
  /** Human-readable one-liner per hazard found, safe to render straight to a user. */
  risks: string[];
  /** Roll-up of `risks` into a single traffic-light. */
  severity: Severity;
}

/** The shape `getAccountInfo({encoding:"jsonParsed"})` returns for a token mint. Everything optional — we trust nothing. */
interface ParsedMintAccount {
  value: {
    owner?: string;
    data?: {
      parsed?: {
        type?: string;
        info?: {
          mintAuthority?: string | null;
          freezeAuthority?: string | null;
          extensions?: Array<{ extension?: string; state?: Record<string, unknown> }>;
        };
      };
    };
  } | null;
}

/** The verdict we hand back when we simply couldn't inspect the mint. Benign by construction. */
function unknownSafety(): TokenSafety {
  return {
    program: "other",
    mint_authority: null,
    freeze_authority: null,
    transfer_fee_bps: 0,
    transfer_fee_can_change: false,
    has_transfer_hook: false,
    permanent_delegate: null,
    default_frozen: false,
    non_transferable: false,
    risks: [],
    severity: "clean",
  };
}

const asString = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

// The zero address is Solana's "no authority" sentinel; treat it as absent, not as a real key.
const NULL_ADDRESS = "11111111111111111111111111111111";
const liveAuthority = (v: unknown): string | null => {
  const s = asString(v);
  return s && s !== NULL_ADDRESS ? s : null;
};

/**
 * Inspect a mint's token program and (for Token-2022) its extensions, and roll the hazards up into
 * a severity. One `getAccountInfo`, cached ~1h because authorities *can* be revoked and we don't
 * want to keep condemning a coin whose dev did the right thing an hour ago.
 *
 * Never throws: any RPC error, odd shape, or non-token account collapses to an "other / clean" verdict.
 */
export async function tokenSafety(rpc: SolanaRpc, mint: string, cache: KV): Promise<TokenSafety> {
  const key = `token_safety:${mint}`;
  const hit = await cache.get<TokenSafety>(key);
  if (hit) return hit;

  try {
    const res = await rpc.call<ParsedMintAccount>("getAccountInfo", [mint, { encoding: "jsonParsed" }]);
    const account = res?.value;
    if (!account) return unknownSafety(); // account doesn't exist — don't cache the miss, it may appear

    const owner = asString(account.owner);
    const program: TokenSafety["program"] = owner === SPL_TOKEN ? "spl" : owner === TOKEN_2022 ? "token2022" : "other";

    const info = account.data?.parsed?.info;
    // If it parsed as something other than a mint (or didn't parse), we can't reason about it — bail benign.
    if (!info || account.data?.parsed?.type !== "mint") {
      const shell = { ...unknownSafety(), program };
      await cache.set(key, shell, 3600);
      return shell;
    }

    const safety: TokenSafety = {
      program,
      mint_authority: liveAuthority(info.mintAuthority),
      freeze_authority: liveAuthority(info.freezeAuthority),
      transfer_fee_bps: 0,
      transfer_fee_can_change: false,
      has_transfer_hook: false,
      permanent_delegate: null,
      default_frozen: false,
      non_transferable: false,
      risks: [],
      severity: "clean",
    };

    // Walk the Token-2022 extension list. Legacy SPL mints have none, so this loop is a no-op there.
    for (const ext of info.extensions ?? []) {
      const state = ext?.state ?? {};
      switch (ext?.extension) {
        case "transferFeeConfig": {
          // The *newer* fee is the one that applies from the next epoch on — the honest reading of the tax.
          const newer = state.newerTransferFee as { transferFeeBasisPoints?: unknown } | undefined;
          const bps = Number(newer?.transferFeeBasisPoints);
          if (Number.isFinite(bps) && bps > 0) safety.transfer_fee_bps = bps;
          // An authority on the config can still crank the fee up later — worth flagging even at 0 bps today.
          safety.transfer_fee_can_change = liveAuthority(state.transferFeeConfigAuthority) !== null;
          break;
        }
        case "transferHook":
          // A hook only bites when a real program is wired in; a null programId is an inert placeholder.
          if (liveAuthority(state.programId) !== null) safety.has_transfer_hook = true;
          break;
        case "permanentDelegate":
          safety.permanent_delegate = liveAuthority(state.delegate);
          break;
        case "defaultAccountState":
          if (state.accountState === "frozen") safety.default_frozen = true;
          break;
        case "nonTransferable":
          safety.non_transferable = true;
          break;
      }
    }

    // Turn the raw flags into user-facing one-liners. Order = roughly worst-first.
    const risks: string[] = [];
    if (safety.non_transferable) risks.push("token is non-transferable — you can never sell or move it (honeypot)");
    if (safety.default_frozen) risks.push("new holders start frozen — you may be unable to sell (honeypot risk)");
    if (safety.has_transfer_hook) risks.push("transfer hook can block sells (honeypot risk)");
    if (safety.permanent_delegate) risks.push("permanent delegate can seize your tokens");
    // A live fee authority can raise the rate (up to 100%) after an epoch delay — a latent honeypot, and
    // the part a trader needs to know on reward-tax launchpads (StonkFun/LaunchLab), not just the 3% today.
    if (safety.transfer_fee_bps > 0)
      risks.push(`${(safety.transfer_fee_bps / 100).toFixed(2)}% transfer tax on every trade${safety.transfer_fee_can_change ? ", and its authority can raise it" : ""}`);
    else if (safety.transfer_fee_can_change) risks.push("transfer-fee authority can introduce a tax on trades");
    if (safety.mint_authority) risks.push("mint authority still active — supply can be inflated");
    if (safety.freeze_authority) risks.push("freeze authority active — your tokens can be frozen");
    safety.risks = risks;

    // Severity: the "danger" set is the honeypot/seizure vectors; "caution" is revocable-but-live risk.
    const danger =
      safety.non_transferable ||
      safety.default_frozen ||
      safety.has_transfer_hook ||
      safety.permanent_delegate !== null ||
      safety.transfer_fee_bps > DANGER_FEE_BPS;
    const caution =
      safety.mint_authority !== null ||
      safety.freeze_authority !== null ||
      safety.transfer_fee_bps > 0 ||
      safety.transfer_fee_can_change;
    safety.severity = danger ? "danger" : caution ? "caution" : "clean";

    await cache.set(key, safety, 3600);
    return safety;
  } catch {
    // RPC hiccup, timeout, malformed JSON — never let a safety check sink a scan.
    return unknownSafety();
  }
}
