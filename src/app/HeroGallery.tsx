"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Grade } from "@/lib/karma/types";

/**
 * The hero card, now a living wall instead of one static frog: real graded callers auto-rotate,
 * face + handle + their verdict word, each linking to its card. It's the board in miniature, the
 * proof that the thing is populated. Falls back to the frog per-image if an avatar won't load.
 */
export interface GalleryPerson {
  handle: string;
  wallet: string;
  grade: Grade | null;
  title: string | null;
  src: string | null;
}

const ROTATE_MS = 3200;

export default function HeroGallery({ people }: { people: GalleryPerson[] }) {
  const [i, setI] = useState(0);
  const [broken, setBroken] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (people.length < 2) return;
    const id = setInterval(() => setI((n) => (n + 1) % people.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [people.length]);

  if (!people.length) return null;
  const p = people[i];
  const src = p.src && !broken[p.wallet] ? p.src : "/pepe.jpg";

  return (
    <figure className="flex flex-col border-2 border-foreground bg-foreground">
      <figcaption className="silk flex items-center justify-between px-3 py-2 text-[9px] tracking-[0.1em] text-background">
        <span>ON THE WALL</span>
        <span className="opacity-60">@{p.handle}</span>
      </figcaption>

      <Link href={`/w/${p.wallet}`} className="group relative block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={p.wallet}
          src={src}
          alt={`@${p.handle}`}
          onError={() => setBroken((b) => ({ ...b, [p.wallet]: true }))}
          className="animate-[fadein_.4s_ease] mx-auto h-64 w-full object-cover px-6 py-2 grayscale transition group-hover:grayscale-0"
        />
      </Link>

      <p className="silk px-3 py-2 text-center text-[9px] tracking-[0.1em] text-background">
        {p.title ? `GRADED ${p.title.toUpperCase()}` : "READING THE CHAIN"}
      </p>

      <Link
        href="/claim"
        className="silk block bg-amber-500 px-3 py-2.5 text-center text-[10px] tracking-[0.1em] text-foreground no-underline hover:bg-background"
      >
        ADD YOUR PROFILE
      </Link>
    </figure>
  );
}
