import CryptoJS from "crypto-js";
import { USER_AGENT } from "./env";
import { debugLog } from "./debug";
import { ehGet, ehPut } from "./ehstore";
import type {
  NormalizedGallery,
  NormalizedListItem,
  NormalizedSearchResult,
  NormalizedTag,
  BrowseResult,
  MediaFetchResult,
} from "./sources";

const APP_CHANNEL = "1";
const APP_PLATFORM = "android";
const APP_VERSION = "20251017";
const APP_UUID = "webUUIDv2";
const API_SECRET = "C69BAF41DA5ABD1FFEDC6D2FEA56B";
const KEY_SECRET = "~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn\0";

function env(name: string, fallback: string): string {
  const g = globalThis as any;
  const v = g.process?.env?.[name] ?? g[name];
  return typeof v === "string" && v ? v : fallback;
}

const BK_API_BASE = env("BK_API_BASE", "https://picaapi.go2778.com/").replace(/\/+$/, "") + "/";
const BK_IMAGE_QUALITY = env("BK_IMAGE_QUALITY", "original");

function bytes(str: string): Uint8Array {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
}

function bytesToHex(b: Uint8Array): string {
  let h = "";
  for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
  return h;
}

function hexToBytes(hex: string): Uint8Array {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function sha256Hex(parts: Uint8Array[]): string {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    joined.set(p, off);
    off += p.length;
  }
  return CryptoJS.SHA256(CryptoJS.lib.WordArray.create(joined)).toString();
}

// key strings derived from the secret like the reference implementation
const KEY_A = Uint8Array.from(bytes(KEY_SECRET), (b) => (b ^ 92) & 0xff);
const KEY_B = Uint8Array.from(bytes(KEY_SECRET), (b) => (b ^ 54) & 0xff);

const NONCE_ALPHABET = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678";
function randomNonce(): string {
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += NONCE_ALPHABET[Math.floor(Math.random() * NONCE_ALPHABET.length)];
  }
  return s;
}

function makeSignature(urlDir: string, stime: string, method: string, nonce: string): string {
  const ready = (urlDir + stime + nonce + method + API_SECRET).toLowerCase();
  const rb = bytes(ready);
  const c = hexToBytes(sha256Hex([KEY_B, rb]));
  return sha256Hex([KEY_A, c]);
}

function makeHeaders(urlDir: string, method: string, authorization?: string): Record<string, string> {
  const stime = String(Math.floor(Date.now() / 1000));
  const nonce = randomNonce();
  const h: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.picacomic.com.v1+json",
    "Accept-Language": "zh-CN, zh; q=0.9, en; q=0.8",
    "App-Channel": APP_CHANNEL,
    "App-Platform": APP_PLATFORM,
    "App-Uuid": APP_UUID,
    "App-Version": APP_VERSION,
    Time: stime,
    "Image-Quality": BK_IMAGE_QUALITY,
    "Content-Type": "application/json; charset=UTF-8",
    Nonce: nonce,
    Signature: makeSignature(urlDir, stime, method, nonce),
    Origin: "https://manhuabika.com",
    Referer: "https://manhuabika.com/",
  };
  if (authorization) h.Authorization = authorization;
  return h;
}

async function getToken(): Promise<string | undefined> {
  const cached = await ehGet("bk_token");
  if (cached) return cached;
  return env("BK_TOKEN", "");
}

async function saveToken(token: string): Promise<void> {
  await ehPut("bk_token", token);
}

async function login(): Promise<string> {
  const existing = await getToken();
  if (existing) return existing;
  const email = env("BK_EMAIL", "");
  const password = env("BK_PASSWORD", "");
  if (!email || !password) throw new Error("bk login requires BK_EMAIL and BK_PASSWORD (or BK_TOKEN)");
  const data = await bkApi("POST", "auth/sign-in", { email, password }, undefined);
  const token = data?.token;
  if (!token) throw new Error("bk login failed");
  await saveToken(token);
  return token;
}

async function bkApi(
  method: string,
  urlDir: string,
  jsonBody?: Record<string, unknown>,
  token?: string,
): Promise<any> {
  const authorization = token ?? (await getToken());
  const res = await fetch(BK_API_BASE + urlDir, {
    method,
    headers: makeHeaders(urlDir, method, authorization),
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  if (!res.ok) throw new Error(`bk ${urlDir} -> HTTP ${res.status}`);
  const j = await res.json();
  if (j?.code !== 200) throw new Error(`bk ${urlDir} -> ${j?.code ?? "unknown"} ${j?.message ?? j?.error ?? ""}`);
  return j.data;
}

function pictureUrl(pic: any): string {
  const server = String(pic?.fileServer ?? "").replace(/https?:\/\//, "").replace(/\/+$/, "");
  const path = String(pic?.path ?? "").replace(/^\/+/, "");
  if (!server || !path) return "";
  const s = `https://${server}/static/${path}`.replace(/\/\/static\//, "/static/");
  return s;
}

function mapComic(it: any): NormalizedListItem {
  const id = String(it._id ?? it.id);
  return {
    id,
    title: it.title || `#${id}`,
    japanese_title: null,
    pages: it.pagesCount ?? 0,
    favorites: it.likesCount ?? it.totalLikes ?? 0,
    thumb: { path: pictureUrl(it.thumb), kind: "thumb" },
    variant: "bk",
    published: typeof it.updated_at === "number" ? it.updated_at : undefined,
  };
}

function pageMeta(info: any) {
  return {
    docs: Array.isArray(info?.docs) ? info.docs : (info?.comics ?? info?.eps ?? info?.pages ?? info?.comments ?? []),
    pages: Number(info?.pages ?? 1),
    total: Number(info?.total ?? 0),
    page: Number(info?.page ?? 1),
  };
}

export async function bkSearch(opts: { query: string; page?: number }): Promise<NormalizedSearchResult> {
  const token = await login();
  const page = Math.max(1, opts.page ?? 1);
  const body = { keyword: opts.query.trim(), sort: "dd" };
  const res = await bkApi("POST", `comics/advanced-search?page=${page}&s=dd`, body, token);
  const meta = res?.comics ?? {};
  const docs = Array.isArray(meta.docs) ? meta.docs : [];
  return {
    items: docs.map(mapComic),
    num_pages: Number(meta.pages ?? 1),
    per_page: Number(meta.limit ?? 20),
    total: Number(meta.total ?? 0),
  };
}

export async function bkGallery(id: string): Promise<NormalizedGallery> {
  const token = await login();
  const detail = await bkApi("GET", `comics/${id}`, undefined, token);
  const comic = detail?.comic ?? {};
  const name = comic.title || `#${id}`;

  // collect eps
  const eps: any[] = [];
  let epsPage = 1;
  let epsPages = 1;
  do {
    const data = await bkApi("GET", `comics/${id}/eps?page=${epsPage}`, undefined, token);
    const meta = pageMeta(data?.eps);
    epsPages = meta.pages || 1;
    eps.push(...meta.docs);
    epsPage++;
  } while (epsPage <= epsPages && epsPage <= 50);

  eps.sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));

  const pages: NormalizedGallery["pages"] = [];
  let number = 0;
  for (const ep of eps) {
    const order = Number(ep.order ?? 1);
    let page = 1;
    let pagesCount = 1;
    do {
      const data = await bkApi("GET", `comics/${id}/order/${order}/pages?page=${page}`, undefined, token);
      const meta = pageMeta(data?.pages);
      pagesCount = meta.pages || 1;
      for (const img of meta.docs) {
        const url = pictureUrl(img?.media);
        number += 1;
        if (!url) continue;
        pages.push({
          number,
          path: url,
          width: 0,
          height: 0,
          thumbnail: url,
          thumbnail_width: 0,
          thumbnail_height: 0,
        });
      }
      page++;
    } while (page <= pagesCount && page <= 50);
  }

  return {
    id,
    title: name,
    japanese_title: null,
    pretty: name,
    scanlator: comic.author ?? "",
    upload_date: 0,
    num_pages: pages.length || Number(comic.pagesCount ?? 0),
    num_favorites: Number(comic.likesCount ?? comic.totalLikes ?? 0),
    cover: { path: pictureUrl(comic.thumb), width: 0, height: 0 },
    thumbnail: { path: pictureUrl(comic.thumb), width: 0, height: 0 },
    tags: (comic.tags ?? []).map((t: string, i: number) => ({
      id: `tag:${t}`,
      type: "tag",
      name: t,
      count: 0,
    })),
    pages,
    variant: "bk",
  };
}

export async function bkFetchMedia(
  path: string,
  _kind: "image" | "thumb",
): Promise<MediaFetchResult> {
  if (!path.startsWith("https://")) throw new Error("bad bk media path");
  debugLog("[bk] fetch", path.slice(0, 90));
  const res = await fetch(path, {
    headers: {
      "user-agent": USER_AGENT,
      referer: "https://manhuabika.com/",
    },
  });
  if (!res.ok) throw new Error(`bk media -> HTTP ${res.status}`);
  return { response: res };
}

export async function bkTags(_query: string, _limit: number): Promise<NormalizedTag[]> {
  return [];
}

export async function bkBrowseTags(_type: string, _page: number): Promise<BrowseResult> {
  return { items: [], num_pages: 1, per_page: 24 };
}