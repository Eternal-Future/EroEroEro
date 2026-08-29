import { Hono } from "hono";
import { index_html, style_css, app_js } from "./assets";
import { getEnv } from "./env";
import { NhentaiError } from "./nhentai";
import { fetchMedia, fetchMediaBuffer, isValidMediaPath, serverOrigin } from "./media";
import { getCachedImage, imageCacheKey, putCachedImage } from "./imageCache";
import {
  buildMediaUrl,
  getSource,
  listSources,
  type NormalizedPage,
  type SourceAdapter,
} from "./sources";
import { zipStream } from "./zip";

export const app = new Hono();

// Only images are meant to be cached by browsers/CDN nodes. Everything else
// (HTML/JS/CSS/JSON/ZIP) defaults to no-store so CDNs never cache it. The
// `/img` route sets its own cache headers and is skipped below because it
// always provides a Cache-Control header.
app.use("*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) {
    c.res.headers.set("Cache-Control", "no-store");
  }
  if (!c.res.headers.has("CDN-Cache-Control")) {
    c.res.headers.set("CDN-Cache-Control", "no-cache");
  }
  if (!c.res.headers.has("Vercel-CDN-Cache-Control")) {
    c.res.headers.set("Vercel-CDN-Cache-Control", "no-cache");
  }
});

// ---------------------------------------------------------------------------
// Static frontend (served from inlined assets so every target works the same,
// no 302, no external asset hops)
// ---------------------------------------------------------------------------
app.get("/", (c) => c.html(index_html));
app.get("/index.html", (c) => c.html(index_html));
app.get("/style.css", (c) =>
  c.body(style_css, { headers: { "Content-Type": "text/css; charset=utf-8" } }),
);
app.get("/app.js", (c) =>
  c.body(app_js, { headers: { "Content-Type": "text/javascript; charset=utf-8" } }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function authKey(c: any): string | undefined {
  return getEnv(c, "NHENTAI_API_KEY");
}

function src(c: any): SourceAdapter {
  const name = c.req.param("source");
  const adapter = getSource(name);
  if (!adapter) {
    const err = new NhentaiError(404, `unknown source: ${name}`);
    throw err;
  }
  return adapter;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// ---------------------------------------------------------------------------
// Health / sources
// ---------------------------------------------------------------------------
app.get("/api/health", (c) =>
  c.json({ ok: true, app: "Ero³", version: "0.2.0", sources: listSources() }),
);

app.get("/api/sources", (c) => c.json({ sources: listSources() }));

// ---------------------------------------------------------------------------
// Search (keyword, tag, or home feed)
// ---------------------------------------------------------------------------
app.get("/api/source/:source/search", async (c) => {
  const adapter = src(c);
  const query = c.req.query("q") ?? "";
  const tagId = c.req.query("tag_id");
  const tagName = c.req.query("tag") ?? undefined;
  const page = positiveInt(c.req.query("page"), 1);
  const data = await adapter.search({
    query,
    tagId,
    tagName,
    sort: c.req.query("sort"),
    page,
    key: authKey(c),
  });

  return c.json({
    source: adapter.id,
    items: data.items.map((it) => ({
      ...it,
      thumb: buildMediaUrl(adapter.id, it.thumb.path, it.thumb.kind),
    })),
    page,
    num_pages: data.num_pages,
    per_page: data.per_page,
    total: data.total,
  });
});

// ---------------------------------------------------------------------------
// Gallery detail
// ---------------------------------------------------------------------------
app.get("/api/source/:source/gallery/:id", async (c) => {
  const adapter = src(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "invalid gallery id" }, 400);

  const g = await adapter.gallery(id, authKey(c));
  return c.json({
    source: adapter.id,
    id: g.id,
    title: g.title,
    japanese_title: g.japanese_title,
    pretty: g.pretty,
    scanlator: g.scanlator,
    upload_date: g.upload_date,
    num_pages: g.num_pages,
    num_favorites: g.num_favorites,
    cover: buildMediaUrl(adapter.id, g.cover.path, "thumb"),
    thumb: buildMediaUrl(adapter.id, g.thumbnail.path, "thumb"),
    tags: g.tags,
    pages: g.pages.map((p) => ({
      number: p.number,
      width: p.width,
      height: p.height,
      img: buildMediaUrl(adapter.id, p.path, "image"),
      thumb: buildMediaUrl(adapter.id, p.thumbnail, "thumb"),
    })),
  });
});

// ---------------------------------------------------------------------------
// Tag autocomplete + tag browsing (source-aware)
// ---------------------------------------------------------------------------
app.get("/api/source/:source/tags", async (c) => {
  const adapter = src(c);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ source: adapter.id, items: [] });
  const limit = clampInt(c.req.query("limit"), 8, 1, 20);
  const type = c.req.query("type") ?? undefined;
  const tags = await adapter.tags(q, limit, type);
  return c.json({ source: adapter.id, items: tags });
});

app.get("/api/source/:source/tags/browse", async (c) => {
  const adapter = src(c);
  const type = (c.req.query("type") ?? "tag").trim() || "tag";
  const page = positiveInt(c.req.query("page"), 1);
  const sort = c.req.query("sort") ?? "popular";
  const data = await adapter.browseTags(type, page, sort);
  return c.json({
    source: adapter.id,
    type,
    items: data.items,
    page,
    num_pages: data.num_pages,
  });
});

// ---------------------------------------------------------------------------
// Media proxy — no direct links, no 302
// ---------------------------------------------------------------------------
app.get("/api/source/:source/img", async (c) => {
  const adapter = src(c);
  const path = c.req.query("path") ?? "";
  const kind = c.req.query("kind") === "image" ? "image" : "thumb";
  if (!isValidMediaPath(path)) return c.json({ error: "bad media path" }, 400);

  const cacheKey = imageCacheKey(adapter.id, kind, path);
  let data: Uint8Array;
  let contentType: string;
  let cacheHit = true;

  const cached = getCachedImage(cacheKey);
  if (cached) {
    data = cached.data;
    contentType = cached.contentType;
  } else {
    cacheHit = false;
    const servers = await adapter.mediaServers(kind);
    const fetched = await fetchMediaBuffer(path, servers);
    data = fetched.data;
    contentType = fetched.contentType;
    putCachedImage(cacheKey, data, contentType);
  }

  // ≤3MB is kept cacheable for browsers and CDN nodes; larger images bypass
  // shared caches so they don't blow through CDN/browser quota.
  const cacheable = data.byteLength <= 3 * 1024 * 1024;
  const etag = `W/"${data.byteLength.toString(36)}-${hashCode(path + kind).toString(36)}"`;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(data.byteLength),
    "Cache-Control": cacheable
      ? "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800"
      : "no-store",
    "CDN-Cache-Control": cacheable ? "public, max-age=86400" : "no-cache",
    "Vercel-CDN-Cache-Control": cacheable ? "public, max-age=86400" : "no-cache",
    ETag: etag,
    "X-Cache": cacheHit ? "HIT" : "MISS",
    "X-Content-Type-Options": "nosniff",
  };

  return new Response(data.buffer as ArrayBuffer, { headers });
});

// ---------------------------------------------------------------------------
// Download — server fetches pages in real time and streams a ZIP to the client
// with no fixed content-length. The browser's download manager owns the file.
// ---------------------------------------------------------------------------
app.get("/api/source/:source/download/:id", async (c) => {
  const adapter = src(c);
  const id = c.req.param("id");
  if (!id) return c.json({ error: "invalid gallery id" }, 400);

  const g = await adapter.gallery(id, authKey(c));
  const imageServers = await adapter.mediaServers("image");

  const folder = sanitize(`${g.id} ${g.pretty || g.title || "gallery"}`)
    .slice(0, 80)
    .trim()
    .replace(/\.+$/, "") || String(g.id);

  const meta = JSON.stringify(
    {
      source: adapter.id,
      id: g.id,
      title: g.title,
      japanese_title: g.japanese_title,
      tags: g.tags.map((t) => ({ id: t.id, type: t.type, name: t.name })),
      num_pages: g.num_pages,
      num_favorites: g.num_favorites,
    },
    null,
    2,
  );

  const ext = (path: string) => path.split(".").pop()?.toLowerCase() || "jpg";
  const pageName = (p: NormalizedPage) =>
    `${folder}/${String(p.number).padStart(4, "0")}.${ext(p.path)}`;

  const entries = (async function* () {
    yield {
      name: `${folder}/meta.json`,
      open: async () => new TextEncoder().encode(meta) as Uint8Array,
    };
    yield* fetchPagesBuffered(g.pages, 4, pageName, imageServers);
  })();

  const asciiName = (
    folder.replace(/[^\x20-\x7e]/g, "_").replace(/\s+/g, " ").trim() || String(g.id)
  ).slice(0, 60);
  const disposition = `attachment; filename="${asciiName}.zip"; filename*=UTF-8''${encodeURIComponent(folder)}.zip`;

  return new Response(zipStream(entries), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
});

// ---------------------------------------------------------------------------
// Fallbacks
// ---------------------------------------------------------------------------
app.notFound((c) => c.json({ error: "not found" }, 404));

app.onError((err, c) => {
  if (err instanceof NhentaiError) {
    return c.json({ error: err.message, status: err.status }, { status: err.status as any });
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error("[ero-cubed]", message);
  return c.json({ error: "internal error", detail: message }, 500);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function* fetchPagesBuffered(
  pages: NormalizedPage[],
  limit: number,
  nameFor: (p: NormalizedPage) => string,
  servers: string[],
): AsyncGenerator<{ name: string; open: () => Promise<Uint8Array> }, void, void> {
  let preferredServer: string | undefined;
  const results = new Map<number, Uint8Array>();
  const waiters = new Map<number, () => void>();
  let error: Error | null = null;
  let next = 0;
  let inFlight = 0;

  const resolveWaiter = (i: number) => {
    const w = waiters.get(i);
    if (w) {
      waiters.delete(i);
      w();
    }
  };

  const fill = () => {
    while (!error && next < pages.length && inFlight < limit) {
      inFlight++;
      const i = next++;
      (async () => {
        try {
          const { response, url } = await fetchMedia(pages[i].path, servers, {
            preferredServer,
            timeoutMs: 12000,
          });
          preferredServer = serverOrigin(url);
          results.set(i, new Uint8Array(await response.arrayBuffer()));
        } catch (e) {
          error = e instanceof Error ? e : new Error(String(e));
        } finally {
          resolveWaiter(i);
        }
      })().finally(() => {
        inFlight--;
        void fill();
      });
    }
  };

  fill();

  for (let i = 0; i < pages.length; i++) {
    while (!results.has(i) && !error) {
      await new Promise<void>((resolve) => {
        waiters.set(i, resolve);
        if (results.has(i) || error) {
          waiters.delete(i);
          resolve();
        }
      });
    }
    if (error) throw error;
    const data = results.get(i)!;
    results.delete(i);
    yield { name: nameFor(pages[i]), open: async () => data };
  }
}

function sanitize(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashCode(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}