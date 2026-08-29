import type { Context } from "hono";

const g = globalThis as any;

/** Resolve an env var across Node (process.env), Worker bindings, and globalThis. */
export function getEnv(c: Context, key: string): string | undefined {
  const fromCtx = c?.env ? (c.env as any)[key] : undefined;
  if (fromCtx !== undefined && fromCtx !== null) return String(fromCtx);
  if (g.process?.env?.[key] !== undefined) return String(g.process.env[key]);
  if (g[key] !== undefined && g[key] !== null) return String(g[key]);
  return undefined;
}

export const BASE_URL = (g.process?.env?.NHENTAI_BASE ?? "https://nhentai.net").replace(
  /\/+$/,
  "",
);

export const USER_AGENT =
  g.process?.env?.NHENTAI_USER_AGENT ??
  "EroEroEro/0.1 (https://github.com/Eternal-Future/EroEroEro)";