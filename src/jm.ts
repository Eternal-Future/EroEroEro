import CryptoJS from "crypto-js";
import webpDecode, { init as webpDecInit } from "@jsquash/webp/decode.js";
import webpEncode, { init as webpEncInit } from "@jsquash/webp/encode.js";
import webpDecWasm from "@jsquash/webp/codec/dec/webp_dec.wasm";
import webpEncWasm from "@jsquash/webp/codec/enc/webp_enc.wasm";
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
  const scrambleId = String(payload.scramble_id ?? "");
  const images = Array.isArray(payload.images) ? payload.images : [];
  const pages = images.map((img: any, idx: number) => {
    const base = String(img.image ?? "");
    const url = base && scrambleId ? `${base}${base.includes("?") ? "&" : "?"}scramble_id=${encodeURIComponent(scrambleId)}` : base;
    return {
      number: typeof img.page === "number" ? img.page : idx + 1,
      path: url,
      width: 0,
      height: 0,
      thumbnail: url,
      thumbnail_width: 0,
      thumbnail_height: 0,
    };
  });

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

  try {
    const url = new URL(path);
    const scrambleId = url.searchParams.get("scramble_id");
    if (!scrambleId) return { response: res };

    const seg = url.pathname.split("/").filter(Boolean);
    const filename = seg[seg.length - 1] ?? "";
    const aid = seg.length >= 2 ? seg[seg.length - 2] : "";
    const num = jmSegments(Number(scrambleId) || 0, Number(aid) || 0, filename);
    if (num === 0) return { response: res };

    const buffer = await res.arrayBuffer();
    await ensureJmWasm();
    const decoded = await webpDecode(buffer);
    const reordered = reorderRgba(decoded, num);
    const encoded = await webpEncode(reordered, { quality: 90 });
    return {
      response: new Response(new Uint8Array(encoded).buffer as ArrayBuffer, {
        headers: {
          "Content-Type": res.headers.get("content-type") || "image/webp",
          "Content-Length": String(encoded.byteLength),
        },
      }),
    };
  } catch (err) {
    debugLog("[jm] reorder skipped", err instanceof Error ? err.message : String(err));
    return { response: res };
  }
}

function jmSegments(scrambleId: number, aid: number, filename: string): number {
  if (aid < scrambleId) return 0;
  if (aid < 268850) return 10;
  const x = aid < 421926 ? 10 : 8;
  const stem = filename.replace(/\.[^.]+$/, "");
  const md5 = CryptoJS.MD5(`${aid}${stem}`).toString();
  const last = md5.charCodeAt(md5.length - 1) % x;
  return last * 2 + 2;
}

let jmWasmReady: Promise<[unknown, unknown]> | null = null;
function ensureJmWasm(): Promise<[unknown, unknown]> {
  if (!jmWasmReady) {
    jmWasmReady = Promise.all([
      webpDecInit({ locateFile: () => webpDecWasm }),
      webpEncInit({ locateFile: () => webpEncWasm }),
    ]);
  }
  return jmWasmReady;
}

function reorderRgba(img: ImageData, num: number): ImageData {
  const w = img.width;
  const h = img.height;
  const src = new Uint8ClampedArray(img.data);
  const dst = new Uint8ClampedArray(w * h * 4);
  const rowBytes = w * 4;
  const over = h % num;

  for (let i = 0; i < num; i++) {
    const move = Math.floor(h / num);
    const ySrc = h - move * (i + 1) - over;
    const yDst = move * i + (i === 0 ? 0 : over);
    const segH = i === 0 ? move + over : move;
    src.subarray(ySrc * rowBytes, (ySrc + segH) * rowBytes).forEach((v, k) => {
      dst[yDst * rowBytes + k] = v;
    });
  }
  return new ImageData(dst, w, h);
}

export async function jmTags(_query: string, _limit: number): Promise<NormalizedTag[]> {
  return [];
}

export async function jmBrowseTags(_type: string, _page: number): Promise<BrowseResult> {
  return { items: [], num_pages: 1, per_page: 24 };
}