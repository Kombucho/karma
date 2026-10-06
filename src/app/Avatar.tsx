"use client";

import { useState } from "react";

/**
 * One avatar chain for every face on the site:
 *   coin card    → the Dexscreener/pump image of the coin ("the guy"), when the pair carries one
 *   known caller → their X profile picture via unavatar.io/x/<handle> (keyless)
 *   no social    → the frog. A wallet with receipts but no face gets pepe, by design.
 * Any load failure anywhere in the chain also lands on the frog, so the card never shows a
 * broken-image glyph.
 */
export default function Avatar({
  src,
  alt,
  size = 48,
  className = "",
}: {
  src: string | null;
  alt: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = failed || !src ? "/pepe.jpg" : src;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      className={`shrink-0 border-2 border-foreground object-cover ${className}`}
      style={{ width: size, height: size, imageRendering: "auto" }}
    />
  );
}
