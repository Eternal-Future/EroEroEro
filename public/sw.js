/* Ero³ image cache service worker.
 * Browser-side image cache capped at exactly 5 MB total (LRU), single entry ≤3 MB.
 * Only /api/source/<channel>/img requests are handled; everything else is untouched.
 */
const CACHE = "ero3-img-v1";
const LIMIT = 5 * 1024 * 1024; // 5 MB total
const MAX_ENTRY = 3 * 1024 * 1024; // 3 MB per image

const IMG_RE = /^\/api\/source\/[^/]+\/img$/;

let total = 0;
let initialized = false;

function sizeOf(res) {
  const len = res.headers.get("content-length");
  return len ? Number(len) || 0 : 0;
}

async function evict(incoming) {
  const cache = await caches.open(CACHE);
  const keys = await cache.keys(); // oldest-first in modern browsers
  for (const req of keys) {
    if (total + incoming <= LIMIT) break;
    const res = await cache.match(req);
    const size = res ? sizeOf(res) : 0;
    await cache.delete(req);
    total -= size;
  }
  if (total < 0) total = 0;
}

async function initBudget() {
  if (initialized) return;
  initialized = true;
  try {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    let sum = 0;
    for (const req of keys) {
      const res = await cache.match(req);
      if (res) sum += sizeOf(res);
    }
    total = sum;
    await evict(0);
  } catch {
    total = 0;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await initBudget();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    !IMG_RE.test(url.pathname)
  ) {
    return;
  }

  event.respondWith(
    (async () => {
      await initBudget();
      const cache = await caches.open(CACHE);

      const hit = await cache.match(event.request);
      if (hit) {
        // Refresh LRU position by re-inserting (modern browsers keep keys in order).
        await cache.delete(event.request);
        await cache.put(event.request, hit.clone());
        return hit;
      }

      // Bypass the implicit HTTP cache for this sub-fetch; this Service Worker
      // cache is the single controlled browser-side store (5 MB cap).
      const net = await fetch(new Request(event.request, { cache: "no-store" }));
      const contentType = net.headers.get("content-type") || "";
      if (!net.ok || !contentType.startsWith("image/")) return net;

      const size = sizeOf(net);
      if (size > 0 && size <= MAX_ENTRY) {
        await evict(size);
        await cache.put(event.request, net.clone());
        total += size;
      }
      return net;
    })(),
  );
});