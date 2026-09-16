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
// Which upstream URLs may be fetched (jm/bk/eh hand the proxy a full URL).
//
// The primary control is the signature on the /img URL (see mediasign.ts): only
// a path this server produced from a source adapter can be requested, so the
// host is free to change — jm rotates CDN domains and a static allowlist would
// break it. On top of that the URL must be https and must not point back into a
// private network, which is cheap and works everywhere.
//
// `<SOURCE>_MEDIA_HOSTS` remains available as an opt-in narrowing when someone
// wants to pin a CDN (comma/space separated suffixes).
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

/** Host suffixes pinned for this source, or [] when the source is unpinned. */
export function mediaHostSuffixes(envName: string): string[] {
  return suffixFromEnv(readEnvVar(envName));
}

/** Hostname of a configured base URL (auto-allowed when a host list is pinned). */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostMatchesSuffix(host: string, suffixes: string[]): boolean {
  return suffixes.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Loopback / link-local / RFC1918 / CGNAT / multicast literals. */
function isPrivateIp(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  return host.includes(":") ? isPrivateIpv6(host) : false;
}

/**
 * IPv6 literal check. The WHATWG URL parser rewrites IPv4-mapped addresses into
 * their hex form (`::ffff:127.0.0.1` becomes `::ffff:7f00:1`), so the groups are
 * expanded and case-checked rather than pattern-matched.
 */
function isPrivateIpv6(host: string): boolean {
  const halves = host.split("::");
  let groups: string[];
  if (halves.length === 2) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves[1] ? halves[1].split(":") : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return false;
    groups = [...head, ...new Array(fill).fill("0"), ...tail];
  } else {
    groups = host.split(":");
  }
  if (groups.length !== 8) return false;
  const nums = groups.map((g) => Number.parseInt(g || "0", 16));
  if (nums.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return false;

  const [g0, g1] = nums;
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (g0 === 0 && g1 === 0) return true; // ::, ::1, IPv4-compatible
  // ::ffff:a.b.c.d (IPv4-mapped)
  if (nums.slice(0, 6).every((n, i) => (i === 5 ? n === 0xffff : n === 0))) {
    const a = nums[6] >> 8;
    const b = nums[6] & 0xff;
    const c = nums[7] >> 8;
    const d = nums[7] & 0xff;
    return isPrivateIp(`${a}.${b}.${c}.${d}`);
  }
  return false;
}

/** True for hosts that are clearly not public internet endpoints. */
export function isPublicHttpHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  for (const suffix of [".local", ".internal", ".home.arpa", ".localdomain"]) {
    if (h.endsWith(suffix)) return false;
  }
  return !isPrivateIp(h);
}

/**
 * Returns a reason string when `url` must not be fetched, else null.
 * An empty `pinnedSuffixes` means the host is not restricted.
 */
export function mediaUrlRejection(url: string, pinnedSuffixes: string[] = []): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "malformed media url";
  }
  if (parsed.protocol !== "https:") return "media url must be https";
  const host = parsed.hostname.toLowerCase();
  if (!isPublicHttpHost(host)) return `media host is not public: ${host}`;
  if (pinnedSuffixes.length && !hostMatchesSuffix(host, pinnedSuffixes)) {
    return `media host not in the pinned list: ${host}`;
  }
  return null;
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