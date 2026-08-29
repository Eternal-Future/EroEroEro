import {
  browseTags,
  getCdnConfig,
  getGallery,
  searchGalleries,
  searchTags,
  translateNhQuery,
} from "./nhentai";
import type { SortOrder } from "./types";

// ---------------------------------------------------------------------------
// Source-agnostic shapes. Every future source (pixiv, hitomi, ...) implements
// SourceAdapter and returns these normalized shapes, so the web app never
// talks to a source directly.
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

export interface SourceAdapter {
  id: string;
  name: string;
  search(opts: SearchOptions): Promise<NormalizedSearchResult>;
  gallery(id: string, key?: string): Promise<NormalizedGallery>;
  tags(query: string, limit: number, type?: string): Promise<NormalizedTag[]>;
  browseTags(type: string, page: number, sort?: string): Promise<BrowseResult>;
  mediaServers(kind: "image" | "thumb"): Promise<string[]>;
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
      })),
      num_pages: data.num_pages,
      per_page: data.per_page,
      total: data.total,
    };
  },

  async gallery(id, key) {
    const g = await getGallery(Number(id), key);
    return {
      id: g.id,
      title: g.title.english || g.title.pretty || `#${g.id}`,
      japanese_title: g.title.japanese,
      pretty: g.title.pretty,
      scanlator: g.scanlator ?? "",
      upload_date: g.upload_date,
      num_pages: g.num_pages,
      num_favorites: g.num_favorites,
      cover: g.cover,
      thumbnail: g.thumbnail,
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
    const tags = await searchTags(query, limit, type);
    return tags.map((t) => ({
      id: t.id,
      type: t.type,
      name: t.name,
      slug: t.slug,
      count: t.count,
    }));
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

  async mediaServers(kind) {
    const cfg = await getCdnConfig();
    return kind === "image" ? cfg.image_servers : cfg.thumb_servers;
  },
};

const registry: Record<string, SourceAdapter> = {
  nh: nhAdapter,
  nhentai: nhAdapter,
};

export function getSource(name: string): SourceAdapter | undefined {
  return registry[name?.toLowerCase()];
}

export function listSources(): Array<{ id: string; name: string }> {
  return [{ id: "nh", name: "nhentai" }];
}

export function buildMediaUrl(source: string, path: string, kind: "image" | "thumb"): string {
  return `/api/source/${source}/img?path=${encodeURIComponent(path)}&kind=${kind}`;
}