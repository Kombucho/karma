import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Children } from "react";
import { BASE58_ADDRESS, EVM_ADDRESS } from "@/lib/karma/data";
import { scanCoin, type CoinScan, type CoinHolder, type DevProfile, type EvmMarket, type HolderSample } from "@/lib/karma/engine/coin";
import type { TokenSafety } from "@/lib/karma/sources/token-safety";
import type { HolderCluster } from "@/lib/karma/sources/holder-clusters";
import type { EntryRead } from "@/lib/karma/sources/holder-entry";
import { fetchMarketRegime, type MarketRegime } from "@/lib/karma/sources/market";
import { GRADE_STYLE, shortWallet } from "@/lib/karma/grade-ui";
import { SCORING } from "@/lib/karma/scoring.config";
import { evmVerdict, solanaVerdict, type Verdict } from "@/lib/karma/engine/verdict";
import { excludedFunders, serverCache, serverRpc, walletRegistry } from "@/lib/karma/registry";
import { getStoredScan, putStoredScan } from "@/lib/karma/db";
import { recordScanRun } from "@/lib/karma/history";
import { recordHolders } from "@/lib/karma/sources/sibling-overlap";
import Avatar from "../../Avatar";
import WalletTxs from "./WalletTxs";
import ChartReadPanel from "./ChartRead";
import HoldToScan from "./HoldToScan";
import { SESSION_COOKIE, TIERS, canFreshScan, clientIp, recordFreshScan, resolveAccess, type Access } from "@/lib/karma/access";

/** Chart health only makes sense once a coin has ~2 days of candles; below that it's sniper noise. */
const CHART_MIN_AGE_S = 2 * 86400;

/**
 * Coin Scan: who is actually holding this thing, before you buy it.
 *
 * The pitch in one line: Bubblemaps tells you the supply is concentrated; this tells you the
 * top of the book is three F-grade ruggers and a bundle of wallets created in the same hour.
 * Identity + track record, not just distribution.
 *
 * Rendered server-side off the same engine as /api/coin/[mint], shared 5-minute cache. The
 * scan is honest about its own limits: infra (pools, lockers, curve PDAs) is excluded and the
 * excluded share is shown, unknown wallets are called unknown, and an ineligible coin gets its
 * refusal reasons instead of a hollow result.
 */

export const dynamic = "force-dynamic";

const SCAN_TTL = 300;

/** Compact relative age from a unix timestamp against the scan time: 45s, 12m, 3h, 2d. */
function ago(t: number, now: number): string {
  const s = Math.max(0, now - t);
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// Serve a persisted scan up to this old before paying for a fresh RPC sweep. The daily cron and
// every visitor keep the store fresh, so a coin anyone's looked at recently loads instantly.
const DB_FRESH_SECONDS = 1800;

/** The scan, or — when only a fresh RPC sweep would do and the visitor's allowance is spent — who they are. */
async function getScan(mint: string): Promise<CoinScan | { blocked: Access }> {
  const key = `coinscan:${mint}`;
  const mem = await serverCache.get<CoinScan>(key);
  if (mem) return mem;

  // Cross-instance persistence: a scan another instance (or the cron) computed lives in the DB.
  const stored = await getStoredScan<CoinScan>(mint);
  if (stored && stored.ageSeconds < DB_FRESH_SECONDS) {
    await serverCache.set(key, stored.scan, SCAN_TTL);
    return stored.scan;
  }

  // Hold-to-scan: only this cold path spends RPC, so only it counts against the daily allowance.
  const [c, h] = await Promise.all([cookies(), headers()]);
  const access = await resolveAccess(c.get(SESSION_COOKIE)?.value, clientIp(h));
  if (!canFreshScan(access)) return { blocked: access };

  const scan = await scanCoin(serverRpc, mint, SCORING, Math.floor(Date.now() / 1000), serverCache, walletRegistry(), excludedFunders());
  await recordFreshScan(access);
  await serverCache.set(key, scan, SCAN_TTL);
  await putStoredScan(mint, scan, scan.eligible); // accumulate; awaited so serverless doesn't cut the write
  await recordScanRun(scan, "page"); // append-only wallet history
  // Feeds the sibling-overlap lens (no-op until the coin_holders table exists).
  if (scan.eligible) await recordHolders(mint, scan.holders, { checkedAt: scan.checked_at }).catch(() => 0);
  return scan;
}

export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }): Promise<Metadata> {
  const { mint } = await params;
  return { title: `Coin scan ${shortWallet(mint)} — Karma`, description: "Who holds this coin, and what's their record?" };
}

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  if (!BASE58_ADDRESS.test(mint) && !EVM_ADDRESS.test(mint)) notFound();

  let got: Awaited<ReturnType<typeof getScan>>;
  try {
    got = await getScan(mint);
  } catch (e) {
    return (
      <Shell mint={mint} name={null} symbol={null} logo={null}>
        <div className="px-6 py-10 text-center">
          <p className="silk text-sm tracking-[0.14em] text-zinc-300">THE CHAIN WAS SLOW</p>
          <p className="mt-3 text-sm leading-relaxed text-zinc-500">
            the scan timed out before it finished. just refresh and try again — a cold scan can take
            up to 30 seconds.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-zinc-600">
            young project on the free tier, the dev is caffeinating to make this faster.
          </p>
          <p className="mt-4 font-mono text-[11px] text-zinc-700">{(e as Error).message}</p>
        </div>
      </Shell>
    );
  }

  if ("blocked" in got) {
    const a = got.blocked;
    return (
      <Shell mint={mint} name={null} symbol={null} logo={null}>
        <HoldToScan used={a.used} daily={a.daily} wallet={a.wallet} holdingUsd={a.holdingUsd} tiers={TIERS.map((t) => ({ ...t }))} />
      </Shell>
    );
  }
  const scan = got;

  // Ineligible: say why, never render a hollow scan.
  if (!scan.eligible || !scan.summary) {
    return (
      <Shell mint={mint} name={scan.name} symbol={scan.symbol} logo={scan.logo_url}>
        <div className="px-6 py-8">
          <p className="text-xl font-bold text-zinc-300">NOTHING TO READ YET</p>
          <ul className="mt-3 space-y-1.5 text-sm text-zinc-400">
            {scan.refusal_reasons.map((r) => (
              <li key={r}>· {r}</li>
            ))}
          </ul>
        </div>
      </Shell>
    );
  }

  // EVM coins get their own body: no free holder index off Solana, so it's the dev-and-market read.
  if (scan.chain === "evm" && scan.market) {
    return (
      <Shell mint={mint} name={scan.name} symbol={scan.symbol} logo={scan.logo_url}>
        <EvmScan scan={scan} market={scan.market} />
      </Shell>
    );
  }

  const s = scan.summary;
  // The one-glance verdict (shared with the quant features): one word, then at most three facts, worst first.
  const {
    verdict, kols, badKols, bundles, farm, dev, serialLauncher, devBag, clusters, ts, hs, clusterPct, connectedPct,
    crowdFake, en, snipersHold, insiders, hb, ecoRed, rewardRed, ecoAmber, ms, lpPull, ff, sib,
  } = solanaVerdict(scan, s);
  const chips: Chip[] = [];
  if (ts && ts.severity !== "clean" && ts.risks[0]) chips.push({ text: ts.risks[0], bad: ts.severity === "danger" });
  if (clusters.length) chips.push({ text: `${clusters.reduce((x, c) => x + c.member_count, 0)} wallets, one actor · ${clusterPct.toFixed(1)}%`, bad: true });
  if (lpPull) chips.push({ text: `liquidity pullable · ${Math.round(ms!.lp!.pullable_share! * 100)}%`, bad: true });
  if (ff && ff.severity !== "none") chips.push({ text: `last hour: ${ff.fresh_count} fresh wallets buying`, bad: ff.severity === "alert" });
  if (ecoRed || ecoAmber)
    chips.push({ text: `${hb!.ecosystem_only.length} top holders are launchpad insiders · ${hb!.ecosystem_only_pct.toFixed(1)}%`, bad: ecoRed });
  if (sib && sib.verdict !== "none") chips.push({ text: `${sib.core_wallets} wallets shared with other coins`, bad: sib.verdict === "cabal" });
  if (ms?.severity === "danger" && !lpPull) chips.push({ text: ms.signals.find((x) => x.severity === "danger")?.text ?? "market structure", bad: true });
  if (insiders)
    chips.push({
      text: snipersHold ? `snipers still hold ${en!.sniper_pct.toFixed(1)}%` : `insider-shaped supply · ${en!.cohort_pct.toFixed(1)}%`,
      bad: true,
    });
  if (bundles.size) chips.push({ text: `${bundles.size} sybil bundle${bundles.size > 1 ? "s" : ""} · ${s.pct_bundled.toFixed(1)}%`, bad: true });
  if (farm) chips.push({ text: "deployer farms its own holders", bad: true });
  if (serialLauncher) chips.push({ text: `dev: ${dev!.launches}${dev!.launches_capped ? "+" : ""} launched, 0 graduated`, bad: true });
  if (devBag) chips.push({ text: `dev holds ${dev!.holds_pct.toFixed(1)}%`, bad: true });
  if (badKols.length) chips.push({ text: `${badKols.length} graded larper${badKols.length > 1 ? "s" : ""} · ${s.pct_bad_kol.toFixed(1)}%`, bad: true });
  if (crowdFake) chips.push({ text: `crowd ~${Math.round(hs!.manufactured_pct * 100)}% manufactured`, bad: true });
  if (s.top10_pct > 60) chips.push({ text: `top 10 hold ${s.top10_pct.toFixed(0)}%`, bad: false });
  if (!chips.length) {
    if (s.pct_kol > 0) chips.push({ text: `known callers hold ${s.pct_kol.toFixed(1)}%`, bad: false });
    chips.push({ text: `${s.holder_count.toLocaleString()} holders · top 10 hold ${s.top10_pct.toFixed(0)}%`, bad: false });
  }

  const devValue = !dev ? "—" : dev.launches === null ? `${dev.holds_pct.toFixed(1)}%` : `${dev.launches}${dev.launches_capped ? "+" : ""}/${dev.graduated ?? 0}`;
  const devLabel = !dev ? "dev" : dev.launches === null ? "dev holds" : "dev launched / grad";

  return (
    <Shell mint={mint} name={scan.name} symbol={scan.symbol} logo={scan.logo_url}>
      <VerdictStrip verdict={verdict} chips={[...chips.filter((c) => c.bad), ...chips.filter((c) => !c.bad)].slice(0, 3)} provisional={scan.provisional} />

      {/* numbers before prose: the figures that answer "is this a trap". A figure we don't have is dropped, not dashed. */}
      <BigRow>
        {[
          <Big key="top" value={`${s.top10_pct.toFixed(0)}%`} label="top 10 hold" bad={s.top10_pct > 60} />,
          en ? <Big key="ins" value={`${en.cohort_pct.toFixed(1)}%`} label="insider-shaped" bad={insiders} /> : null,
          connectedPct > 0 || !en ? <Big key="con" value={`${connectedPct.toFixed(1)}%`} label="connected wallets" bad={connectedPct > 0} /> : null,
          dev ? <Big key="dev" value={devValue} label={devLabel} bad={serialLauncher || devBag} /> : null,
          hs && hs.sampled > 0 ? (
            <Big key="crowd" value={`${Math.round(hs.manufactured_pct * 100)}%`} sub={`±${Math.round(hs.band * 100)}`} label="crowd manufactured" bad={crowdFake} />
          ) : (
            <Big key="holders" value={s.holder_count.toLocaleString()} label="holders" />
          ),
        ]
          .filter(Boolean)
          .slice(0, 4)}
      </BigRow>

      {ts && ts.severity !== "clean" ? <TokenSafetyPanel ts={ts} /> : null}
      {clusters.length ? <ConnectedPanel clusters={clusters} /> : null}
      {en && en.cohort_count > 0 && en.cohort_pct >= 3 ? <EntryPanel en={en} bad={insiders} /> : null}
      <LensPanel
        rows={[
          ff && ff.severity !== "none" && ff.signal ? { k: "LAST HOUR", t: ff.signal, bad: ff.severity === "alert" } : null,
          hb?.signal && (hb.ecosystem_only.length || hb.reward_only.length) ? { k: "BEHAVIOUR", t: hb.signal, bad: ecoRed || rewardRed } : null,
          sib && sib.verdict !== "none" && sib.signals[0] ? { k: "SIBLING COINS", t: sib.signals[0], bad: sib.verdict === "cabal" } : null,
          ...(ms?.signals ?? []).map((x) => ({ k: "MARKET", t: x.text, bad: x.severity === "danger" })),
        ]}
      />

      {bundles.size ? (
        <Panel tone="bad" title="⚑ SYBIL BUNDLES" aside={`${bundles.size} · ${s.pct_bundled.toFixed(1)}% OF SUPPLY`}>
          <div className="flex flex-col gap-1.5">
            {[...bundles.entries()].map(([id, members]) => {
              const b = scan.bundles.find((x) => x.id === id);
              const reach = b?.fanout && b.fanout.distinct_recipients > 1 ? `${b.fanout.distinct_recipients}${b.fanout.total_txs > b.fanout.sampled_txs ? "+" : ""}` : null;
              return (
                <details key={id} className="group">
                  <summary className="cursor-pointer list-none text-sm text-zinc-100">
                    <span className="tnum font-bold">{members.length}</span> fresh wallets ·{" "}
                    <span className="tnum font-bold">{members.reduce((x, h) => x + h.pct_supply, 0).toFixed(1)}%</span>
                    {b?.uniform_funding ? " · scripted" : b?.funder_is_burner ? " · burner purse" : ""}
                    {reach ? <span className="text-zinc-500"> · purse seeded {reach}</span> : null}
                    <span className="ml-1 text-zinc-600 group-open:hidden">▸</span>
                  </summary>
                  {b?.tree ? (
                    <div className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-relaxed">
                      <p className="text-zinc-500">
                        origin{"  "}
                        {b.tree.root ? <SolLink addr={b.tree.root} /> : <span className="text-zinc-600">too deep to trace</span>}
                      </p>
                      <p className="text-zinc-300">
                        └─ purse{"  "}
                        <SolLink addr={b.tree.funder} className="text-red-400" />
                        {b.tree.funder_first_seen ? <span className="text-zinc-500">{`  · born ${ago(b.tree.funder_first_seen, scan.checked_at)} ago`}</span> : null}
                      </p>
                      <div className="pl-3">
                        {b.tree.members.map((m, i, arr) => (
                          <WalletTxs
                            key={m.wallet}
                            wallet={m.wallet}
                            label={shortWallet(m.wallet)}
                            branch={i === arr.length - 1 ? "└─" : "├─"}
                            meta={
                              `  · ${m.pct_supply.toFixed(1)}%` +
                              (m.funded_sol != null && m.funded_sol > 0 ? ` · seeded ${Math.round(m.funded_sol * 100) / 100} SOL` : "") +
                              (m.first_seen ? ` · born ${ago(m.first_seen, scan.checked_at)} ago` : "")
                            }
                          />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500">
                      {members.map((h) => (
                        <SolLink key={h.wallet} addr={h.wallet} suffix={` · ${h.pct_supply.toFixed(1)}%`} />
                      ))}
                    </div>
                  )}
                </details>
              );
            })}
          </div>
        </Panel>
      ) : null}

      {farm && scan.creator_fanout ? (
        <Panel tone="bad" title="⚑ DEPLOYER FARMS HOLDERS" aside={scan.creator ? shortWallet(scan.creator) : undefined}>
          <p className="text-sm text-zinc-100">
            seeded{" "}
            <span className="tnum font-bold text-red-400">
              {scan.creator_fanout.distinct_recipients}
              {scan.creator_fanout.total_txs > scan.creator_fanout.sampled_txs ? "+" : ""}
            </span>{" "}
            wallets
            <span className="text-zinc-500">
              {scan.creator_fanout.dispensed_sol > 0 ? ` · ${scan.creator_fanout.dispensed_sol} SOL out` : ""}
              {scan.creator_fanout.balance_sol !== null ? ` · ${scan.creator_fanout.balance_sol} SOL left` : ""}
            </span>
          </p>
        </Panel>
      ) : null}

      {dev ? <DevPanel dev={dev} serial={serialLauncher} bag={devBag} /> : null}
      {hs ? <CrowdPanel s={hs} /> : null}

      {kols.length ? (
        <Panel title="HOLDERS WITH RECEIPTS" aside={`${kols.length} IN TOP ${s.top_n}`}>
          <div className="flex flex-col gap-2">
            {kols.map((h) => (
              <HolderRow key={h.wallet} h={h} />
            ))}
          </div>
        </Panel>
      ) : null}

      <WhyDetails readout={s.readout} signals={s.signals ?? s.verdict.replace(/\.$/, "").split(" · ")}>
        <div className="grid grid-cols-3 gap-px border border-white/15 bg-white/15 sm:grid-cols-5">
          <Cell label="Known callers" value={`${s.pct_kol.toFixed(1)}%`} />
          <Cell label="Graded larpers" value={`${s.pct_bad_kol.toFixed(1)}%`} danger={s.pct_bad_kol > 0} />
          <Cell label="Fresh wallets" value={`${s.pct_fresh.toFixed(1)}%`} danger={s.pct_fresh > 10} />
          <Cell label="Bundled" value={`${s.pct_bundled.toFixed(1)}%`} danger={s.pct_bundled > 0} />
          <Cell label="No receipts" value={`${s.pct_unknown.toFixed(1)}%`} />
        </div>
        <p className="text-xs text-zinc-500">
          top holder {s.top1_pct.toFixed(1)}% · top 5 {s.top5_pct.toFixed(1)}% · top 10 {s.top10_pct.toFixed(1)}% · {s.holder_count.toLocaleString()} holders ·
          LP, lockers and vesting ({s.pct_infra_excluded.toFixed(1)}%) excluded
          {kols.length ? "" : ` · nobody in the top ${s.top_n} is a scored caller`}
        </p>
      </WhyDetails>

      {/* Jev's chart read (levels, pattern, crowd), SHADOW until graded; embed + indicators only once candles mean something */}
      <ChartReadPanel mint={mint} chartNetwork={scan.chart_ref && scan.age_seconds !== null && scan.age_seconds >= CHART_MIN_AGE_S ? scan.chart_ref.network : null} />

      <Footer at={scan.checked_at} />
    </Shell>
  );
}

type Chip = { text: string; bad: boolean };

/**
 * The answer in two seconds: one stamped word, then up to three facts. Colour IS the verdict and
 * nothing else — red stamp for danger/coordinated, yellow stamp for caution, bare ink when clean —
 * and text always sits on a ground it contrasts with (paper on red, ink on yellow). No tinted washes.
 */
function VerdictStrip({ verdict, chips, provisional }: { verdict: Verdict; chips: Chip[]; provisional: boolean }) {
  const stamp =
    verdict === "danger" || verdict === "coordinated"
      ? "bg-red-500 text-black"
      : verdict === "caution"
        ? "bg-amber-500 text-foreground"
        : "bg-background text-foreground";
  const word = verdict === "clean" ? "NO RED FLAGS" : verdict.toUpperCase();
  return (
    <div className="px-6 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`silk border-2 border-foreground px-3 py-1.5 text-[15px] tracking-[0.08em] ${stamp}`}>{word}</span>
        {provisional ? <span className="silk border border-zinc-600 px-1.5 py-0.5 text-[9px] tracking-[0.1em] text-zinc-500">UNDER 1H · PROVISIONAL</span> : null}
      </div>
      <ul className="mt-3 flex flex-wrap gap-1.5">
        {chips.map((c, i) => (
          <li key={i} className={`border px-2 py-1 text-[13px] leading-tight ${c.bad ? "border-red-500 text-red-400" : "border-white/25 text-zinc-300"}`}>
            {c.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A headline figure: big numeral, tiny label. Red only when the number itself is the warning. */
function Big({ value, label, bad, sub }: { value: string; label: string; bad?: boolean; sub?: string }) {
  return (
    <div className="bg-background px-3 py-3.5 text-center">
      <div className={`tnum text-2xl font-bold leading-none ${bad ? "text-red-400" : "text-zinc-100"}`}>
        {value}
        {sub ? <span className="ml-0.5 text-xs font-normal text-zinc-500">{sub}</span> : null}
      </div>
      <div className="mt-1.5 text-[10px] uppercase leading-tight tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

/** The headline-figure row: columns follow however many figures we actually have (3 or 4). */
function BigRow({ children }: { children: React.ReactNode }) {
  const n = Children.toArray(children).length;
  return <div className={`grid ${n === 3 ? "" : "grid-cols-2"} gap-px border-y-2 border-foreground bg-white/15 ${n === 3 ? "grid-cols-3" : "sm:grid-cols-4"}`}>{children}</div>;
}

/** Section shell. Neutral by default; a warning adds one coloured rule on the left, never a wash under text. */
function Panel({ title, aside, tone, children }: { title: string; aside?: string; tone?: "bad" | "warn"; children: React.ReactNode }) {
  const rule = tone === "bad" ? "border-l-4 border-l-red-500" : tone === "warn" ? "border-l-4 border-l-amber-500" : "";
  const head = tone === "bad" ? "text-red-400" : tone === "warn" ? "text-amber-400" : "text-zinc-500";
  return (
    <div className={`border-b border-white/15 px-6 py-3.5 ${rule}`}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className={`silk text-[10px] tracking-[0.1em] ${head}`}>{title}</p>
        {aside ? <span className="silk text-right text-[9px] tracking-[0.08em] text-zinc-500">{aside}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The long read — THE READ lines, every signal, the composition — kept, but one tap away. */
function WhyDetails({ readout, signals, children }: { readout?: string[]; signals: string[]; children?: React.ReactNode }) {
  return (
    <details className="group border-t-2 border-foreground px-6 py-3.5">
      <summary className="silk cursor-pointer list-none text-[10px] tracking-[0.1em] text-zinc-500 hover:text-zinc-100">
        <span className="group-open:hidden">▸</span>
        <span className="hidden group-open:inline">▾</span> WHY · FULL BREAKDOWN
      </summary>
      <div className="mt-3 flex flex-col gap-3 text-sm">
        {readout?.length ? (
          <div className="flex flex-col gap-1">
            {readout.map((line, i) => (
              <p key={i} className={`leading-snug ${i === 0 ? "font-semibold text-zinc-100" : "text-zinc-400"}`}>{line}</p>
            ))}
          </div>
        ) : null}
        <ul className="flex flex-col gap-1 text-[13px] text-zinc-300">
          {signals.map((sig, i) => (
            <li key={i} className="flex gap-2">
              <span className="shrink-0 text-zinc-600">·</span>
              <span>{sig}.</span>
            </li>
          ))}
        </ul>
        {children}
      </div>
    </details>
  );
}

function Footer({ at, note }: { at: number; note?: string }) {
  return (
    <p className="border-t border-white/10 px-6 py-3 text-[11px] text-zinc-600">
      {note ? `${note} · ` : ""}not financial advice · {new Date(at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC
    </p>
  );
}

function SolLink({ addr, className, suffix }: { addr: string; className?: string; suffix?: string }) {
  return (
    <a href={`https://solscan.io/account/${addr}`} target="_blank" rel="noopener noreferrer" className={`font-mono ${className ?? ""}`}>
      {shortWallet(addr)}
      {suffix ?? ""}
    </a>
  );
}

function HolderRow({ h }: { h: CoinHolder }) {
  const gs = h.grade ? GRADE_STYLE[h.grade] : null;
  return (
    <Link
      href={`/w/${h.wallet}`}
      className="group flex items-center gap-3 border-2 border-foreground bg-white/[0.02] px-3.5 py-2.5 transition-colors hover:bg-foreground hover:text-background"
    >
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center text-sm font-bold ring-1 ${
          gs ? `${gs.text} ${gs.bg} ${gs.ring}` : "text-zinc-500 bg-white/5 ring-white/10"
        }`}
      >
        {h.grade ?? "?"}
      </span>
      <div className="min-w-0 flex-1">
        <span className="truncate text-sm font-medium">{h.handle ? `@${h.handle}` : shortWallet(h.wallet)}</span>
        {h.title ? <span className="ml-2 text-xs text-zinc-500">{h.title}</span> : null}
      </div>
      <span className="shrink-0 text-sm tnum text-zinc-300">{h.pct_supply.toFixed(1)}%</span>
    </Link>
  );
}

/** RugCheck-style token-safety warning: program hazard / authority / Token-2022 extension. */
function TokenSafetyPanel({ ts }: { ts: TokenSafety }) {
  const danger = ts.severity === "danger";
  return (
    <Panel
      tone={danger ? "bad" : "warn"}
      title={danger ? "⚑ TOKEN RISK" : "TOKEN CAUTION"}
      aside={ts.program === "token2022" ? "TOKEN-2022" : ts.program === "spl" ? "SPL TOKEN" : "UNKNOWN PROGRAM"}
    >
      <ul className="flex flex-col gap-0.5">
        {ts.risks.map((r, i) => (
          <li key={i} className="text-sm leading-snug text-zinc-100">
            {r}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** CONNECTED WALLETS: holders sharing one funding purse — one actor wearing many faces. The bubble map. */
function ConnectedPanel({ clusters }: { clusters: HolderCluster[] }) {
  const totalPct = clusters.reduce((s, c) => s + c.pct_total, 0);
  return (
    <Panel tone="bad" title="⚑ CONNECTED WALLETS" aside={`${clusters.length} CLUSTER${clusters.length > 1 ? "S" : ""} · ${totalPct.toFixed(1)}%`}>
      <div className="flex flex-col gap-1.5">
        {clusters.slice(0, 4).map((c) => (
          <details key={c.funder} className="group">
            <summary className="cursor-pointer list-none text-sm text-zinc-100">
              <span className="tnum font-bold">{c.member_count}</span> wallets · <span className="tnum font-bold">{c.pct_total.toFixed(1)}%</span>
              <span className="text-zinc-500">
                {" "}
                · purse <span className="font-mono">{shortWallet(c.funder)}</span>
                {c.funder_balance_sol != null ? ` · ${Math.round(c.funder_balance_sol).toLocaleString()} SOL` : ""}
              </span>
              <span className="ml-1 text-zinc-600 group-open:hidden">▸</span>
            </summary>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 pl-2 text-[11px] text-zinc-500">
              <SolLink addr={c.funder} className="text-red-400" suffix=" (purse)" />
              {c.members.slice(0, 8).map((w) => (
                <SolLink key={w} addr={w} />
              ))}
            </div>
          </details>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">look independent, funded by one purse. aged wallets included.</p>
    </Panel>
  );
}

/** The behaviour/market lenses: one line each, only when they have something to say. */
function LensPanel({ rows }: { rows: ({ k: string; t: string; bad: boolean } | null)[] }) {
  const live = rows.filter((r): r is { k: string; t: string; bad: boolean } => !!r);
  if (!live.length) return null;
  const bad = live.some((r) => r.bad);
  return (
    <Panel tone={bad ? "bad" : "warn"} title={bad ? "⚑ HOW THEY TRADE IT" : "HOW THEY TRADE IT"}>
      <div className="flex flex-col gap-1.5 text-sm text-zinc-100">
        {live.map((r, i) => (
          <p key={i}>
            <span className={`silk mr-2 text-[9px] tracking-[0.1em] ${r.bad ? "text-red-400" : "text-amber-400"}`}>{r.k}</span>
            {r.t}
          </p>
        ))}
      </div>
    </Panel>
  );
}

/** How the insider-shaped wallets got in: one line each, worst first. */
function EntryPanel({ en, bad }: { en: EntryRead; bad: boolean }) {
  const sniperS = SCORING.coin.entrySniperSeconds;
  const routedFrom = new Map(en.routers.flatMap((r) => r.members.map((m) => [m, r.from] as const)));
  const rows = en.entries
    .filter((e) => (e.after_launch_s !== null && e.after_launch_s <= sniperS) || e.fresh_at_entry || routedFrom.has(e.wallet))
    .sort((a, b) => b.pct_supply - a.pct_supply)
    .slice(0, 8);
  const when = (sec: number | null) => (sec === null ? null : sec < 3600 ? `${Math.max(1, Math.round(sec / 60))}m` : sec < 86400 ? `${Math.round(sec / 3600)}h` : `${Math.round(sec / 86400)}d`);
  return (
    <Panel tone={bad ? "bad" : "warn"} title={bad ? "⚑ INSIDER-SHAPED SUPPLY" : "INSIDER-SHAPED SUPPLY"} aside={`${en.cohort_count} OF TOP ${en.entries.length} · ${en.cohort_pct.toFixed(1)}%`}>
      <div className="flex flex-col gap-1 text-sm text-zinc-100">
        {rows.map((e) => {
          const tags: string[] = [];
          if (e.after_launch_s !== null && e.after_launch_s <= sniperS) tags.push(`sniped ${when(e.after_launch_s)} after launch`);
          else if (e.after_launch_s !== null) tags.push(`in ${when(e.after_launch_s)} after launch`);
          if (e.fresh_at_entry) tags.push("wallet born to buy");
          const from = routedFrom.get(e.wallet);
          return (
            <p key={e.wallet}>
              <span className="tnum font-bold">{e.pct_supply.toFixed(1)}%</span> <SolLink addr={e.wallet} className="text-zinc-400" />
              <span className="text-zinc-500">
                {" "}
                · {tags.join(" · ")}
                {from ? (
                  <>
                    {tags.length ? " · " : ""}moved in from <SolLink addr={from} className="text-red-400" />
                  </>
                ) : null}
              </span>
            </p>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-zinc-500">no shared funder needed: exchange-funded insiders still show when and how they got in.</p>
    </Panel>
  );
}

function DevPanel({ dev, serial, bag, explorer }: { dev: DevProfile; serial: boolean; bag: boolean; explorer?: string }) {
  const farm = !!dev.fanout && dev.fanout.distinct_recipients >= SCORING.coin.farmRecipients;
  const red = serial || bag || farm;
  const evm = dev.native_symbol != null; // EVM devs carry a native-balance symbol; Solana devs don't.
  const age = dev.age_days === null ? (evm ? null : "aged wallet") : dev.age_days < 1 ? "new today" : `${Math.round(dev.age_days)}d old`;
  const verdict = serial
    ? "SERIAL LAUNCHER"
    : dev.launches !== null && dev.launches > 1 && (dev.graduated ?? 0) > 0
      ? "HAS SHIPPED"
      : dev.launches !== null && dev.launches <= 1
        ? "FIRST COIN"
        : undefined;
  const facts: { v: string; l: string; bad?: boolean }[] = [];
  if (!evm && dev.launches !== null && dev.launches > 1) {
    facts.push({ v: `${dev.launches}${dev.launches_capped ? "+" : ""}`, l: "launched" });
    facts.push({ v: `${dev.graduated ?? 0}`, l: "graduated", bad: serial });
    facts.push({ v: `${dev.alive ?? 0}`, l: "alive" });
  }
  facts.push({ v: `${dev.holds_pct.toFixed(1)}%`, l: "holds", bad: bag });
  if (evm && dev.tx_count != null) facts.push({ v: dev.tx_count.toLocaleString(), l: "txns" });
  if (evm && dev.native_balance != null) facts.push({ v: dev.native_balance.toFixed(2), l: dev.native_symbol ?? "" });
  return (
    <Panel tone={red ? "bad" : undefined} title="THE DEV" aside={verdict}>
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs text-zinc-500">
        {facts.map((f) => (
          <span key={f.l}>
            <span className={`tnum text-base font-bold ${f.bad ? "text-red-400" : "text-zinc-100"}`}>{f.v}</span> {f.l}
          </span>
        ))}
        {age ? <span>{age}</span> : null}
        <a href={explorer ? `${explorer}/address/${dev.wallet}` : `https://solscan.io/account/${dev.wallet}`} target="_blank" rel="noopener noreferrer" className="font-mono">
          {shortWallet(dev.wallet)}
        </a>
      </div>
    </Panel>
  );
}

/** THE CROWD: the sampled organic-vs-manufactured read — a composition bar with its numbers, receipts one tap away. */
function CrowdPanel({ s }: { s: HolderSample }) {
  const red = s.manufactured_pct >= 0.55;
  const label = (v: HolderSample["members"][number]["verdict"]) =>
    v === "known" ? "known caller" : v === "real" ? "real trader" : v === "farmed" ? "farmed" : "fresh / thin";
  const color = (v: HolderSample["members"][number]["verdict"]) =>
    v === "known" ? "text-green-400" : v === "real" ? "text-zinc-300" : v === "farmed" ? "text-red-400" : "text-amber-400";

  return (
    <Panel tone={red ? "bad" : undefined} title="THE CROWD" aside={`${s.sampled} OF ${s.population} SAMPLED`}>
      {/* the numbers under the bar are its legend, so the colours never carry meaning alone */}
      <div className="flex h-2.5 w-full overflow-hidden border border-foreground bg-background">
        {s.farmed > 0 ? <div className="bg-red-500" style={{ width: `${(s.farmed / s.sampled) * 100}%` }} /> : null}
        {s.fresh > 0 ? <div className="bg-amber-500" style={{ width: `${(s.fresh / s.sampled) * 100}%` }} /> : null}
        {s.real > 0 ? <div className="bg-zinc-600" style={{ width: `${(s.real / s.sampled) * 100}%` }} /> : null}
        {s.known > 0 ? <div className="bg-green-500" style={{ width: `${(s.known / s.sampled) * 100}%` }} /> : null}
      </div>
      <p className="mt-1.5 text-xs text-zinc-500">
        <span className={`tnum font-bold ${red ? "text-red-400" : "text-zinc-100"}`}>{s.fresh + s.farmed}</span> fresh / farmed ·{" "}
        <span className="tnum font-bold text-zinc-100">{s.real + s.known}</span> real / known
        {s.shared_funders ? ` · ${s.shared_funders} shared purse${s.shared_funders > 1 ? "s" : ""}` : ""}
      </p>
      <details className="group mt-1.5">
        <summary className="cursor-pointer list-none text-[11px] text-zinc-500 hover:text-zinc-100">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span> sampled wallets
        </summary>
        <div className="mt-1.5 flex flex-col gap-1 overflow-x-auto font-mono text-[11px] leading-relaxed">
          {s.members.map((m) => (
            <a key={m.wallet} href={`/w/${m.wallet}`} className="flex items-center gap-2 text-zinc-400">
              <span className="w-10 shrink-0 text-zinc-600">{m.stratum}</span>
              <span className="w-24 shrink-0 truncate">{m.handle ? `@${m.handle}` : shortWallet(m.wallet)}</span>
              <span className="w-28 shrink-0 tabular-nums text-zinc-500">
                {m.tx_count}
                {m.tx_capped ? "+" : ""} tx · {m.age_days === null ? "aged" : m.age_days < 1 ? "today" : `${Math.round(m.age_days)}d`}
              </span>
              <span className={`shrink-0 ${color(m.verdict)}`}>{label(m.verdict)}</span>
            </a>
          ))}
        </div>
      </details>
    </Panel>
  );
}

/** Compact USD with a $ sign; "—" for null. */
function usd(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

/** The EVM body: dev-and-market read, honest that the holder book isn't indexed off Solana. */
function EvmScan({ scan, market }: { scan: CoinScan; market: EvmMarket }) {
  const s = scan.summary!;
  const source = market.source ?? "pump.fun";
  const fromPump = source === "pump.fun";
  const { verdict, dev, bag, flagged, dd, thin, roundTrip } = evmVerdict(scan, s, market);
  const chips: Chip[] = [];
  if (flagged) chips.push({ text: `pump security: ${market.security_verdict}`, bad: true });
  if (bag) chips.push({ text: `dev holds ${dev!.holds_pct.toFixed(1)}%`, bad: true });
  if (roundTrip) chips.push({ text: `down ${Math.round(dd! * 100)}% from ATH`, bad: true });
  if (thin) chips.push({ text: `liquidity ${usd(market.liquidity_usd)}`, bad: true });
  if (s.holder_count > 0) chips.push({ text: `top 10 hold ${s.top10_pct.toFixed(0)}%`, bad: s.top10_pct > 70 });
  chips.push({ text: `${market.chain_label} · ${(market.protocol ?? "AMM").replace(/_/g, " ")}`, bad: false });

  return (
    <>
      <VerdictStrip verdict={verdict} chips={chips.slice(0, 3)} provisional={scan.provisional} />

      {/* market row */}
      <div className="grid grid-cols-2 gap-px border-y-2 border-foreground bg-white/15 sm:grid-cols-4">
        <Big label="Market cap" value={usd(market.mcap_usd)} />
        <Big label="ATH mcap" value={usd(market.ath_mcap_usd)} />
        <Big label="Down from ATH" value={dd != null ? `${Math.round(dd * 100)}%` : "—"} bad={roundTrip} />
        <Big label="Liquidity" value={usd(market.liquidity_usd)} bad={thin} />
      </div>

      {/* pump's own security verdict + the outbound links */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/10 bg-white/[0.015] px-6 py-3 text-xs">
        {fromPump ? (
          <>
            <span className="silk text-[10px] tracking-[0.1em] text-zinc-500">PUMP SECURITY</span>
            <span className={flagged ? "font-semibold text-red-400" : "font-semibold text-zinc-200"}>
              {market.security_verdict ?? "unknown"}
              {market.security_reason ? ` · ${market.security_reason}` : ""}
            </span>
          </>
        ) : (
          <>
            <span className="silk text-[10px] tracking-[0.1em] text-zinc-500">READ FROM</span>
            <span className="font-semibold text-zinc-200">{source === "onchain" ? "the chain only · no DEX pool" : `${source} · not a pump.fun coin`}</span>
          </>
        )}
        <a href={market.chart_url ?? market.explorer_url} target="_blank" rel="noopener noreferrer" className="ml-auto text-zinc-500 hover:text-zinc-300">
          chart ↗
        </a>
        <a href={market.explorer_url} target="_blank" rel="noopener noreferrer" className="text-zinc-500 hover:text-zinc-300">
          explorer ↗
        </a>
      </div>

      {/* concentration, reconstructed from Transfer logs + Multicall3 — real now, not "not indexed yet" */}
      {s.holder_count > 0 ? (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-b border-white/10 bg-white/[0.015] px-6 py-3 text-xs">
          <span className="silk text-[10px] tracking-[0.1em] text-zinc-500">CONCENTRATION</span>
          <span className="text-zinc-400">
            top holder <span className={`tnum font-semibold ${s.top1_pct > 15 ? "text-red-400" : "text-zinc-100"}`}>{s.top1_pct.toFixed(1)}%</span>
          </span>
          <span className="text-zinc-400">
            top 5 <span className={`tnum font-semibold ${s.top5_pct > 40 ? "text-red-400" : "text-zinc-100"}`}>{s.top5_pct.toFixed(1)}%</span>
          </span>
          <span className="text-zinc-400">
            top 10 <span className={`tnum font-semibold ${s.top10_pct > 60 ? "text-red-400" : "text-zinc-100"}`}>{s.top10_pct.toFixed(1)}%</span>
          </span>
          <span className="text-zinc-400">
            <span className="tnum font-semibold text-zinc-100">{s.holder_count.toLocaleString()}{scan.evm_holder_book?.partial ? "+" : ""}</span> holders
          </span>
        </div>
      ) : null}

      {dev ? <DevPanel dev={dev} serial={false} bag={bag} explorer={market.explorer_base} /> : null}

      <WhyDetails readout={s.readout} signals={s.signals} />

      {/* chart read — only on coins old enough for candles to mean anything (the read itself is Solana-only for now) */}
      {scan.chart_ref && scan.age_seconds !== null && scan.age_seconds >= CHART_MIN_AGE_S ? (
        <ChartReadPanel mint={scan.mint} chartNetwork={scan.chart_ref.network} />
      ) : null}

      <Footer at={scan.checked_at} note={`${market.chain_label} · ${source}`} />
    </>
  );
}

function Cell({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="bg-background px-3 py-3 text-center">
      <div className={`text-lg font-bold tnum ${danger ? "text-red-400" : "text-zinc-100"}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide leading-tight text-zinc-500">{label}</div>
    </div>
  );
}

/** THE TIDE: the macro backdrop under any coin — risk-on/off from BTC/SOL/ETH, context not a call. */
function MarketTide({ regime }: { regime: MarketRegime }) {
  // One quiet line of context: it's the backdrop, not the verdict, so it never competes with the card.
  const riskColor = regime.risk === "risk-on" ? "text-green-400" : regime.risk === "risk-off" ? "text-red-400" : "text-zinc-300";
  const arrow = (t: string | null) => (t === "up" ? "▲" : t === "down" ? "▼" : "→");
  const chgColor = (x: number | null) => (x == null ? "text-zinc-500" : x >= 0 ? "text-green-400" : "text-red-400");
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-white/15 pb-2" title={regime.note}>
      <span className="silk text-[10px] tracking-[0.1em] text-zinc-500">TIDE</span>
      <span className={`silk text-[10px] tracking-[0.1em] ${riskColor}`}>{regime.risk.toUpperCase()}</span>
      <div className="ml-auto flex items-center gap-3 text-xs tnum">
        {regime.assets.map((a) => (
          <span key={a.symbol} className="text-zinc-400">
            {a.symbol} <span className={chgColor(a.chg_24h)}>{arrow(a.trend)}{a.chg_24h != null ? ` ${a.chg_24h >= 0 ? "+" : ""}${(a.chg_24h * 100).toFixed(1)}%` : ""}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

async function Shell({ mint, name, symbol, logo, children }: { mint: string; name: string | null; symbol: string | null; logo?: string | null; children: React.ReactNode }) {
  const isEvm = mint.startsWith("0x");
  // The market tide, fetched once and cached 10 min — cheap context on every scan, both chains.
  const regime = await fetchMarketRegime(serverCache, Math.floor(Date.now() / 1000)).catch(() => null);
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-5 py-10">
      <div className="mb-3 flex items-center justify-between text-sm">
        <div className="flex items-center gap-3">
          <Avatar src={logo ?? null} alt={symbol ? `$${symbol}` : "coin"} size={44} />
          <span className="text-lg font-semibold">{symbol ? `$${symbol}` : "Coin scan"}</span>
          {name ? <span className="text-xs text-zinc-500">{name}</span> : null}
        </div>
        <a
          href={isEvm ? `https://bscscan.com/token/${mint}` : `https://solscan.io/token/${mint}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-zinc-500 hover:text-zinc-300"
        >
          {shortWallet(mint)}
        </a>
      </div>
      {regime ? <MarketTide regime={regime} /> : null}
      <div className="overflow-hidden border-2 border-foreground bg-white/[0.02]">{children}</div>
      <p className="mt-4 text-center text-xs text-zinc-600">
        who is holding, and what they did to the last room ·{" "}
        <Link href="/methodology" className="underline hover:text-zinc-400">
          methodology
        </Link>
      </p>
    </main>
  );
}
