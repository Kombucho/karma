import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimal key-value cache the engine reads through. Supabase plugs in here in Phase 2. */
export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
}

interface Entry<T> {
  exp: number | null;
  v: T;
}

export class MemoryCache implements KV {
  private store = new Map<string, Entry<unknown>>();

  async get<T>(key: string): Promise<T | undefined> {
    const e = this.store.get(key);
    if (!e || (e.exp && e.exp < Date.now())) return undefined;
    return e.v as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.store.set(key, { exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null, v: value });
  }
}

/** Local disk cache for the CLI, so re-running validation after a threshold tweak costs no API calls. */
export class FileCache implements KV {
  constructor(private readonly dir = path.join(process.cwd(), ".cache")) {}

  private file(key: string) {
    const h = createHash("sha1").update(key).digest("hex");
    return path.join(this.dir, h.slice(0, 2), `${h}.json`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const e = JSON.parse(await readFile(this.file(key), "utf8")) as Entry<T>;
      if (e.exp && e.exp < Date.now()) return undefined;
      return e.v;
    } catch {
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify({ exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null, v: value }));
  }
}
