// Node-only e-hentai bridges: HTTP proxy support for igneous acquisition and
// local SQLite persistence for igneous / tag index data. This file is NEVER
// imported by the Workers/Vercel entries, so the serverless graph stays free
// of Node built-ins.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ProxyAgent } from "undici";
import { setEhAcquireFetcher } from "./ehentai";
import { setEhStore } from "./ehstore";

export function installEhNodeBridge(): void {
  const proc = (globalThis as any).process;
  const dataDir = proc?.env?.EHENTAI_STATE_DIR ?? ".data";
  const sqliteFile = proc?.env?.EHENTAI_SQLITE_FILE ?? "eh.sqlite";
  const base = join(proc.cwd(), dataDir);
  const dbPath = join(base, sqliteFile.replace(/^\.data\//, ""));
  mkdirSync(dirname(dbPath), { recursive: true });

  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS eh_kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER)",
  );
  setEhStore({
    async get(key) {
      try {
        const row = sqlite.prepare("SELECT v FROM eh_kv WHERE k = ?").get(key) as
          | { v: string }
          | undefined;
        return row?.v ?? null;
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        sqlite
          .prepare(
            "INSERT INTO eh_kv (k, v, updated_at) VALUES (?, ?, strftime('%s','now')) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at",
          )
          .run(key, value);
      } catch {
        // best effort
      }
    },
  });

  const proxy = proc?.env?.EHENTAI_IGNEOUS_PROXY;
  if (proxy) {
    const agent = new ProxyAgent({ uri: proxy });
    setEhAcquireFetcher((url, init) => {
      return fetch(url, { ...(init ?? {}), dispatcher: agent } as any);
    });
  }
}