import { USER_AGENT } from "./env";

export type MediaKind = "image" | "thumb";

const SAFE_PATH = /^galleries\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isValidMediaPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes("..");
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
  if (!isValidMediaPath(path)) throw new Error(`invalid media path: ${path}`);
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

function contentTypeFor(path: string): string {
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