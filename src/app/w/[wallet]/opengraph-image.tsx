import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { getWalletReport, identityFor, shortWalletOG } from "@/lib/karma/data";
import { GRADE_TITLES } from "@/lib/karma/scoring.config";

/**
 * Face chain for the share card, resolved server-side to a data URI so Satori never renders a
 * broken image: local pixel avatar → X pfp via unavatar (2.5s budget) → the frog. A wallet
 * with receipts but no social gets pepe on the card that goes viral — that is the bit.
 */
async function loadAvatar(wallet: string, handle: string | null): Promise<string> {
  try {
    const local = await readFile(path.join(process.cwd(), "public", "avatars", `${wallet}.png`));
    return `data:image/png;base64,${local.toString("base64")}`;
  } catch {}
  if (handle) {
    try {
      const res = await fetch(`https://unavatar.io/x/${encodeURIComponent(handle)}`, {
        signal: AbortSignal.timeout(2500),
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const type = res.headers.get("content-type") ?? "image/png";
        return `data:${type};base64,${buf.toString("base64")}`;
      }
    } catch {}
  }
  const pepe = await readFile(path.join(process.cwd(), "public", "pepe.jpg"));
  return `data:image/jpeg;base64,${pepe.toString("base64")}`;
}

/**
 * The share card. This is the product's entire distribution mechanic: the thing that unfurls
 * in a quote-tweet has to carry the verdict, the receipts and the honesty in one glance,
 * because almost nobody clicks through.
 *
 * Design rules it follows:
 *   - the GRADE is the image; everything else is supporting evidence
 *   - rates are shown against the market, never absolute — "0.43×" is a claim about the caller,
 *     "19% rug rate" is a claim about memecoins
 *   - the confidence band is on the card. A screenshot that hides its own uncertainty is the
 *     thing every competitor ships, and it is what makes their numbers unquotable.
 */

export const alt = "Karma card";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GRADE_COLOR: Record<string, { fg: string; bg: string }> = {
  S: { fg: "#34d399", bg: "rgba(16,185,129,0.14)" },
  A: { fg: "#4ade80", bg: "rgba(34,197,94,0.14)" },
  B: { fg: "#a3e635", bg: "rgba(132,204,22,0.14)" },
  C: { fg: "#fbbf24", bg: "rgba(245,158,11,0.14)" },
  D: { fg: "#fb923c", bg: "rgba(249,115,22,0.14)" },
  F: { fg: "#f87171", bg: "rgba(239,68,68,0.14)" },
};

/** Below 1× is better than the market, above is worse. */
const multColor = (x: number) => (x <= 0.6 ? "#34d399" : x <= 0.9 ? "#a3e635" : x < 1.15 ? "#d4d4d8" : x < 1.5 ? "#fb923c" : "#f87171");

export default async function Image({ params }: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await params;
  const report = getWalletReport(wallet);
  const identity = identityFor(wallet);
  const handle = report?.handle ?? identity?.handle ?? null;
  const who = handle ? `@${handle}` : shortWalletOG(wallet);
  const t = report?.trust;

  // No record: say so on the card rather than rendering a misleading blank grade.
  if (!t) {
    const avatar = await loadAvatar(wallet, handle);
    return new ImageResponse(
      (
        <div style={{ display: "flex", ...shell, justifyContent: "center", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatar} width={140} height={140} style={{ border: "4px solid #3f3f46", objectFit: "cover" }} alt="" />
          <div style={{ display: "flex", fontSize: 72, fontWeight: 800, color: "#a1a1aa", marginTop: 18 }}>{who}</div>
          <div style={{ display: "flex", fontSize: 34, color: "#71717a", marginTop: 16 }}>No public calls. Nothing to grade.</div>
          <div style={{ display: "flex", fontSize: 26, color: "#52525b", marginTop: 40 }}>karma · receipts, not vibes</div>
        </div>
      ),
      size,
    );
  }

  const c = GRADE_COLOR[t.grade] ?? GRADE_COLOR.C;
  const avatar = await loadAvatar(wallet, handle);

  return new ImageResponse(
    (
      <div style={shell}>
        {/* top: grade + who */}
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 196,
              height: 196,
              borderRadius: 34,
              background: c.bg,
              border: `5px solid ${c.fg}55`,
              color: c.fg,
              fontSize: 128,
              fontWeight: 900,
            }}
          >
            {t.grade}
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatar} width={120} height={120} style={{ border: `4px solid ${c.fg}55`, objectFit: "cover" }} alt="" />
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ display: "flex", fontSize: 48, fontWeight: 800, color: "#fafafa" }}>{who}</div>
            <div style={{ display: "flex", fontSize: 38, fontWeight: 800, color: c.fg, marginTop: 4 }}>{GRADE_TITLES[t.grade]}</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 10 }}>
              <div style={{ display: "flex", fontSize: 58, fontWeight: 900, color: c.fg }}>{t.karma}</div>
              <div style={{ display: "flex", fontSize: 30, color: "#71717a" }}>/100</div>
              {/* The uncertainty travels with the number, always.
                  Satori treats interleaved text and expressions as multiple child nodes and
                  demands an explicit display on the parent — so every text node here is a
                  single interpolated string, not a mix. */}
              <div style={{ display: "flex", fontSize: 26, color: "#71717a" }}>
                {`95% band ${t.karma_low}–${t.karma_high} · ${t.n} calls`}
              </div>
            </div>
          </div>
        </div>

        {/* the two axes that actually move the grade */}
        <div style={{ display: "flex", gap: 16, marginTop: 28 }}>
          <Metric
            label="DUMPS ON YOU"
            value={`${t.dump_vs_market.toFixed(2)}×`}
            sub={`${Math.round(t.dump_rate_observed * t.n)} of ${t.n} calls · vs trench avg`}
            color={multColor(t.dump_vs_market)}
          />
          <Metric
            label="CALLS THAT RUG"
            value={`${t.rug_vs_market.toFixed(2)}×`}
            sub={`${Math.round(t.rug_rate_observed * t.n)} of ${t.n} calls · vs trench avg`}
            color={multColor(t.rug_vs_market)}
          />
          <Metric
            label="2× RATE (NEVER SCORED)"
            value={`${Math.round(t.opportunity.two_x_rate * 100)}%`}
            sub={`reliability ${t.opportunity.reliability.toFixed(2)} · alpha doesn't persist`}
            color="#71717a"
          />
        </div>

        {/* footer: the verdict in words, and the source of truth */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 10 }}>
          <div style={{ display: "flex", fontSize: 27, color: "#d4d4d8", lineHeight: 1.3 }}>{t.verdict}</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", fontSize: 22, color: "#52525b" }}>
              karma · receipts, not vibes · 5,667 calls across 3,890 coins
            </div>
            <div style={{ display: "flex", fontSize: 22, color: "#3f3f46" }}>1.00× = the trench average</div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}

const shell: React.CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  background: "#09090b",
  padding: "44px 56px",
  fontFamily: "sans-serif",
};

function Metric({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        padding: "16px 22px",
        borderRadius: 22,
        background: "rgba(255,255,255,0.035)",
        border: "1px solid rgba(255,255,255,0.09)",
      }}
    >
      <div style={{ display: "flex", fontSize: 18, letterSpacing: 1.3, color: "#71717a" }}>{label}</div>
      <div style={{ display: "flex", fontSize: 50, fontWeight: 900, color, marginTop: 4 }}>{value}</div>
      <div style={{ display: "flex", fontSize: 18, color: "#52525b", marginTop: 3 }}>{sub}</div>
    </div>
  );
}
