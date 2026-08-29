import {
  browseTags,
  getCdnConfig,
  getGallery,
  rawSearchTags,
  searchGalleries,
  searchTags,
  translateNhQuery,
} from "./nhentai";
import { fetchMedia as fetchMediaWithServers, serverOrigin } from "./media";
import { searchEh, ehGallery, ehFetchMedia, ehBrowseTags } from "./ehentai";
import { suggestEhTags, ehKeysForLocalizedQuery, ehCanonicalTagsFor } from "./ehtags";
import type { SortOrder } from "./types";

// ---------------------------------------------------------------------------
// Source-agnostic shapes. Every future source implements SourceAdapter and
// returns these normalized shapes, so the web app never talks to a source
// directly.
// ---------------------------------------------------------------------------
export interface NormalizedThumb {
  path: string;
  kind: "image" | "thumb";
  width?: number;
  height?: number;
}

export interface NormalizedListItem {
  id: number | string;
  title: string;
  japanese_title?: string | null;
  pages: number;
  favorites: number;
  thumb: NormalizedThumb;
  variant?: string;
  /** Unix seconds when the gallery was published, if the source exposes it. */
  published?: number;
}

export interface NormalizedSearchResult {
  items: NormalizedListItem[];
  num_pages: number;
  per_page: number;
  total: number | null;
}

export interface NormalizedTag {
  id: number | string;
  type: string;
  name: string;
  slug?: string;
  count?: number;
}

export interface NormalizedPage {
  number: number;
  path: string;
  width: number;
  height: number;
  thumbnail: string;
  thumbnail_width: number;
  thumbnail_height: number;
}

export interface NormalizedGallery {
  id: number | string;
  title: string;
  japanese_title: string | null;
  pretty: string;
  scanlator: string;
  upload_date: number;
  num_pages: number;
  num_favorites: number;
  cover: { path: string; width: number; height: number };
  thumbnail: { path: string; width: number; height: number };
  tags: NormalizedTag[];
  pages: NormalizedPage[];
  variant?: string;
}

export interface SearchOptions {
  query?: string;
  tagId?: string | number;
  tagName?: string;
  sort?: string;
  page?: number;
  key?: string;
}

export interface BrowseResult {
  items: NormalizedTag[];
  num_pages: number;
  per_page: number;
}

export interface MediaFetchResult {
  response: Response;
  serverHint?: string;
}

export interface SourceAdapter {
  id: string;
  name: string;
  search(opts: SearchOptions): Promise<NormalizedSearchResult>;
  gallery(id: string, key?: string): Promise<NormalizedGallery>;
  tags(query: string, limit: number, type?: string): Promise<NormalizedTag[]>;
  browseTags(type: string, page: number, sort?: string): Promise<BrowseResult>;
  fetchMedia(path: string, kind: "image" | "thumb", preferredServer?: string): Promise<MediaFetchResult>;
}

// ---------------------------------------------------------------------------
// nhentai adapter
// ---------------------------------------------------------------------------
const nhAdapter: SourceAdapter = {
  id: "nh",
  name: "nhentai",

  async search(opts) {
    let query = opts.query ? translateNhQuery(opts.query) : undefined;
    if (opts.tagName) {
      query = `tag:"${String(opts.tagName).replace(/"/g, "")}"`;
    }
    const tagId =
      opts.tagId !== undefined && opts.tagId !== "" && Number.isFinite(Number(opts.tagId))
        ? Number(opts.tagId)
        : undefined;
    const data = await searchGalleries(
      { query, tagId, sort: opts.sort as SortOrder, page: opts.page ?? 1 },
      opts.key,
    );
    return {
      items: data.result.map((r) => ({
        id: r.id,
        title: r.english_title || r.japanese_title || `#${r.id}`,
        japanese_title: r.japanese_title,
        pages: r.num_pages,
        favorites: r.num_favorites,
        thumb: {
          path: r.thumbnail,
          kind: "thumb" as const,
          width: r.thumbnail_width,
          height: r.thumbnail_height,
        },
        variant: "nh",
      })),
      num_pages: data.num_pages,
      per_page: data.per_page,
      total: data.total,
    };
  },

  async gallery(id, key) {
    const g = await getGallery(Number(id), key);
    const en = g.title.english || g.title.pretty || `#${g.id}`;
    const jp = g.title.japanese ?? null;
    return {
      id: g.id,
      title: jp || en,
      japanese_title: jp ? en : null,
      pretty: g.title.pretty,
      scanlator: g.scanlator ?? "",
      upload_date: g.upload_date,
      num_pages: g.num_pages,
      num_favorites: g.num_favorites,
      cover: g.cover,
      thumbnail: g.thumbnail,
      variant: "nh",
      tags: g.tags.map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        slug: t.slug,
        count: t.count,
      })),
      pages: g.pages.map((p) => ({
        number: p.number,
        path: p.path,
        width: p.width,
        height: p.height,
        thumbnail: p.thumbnail,
        thumbnail_width: p.thumbnail_width,
        thumbnail_height: p.thumbnail_height,
      })),
    };
  },

  async tags(query, limit, type) {
    const tags: NormalizedTag[] = [];
    const seen = new Set<string>();
    const push = (t: { id: number | string; type: string; name: string; slug?: string; count?: number }) => {
      const key = `${t.type}:${t.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      tags.push(t);
    };
    for (const t of await searchTags(query, limit, type)) push(t);

    // If nhentai's own prefix search had room, reuse EhTagTranslation keys:
    // a Chinese (or other localized) query matches an EH tag, then we resolve
    // that tag's canonical name against nhentai to keep the real tag id.
    if (tags.length < limit) {
      try {
        const keys = await ehKeysForLocalizedQuery(query, limit * 2);
        for (const key of keys) {
          if (tags.length >= limit) break;
          const direct = await rawSearchTags(key, 1);
          for (const t of direct) push(t);
        }
      } catch {
        // localization fallback is best-effort
      }
    }
    return tags.slice(0, limit);
  },

  async browseTags(type, page, sort) {
    const data = await browseTags(type, page, sort === "name" ? "name" : "popular");
    return {
      items: data.result.map((t) => ({
        id: t.id,
        type: t.type,
        name: t.name,
        slug: t.slug,
        count: t.count,
      })),
      num_pages: data.num_pages,
      per_page: data.per_page,
    };
  },

  async fetchMedia(path, kind, preferredServer) {
    const cfg = await getCdnConfig();
    const servers = kind === "image" ? cfg.image_servers : cfg.thumb_servers;
    const fm = await fetchMediaWithServers(path, servers, {
      preferredServer,
      timeoutMs: 12000,
    });
    return { response: fm.response, serverHint: serverOrigin(fm.url) };
  },
};

// ---------------------------------------------------------------------------
// e-hentai adapter (exhentai first, falls back to e-hentai)
// ---------------------------------------------------------------------------
const ehAdapter: SourceAdapter = {
  id: "eh",
  name: "e-hentai",

  async search(opts) {
    let query = opts.query ?? "";
    if (opts.tagId) {
      // canonical id like "language:chinese" or "male:yaoi"
      query = String(opts.tagId);
    } else if (opts.tagName) {
      const canonical = await ehCanonicalTagsFor(String(opts.tagName), 1);
      query = canonical[0] ?? String(opts.tagName);
    }
    return searchEh({ query, page: opts.page ?? 1 });
  },

  async gallery(id) {
    return ehGallery(id);
  },

  async tags(query, limit) {
    return suggestEhTags(query, limit);
  },

  async browseTags(type, page) {
    return ehBrowseTags(type, page);
  },

  async fetchMedia(path, kind) {
    return ehFetchMedia(path, kind);
  },
};

const registry: Record<string, SourceAdapter> = {
  nh: nhAdapter,
  nhentai: nhAdapter,
  eh: ehAdapter,
  ehentai: ehAdapter,
  "e-hentai": ehAdapter,
  exhentai: ehAdapter,
};

export function getSource(name: string): SourceAdapter | undefined {
  return registry[name?.toLowerCase()];
}

export function listSources(): Array<{ id: string; name: string }> {
  return [
    { id: "nh", name: "nhentai" },
    { id: "eh", name: "e-hentai" },
  ];
}

export function buildMediaUrl(source: string, path: string, kind: "image" | "thumb"): string {
  return `/api/source/${source}/img?path=${encodeURIComponent(path)}&kind=${kind}`;
}