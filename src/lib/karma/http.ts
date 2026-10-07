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

/**
 * A 429 that is a spent monthly quota, not a burst limit: retrying can't help until the plan resets, so it
 * throws on the first response instead of burning ~60s of backoff per call (Helius sends "max usage reached").
 */
export class QuotaError extends HttpError {}
const QUOTA_BODY = /max usage|quota|credits? (exhausted|exceeded)|monthly limit|upgrade your plan/i;

const redact = (url: string) => url.replace(/api-key=[^&]+/, "api-key=***");

const lane = new AsyncLocalStorage<"low">();

/**
 * Run `fn` in the low-priority lane: its rate-limited calls only take a slot when the queue is nearly
 * empty, so bulk work (the crowd sample) soaks up idle capacity without delaying the critical path
 * (funder → gate chains) queued behind it. Wall time on a shared pipe is set by the longest chain, not
 * the biggest pile, so the pile should wait.
 */
export const lowPriority = <T>(fn: () => Promise<T>): Promise<T> => lane.run("low", fn);

/** A network call refused because the scan's time budget ran out (see withBudget). */
export class DeadlineError extends Error {}
const budget = new AsyncLocalStorage<{ until: number; hit: boolean }>();

/**
 * Run `fn` with a wall-clock budget: once it's spent, every rate-limited call inside fails at once instead
 * of queueing, so the work done so far comes back (`hit` says it's partial). The layered cron uses it to
 * take a cheap pass over every coin before a deep pass over a few; what each pass read stays in the fact
 * cache for the next one.
 */
export async function withBudget<T>(ms: number, fn: () => Promise<T>): Promise<{ value: T; hit: boolean }> {
  const b = { until: Date.now() + ms, hit: false };
  const value = await budget.run(b, fn);
  return { value, hit: b.hit };
}

/** Ms left in the current budget, or Infinity outside one. */
function budgetLeft(): number {
  const b = budget.getStore();
  return b ? b.until - Date.now() : Infinity;
}

/** A backoff sleep that won't outlive the budget: if the wait is longer than what's left, give up now. */
export async function budgetSleep(ms: number): Promise<void> {
  if (ms > budgetLeft()) {
    budget.getStore()!.hit = true;
    throw new DeadlineError("scan budget spent");
  }
  await sleep(ms);
}

function spent(): void {
  const b = budget.getStore();
  if (b && Date.now() > b.until) {
    b.hit = true;
    throw new DeadlineError("scan budget spent");
  }
}

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
    // A slot past the scan's budget would only delay the partial result: refuse it without reserving.
    const b = budget.getStore();
    if (b && slot > b.until) {
      b.hit = true;
      throw new DeadlineError("scan budget spent");
    }
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
    spent();
    await opts.limiter?.take();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { accept: "application/json", ...(init.headers as Record<string, string> | undefined) },
        // Inside a budget, a call never waits past it: the in-flight request is cut at the deadline too.
        signal: AbortSignal.timeout(Math.max(1, Math.min(opts.timeoutMs ?? 30_000, budgetLeft()))),
      });
    } catch (err) {
      spent();
      if (attempt >= retries) throw err;
      await budgetSleep(backoff(attempt));
      continue;
    }
    if (res.status === 429) {
      const body = await res.clone().text();
      if (QUOTA_BODY.test(body)) throw new QuotaError(res.status, body, url);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new HttpError(res.status, await res.text(), url);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
      // Nudge the shared queue back briefly, but never by the full backoff: with dozens of calls queued
      // in parallel, each 429 escalating a queue-wide freeze (1s, 2s, 4s…) stalled whole scans.
      opts.limiter?.penalize(Math.min(wait, 750));
      await budgetSleep(wait);
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, await res.text(), url);
    return (await res.json()) as T;
  }
}
