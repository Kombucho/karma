import type { Metadata } from "next";
import Link from "next/link";
import ClaimForm from "./ClaimForm";

export const metadata: Metadata = {
  title: "Claim your card — Karma",
  description: "Bind your X handle to your wallet with one post. Free. Your card gets your face, your line goes in the cookie jar.",
};

export default function ClaimPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-3 py-8 sm:px-5">
      <section className="border-2 border-foreground">
        <div className="silk flex items-center justify-between bg-foreground px-3 py-2 text-[10px] tracking-[0.1em] text-background">
          <span>▶ CLAIM YOUR CARD</span>
          <span className="opacity-60">FREE</span>
        </div>

        <div className="px-4 py-5 sm:px-6">
          <p className="mb-5 text-sm text-zinc-500">
            Put your face on your on-chain record. Free, and it can&apos;t buy you a better grade.
          </p>
          <ClaimForm />
        </div>
      </section>

      <p className="mt-4 text-center text-xs text-zinc-600">
        <Link href="/" className="underline">back to karma</Link> ·{" "}
        <Link href="/methodology" className="underline">how grades work</Link>
      </p>
    </main>
  );
}
