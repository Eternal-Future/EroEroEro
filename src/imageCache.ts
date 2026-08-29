// Small in-memory image cache for proxied media. Works per isolate: fine for
// Node/Docker (the long-lived process), and reduces repeated CDN fetches on
// Workers/Vercel by keeping hot images in the instance's memory.
//
// Browser/CDN caching policy is handled by the response headers; this cache is
// the server-side counterpart so we don't repeatedly hit the source CDN.

const MAX_TOTAL_BYTES = 64 * 1024 * 1024; // 64 MB total
const MAX_ENTRY_BYTES = 3 * 1024 * 1024; // 3 MB per image (matches browser policy)
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CacheEntry {
  data: Uint8Array;
  contentType: string;
  at: number;
  size: number;
}

const cache = new Map<string, CacheEntry>();
let totalBytes = 0;

export function getCachedImage(key: string): { data: Uint8Array; contentType: string } | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(key);
    totalBytes -= entry.size;
    return undefined;
  }
  // Refresh access time is not tracked; TTL from insert is good enough here.
  return { data: entry.data, contentType: entry.contentType };
}

export function putCachedImage(key: string, data: Uint8Array, contentType: string): void {
  if (data.byteLength === 0 || data.byteLength > MAX_ENTRY_BYTES) return;
  if (cache.has(key)) return;

  cache.set(key, { data, contentType, at: Date.now(), size: data.byteLength });
  totalBytes += data.byteLength;

  while (totalBytes > MAX_TOTAL_BYTES) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    const removed = cache.get(first);
    if (removed) totalBytes -= removed.size;
    cache.delete(first);
  }
}

export function imageCacheKey(source: string, kind: string, path: string): string {
  return `${source}|${kind}|${path}`;
}