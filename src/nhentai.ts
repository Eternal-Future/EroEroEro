import { BASE_URL, USER_AGENT } from "./env";
import type {
  CdnConfig,
  GalleryDetail,
  Paginated,
  GalleryListItem,
  SortOrder,
  Tag,
} from "./types";

export class NhentaiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "NhentaiError";
  }
}

interface Cached<T> {
  at: number;
  ttl: number;
  value: T;
}

const cache = new Map<string, Cached<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key) as Cached<T> | undefined;
  if (!hit) return undefined;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet<T>(key: string, value: T, ttl: number): void {
  cache.set(key, { at: Date.now(), ttl, value });
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
}

function headersWithAuth(key?: string): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT };
  if (key) h["Authorization"] = `Key ${key}`;
  return h;
}

async function fetchJson<T>(path: string, init?: RequestInit, key?: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...headersWithAuth(key), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NhentaiError(res.status, `nhentai ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export async function getCdnConfig(): Promise<CdnConfig> {
  const cached = cacheGet<CdnConfig>("cdn");
  if (cached) return cached;
  const cfg = await fetchJson<CdnConfig>("/api/v2/cdn");
  cacheSet("cdn", cfg, 10 * 60 * 1000);
  return cfg;
}

export async function searchGalleries(
  opts: { query?: string; tagId?: number; sort?: SortOrder; page?: number },
  key?: string,
): Promise<Paginated<GalleryListItem>> {
  const sort = opts.sort ?? "date";
  const page = opts.page ?? 1;
  if (opts.tagId) {
    const q = new URLSearchParams({
      tag_id: String(opts.tagId),
      sort,
      page: String(page),
      per_page: "25",
    });
    return fetchJson<Paginated<GalleryListItem>>(
      `/api/v2/galleries/tagged?${q.toString()}`,
      undefined,
      key,
    );
  }
  if (opts.query && opts.query.trim()) {
    const q = new URLSearchParams({
      query: opts.query.trim(),
      sort,
      page: String(page),
    });
    return fetchJson<Paginated<GalleryListItem>>(
      `/api/v2/search?${q.toString()}`,
      undefined,
      key,
    );
  }
  // Home feed (newest).
  const q = new URLSearchParams({ page: String(page), per_page: "25" });
  return fetchJson<Paginated<GalleryListItem>>(
    `/api/v2/galleries?${q.toString()}`,
    undefined,
    key,
  );
}

export async function getGallery(id: number, key?: string): Promise<GalleryDetail> {
  const cacheKey = `gallery:${id}`;
  const cached = cacheGet<GalleryDetail>(cacheKey);
  if (cached) return cached;
  const detail = await fetchJson<GalleryDetail>(`/api/v2/galleries/${id}`, undefined, key);
  cacheSet(cacheKey, detail, 5 * 60 * 1000);
  return detail;
}

async function rawSearchTags(
  query: string,
  limit = 8,
  type?: string,
): Promise<Tag[]> {
  const res = await fetch(`${BASE_URL}/api/v2/tags/search`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(type ? { query, limit, type } : { query, limit }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NhentaiError(res.status, `nhentai tags/search -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Tag[];
}

// First pages of every tag type, merged and cached. Used only as a fallback so
// that `tag:nh_only` can also match "males only" / "females only", which the
// official prefix search would miss.
const TAG_INDEX_TYPES = ["tag", "language", "artist", "character", "parody", "group", "category"];

async function tagIndex(): Promise<Tag[]> {
  const cached = cacheGet<Tag[]>("tag-index");
  if (cached) return cached;
  const all: Tag[] = [];
  const seen = new Set<number>();
  for (const type of TAG_INDEX_TYPES) {
    try {
      const page = await fetchJson<{ result: Tag[] }>(
        `/api/v2/tags/${type}?sort=popular&page=1&per_page=100`,
      );
      for (const tag of page.result ?? []) {
        if (!seen.has(tag.id)) {
          seen.add(tag.id);
          all.push(tag);
        }
      }
    } catch {
      // one failing type must not break the whole suggestion index
    }
  }
  cacheSet("tag-index", all, 10 * 60 * 1000);
  return all;
}

export async function searchTags(
  query: string,
  limit = 8,
  type?: string,
): Promise<Tag[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Tag[] = [];
  const seen = new Set<string>();
  const direct = await rawSearchTags(query, limit, type);
  for (const t of direct) {
    seen.add(`${t.type}:${t.id}`);
    out.push(t);
  }
  if (out.length < limit && !type) {
    const index = await tagIndex();
    for (const t of index) {
      const key = `${t.type}:${t.id}`;
      if (seen.has(key)) continue;
      if (t.name.toLowerCase().includes(q)) {
        seen.add(key);
        out.push(t);
        if (out.length >= limit) break;
      }
    }
  }
  return out.slice(0, limit);
}

export interface TagPage {
  result: Tag[];
  num_pages: number;
  per_page: number;
}

export async function browseTags(
  type: string,
  page = 1,
  sort: "name" | "popular" = "popular",
  perPage = 24,
): Promise<TagPage> {
  const q = new URLSearchParams({
    sort,
    page: String(page),
    per_page: String(perPage),
  });
  return fetchJson<TagPage>(`/api/v2/tags/${encodeURIComponent(type)}?${q.toString()}`);
}

export const VALID_SORTS: SortOrder[] = [
  "date",
  "popular",
  "popular-today",
  "popular-week",
  "popular-month",
];

/**
 * Translate aggregate search syntax into nhentai's native syntax.
 * - `tag:nh_foo` or `tag:nhentai_foo`  ->  `tag:"foo"`
 * - `tag:other_source_foo` is left untouched (future sources handle their own).
 * Underscores in the tag part are treated as spaces, so `tag:nh_big_breasts`
 * becomes `tag:"big breasts"`.
 */
export function translateNhQuery(query: string): string {
  const nhTag = /\btag:(nh|nhentai)_([A-Za-z0-9_]+)/g;
  const ownTag = /\btag:(?!")([A-Za-z0-9]+)\b/g;
  return query
    .replace(nhTag, (_m, _src, rest) => `tag:"${rest.replace(/_/g, " ")}"`)
    .replace(ownTag, (_m, rest) => `tag:"${rest.replace(/_/g, " ")}"`);
}