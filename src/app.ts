import { Hono } from "hono";
import { index_html, style_css, app_js } from "./assets";
import { getEnv } from "./env";
import {
  NhentaiError,
  VALID_SORTS,
  browseTags,
  getGallery,
  searchGalleries,
  searchTags,
} from "./nhentai";
import { fetchMedia, fetchMediaBuffer, isValidMediaPath, serverOrigin } from "./media";
import { zipStream } from "./zip";
import type { SortOrder, PageInfo } from "./types";

export const app = new Hono();

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

function authKey(c: any): string | undefined {
  return getEnv(c, "NHENTAI_API_KEY");
}

function imgUrl(path: string, kind: "image" | "thumb"): string {
  return `/api/img?path=${encodeURIComponent(path)}&kind=${kind}`;
}

function toSort(raw: string | undefined): SortOrder {
  return (VALID_SORTS as string[]).includes(raw ?? "") ? (raw as SortOrder) : "date";
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/api/health", (c) =>
  c.json({ ok: true, source: "nhentai", app: "eroeroero", version: "0.1.0" }),
);

// ---------------------------------------------------------------------------
// Search (keyword, tag, or home feed)
// ---------------------------------------------------------------------------
app.get("/api/search", async (c) => {
  const query = c.req.query("q") ?? "";
  const tagIdRaw = c.req.query("tag_id");
  const sort = toSort(c.req.query("sort"));
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const tagId = tagIdRaw ? Number(tagIdRaw) : undefined;

  const data = await searchGalleries(
    { query, tagId: tagId && Number.isFinite(tagId) ? tagId : undefined, sort, page },
    authKey(c),
  );

  return c.json({
    items: data.result.map((r) => ({
      id: r.id,
      title: r.english_title || r.japanese_title || `#${r.id}`,
      japanese_title: r.japanese_title,
      pages: r.num_pages,
      favorites: r.num_favorites,
      width: r.thumbnail_width,
      height: r.thumbnail_height,
      thumb: imgUrl(r.thumbnail, "thumb"),
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
app.get("/api/gallery/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid gallery id" }, 400);

  const g = await getGallery(id, authKey(c));
  return c.json({
    id: g.id,
    title: g.title.english || g.title.pretty || `#${g.id}`,
    japanese_title: g.title.japanese,
    pretty: g.title.pretty,
    scanlator: g.scanlator ?? "",
    upload_date: g.upload_date,
    num_pages: g.num_pages,
    num_favorites: g.num_favorites,
    cover: imgUrl(g.cover.path, "thumb"),
    thumb: imgUrl(g.thumbnail.path, "thumb"),
    tags: g.tags.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      slug: t.slug,
      count: t.count,
    })),
    pages: g.pages.map((p) => ({
      number: p.number,
      width: p.width,
      height: p.height,
      img: imgUrl(p.path, "image"),
      thumb: imgUrl(p.thumbnail, "thumb"),
    })),
  });
});

// ---------------------------------------------------------------------------
// Tag autocomplete + tag browsing
// ---------------------------------------------------------------------------
app.get("/api/tags", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json([]);
  const limit = Math.min(20, Math.max(1, Number(c.req.query("limit") ?? "8") || 8));
  const tags = await searchTags(q, limit);
  return c.json(tags.map((t) => ({ id: t.id, type: t.type, name: t.name, count: t.count })));
});

app.get("/api/tags/browse", async (c) => {
  const type = (c.req.query("type") ?? "tag").trim() || "tag";
  const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
  const sort = c.req.query("sort") === "name" ? "name" : "popular";
  const data = await browseTags(type, page, sort);
  return c.json({
    type,
    items: data.result.map((t) => ({ id: t.id, type: t.type, name: t.name, count: t.count })),
    page,
    num_pages: data.num_pages,
  });
});

// ---------------------------------------------------------------------------
// Media proxy — no direct links, no 302
// ---------------------------------------------------------------------------
app.get("/api/img", async (c) => {
  const path = c.req.query("path") ?? "";
  const kind = c.req.query("kind") === "image" ? "image" : "thumb";
  if (!isValidMediaPath(path)) return c.json({ error: "bad media path" }, 400);

  const { data, contentType } = await fetchMediaBuffer(path, kind);
  return new Response(data.buffer as ArrayBuffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(data.byteLength),
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// ---------------------------------------------------------------------------
// Download — real-time fetch every page and stream a ZIP to the client
// ---------------------------------------------------------------------------
app.get("/api/download/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id) || id <= 0) return c.json({ error: "invalid gallery id" }, 400);

  const g = await getGallery(id, authKey(c));
  const folder = sanitize(`${g.id} ${g.title.pretty || g.title.english || "gallery"}`)
    .slice(0, 80)
    .trim()
    .replace(/\.+$/, "") || String(g.id);

  const meta = JSON.stringify(
    {
      id: g.id,
      title: g.title,
      tags: g.tags.map((t) => ({ id: t.id, type: t.type, name: t.name })),
      num_pages: g.num_pages,
      num_favorites: g.num_favorites,
    },
    null,
    2,
  );

  const ext = (path: string) => path.split(".").pop()?.toLowerCase() || "jpg";

  const pageName = (p: { number: number; path: string }) =>
    `${folder}/${String(p.number).padStart(4, "0")}.${ext(p.path)}`;

  const entries = (async function* () {
    yield {
      name: `${folder}/meta.json`,
      open: async () => new TextEncoder().encode(meta) as Uint8Array,
    };
    yield* fetchPagesBuffered(g.pages, 4, pageName);
  })();

  const asciiName = (folder.replace(/[^\x20-\x7e]/g, "_").replace(/\s+/g, " ").trim() || String(g.id)).slice(0, 60);
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
  console.error("[eroeroero]", message);
  return c.json({ error: "internal error", detail: message }, 500);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function* fetchPagesBuffered(
  pages: PageInfo[],
  limit: number,
  nameFor: (p: PageInfo) => string,
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
          const { response, url } = await fetchMedia(pages[i].path, "image", {
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