// Minimal KV storage used by the e-hentai integration. Local Node uses SQLite
// (`node:sqlite`, installed by ehentai-node.ts). Cloudflare Workers can hand
// us a D1 binding through `maybeInitEhStore(c.env)` — the two share the same
// get/put interface, so tag indexes and igneous state survive restarts.

export interface EhKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
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

/** Build a KV store from a Cloudflare D1 binding. */
export function d1EhStore(binding: any): EhKvStore {
  return {
    async get(key) {
      try {
        const row = await binding.prepare("SELECT v FROM eh_kv WHERE k = ?").bind(key).first();
        return row && typeof row.v === "string" ? row.v : null;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        await binding
          .prepare("INSERT INTO eh_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = strftime('%s','now')")
          .bind(key, value)
          .run();
      } catch {
        // best effort
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

/** Call from Hono middleware with `c.env`; no-op outside Workers. */
export async function maybeInitEhStore(env: any): Promise<void> {
  if (!store && env && typeof env.EH_D1?.prepare === "function") {
    setEhStore(d1EhStore(env.EH_D1));
    try {
      await env.EH_D1.exec(EH_KV_SCHEMA);
    } catch {
      // schema may already exist
    }
  }
}