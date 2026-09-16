import { USER_AGENT } from "./env";

export type MediaKind = "image" | "thumb";

/** A media URL/path the caller supplied that this server refuses to fetch. */
export class MediaUrlError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "MediaUrlError";
  }
}

const SAFE_PATH = /^galleries\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidMediaPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes("..");
}

// ---------------------------------------------------------------------------
// Host allowlist for sources that hand the proxy a full URL (jm/bk/eh thumbs).
// Without it the /img route is an open https fetcher: anyone could point it at
// an internal service and read the response back through this server.
// Sources append extra hosts with `<SOURCE>_MEDIA_HOSTS` (comma/space separated).
// ---------------------------------------------------------------------------
function readEnvVar(name: string): string {
  const g = globalThis as any;
  const v = g.process?.env?.[name] ?? g[name];
  return typeof v === "string" ? v : "";
}

function suffixFromEnv(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^\.+|\/+$/g, ""))
    .filter(Boolean);
}

/** Default suffixes plus whatever `<envName>` adds at call time. */
export function allowedHostSuffixes(envName: string, defaults: string[]): string[] {
  return [...defaults, ...suffixFromEnv(readEnvVar(envName))];
}

/** True when `url` is https and its host is one of `suffixes` (or a subdomain). */
export function isAllowedMediaUrl(url: string, suffixes: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Hostname of a configured base URL (used to auto-allow user-configured mirrors). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Response body guards for the image proxy
// ---------------------------------------------------------------------------
/** Hard ceiling for one proxied media file. Larger responses are refused. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/** Lowercased media type without parameters. */
export function normalizeMediaType(raw: string | null | undefined): string {
  return (raw ?? "").split(";")[0].trim().toLowerCase();
}

const UNSERVABLE_TYPES = new Set(["image/svg+xml"]);

/**
 * Only raster images may be proxied. SVG and any text/* / HTML type would let a
 * hostile upstream execute script on this app's own origin (the response keeps
 * the upstream Content-Type).
 */
export function isServableImageType(type: string): boolean {
  const t = (type ?? "").toLowerCase();
  if (!t) return false;
  if (UNSERVABLE_TYPES.has(t)) return false;
  return t.startsWith("image/") || t === "application/octet-stream";
}

/** Drop an unwanted upstream body so the connection is not held open. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // already consumed or unavailable
  }
}

/** Read a response body into memory, refusing anything above `maxBytes`. */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = MAX_MEDIA_BYTES,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discardBody(response);
    throw new Error(`media too large: ${declared} bytes`);
  }
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`media too large: over ${maxBytes} bytes`);
      chunks.push(value);
    }
  } catch (err) {
    try {
      await reader.cancel();
    } catch {
      // stream already errored
    }
    throw err;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function startIndex(path: string, len: number): number {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) >>> 0;
  return h % len;
}

export function serverOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export interface FetchedMedia {
  response: Response;
  url: string;
}

export interface FetchMediaOptions {
  /** Try this server origin first for connection reuse during a long download. */
  preferredServer?: string;
  timeoutMs?: number;
}

/**
 * Fetch a media path from source-provided CDN servers, trying every server
 * before giving up. Server discovery lives in the source adapter, so this
 * stays source-agnostic.
 */
export async function fetchMedia(
  path: string,
  servers: string[],
  opts: FetchMediaOptions = {},
): Promise<FetchedMedia> {
  if (!isValidMediaPath(path)) throw new MediaUrlError(`invalid media path: ${path}`);
  const timeoutMs = opts.timeoutMs ?? 12000;
  const cleaned = servers.map((s) => s.replace(/\/+$/, ""));
  if (cleaned.length === 0) throw new Error("no media servers configured");

  // Put the preferred server first so a whole download reuses one connection.
  const ordered = opts.preferredServer
    ? [opts.preferredServer, ...cleaned.filter((s) => s !== opts.preferredServer)]
    : cleaned;

  let lastError: unknown = new Error("all media servers failed");
  const start = opts.preferredServer ? 0 : startIndex(path, ordered.length);
  for (let i = 0; i < ordered.length; i++) {
    const url = `${ordered[(start + i) % ordered.length]}/${path}`;
    // Bound only the connection/headers phase. The timer is cleared as soon as
    // headers arrive so a slow body stream is never aborted mid-download.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      if (response.ok) return { response, url };
      lastError = new Error(`HTTP ${response.status} from ${url}`);
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Fetch and fully buffer a media file (used for single-image preview). */
export async function fetchMediaBuffer(
  path: string,
  servers: string[],
): Promise<{ data: Uint8Array; contentType: string; url: string }> {
  const { response, url } = await fetchMedia(path, servers);
  const data = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? contentTypeFor(path);
  return { data, contentType, url };
}

export function contentTypeFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}