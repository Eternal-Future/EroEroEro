import { serve } from "@hono/node-server";
import { app } from "./app";
import { installEhNodeBridge } from "./ehentai-node";

installEhNodeBridge();

const port = Number((globalThis as any).process?.env?.PORT ?? 8787);

console.log(`[Ero³] listening on http://localhost:${port}`);
serve({ fetch: app.fetch, port });