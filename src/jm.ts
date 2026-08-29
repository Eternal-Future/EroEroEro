import CryptoJS from "crypto-js";
import { USER_AGENT } from "./env";
import { debugLog } from "./debug";
import type {
  NormalizedGallery,
  NormalizedListItem,
  NormalizedSearchResult,
  NormalizedTag,
  BrowseResult,
  MediaFetchResult,
} from "./sources";

const SECRET = "185Hcomic3PAPP7R";
const VERSION = "2.1.4";
const APP_PACKAGE = "com.a7m3p9xv.t6qk2z8.app";

function env(name: string, fallback: string): string {
  const g = globalThis as any;
  const v = g.process?.env?.[name] ?? g[name];
  return typeof v === "string" && v ? v : fallback;
}

const JM_BASE = env("JM_BASE", "https://www.cdngwc.cc").replace(/\/+$/, "");
const JM_CDN_COVER = env("JM_CDN_COVER", "https://cdn-msp.jmapiproxy1.cc").replace(/\/+$/, "");

function md5Hex(s: string): string {
  return CryptoJS.MD5(s).toString();
}

function jmHeaders(ts: number): Record<string, string> {
  return {
    authorization: "",
    tokenparam: `${ts},${VERSION}`,
    token: md5Hex(String(ts) + SECRET),
    origin: "http://localhost",
    referer: "http://localhost",
    "x-requested-with": APP_PACKAGE,
    "user-agent": USER_AGENT,
  };
}

function aesDecryptEcbB64(ciphertext: string, keyHex: string): string {
  const key = CryptoJS.enc.Utf8.parse(keyHex);
  return CryptoJS.AES.decrypt(ciphertext, key, { mode: CryptoJS.mode.ECB }).toString(
    CryptoJS.enc.Utf8,
  );
}

async function jmFetchDecrypted(path: string): Promise<any> {
  const ts = Math.floor(Date.now() / 1000);
  const url = `${JM_BASE}${path}`;
  debugLog("[jm] GET", url);
  const res = await fetch(url, { headers: jmHeaders(ts) });
  if (!res.ok) throw new Error(`jm ${path} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json?.code !== 200 || typeof json?.data !== "string") {
    throw new Error(`jm bad response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const key = md5Hex(String(ts) + SECRET);
  const text = aesDecryptEcbB64(json.data, key);
  try {
    const payload = JSON.parse(text);
    debugLog(
      "[jm] payload",
      Array.isArray(payload) ? `array(${payload.length})` : `obj(total=${payload?.total},content=${payload?.content?.length})`,
    );
    return payload;
  } catch {
    throw new Error("jm decrypt failed");
  }
}

function coverUrl(id: string): string {
  return `${JM_CDN_COVER}/media/albums/${id}_3x4.jpg`;
}

function mapItem(it: any): NormalizedListItem {
  const id = String(it.id);
  return {
    id,
    title: it.name || `#${id}`,
    japanese_title: null,
    pages: 0,
    favorites: 0,
    thumb: { path: coverUrl(id), kind: "thumb" },
    variant: "jm",
    published: typeof it.update_at === "number" ? it.update_at : undefined,
  };
}

export async function jmSearch(opts: {
  query: string;
  page?: number;
}): Promise<NormalizedSearchResult> {
  const page = Math.max(1, opts.page ?? 1);
  const query = opts.query?.trim() ?? "";
  const path = query
    ? `/search?search_query=${encodeURIComponent(query)}&page=${page}&lang=TW`
    : `/latest?page=${page}&lang=TW`;

  const payload = await jmFetchDecrypted(path);
  const list = Array.isArray(payload) ? payload : payload.content ?? [];
  const total = !Array.isArray(payload) && payload.total ? Number(payload.total) : null;
  const items = (list as any[]).map(mapItem);
  return {
    items,
    num_pages: list.length === 80 ? page + 1 : page,
    per_page: 80,
    total,
  };
}

export async function jmGallery(id: string): Promise<NormalizedGallery> {
  const payload = await jmFetchDecrypted(`/comic_read?id=${encodeURIComponent(id)}&lang=TW`);
  const name = payload.name || `#${id}`;
  const images = Array.isArray(payload.images) ? payload.images : [];
  const pages = images.map((img: any, idx: number) => ({
    number: typeof img.page === "number" ? img.page : idx + 1,
    path: String(img.image ?? ""),
    width: 0,
    height: 0,
    thumbnail: String(img.image ?? ""),
    thumbnail_width: 0,
    thumbnail_height: 0,
  }));

  return {
    id,
    title: name,
    japanese_title: null,
    pretty: name,
    scanlator: payload.author ?? "",
    upload_date: 0,
    num_pages: Number(payload.total_page ?? pages.length) || pages.length,
    num_favorites: 0,
    cover: { path: coverUrl(id), width: 0, height: 0 },
    thumbnail: { path: coverUrl(id), width: 0, height: 0 },
    tags: payload.author
      ? [{ id: `artist:${payload.author}`, type: "artist", name: payload.author, count: 0 }]
      : [],
    pages,
    variant: "jm",
  };
}

export async function jmFetchMedia(
  path: string,
  kind: "image" | "thumb",
): Promise<MediaFetchResult> {
  if (!path.startsWith("https://")) throw new Error("bad jm media path");
  debugLog("[jm] fetch", kind, path.slice(0, 90));
  const res = await fetch(path, {
    headers: { "user-agent": USER_AGENT, referer: "http://localhost" },
  });
  if (!res.ok) throw new Error(`jm media -> HTTP ${res.status}`);
  return { response: res };
}

export async function jmTags(_query: string, _limit: number): Promise<NormalizedTag[]> {
  return [];
}

export async function jmBrowseTags(_type: string, _page: number): Promise<BrowseResult> {
  return { items: [], num_pages: 1, per_page: 24 };
}