// Minimal KV storage used by the e-hentai integration. Local Node uses SQLite
// (`node:sqlite`, installed by ehentai-node.ts). Cloudflare Workers can hand
// us a D1 binding through `maybeInitEhStore(c.env)` — the two share the same
// get/put interface, so tag indexes and igneous state survive restarts.

export interface EhKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

let store: EhKvStore | null = null;

class MemoryStore implements EhKvStore {
  private map = new Map<string, string>();
  async get(key: string) {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async del(key: string) {
    this.map.delete(key);
  }
}

const memoryStore = new MemoryStore();

export async function setEhStore(s: EhKvStore | null): Promise<void> {
  store = s;
}

export async function ehGet(key: string): Promise<string | null> {
  return (store ?? memoryStore).get(key);
}

export async function ehPut(key: string, value: string): Promise<void> {
  return (store ?? memoryStore).put(key, value);
}

export async function ehDel(key: string): Promise<void> {
  return (store ?? memoryStore).del(key);
}

/** Build a KV store from a Cloudflare D1 binding. */
export function d1EhStore(binding: any): EhKvStore {
  return {
    async get(key) {
      try {
        const row = await binding.prepare("SELECT v FROM eh_kv WHERE k = ?").bind(key).first();
        return row && typeof row.v === "string" ? row.v : null;
      } catch (err) {
        console.error("[ehstore] d1 get failed", key, err instanceof Error ? err.message : String(err));
        return null;
      }
    },
    async put(key, value) {
      try {
        await binding
          .prepare("INSERT INTO eh_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = strftime('%s','now')")
          .bind(key, value)
          .run();
      } catch (err) {
        // best effort, but never silent: a failing put means state (including
        // the bk token) is lost on the next isolate.
        console.error("[ehstore] d1 put failed", key, err instanceof Error ? err.message : String(err));
      }
    },
    async del(key) {
      try {
        await binding.prepare("DELETE FROM eh_kv WHERE k = ?").bind(key).run();
      } catch (err) {
        console.error("[ehstore] d1 del failed", key, err instanceof Error ? err.message : String(err));
      }
    },
  };
}

export const EH_KV_SCHEMA = `
CREATE TABLE IF NOT EXISTS eh_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER
);
`;

let warnedNoPersistentStore = false;

/** Call from Hono middleware with `c.env`; no-op outside Workers. */
export async function maybeInitEhStore(env: any): Promise<void> {
  // `env` only exists on Workers/Vercel-style runtimes; Node installs its own
  // SQLite store in ehentai-node.ts.
  if (!store && env && typeof env.EH_D1?.prepare !== "function" && !warnedNoPersistentStore) {
    warnedNoPersistentStore = true;
    console.warn(
      "[ehstore] no EH_D1 binding: state (eh igneous, bk token, nh dates, tag db) is per-instance only",
    );
  }
  if (!store && env && typeof env.EH_D1?.prepare === "function") {
    setEhStore(d1EhStore(env.EH_D1));
    try {
      await env.EH_D1.exec(EH_KV_SCHEMA);
    } catch {
      // schema may already exist
    }
  }
}