/**
 * Shown automatically while the coin scan runs (Next wraps the async page in this Suspense
 * boundary). A cold scan pulls holders, funders and fan-outs live off the chain and can take a
 * while on the free tier, so we say so plainly instead of leaving a blank spinner.
 */
export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-xl flex-1 px-5 py-10">
      <div className="border-2 border-foreground bg-white/[0.02] px-6 py-14 text-center">
        <p className="silk animate-pulse text-sm tracking-[0.14em] text-zinc-300">READING THE CHAIN…</p>
        <p className="mt-4 text-sm leading-relaxed text-zinc-500">
          pulling every holder, who funded them, and how far the money fans out. a cold scan can take
          up to 30 seconds.
        </p>
        <p className="mt-3 text-xs leading-relaxed text-zinc-600">
          young project, running on the free tier. if it times out, just refresh, the dev is
          caffeinating to make this faster.
        </p>
      </div>
    </main>
  );
}
