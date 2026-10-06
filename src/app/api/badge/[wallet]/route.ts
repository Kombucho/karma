import { BASE58_ADDRESS, getWalletReport, resolveHandle } from "@/lib/karma/data";

/**
 * Embeddable SVG badge. `GET /api/badge/<wallet-or-@handle>?style=flat`
 *
 * The strategic point of this file: a website competes with kolscan and GMGN on traffic, and
 * loses — they have real-time data and a brand. A badge doesn't compete, it distributes. Any
 * terminal, portfolio tracker, Telegram bot preview or launchpad can render one for free, and
 * every place it renders is a place Karma's verdict travels without Karma owning the surface.
 * Ratings agencies win by being cited, not by being visited.
 *
 * It is deliberately the *most conservative* version of the score: grade + number, no cherry-
 * picked stat, and it links back to the full card where the band and the limits live. A badge
 * that overclaims is worse than no badge, because it is the version that spreads.
 *
 * Self-contained SVG with no external fonts, so it renders in <img> tags and README files.
 */

const COLOR: Record<string, string> = {
  S: "#10b981",
  A: "#22c55e",
  B: "#84cc16",
  C: "#f59e0b",
  D: "#f97316",
  F: "#ef4444",
};

/** Approximate width of the Verdana/DejaVu fallback at 11px, good enough for badge geometry. */
const textWidth = (s: string) => s.length * 6.2 + 12;

function svg(label: string, value: string, color: string): string {
  const lw = textWidth(label);
  const vw = textWidth(value);
  const w = lw + vw;
  // Text is drawn twice — once in near-black at +1px for the shadow, once in white — which is
  // the shields.io trick for staying legible on any background without an external font.
  const t = (x: number, s: string, fill: string, dy = 0) =>
    `<text x="${x * 10}" y="${(14 + dy) * 10}" fill="${fill}" font-family="Verdana,DejaVu Sans,sans-serif" font-size="110" transform="scale(.1)" textLength="${(textWidth(s) - 12) * 10}">${s}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${lw}" height="20" fill="#18181b"/>
    <rect x="${lw}" width="${vw}" height="20" fill="${color}"/>
    <rect width="${w}" height="20" fill="url(#s)"/>
  </g>
  <g text-anchor="start">
    ${t(lw / 2 - (lw - 12) / 2, label, "#010101", 1)}${t(lw / 2 - (lw - 12) / 2, label, "#fff")}
    ${t(lw + vw / 2 - (vw - 12) / 2, value, "#010101", 1)}${t(lw + vw / 2 - (vw - 12) / 2, value, "#fff")}
  </g>
</svg>`;
}

const headers = (immutable: boolean) => ({
  "content-type": "image/svg+xml; charset=utf-8",
  // Badges get hammered by image proxies; cache hard, revalidate in the background.
  "cache-control": immutable ? "public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400" : "public, max-age=300",
});

export async function GET(_req: Request, { params }: { params: Promise<{ wallet: string }> }) {
  const { wallet: raw } = await params;
  const input = decodeURIComponent(raw).replace(/\.svg$/, "");
  const wallet = BASE58_ADDRESS.test(input) ? input : resolveHandle(input);

  const report = wallet ? getWalletReport(wallet) : null;
  const t = report?.trust;

  if (!t) {
    return new Response(svg("karma", "not scored", "#52525b"), { headers: headers(false) });
  }

  // Grade and number only. Anything more nuanced belongs on the card, where the confidence
  // band and the "this is not a prediction you'll make money" caveat can travel with it.
  return new Response(svg("karma", `${t.grade} · ${t.karma}/100`, COLOR[t.grade] ?? "#52525b"), {
    headers: headers(true),
  });
}
