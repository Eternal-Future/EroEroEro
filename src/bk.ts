import CryptoJS from "crypto-js";
import { USER_AGENT } from "./env";
import { debugLog } from "./debug";
import { ehGet, ehPut, ehDel } from "./ehstore";
import { mediaHostSuffixes, hostOf, mediaUrlRejection, MediaUrlError } from "./media";
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

// PicAcg hands out image URLs on storage hosts. BK_MEDIA_HOSTS can pin them;
// otherwise any public https host passes, because the /img URL signature
// already limits requests to paths this server handed out.
function bkMediaHosts(): string[] {
  const pinned = mediaHostSuffixes("BK_MEDIA_HOSTS");
  if (!pinned.length) return [];
  const configured = hostOf(BK_API_BASE);
  return configured ? [...pinned, configured] : pinned;
}

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

async function getToken(): Promise<string> {
  // An explicitly configured token always wins: otherwise a stale cached value
  // would keep overriding a freshly set BK_TOKEN.
  const fromEnv = env("BK_TOKEN", "");
  if (fromEnv) return fromEnv;
  return (await ehGet("bk_token")) ?? "";
}

async function saveToken(token: string): Promise<void> {
  await ehPut("bk_token", token);
}

async function clearToken(): Promise<void> {
  await ehDel("bk_token");
}

async function signIn(email: string, password: string): Promise<string> {
  const r = await bkRequest("POST", "auth/sign-in", { email, password }, "");
  if (r.code !== 200 || !r.data?.token) {
    throw new Error(`bk login failed -> ${r.code ?? "unknown"} ${r.message ?? ""}`.trim());
  }
  await saveToken(r.data.token as string);
  return r.data.token as string;
}

// One in-flight login per isolate. Concurrent requests used to fire their own
// sign-in, which both wasted a request and fought over the stored token.
let loginPromise: Promise<string> | null = null;

function ensureToken(): Promise<string> {
  if (loginPromise) return loginPromise;
  const p = (async () => {
    const existing = await getToken();
    if (existing) return existing;
    const email = env("BK_EMAIL", "");
    const password = env("BK_PASSWORD", "");
    if (!email || !password) {
      throw new Error("bk login requires BK_EMAIL and BK_PASSWORD (or BK_TOKEN)");
    }
    return signIn(email, password);
  })();
  loginPromise = p;
  p.catch(() => {}).finally(() => {
    if (loginPromise === p) loginPromise = null;
  });
  return p;
}

/** Drop the stored token and sign in again; returns null when impossible. */
let refreshPromise: Promise<string | null> | null = null;

function refreshToken(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;
  const p = (async () => {
    await clearToken();
    const email = env("BK_EMAIL", "");
    const password = env("BK_PASSWORD", "");
    if (!email || !password) return null;
    try {
      debugLog("[bk] signing in again after an auth failure");
      return await signIn(email, password);
    } catch (err) {
      debugLog("[bk] re-login failed:", err instanceof Error ? err.message : String(err));
      return null;
    }
  })();
  refreshPromise = p;
  p.catch(() => {}).finally(() => {
    if (refreshPromise === p) refreshPromise = null;
  });
  return p;
}

interface BkResponse {
  status: number;
  ok: boolean;
  code?: number;
  message?: string;
  data: any;
}

async function bkRequest(
  method: string,
  urlDir: string,
  jsonBody?: Record<string, unknown>,
  authorization?: string,
): Promise<BkResponse> {
  const res = await fetch(BK_API_BASE + urlDir, {
    method,
    headers: makeHeaders(urlDir, method, authorization || undefined),
    body: jsonBody ? JSON.stringify(jsonBody) : undefined,
  });
  let payload: any = null;
  try {
    payload = await res.json();
  } catch {
    // non-JSON error page; status is all we have
  }
  return {
    status: res.status,
    ok: res.ok,
    code: typeof payload?.code === "number" ? payload.code : undefined,
    message: payload?.message ?? payload?.error ?? "",
    data: payload?.data,
  };
}

/** PicAcg reports auth problems either as HTTP 401/403 or as `code` 401/403. */
function isAuthFailure(r: BkResponse): boolean {
  if (r.status === 401 || r.status === 403) return true;
  if (r.code === 401 || r.code === 403) return true;
  const msg = String(r.message ?? "").toLowerCase();
  return /unauthor|not\s*log|未登[入录]|登录(失效|过期)|token\s*(expire|invalid|not)|invalid\s*token/.test(msg);
}

async function bkApi(
  method: string,
  urlDir: string,
  jsonBody?: Record<string, unknown>,
  token?: string,
  retried = false,
): Promise<any> {
  const authorization = token || (await ensureToken());
  const r = await bkRequest(method, urlDir, jsonBody, authorization);

  if (isAuthFailure(r) && !retried) {
    // Cached tokens expire; without this retry a stale value 401s forever
    // because it is persisted in the KV store. Exactly one retry per request:
    // a fresh token that is still rejected means the account/token itself is
    // not usable, and signing in repeatedly would just loop.
    const fresh = await refreshToken();
    if (fresh && fresh !== authorization) {
      return bkApi(method, urlDir, jsonBody, fresh, true);
    }
  }

  if (r.status === 401 || r.status === 403) {
    throw new Error(`bk ${urlDir} -> HTTP ${r.status}${r.message ? ` ${r.message}` : ""}`);
  }
  if (!r.ok) throw new Error(`bk ${urlDir} -> HTTP ${r.status}`);
  if (r.code !== 200) {
    throw new Error(`bk ${urlDir} -> ${r.code ?? "unknown"} ${r.message}`.trim());
  }
  return r.data;
}

function pictureUrl(pic: any): string {
  const server = String(pic?.fileServer ?? "")
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
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
  const token = await ensureToken();
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
  const token = await ensureToken();
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
        // Skip pages the API returned without an image URL before numbering, so
        // the page/ZIP numbering stays contiguous.
        if (!url) continue;
        number += 1;
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
  const rejection = mediaUrlRejection(path, bkMediaHosts());
  if (rejection) throw new MediaUrlError(`bk ${rejection}`);
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