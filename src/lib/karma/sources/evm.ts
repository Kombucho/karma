/**
 * The thinnest possible EVM reader: enough JSON-RPC to answer the two questions a coin scan needs on
 * a chain where nobody hands us a holder index for free — "how much of this coin does the dev still
 * hold" and "is the dev wallet alive". Keyless public RPCs, one POST per call. No ethers, no viem;
 * an ERC-20 balance is one `eth_call` and 32 bytes of hex, and pulling a library in for that would be
 * exactly the part to delete.
 */

export interface EvmChain {
  id: number;
  key: string;
  label: string;
  rpc: string;
  /** Native gas token symbol. */
  native: string;
  /** GeckoTerminal network slug, for the chart link. */
  gt: string;
  explorer: string;
  /** Blocks per eth_getLogs window on the keyless RPC. Default 2k (BSC's cap); fast chains need far more. */
  logWindow?: number;
  /** For a hard, small range cap (HyperEVM: 1k blocks at ~1s): fetch this many fixed windows at once. */
  logParallel?: number;
  /** PublicNode host for the same chain: with PUBLICNODE_ARCHIVE_TOKEN, the fallback when the keyless RPC refuses us. */
  archiveRpc?: string;
  /** Blockscout instance indexing this chain: the holder book in one call instead of a log replay. */
  blockscout?: { url: string; chainId: number };
}

// The chains pump.fun launches on. BSC is where the 0x…7777 mints live today; the rest are wired so
// a new pump chain is one row, not a refactor.
const CHAINS: Record<number, EvmChain> = {
  56: { id: 56, key: "bsc", label: "BNB Chain", rpc: "https://bsc-rpc.publicnode.com", native: "BNB", gt: "bsc", explorer: "https://bscscan.com" },
  8453: { id: 8453, key: "base", label: "Base", rpc: "https://base-rpc.publicnode.com", native: "ETH", gt: "base", explorer: "https://basescan.org" },
  1: { id: 1, key: "eth", label: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", native: "ETH", gt: "eth", explorer: "https://etherscan.io" },
  // Robinhood Chain — where a lot of pump.fun's non-BSC coins actually live (CEREBRO etc). GT slug
  // "robinhood", keyless RPC; its official explorer is Blockscout, which also serves the holder book. Adding a chain is one row, exactly as intended.
  // ~0.1s blocks, so a days-old coin spans millions of blocks; its RPC takes any range for one address
  // (cap is 10k logs per call, not blocks), so the window starts huge and halves on the log cap.
  // HyperEVM (Hyperliquid), where pump's "projectx" coins trade. ~1s blocks and every free RPC caps
  // getLogs at 1k blocks, so the sweep fans out in parallel fixed windows under a depth budget.
  999: { id: 999, key: "hyperevm", label: "HyperEVM", rpc: "https://hyperliquid-rpc.publicnode.com", native: "HYPE", gt: "hyperevm", explorer: "https://hyperevmscan.io", logWindow: 1_000, logParallel: 8 },
  4663: { id: 4663, key: "robinhood", label: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", native: "ETH", gt: "robinhood", explorer: "https://robinhoodchain.blockscout.com", logWindow: 5_000_000, archiveRpc: "https://robinhood-rpc.publicnode.com", blockscout: { url: "https://robinhoodchain.blockscout.com", chainId: 4663 } },
};

/** Every chain we can read, for callers that must find which one a bare 0x address lives on. */
export function evmChains(): EvmChain[] {
  return Object.values(CHAINS);
}

/**
 * Resolve a CAIP-2 id ("eip155:56"), a bare number, or a numeric string to a chain. A KNOWN id maps
 * to its row; an UNKNOWN id degrades to a market-only shell labelled by its number (never masquerades
 * as BNB — that mislabelling is what made a Robinhood coin read as "BNB Chain" with an empty book);
 * a missing id falls back to BSC, the dominant pump EVM chain.
 */
export function evmChain(chainId: string | number | null | undefined): EvmChain {
  let id: number | null = null;
  if (typeof chainId === "number") id = chainId;
  else if (typeof chainId === "string") {
    const m = chainId.match(/(\d+)\s*$/); // "eip155:56" → 56
    if (m) id = Number(m[1]);
  }
  if (id !== null && CHAINS[id]) return CHAINS[id];
  if (id !== null) return { id, key: `chain-${id}`, label: `Chain ${id}`, rpc: "", native: "ETH", gt: "", explorer: "" };
  return CHAINS[56];
}

/** The last RPC failure per chain, surfaced on the holder book so an empty book says why. */
const lastRpcError = new Map<number, string>();

async function rpcOnce<T>(url: string, method: string, params: unknown[]): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `http ${res.status}` };
    const j = (await res.json()) as { result?: T; error?: { message?: string } };
    if (j.error || j.result === undefined) return { ok: false, error: j.error?.message ?? "no result" };
    return { ok: true, result: j.result as T };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "fetch failed" };
  }
}

/**
 * One JSON-RPC call on the chain's keyless RPC, falling back to its PublicNode host when it has one
 * (Robinhood's public RPC 429s shared Vercel IPs). Latest-state calls need no token there.
 */
async function rpc<T>(chain: EvmChain, method: string, params: unknown[]): Promise<T | null> {
  const first = await rpcOnce<T>(chain.rpc, method, params);
  if (first.ok) return first.result;
  if (chain.archiveRpc) {
    const pn = process.env.PUBLICNODE_ARCHIVE_TOKEN ?? process.env.BSC_RPC_ARCHIVE_TOKEN;
    const url = pn && !pn.startsWith("http") ? `${chain.archiveRpc}/${pn}` : chain.archiveRpc;
    const second = await rpcOnce<T>(url, method, params);
    if (second.ok) return second.result;
    lastRpcError.set(chain.id, `${first.error}; publicnode: ${second.error}`);
    return null;
  }
  lastRpcError.set(chain.id, first.error);
  return null;
}

const pad32 = (addr: string) => addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const toBigInt = (hex: string | null) => (hex && hex !== "0x" ? BigInt(hex) : null);

/** ERC-20 `balanceOf(owner)` — selector 0x70a08231. Null on any RPC failure. */
export async function evmBalanceOf(chain: EvmChain, token: string, owner: string): Promise<bigint | null> {
  const r = await rpc<string>(chain, "eth_call", [{ to: token, data: `0x70a08231${pad32(owner)}` }, "latest"]);
  return toBigInt(r);
}

/** ERC-20 `totalSupply()` — selector 0x18160ddd. */
export async function evmTotalSupply(chain: EvmChain, token: string): Promise<bigint | null> {
  const r = await rpc<string>(chain, "eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
  return toBigInt(r);
}

/** Decode an ABI `string` return (or a legacy bytes32 one, e.g. MKR-style tokens). Null if unreadable. */
function abiString(hex: string | null): string | null {
  if (!hex || hex === "0x") return null;
  const h = hex.replace(/^0x/, "");
  const bytes = (x: string) => new TextDecoder().decode(Uint8Array.from(x.match(/../g) ?? [], (b) => parseInt(b, 16))).replace(/\0+$/, "").trim();
  try {
    if (h.length === 64) return bytes(h) || null; // bytes32
    const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + h.slice(off, off + 64))) * 2;
    return bytes(h.slice(off + 64, off + 64 + len)) || null;
  } catch {
    return null;
  }
}

/** ERC-20 `name()` (0x06fdde03) and `symbol()` (0x95d89b41). Nulls when the contract doesn't answer. */
export async function evmTokenMeta(chain: EvmChain, token: string): Promise<{ name: string | null; symbol: string | null }> {
  const [n, s] = await Promise.all([
    rpc<string>(chain, "eth_call", [{ to: token, data: "0x06fdde03" }, "latest"]),
    rpc<string>(chain, "eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]),
  ]);
  return { name: abiString(n), symbol: abiString(s) };
}

/** A wallet's shape on-chain: transaction count (nonce) and native-token balance. */
export async function evmWallet(chain: EvmChain, addr: string): Promise<{ tx_count: number; native_balance: number }> {
  const [nonceHex, balHex] = await Promise.all([
    rpc<string>(chain, "eth_getTransactionCount", [addr, "latest"]),
    rpc<string>(chain, "eth_getBalance", [addr, "latest"]),
  ]);
  const wei = toBigInt(balHex);
  return {
    tx_count: nonceHex ? Number(BigInt(nonceHex)) : 0,
    native_balance: wei !== null ? Number(wei) / 1e18 : 0,
  };
}

/* -----------------------------------------------------------------------------------------------
 * Holder-book reconstruction from Transfer logs.
 *
 * There is no free holder index on BSC the way Helius hands one to us on Solana, so we rebuild the
 * book the only way the chain gives it away for nothing: replay every ERC-20 Transfer since the
 * coin was born, collect everyone a token ever landed on, then ask a single Multicall3 for all of
 * their live balances at once. Keyless public RPCs only serve a shallow window of logs, so this is
 * built to degrade honestly — it returns what it could reach and a `partial` flag, never throws.
 * --------------------------------------------------------------------------------------------- */

/** keccak256("Transfer(address,address,uint256)") — topic0 of every ERC-20 transfer. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Multicall3, deployed at the same address on BSC/Base/Ethereum and most EVM chains. */
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const DEAD_ADDR = "0x000000000000000000000000000000000000dead";

/** Left-pad a hex string (no 0x) to 64 chars — one ABI word. */
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
/** A 32-byte uint as hex. */
const uintWord = (n: number | bigint) => word(BigInt(n).toString(16));
/** The last 20 bytes of a 32-byte topic word, as a lowercase 0x address. */
const topicToAddr = (topic: string) => "0x" + topic.replace(/^0x/, "").toLowerCase().slice(24);

interface EvmBlock {
  number: number;
  timestamp: number;
}

async function getBlock(chain: EvmChain, tag: string): Promise<EvmBlock | null> {
  // false = don't hydrate transactions; we only want number + timestamp.
  const b = await rpc<{ number: string; timestamp: string }>(chain, "eth_getBlockByNumber", [tag, false]);
  if (!b || !b.number || !b.timestamp) return null;
  return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)) };
}

/**
 * Estimate the block number at a past unix time. We measure the chain's REAL average block time
 * from two live samples (never hardcode 3s — BSC drifts), project the target, then refine with a
 * couple of probes so we land just before the target rather than guessing. Returns a floor block,
 * or null if the chain is unreachable.
 */
export async function blockAtTimestamp(chain: EvmChain, unixSec: number): Promise<number | null> {
  const latest = await getBlock(chain, "latest");
  if (!latest) return null;
  if (unixSec >= latest.timestamp) return latest.number;

  // A second sample ~5000 blocks back gives a real seconds-per-block for THIS chain right now.
  const olderNum = Math.max(1, latest.number - 5000);
  const older = await getBlock(chain, "0x" + olderNum.toString(16));
  const spanBlocks = older ? latest.number - older.number : 0;
  const spanSecs = older ? latest.timestamp - older.timestamp : 0;
  const secsPerBlock = spanBlocks > 0 && spanSecs > 0 ? spanSecs / spanBlocks : 3; // 3s fallback if the probe failed

  // First projection from the latest sample.
  let guess = Math.max(1, Math.floor(latest.number - (latest.timestamp - unixSec) / secsPerBlock));

  // Refine: probe the guess, correct by the observed error, up to 3 times. Converges fast because
  // block time is near-constant over a short horizon.
  for (let i = 0; i < 3; i++) {
    const probe = await getBlock(chain, "0x" + guess.toString(16));
    if (!probe) break;
    const errSecs = probe.timestamp - unixSec;
    if (Math.abs(errSecs) < secsPerBlock * 2) break; // within ~2 blocks, good enough
    const next = Math.max(1, Math.min(latest.number, Math.floor(guess - errSecs / secsPerBlock)));
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

/** One decoded ERC-20 transfer: who sent, who received, how much, and where in the chain. */
export interface TransferLog {
  from: string;
  to: string;
  value: bigint;
  block: number;
}

interface TransferLogsResult {
  logs: TransferLog[];
  /** The last error the sweep hit, if any — why a book is empty or partial. */
  error?: string;
  /** True when the sweep couldn't reach `fromBlock` (archive wall on a keyless RPC). */
  partial: boolean;
  /** The oldest block actually covered — where the sweep really started. */
  from_block: number;
}

const rpcError = (s: string) => s.toLowerCase();
const isArchiveError = (msg: string) => /archive|personal token|beyond the last accepted block|missing trie/.test(rpcError(msg));
/** "limited to 50 blocks", "block range is too large" → pull out N if present. */
function limitedBlocks(msg: string): number | null {
  const m = rpcError(msg).match(/(\d+)\s*blocks?/);
  if (m) return Number(m[1]);
  if (/range is too large|too many|exceed|limited|too wide/.test(rpcError(msg))) return 0; // shrink, no explicit N
  return null;
}

/** Raw eth_getLogs for one window. Returns logs, or an error string to let the caller adapt. */
async function getLogsWindow(
  rpcUrl: string,
  token: string,
  from: number,
  to: number,
): Promise<{ logs: Array<{ topics: string[]; data: string; blockNumber: string }> } | { error: string }> {
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_getLogs",
        params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { error: `http ${res.status}` };
    const j = (await res.json()) as { result?: Array<{ topics: string[]; data: string; blockNumber: string }>; error?: { message?: string } };
    if (j.error) return { error: j.error.message ?? "rpc error" };
    return { logs: j.result ?? [] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "fetch failed" };
  }
}

/** A bare PublicNode personal token (not a full archive URL, which is pinned to one chain). */
const hasPnToken = () => {
  const t = process.env.PUBLICNODE_ARCHIVE_TOKEN ?? process.env.BSC_RPC_ARCHIVE_TOKEN;
  return !!t && !t.startsWith("http");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (msg: string) => /429|too many requests|rate limit/.test(rpcError(msg));

/** Most fixed windows the parallel sweep will pull: 600 × 1k blocks ≈ a week of HyperEVM. */
const PARALLEL_MAX_WINDOWS = 600;
/** Wall-clock budget for a log sweep. A hyperactive coin (200k transfers/day) would otherwise hold the
 *  page for 80s+; past this we stop, newest-first, and report the book as partial. */
const SWEEP_BUDGET_MS = 25_000;

/**
 * Fixed-window sweep for chains whose RPC hard-caps the range small (HyperEVM: 1k blocks). Pulls
 * `logParallel` windows at a time, newest-first, retrying rate limits; stops at the first window that
 * still fails or at the depth budget and says so via `partial` — live holders are always covered first.
 */
async function getTransferLogsParallel(
  chain: EvmChain,
  rpcUrl: string,
  token: string,
  fromBlock: number,
  toBlock: number,
  opts: { size?: number; par?: number } = {},
): Promise<TransferLogsResult> {
  const size = opts.size ?? chain.logWindow ?? 1_000;
  const par = opts.par ?? chain.logParallel ?? 4;
  const logs: TransferLog[] = [];
  let hi = toBlock;
  let windows = 0;
  const deadline = Date.now() + SWEEP_BUDGET_MS;
  while (hi >= fromBlock) {
    if (windows >= PARALLEL_MAX_WINDOWS || Date.now() > deadline) return { logs, partial: true, from_block: hi + 1 };
    const batch: Array<[number, number]> = [];
    for (let i = 0; i < par && hi >= fromBlock; i++) {
      const lo = Math.max(fromBlock, hi - size + 1);
      batch.push([lo, hi]);
      hi = lo - 1;
    }
    windows += batch.length;
    const results = await Promise.all(
      batch.map(async ([lo, h]) => {
        let err = "rate limited";
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await getLogsWindow(rpcUrl, token, lo, h);
          if (!("error" in r)) return r.logs;
          err = r.error;
          if (!isRateLimit(r.error)) break;
          await sleep(400 * (attempt + 1));
        }
        return err;
      }),
    );
    // Keep the contiguous newest run; the first failed window is where coverage honestly ends.
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (typeof r === "string") return { logs, partial: true, from_block: batch[i][1] + 1, error: r };
      for (const l of r) {
        if (!l.topics || l.topics.length < 3) continue;
        logs.push({ from: topicToAddr(l.topics[1]), to: topicToAddr(l.topics[2]), value: toBigInt(l.data) ?? 0n, block: Number(BigInt(l.blockNumber)) });
      }
    }
  }
  return { logs, partial: false, from_block: fromBlock };
}

/**
 * Paginate eth_getLogs over [fromBlock,toBlock] for a token's Transfer events. The window size
 * adapts to whatever the provider allows: it starts wide, shrinks to the exact N when the RPC says
 * "limited to N blocks", and stops at the archive wall (marking the result partial) unless
 * BSC_RPC_ARCHIVE_TOKEN is set — in which case it appends the token to the publicnode URL (allnodes
 * format) and widens the window, since an archive node serves the full history.
 *
 * Sweeps newest-first so that on a shallow keyless RPC we keep the most recent, most relevant logs
 * (the current holders) and only lose the deep tail.
 */
export async function getTransferLogs(chain: EvmChain, token: string, fromBlock: number, toBlock: number): Promise<TransferLogsResult> {
  // One PublicNode personal token covers every EVM chain (bsc/base/eth) — one free var, all chains.
  // BSC_RPC_ARCHIVE_TOKEN kept as a fallback name for compatibility.
  // Only for PublicNode-hosted chains: appended to any other RPC it breaks the URL.
  const archiveToken = chain.rpc.includes("publicnode.com") && !chain.logWindow
    ? (process.env.PUBLICNODE_ARCHIVE_TOKEN ?? process.env.BSC_RPC_ARCHIVE_TOKEN)
    : undefined;
  // Accept EITHER a full archive RPC URL (any provider) or a bare personal token (appended as a
  // path segment, the allnodes/publicnode format). Whatever the provider hands over just works.
  const rpcUrl = archiveToken
    ? archiveToken.startsWith("http")
      ? archiveToken
      : `${chain.rpc.replace(/\/$/, "")}/${archiveToken}`
    : chain.rpc;

  if (chain.logParallel && !archiveToken) return getTransferLogsParallel(chain, rpcUrl, token, fromBlock, toBlock);

  const logs: TransferLog[] = [];
  // 45k, safely under PublicNode's 50k archive range cap, so windows paginate instead of tripping it.
  let window = archiveToken ? 45_000 : (chain.logWindow ?? 2_000);
  const MIN_WINDOW = 1;
  let reached = fromBlock; // the oldest block we actually covered
  let partial = false;

  const startWindow = window;
  let rateRetries = 0;
  let lastError: string | undefined;
  const deadline = Date.now() + SWEEP_BUDGET_MS;

  // Walk newest→oldest so the shallow-window loss falls on the deep tail, not on live holders.
  let hi = toBlock;
  while (hi >= fromBlock) {
    if (Date.now() > deadline) {
      partial = true;
      reached = hi + 1;
      break;
    }
    const lo = Math.max(fromBlock, hi - window + 1);
    const r = await getLogsWindow(rpcUrl, token, lo, hi);

    if ("error" in r) lastError = r.error;
    if ("error" in r && isRateLimit(r.error) && rateRetries < 5) {
      // A 429 says nothing about the range — wait and retry the same window instead of shrinking it.
      rateRetries++;
      await sleep(400 * rateRetries);
      continue;
    }
    if ("error" in r && isRateLimit(r.error) && !logs.length && chain.archiveRpc && hasPnToken()) {
      // Still refused after the retries and nothing read yet: don't spend the budget here, go to PublicNode.
      partial = true;
      reached = hi + 1;
      break;
    }
    rateRetries = 0;

    if ("error" in r) {
      const n = limitedBlocks(r.error);
      if (isArchiveError(r.error) && !archiveToken) {
        // Hit the keyless archive wall — everything older than here is unreachable for free.
        partial = true;
        reached = hi + 1;
        break;
      }
      if (n !== null) {
        // Provider capped the range. Shrink to its stated N (or halve when it didn't say), retry same hi.
        const next = n > 0 ? n : Math.floor(window / 2);
        if (next < MIN_WINDOW || next >= window) {
          // Can't shrink any further — give up on the deep tail honestly.
          partial = true;
          reached = hi + 1;
          break;
        }
        window = next;
        continue;
      }
      // Unknown transient error: shrink once and retry; if already tiny, stop and mark partial.
      if (window > MIN_WINDOW) {
        window = Math.max(MIN_WINDOW, Math.floor(window / 2));
        continue;
      }
      partial = true;
      reached = hi + 1;
      break;
    }

    for (const l of r.logs) {
      // topics: [topic0, from(indexed), to(indexed)]. A malformed/partial-topic transfer is skipped.
      if (!l.topics || l.topics.length < 3) continue;
      logs.push({
        from: topicToAddr(l.topics[1]),
        to: topicToAddr(l.topics[2]),
        value: toBigInt(l.data) ?? 0n,
        block: Number(BigInt(l.blockNumber)),
      });
    }
    reached = lo;
    hi = lo - 1;
    // A busy stretch shrank the window; once logs thin out again, grow back so a quiet tail stays cheap.
    if (r.logs.length < 2_500 && window < startWindow) window = Math.min(startWindow, window * 2);
  }

  // The keyless RPC refused us outright (Robinhood's 429s shared Vercel IPs): if the chain has a PublicNode
  // host and we hold the archive token, sweep there instead — 45k-block windows, 8 at a time.
  const pnToken = process.env.PUBLICNODE_ARCHIVE_TOKEN ?? process.env.BSC_RPC_ARCHIVE_TOKEN;
  if (!logs.length && partial && chain.archiveRpc && pnToken && hasPnToken()) {
    const fb = await getTransferLogsParallel(chain, `${chain.archiveRpc}/${pnToken}`, token, fromBlock, toBlock, { size: 45_000, par: 8 });
    if (fb.logs.length) return fb;
    lastError = `${lastError ?? "refused"}; publicnode: ${fb.error ?? "no logs"}`;
  }
  return { logs, partial, from_block: reached, error: lastError };
}

/**
 * Multicall3 aggregate3 to read many ERC-20 balances in one eth_call. Encodes the call by hand:
 * aggregate3((address target, bool allowFailure, bytes callData)[]). The argument is a dynamic
 * array of tuples, and each tuple carries a dynamic `bytes` — so there are three offset layers to
 * get right (array head → per-tuple head → the bytes' own offset+length+body). Returns one bigint
 * per address (null where the sub-call failed). Batches internally to stay under call-size limits.
 */
export async function multicallBalances(chain: EvmChain, token: string, addresses: string[]): Promise<(bigint | null)[]> {
  const out: (bigint | null)[] = [];
  const BATCH = 400;
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    const decoded = await multicallBatch(chain, token, batch);
    for (const d of decoded) out.push(d);
  }
  return out;
}

function encodeAggregate3(token: string, addresses: string[]): string {
  const n = addresses.length;
  // aggregate3((address,bool,bytes)[]) selector.
  const SELECTOR = "82ad56cb";

  // Each call's calldata = balanceOf(addr): selector 0x70a08231 + 32-byte owner. 36 bytes → the
  // bytes body occupies 2 words (36 bytes padded to 64).
  const callData = (addr: string) => "70a08231" + word(addr);

  // A single tuple (address target, bool allowFailure, bytes callData), ABI-encoded RELATIVE to the
  // tuple's own start. Because it contains a dynamic member (bytes), the tuple is itself dynamic:
  //   word0: target (address)
  //   word1: allowFailure (bool, 1)
  //   word2: offset to the bytes, from the tuple start = 0x60 (3 words of head)
  //   word3: bytes length
  //   word4..: bytes body, right-padded to a whole number of words
  const encodeTuple = (addr: string) => {
    const cd = callData(addr);
    const cdBytes = cd.length / 2; // hex chars → bytes
    const body = cd.padEnd(Math.ceil(cd.length / 64) * 64, "0");
    return word(token) + uintWord(1) + uintWord(0x60) + uintWord(cdBytes) + body;
  };

  const tuples = addresses.map(encodeTuple);

  // The array is dynamic: [ length ][ per-tuple offsets... ][ tuples... ]. Inside the array: a
  // length word, then n head words (each an offset to its tuple, measured from the first head
  // word), then the tuples packed back-to-back. Offsets are counted in bytes (32 per word).
  const headWords = n; // one offset per tuple
  let byteCursor = headWords * 32; // byte offset of the first tuple, past the head words
  const heads: string[] = [];
  const bodies: string[] = [];
  for (const t of tuples) {
    heads.push(uintWord(byteCursor));
    bodies.push(t);
    byteCursor += t.length / 2; // advance past this tuple's bytes
  }

  // The single argument's offset (from just after the selector) is one word → 0x20.
  const array = uintWord(n) + heads.join("") + bodies.join("");
  return "0x" + SELECTOR + uintWord(0x20) + array;
}

async function multicallBatch(chain: EvmChain, token: string, addresses: string[]): Promise<(bigint | null)[]> {
  if (!addresses.length) return [];
  const data = encodeAggregate3(token, addresses);
  const ret = await rpc<string>(chain, "eth_call", [{ to: MULTICALL3, data }, "latest"]);
  if (!ret) return addresses.map(() => null);
  return decodeAggregate3(ret, addresses.length);
}

/**
 * Decode aggregate3's return: Result[] where Result = (bool success, bytes returnData). Same
 * dynamic-array-of-dynamic-tuples shape as the input. We read the array length, then for each
 * element follow its offset to (success word, bytes-offset word), then read the bytes length +
 * body and interpret the first word of returnData as the uint256 balance.
 */
function decodeAggregate3(hex: string, expected: number): (bigint | null)[] {
  const h = hex.replace(/^0x/, "");
  const wordAt = (byteOff: number) => h.slice(byteOff * 2, byteOff * 2 + 64);
  const numAt = (byteOff: number) => BigInt("0x" + (wordAt(byteOff) || "0"));

  const out: (bigint | null)[] = [];
  try {
    // Layout: [0x20 offset][array len][elem offsets...][elems...], all relative to the data start.
    const arrOff = Number(numAt(0)); // = 0x20
    const len = Number(numAt(arrOff));
    const headBase = arrOff + 32; // first element-offset word
    for (let i = 0; i < len; i++) {
      const elemOff = headBase + Number(numAt(headBase + i * 32)); // element start, relative to headBase
      const success = numAt(elemOff) !== 0n; // word0: bool success
      const bytesOff = elemOff + Number(numAt(elemOff + 32)); // word1: offset to returnData bytes
      const bytesLen = Number(numAt(bytesOff)); // returnData length
      if (!success || bytesLen < 32) {
        out.push(null);
        continue;
      }
      out.push(numAt(bytesOff + 32)); // first word of returnData = balanceOf result
    }
  } catch {
    return Array.from({ length: expected }, () => null);
  }
  // Pad/truncate defensively so the caller's index alignment always holds.
  while (out.length < expected) out.push(null);
  return out.slice(0, expected);
}

/** The reconstructed holder book for an EVM coin — the EVM analogue of the Solana holder set. */
export interface EvmHolder {
  address: string;
  /** Live balance, raw base units, as a string (bigint can't cross JSON). */
  balance: string;
  pct: number;
  first_block: number;
  source: "pool" | "creator" | "other";
}

export interface EvmHolderBook {
  holders: EvmHolder[];
  holder_count: number;
  top1_pct: number;
  top5_pct: number;
  top10_pct: number;
  /** Wallets first funded the coin by the pool in the opening blocks — snipers. count + summed pct. */
  snipers: { count: number; pct: number };
  /** Wallets whose first inbound transfer came from the creator — an airdrop bundle. count + summed pct. */
  airdrop: { count: number; pct: number };
  /** True when the log sweep couldn't reach the coin's birth block (keyless archive wall). */
  partial: boolean;
  /** The oldest block the sweep actually covered. */
  from_block: number;
  /** What the sweep saw, so an empty or thin book says why instead of just reading zero. */
  diag?: { logs: number; candidates: number; balance_failed: number; error?: string };
  /** Where the book came from. Blockscout gives balances but no entry history, so its snipers/airdrop
   *  are unknown (zeros), not measured. Absent = the Transfer-log replay. */
  source?: "logs" | "blockscout";
}

interface BsHolder {
  address?: { hash?: string };
  value?: string;
}

/** One Blockscout REST v2 GET: the Pro API when BLOCKSCOUT_API_KEY is set, the explorer's own API otherwise. */
async function blockscoutGet<T>(bs: NonNullable<EvmChain["blockscout"]>, path: string): Promise<T | null> {
  const key = process.env.BLOCKSCOUT_API_KEY;
  const urls = key
    ? [`https://api.blockscout.com/${bs.chainId}${path}${path.includes("?") ? "&" : "?"}apikey=${key}`, `${bs.url}${path}`]
    : [`${bs.url}${path}`];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) return (await res.json()) as T;
      console.warn(`[blockscout] ${res.status} for ${path}${url.includes("apikey") ? " (pro)" : ""}`);
    } catch (e) {
      console.warn(`[blockscout] ${e instanceof Error ? e.message : "fetch failed"} for ${path}`);
    }
  }
  return null;
}

/**
 * The holder book straight from the chain's Blockscout indexer: holder count + the top holders by
 * balance, two or three calls instead of replaying millions of Transfer logs on a rate-limited RPC.
 * Same shape as reconstructHolders, same exclusions (zero/dead/the token/its pool). Null when the
 * chain has no Blockscout or it doesn't answer — the caller falls back to the log replay.
 */
export async function blockscoutHolders(
  chain: EvmChain,
  token: string,
  opts: { poolAddress: string | null },
): Promise<EvmHolderBook | null> {
  const bs = chain.blockscout;
  if (!bs) return null;
  const [info, page1] = await Promise.all([
    blockscoutGet<{ holders_count?: string | number; holders?: string | number; total_supply?: string | null }>(bs, `/api/v2/tokens/${token}`),
    blockscoutGet<{ items?: BsHolder[]; next_page_params?: Record<string, string | number> | null }>(bs, `/api/v2/tokens/${token}/holders`),
  ]);
  if (!info || !page1?.items) return null;
  const items = [...page1.items];
  if (page1.next_page_params) {
    const q = new URLSearchParams(Object.entries(page1.next_page_params).map(([k, v]) => [k, String(v)])).toString();
    const page2 = await blockscoutGet<{ items?: BsHolder[] }>(bs, `/api/v2/tokens/${token}/holders?${q}`);
    items.push(...(page2?.items ?? []));
  }

  const excluded = new Set([ZERO_ADDR, DEAD_ADDR, token.toLowerCase(), ...(opts.poolAddress ? [opts.poolAddress.toLowerCase()] : [])]);
  const parsed = items
    .map((h) => ({ address: h.address?.hash?.toLowerCase() ?? "", bal: /^\d+$/.test(h.value ?? "") ? BigInt(h.value!) : 0n }))
    .filter((h) => h.address && h.bal > 0n);
  const kept = parsed.filter((h) => !excluded.has(h.address));

  // Denominator: Blockscout's supply, else the chain's; never below the balances we can see.
  const bsSupply = /^\d+$/.test(info.total_supply ?? "") ? BigInt(info.total_supply!) : null;
  const supplyRaw = bsSupply ?? (await evmTotalSupply(chain, token).catch(() => null));
  const sumBal = parsed.reduce((s, h) => s + h.bal, 0n);
  const supply = supplyRaw && supplyRaw >= sumBal ? supplyRaw : sumBal;
  const pct = (b: bigint) => (supply > 0n ? Math.min(100, Number((b * 1_000_000n) / supply) / 10_000) : 0);

  const held: EvmHolder[] = kept.map((h) => ({ address: h.address, balance: h.bal.toString(), pct: pct(h.bal), first_block: 0, source: "other" }));
  const cum = (n: number) => held.slice(0, n).reduce((s, h) => s + h.pct, 0);
  const total = Number(info.holders_count ?? info.holders ?? NaN);
  // The index's count includes the pool/dead rows we drop from the book; take those out too.
  const holderCount = Number.isFinite(total) && total > 0 ? Math.max(held.length, total - (parsed.length - kept.length)) : held.length;
  if (!holderCount) return null; // an empty index answer is no better than the replay — let it try

  return {
    holders: held,
    holder_count: holderCount,
    top1_pct: held[0]?.pct ?? 0,
    top5_pct: cum(5),
    top10_pct: cum(10),
    snipers: { count: 0, pct: 0 },
    airdrop: { count: 0, pct: 0 },
    partial: false,
    from_block: 0,
    source: "blockscout",
  };
}

/**
 * Reconstruct the holder book for a pump.fun EVM coin from its Transfer log history, then verify
 * every candidate's live balance via one Multicall3 sweep. Mirrors the Solana scan's shape
 * (concentration + first-block signals) so it slots into the coin scan cleanly. Never throws —
 * returns null on a total failure, or a `partial:true` book when the free RPC window fell short.
 */
export async function reconstructHolders(
  chain: EvmChain,
  token: string,
  opts: { createdMs: number | null; poolAddress: string | null; creator: string | null; totalSupply: bigint | null },
): Promise<EvmHolderBook | null> {
  try {
    const latest = await getBlock(chain, "latest");
    if (!latest) return null;

    // Where the coin was born. If pump gave us no timestamp, fall back to a recent window (the
    // keyless RPC can't serve deeper anyway, so this is the honest ceiling).
    const fromBlock =
      opts.createdMs !== null
        ? (await blockAtTimestamp(chain, Math.floor(opts.createdMs / 1000))) ?? Math.max(1, latest.number - 2000)
        : Math.max(1, latest.number - 2000);

    const { logs, partial, from_block, error: sweepError } = await getTransferLogs(chain, token, fromBlock, latest.number);

    const pool = opts.poolAddress?.toLowerCase() ?? null;
    const creator = opts.creator?.toLowerCase() ?? null;
    const tokenLc = token.toLowerCase();
    const excluded = new Set([ZERO_ADDR, DEAD_ADDR, tokenLc, ...(pool ? [pool] : [])]);

    // First-seen block and first sender per candidate — the raw material for the sniper/airdrop reads.
    // Logs come back newest-first (we swept descending), so walk oldest-first to get true first-seen.
    interface Cand {
      firstBlock: number;
      firstFrom: string;
    }
    const cand = new Map<string, Cand>();
    const ordered = logs.slice().sort((a, b) => a.block - b.block);
    for (const l of ordered) {
      const to = l.to.toLowerCase();
      if (excluded.has(to)) continue;
      if (!cand.has(to)) cand.set(to, { firstBlock: l.block, firstFrom: l.from.toLowerCase() });
    }

    const addresses = [...cand.keys()];
    if (!addresses.length) {
      return {
        holders: [],
        holder_count: 0,
        top1_pct: 0,
        top5_pct: 0,
        top10_pct: 0,
        snipers: { count: 0, pct: 0 },
        airdrop: { count: 0, pct: 0 },
        partial,
        from_block,
        diag: { logs: logs.length, candidates: 0, balance_failed: 0, error: sweepError },
      };
    }

    // Live balances for all candidates in batched Multicall3 calls.
    const balances = await multicallBalances(chain, token, addresses);

    // The denominator for concentration. Use the CURRENT on-chain supply (authoritative, in the same
    // base units as balanceOf), and never a value smaller than the balances we can already see — a
    // stale/wrong supply is what produced impossible >100% concentration. pump's number is ignored.
    const onchainSupply = await evmTotalSupply(chain, token).catch(() => null);
    const sumBal = balances.reduce<bigint>((s, b) => s + (b !== null && b > 0n ? b : 0n), 0n);
    const supply: bigint | null = onchainSupply && onchainSupply >= sumBal ? onchainSupply : sumBal > 0n ? sumBal : onchainSupply;

    // Drop zero balances (sold out / passed through), attach first-seen + source.
    const openWindowEnd = from_block + 3; // "first ~3 blocks after fromBlock" = the sniper window
    const held: EvmHolder[] = [];
    addresses.forEach((addr, i) => {
      const bal = balances[i];
      if (bal === null || bal <= 0n) return;
      const c = cand.get(addr)!;
      // Clamp to 100 as a final guard against any residual supply weirdness (rebasing tokens, etc.).
      const pctVal = supply && supply > 0n ? Math.min(100, Number((bal * 1_000_000n) / supply) / 10_000) : 0;
      const source: EvmHolder["source"] =
        creator && c.firstFrom === creator ? "creator" : pool && c.firstFrom === pool ? "pool" : "other";
      held.push({ address: addr, balance: bal.toString(), pct: pctVal, first_block: c.firstBlock, source });
    });

    held.sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : BigInt(b.balance) < BigInt(a.balance) ? -1 : 0));

    const cum = (nn: number) => held.slice(0, nn).reduce((s, h) => s + h.pct, 0);

    // Snipers: pool-funded holders that first appeared in the opening blocks of the sweep.
    const sniperList = held.filter((h) => h.source === "pool" && h.first_block <= openWindowEnd);
    // Airdrop bundle: holders whose very first token came straight from the creator.
    const airdropList = held.filter((h) => h.source === "creator");

    return {
      holders: held,
      holder_count: held.length,
      top1_pct: held[0]?.pct ?? 0,
      top5_pct: cum(5),
      top10_pct: cum(10),
      snipers: { count: sniperList.length, pct: sniperList.reduce((s, h) => s + h.pct, 0) },
      airdrop: { count: airdropList.length, pct: airdropList.reduce((s, h) => s + h.pct, 0) },
      partial,
      from_block,
      diag: {
        logs: logs.length,
        candidates: addresses.length,
        balance_failed: balances.filter((b) => b === null).length,
        error: sweepError ?? lastRpcError.get(chain.id),
      },
    };
  } catch {
    return null;
  }
}
