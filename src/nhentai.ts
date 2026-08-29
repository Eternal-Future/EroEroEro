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

export async function searchTags(
  query: string,
  limit = 8,
): Promise<Tag[]> {
  const res = await fetch(`${BASE_URL}/api/v2/tags/search`, {
    method: "POST",
    headers: {
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new NhentaiError(res.status, `nhentai tags/search -> HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as Tag[];
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
): Promise<TagPage> {
  const q = new URLSearchParams({ sort, page: String(page), per_page: "24" });
  return fetchJson<TagPage>(`/api/v2/tags/${encodeURIComponent(type)}?${q.toString()}`);
}

export const VALID_SORTS: SortOrder[] = [
  "date",
  "popular",
  "popular-today",
  "popular-week",
  "popular-month",
];