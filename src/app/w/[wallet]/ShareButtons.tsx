"use client";

import { useEffect, useState } from "react";

/**
 * Sharing IS the distribution mechanic, so the button hands over the card itself, not a link and
 * a prayer. On a phone (Web Share API with file support) it fetches the 1200×630 Karma card PNG —
 * the exact image that unfurls on X — and drops it straight into the native share sheet, so what
 * you send is the card, not a screenshot of the whole page. Desktop, or any browser without file
 * sharing, falls back to the X intent, where the same card unfurls from the page's OG tags.
 */
export default function ShareButtons({ text, wallet }: { text: string; wallet: string }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read the URL only after mount so server and client render the same markup (no hydration mismatch).
  const [shareUrl, setShareUrl] = useState("");
  const [canShareFile, setCanShareFile] = useState(false);
  useEffect(() => {
    setShareUrl(window.location.href);
    // Feature-detect file sharing with a probe file — this is what gates the native card share.
    try {
      const probe = new File([""], "probe.png", { type: "image/png" });
      setCanShareFile(
        typeof navigator !== "undefined" &&
          !!navigator.canShare &&
          navigator.canShare({ files: [probe] }),
      );
    } catch {
      setCanShareFile(false);
    }
  }, []);

  const xUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}${
    shareUrl ? `&url=${encodeURIComponent(shareUrl)}` : ""
  }`;

  async function shareCard() {
    setBusy(true);
    try {
      const res = await fetch(`/w/${wallet}/opengraph-image`);
      const blob = await res.blob();
      const file = new File([blob], "karma-card.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text });
        return;
      }
    } catch {
      // fall through to the X intent below
    } finally {
      setBusy(false);
    }
    window.open(xUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="flex gap-2">
      {canShareFile ? (
        <button
          onClick={shareCard}
          disabled={busy}
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-center text-sm font-semibold text-black transition-colors hover:bg-zinc-200 disabled:opacity-60"
        >
          {busy ? "Loading card…" : "Share the card"}
        </button>
      ) : (
        <a
          href={xUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 rounded-lg bg-white px-4 py-2.5 text-center text-sm font-semibold text-black transition-colors hover:bg-zinc-200"
        >
          Share on X
        </a>
      )}
      <button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(shareUrl);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {}
        }}
        className="rounded-lg border border-white/15 px-4 py-2.5 text-sm font-medium text-zinc-300 transition-colors hover:border-white/30 hover:text-white"
      >
        {copied ? "Copied ✓" : "Copy link"}
      </button>
    </div>
  );
}
