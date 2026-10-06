import { AsyncLocalStorage } from "node:async_hooks";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} for ${redact(url)}: ${body.slice(0, 200)}`);
  }
}

const redact = (url: string) => url.replace(/api-key=[^&]+/, "api-key=***");

const lane = new AsyncLocalStorage<"low">();

/**
 * Run `fn` in the low-priority lane: its rate-limited calls only take a slot when the queue is nearly
 * empty, so bulk work (the crowd sample) soaks up idle capacity without delaying the critical path
 * (funder → gate chains) queued behind it. Wall time on a shared pipe is set by the longest chain, not
 * the biggest pile, so the pile should wait.
 */
export const lowPriority = <T>(fn: () => Promise<T>): Promise<T> => lane.run("low", fn);

/** Spaces requests out to a fixed rate. Slots are reserved synchronously, so callers can fire in parallel. */
export class RateLimiter {
  private next = 0;

  constructor(private readonly minIntervalMs: number) {}

  async take(): Promise<void> {
    // Low lane: wait until at most one slot is queued ahead, so a normal call arriving later never sits
    // behind more than a slot or two of bulk work.
    if (lane.getStore() === "low") while (this.next - Date.now() > this.minIntervalMs) await sleep(this.minIntervalMs);
    const now = Date.now();
    const slot = Math.max(now, this.next);
    this.next = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }

  /** How long a caller taking a slot right now would wait, in ms. Lets a pool pick its least-busy endpoint. */
  backlogMs(): number {
    return Math.max(0, this.next - Date.now());
  }

  /** Push every pending slot back, e.g. after a 429. */
  penalize(ms: number) {
    this.next = Math.max(this.next, Date.now() + ms);
  }
}

const backoff = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250;

export async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  opts: { limiter?: RateLimiter; retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 6;
  for (let attempt = 0; ; attempt++) {
    await opts.limiter?.take();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, await res.text(), url);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      // Nudge the shared queue back briefly, but never by the full backoff: with dozens of calls queued
      // in parallel, each 429 escalating a queue-wide freeze (1s, 2s, 4s…) stalled whole scans.
      opts.limiter?.penalize(Math.min(wait, 750));
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, await res.text(), url);
    return (await res.json()) as T;
  }
}
