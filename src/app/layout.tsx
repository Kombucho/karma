import type { Metadata } from "next";
import Link from "next/link";
import { Silkscreen, Press_Start_2P } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

/**
 * Chrome for the Kombucho stationery skin (Front-end/Karma v3.dc.html): microbar, ink-boxed
 * masthead with the giant wordmark, inverted ticker band, diner-rules footer. Body text is
 * Courier; Silkscreen is the display face for stamps and labels.
 */
const silkscreen = Silkscreen({
  weight: ["400", "700"],
  variable: "--font-silkscreen",
  subsets: ["latin"],
});

/** The card unit uses a second, chunkier pixel face for the score itself. */
const pressStart = Press_Start_2P({
  weight: "400",
  variable: "--font-press",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KARMA — wallet receipts, not vibes",
  description:
    "Grade any Solana caller on their real track record. Did copying their buys win, or did they dump on followers? Computed from on-chain history. Not financial advice.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${silkscreen.variable} ${pressStart.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <div className="mx-auto w-full max-w-5xl px-3 sm:px-5">
          {/* microbar */}
          <div className="silk flex items-center justify-between py-2 text-[10px] tracking-[0.08em]">
            <span>KARMA · A PROJECT BY KOMBUCHO</span>
            <div className="flex items-center gap-2.5">
              <a
                href="https://x.com/KombuchoBuild"
                target="_blank"
                rel="noopener noreferrer"
                className="border border-foreground px-1.5 py-0.5 no-underline hover:bg-foreground hover:text-background"
                title="Send feedback by DM on X"
              >
                FEEDBACK
              </a>
              <a
                href="https://x.com/KombuchoBuild"
                target="_blank"
                rel="noopener noreferrer"
                className="no-underline hover:text-red-400"
              >
                @KOMBUCHOBUILD
              </a>
            </div>
          </div>

          {/* masthead */}
          <div className="ink-box flex items-center justify-between gap-4 px-3 pb-2 pt-3 sm:px-5">
            <div className="min-w-0">
              <Link href="/" className="block no-underline hover:text-foreground">
                <h1 className="silk whitespace-nowrap text-[clamp(38px,9vw,130px)] font-bold leading-[0.85] tracking-tight">
                  KARMA
                </h1>
              </Link>
              <nav className="silk mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-[10px] tracking-[0.1em] uppercase">
                <Link href="/" className="underline underline-offset-[3px]">check a wallet</Link>
                <Link href="/methodology" className="underline underline-offset-[3px]">how it grades</Link>
                <Link href="/leaderboard" className="underline underline-offset-[3px]">the board</Link>
                <Link href="/audit" className="underline underline-offset-[3px]">the audit</Link>
                <Link href="/claim" className="underline underline-offset-[3px]">claim your card</Link>
                <Link href="/#token" className="underline underline-offset-[3px]">$karma</Link>
              </nav>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/karma-buddha.png"
              alt="Karma"
              className="hidden h-28 w-auto shrink-0 object-contain sm:block lg:h-36"
            />
          </div>

          {/* ticker band */}
          <div className="overflow-hidden border-2 border-t-0 border-foreground bg-foreground py-2 text-background">
            <div className="tick-band flex w-max text-[13px] tracking-[0.06em]">
              <span className="pr-9">
                YOU WERE NEVER EARLY. YOU WERE
                THEIR EXIT LIQUIDITY. ✦ 45% OF CALLED COINS ROUND-TRIP TO ZERO. THAT IS THE BASELINE,
                NOT THE CRIME. ✦ RECEIPTS, NOT VIBES. ✦
              </span>
              <span className="pr-9">
                YOU WERE NEVER EARLY. YOU WERE
                THEIR EXIT LIQUIDITY. ✦ 45% OF CALLED COINS ROUND-TRIP TO ZERO. THAT IS THE BASELINE,
                NOT THE CRIME. ✦ RECEIPTS, NOT VIBES. ✦
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 flex-col">{children}</div>

        {/* global buy CTA — every page ends on the same offer */}
        <div className="mx-auto w-full max-w-5xl px-3 pb-8 pt-6 sm:px-5">
          <Link
            href="/#token"
            className="silk block border-2 border-foreground bg-red-500 px-4 py-3 text-center text-[12px] tracking-[0.1em] text-background no-underline hover:bg-foreground hover:text-red-500"
          >
            LIKE THE PROJECT? BUY $KARMA →
          </Link>
        </div>
        <Analytics />
      </body>
    </html>
  );
}
