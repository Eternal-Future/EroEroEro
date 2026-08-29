import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "./app";
import { installEhNodeBridge } from "./ehentai-node";
import { enableDebug } from "./debug";

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

const proc = (globalThis as any).process;
if (proc?.argv?.includes("--debug") || proc?.env?.ERO3_DEBUG === "1") {
  enableDebug();
}

installEhNodeBridge();

const port = Number((globalThis as any).process?.env?.PORT ?? 8787);
const host = (globalThis as any).process?.env?.HOST ?? "0.0.0.0";

console.log(`[Ero³] listening on http://${host}:${port}${proc?.argv?.includes("--debug") ? " (debug)" : ""}`);
serve({ fetch: app.fetch, port, hostname: host });