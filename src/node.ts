import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "./app";
import { installEhNodeBridge } from "./ehentai-node";

function loadDotEnv(): void {
  const proc = (globalThis as any).process;
  if (!proc || !proc.cwd) return;
  try {
    const path = join(proc.cwd(), ".env");
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in proc.env)) proc.env[key] = value;
    }
  } catch {
    // no .env file — fine
  }
}

loadDotEnv();
installEhNodeBridge();

const port = Number((globalThis as any).process?.env?.PORT ?? 8787);

console.log(`[Ero³] listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });