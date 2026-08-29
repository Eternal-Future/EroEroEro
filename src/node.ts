import { serve } from "@hono/node-server";
import { app } from "./app";

const port = Number((globalThis as any).process?.env?.PORT ?? 8787);

console.log(`[eroeroero] listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });