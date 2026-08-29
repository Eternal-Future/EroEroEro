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

export interface EhPersistState {
  igneous?: string | null;
  blocked?: boolean;
  at?: number;
}

type AcquireFetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface PersistBridge {
  readState(): Promise<EhPersistState | null>;
  writeState(state: EhPersistState): Promise<void>;
}

let acquireFetcher: AcquireFetcher | null = null;
let persistBridge: PersistBridge | null = null;
let memoryState: EhPersistState | null = null;
let loaded = false;
let requestEnv: Record<string, string> | null = null;

export function setEhAcquireFetcher(fn: AcquireFetcher): void {
  acquireFetcher = fn;
}

export function setEhPersistBridge(bridge: PersistBridge): void {
  persistBridge = bridge;
}

/** Bind Worker/Edge env (c.env) for this request/isolate. Node uses process.env. */
export function setEhRequestEnv(env: Record<string, unknown> | null | undefined): void {
  if (!env) return;
  const copy: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") copy[k] = v;
  }
  requestEnv = copy;
}

function env(name: string): string | undefined {
  if (requestEnv && requestEnv[name] !== undefined) return requestEnv[name];
  const g = globalThis as any;
  return g.process?.env?.[name] ?? g[name];
}

export class EhError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "EhError";
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function load(): Promise<EhPersistState | null> {
  if (loaded) return memoryState;
  loaded = true;
  if (persistBridge) {
    try {
      memoryState = await persistBridge.readState();
    } catch {
      memoryState = null;
    }
  }
  try {
    const raw = await ehGet("eh_state");
    if (!memoryState && raw) memoryState = JSON.parse(raw) as EhPersistState;
  } catch {
    // storage unavailable; fall back to memory/env
  }
  const override = env("EHENTAI_IGNEOUS");
  if (override) {
    memoryState = { igneous: override, blocked: false, at: Date.now() };
  }
  return memoryState;
}

async function saveState(state: EhPersistState): Promise<void> {
  memoryState = state;
  if (persistBridge) {
    try {
      await persistBridge.writeState(state);
    } catch {
      // best effort
    }
  }
  try {
    await ehPut("eh_state", JSON.stringify(state));
  } catch {
    // best effort
  }
}

function baseCookie(): string {
  return env("EHENTAI_COOKIE") ?? "";
}

function cookieFor(mode: "exh" | "eh"): string {
  const parts: string[] = [];
  if (baseCookie()) parts.push(baseCookie());
  if (mode === "exh" && memoryState?.igneous) parts.push(`igneous=${memoryState.igneous}`);
  return parts.join("; ");
}

function headersFor(mode: "exh" | "eh", extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "User-Agent": USER_AGENT, ...extra };
  const cookie = cookieFor(mode);
  if (cookie) h["Cookie"] = cookie;
  return h;
}

async function acquireIgneous(): Promise<string | null> {
  const cookie = baseCookie();
  if (!cookie) {
    debugLog("[eh] acquireIgneous: no EHENTAI_COOKIE configured");
    return null;
  }

  const url = `https://exhentai.org/?_=${Date.now()}`;
  debugLog("[eh] acquireIgneous: fetching", url, "via", acquireFetcher ? "proxy" : "direct");
  const res = await (acquireFetcher ?? fetch)(url, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookie },
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const headerCookie = res.headers.get("set-cookie") ?? "";
  const all = setCookies.length ? setCookies.join("; ") : headerCookie;
  const m = all.match(/igneous=([^;]+)/);
  const ig = m ? m[1].trim() : "";
  debugLog("[eh] acquireIgneous: status", res.status, "igneous", ig ? `${ig.slice(0, 4)}...` : "(none)");
  if (ig && ig.toLowerCase() !== "mystery") {
    await saveState({ igneous: ig, blocked: false, at: Date.now() });
    return ig;
  }
  await saveState({ igneous: null, blocked: true, at: Date.now() });
  return null;
}

async function tryExh(path: string): Promise<string | null> {
  await load();
  if (!memoryState?.igneous) {
    if (memoryState?.blocked) return null;
    const ig = await acquireIgneous();
    if (!ig) return null;
  }

  const url = `https://exhentai.org${path}`;
  debugLog("[eh] tryExh", path);

  const fetchExh = async (): Promise<string | null> => {
    const res = await fetch(url, { headers: headersFor("exh") });
    if (res.ok) return await res.text();
    // Any exhentai failure (redirect to e-hentai, denied access, missing
    // gallery, rate limit, 5xx) should fall back to e-hentai instead of
    // failing the whole request.
    debugLog("[eh] tryExh fallback", path, "status", res.status);
    return null;
  };

  try {
    return await fetchExh();
  } catch (err) {
    // network failure or igneous expired: try to refresh once, then fall back
    debugLog("[eh] tryExh failed, refreshing igneous:", err instanceof Error ? err.message : String(err));
    const ig = await acquireIgneous();
    if (!ig) return null;
    try {
      return await fetchExh();
    } catch (err2) {
      debugLog("[eh] tryExh retry failed:", err2 instanceof Error ? err2.message : String(err2));
      return null;
    }
  }
}

async function fetchEh(path: string): Promise<string> {
  const res = await fetch(`https://e-hentai.org${path}`, { headers: headersFor("eh") });
  if (!res.ok) throw new EhError(res.status, `e-hentai ${path} -> HTTP ${res.status}`);
  return res.text();
}

function parseList(html: string, variant: "exh" | "eh"): {
  items: NormalizedListItem[];
  nextCursor: string;
  total: number | null;
  hasNext: boolean;
} {
  const totalM = html.match(/Found (?:about )?([0-9,]+) results/);
  const total = totalM ? Number(totalM[1].replace(/,/g, "")) : null;

  const nextM = html.match(/nexturl="[^"]*next=(\d+)/);
  const nextCursor = nextM ? nextM[1] : "";

  const items: NormalizedListItem[] = [];
  const rows = html.split("<tr>").slice(1);
  for (const row of rows) {
    const g = row.match(/\/g\/(\d+)\/([0-9a-f]{10})\//);
    if (!g) continue;
    const titleRaw = row.match(/<div class="glink">([\s\S]*?)<\/div>/)?.[1] ?? "";
    const title = stripTags(titleRaw) || `#${g[1]}`;
    const thumbRaw =
      row.match(/data-src="([^"]+)"/)?.[1] ??
      row.match(/<img[^>]+src="(https:[^"]+)"/)?.[1] ??
      "";
    const pagesM = row.match(/([0-9,]+)\s*pages/);
    const pages = pagesM ? Number(pagesM[1].replace(/,/g, "")) : 0;
    const postedM = row.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/);
    const postedTs = postedM ? new Date(postedM[1].replace(" ", "T") + ":00Z").getTime() : NaN;
    const published = Number.isFinite(postedTs) ? Math.floor(postedTs / 1000) : undefined;
    if (!thumbRaw.startsWith("https://")) continue;
    items.push({
      id: `${g[1]}_${g[2]}`,
      title,
      japanese_title: null,
      pages,
      favorites: 0,
      thumb: { path: thumbRaw, kind: "thumb" },
      variant,
      published,
    });
  }
  return { items, nextCursor, total, hasNext: Boolean(nextCursor) };
}

interface EhListPage {
  html: string;
  next: string;
  hasNext: boolean;
}

// cursor cache so page N doesn't need to re-walk pages 1..N every time.
// It remembers the cursor to fetch page `page + 1`, so forward navigation can
// resume from the fork instead of restarting at page 1.
const CURSOR_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const CURSOR_CACHE_MAX = 200;
const cursorCache = new Map<string, { page: number; next: string; hasNext: boolean; at: number }>();

function readCursorCache(queryKey: string): { page: number; next: string; hasNext: boolean } | undefined {
  const hit = cursorCache.get(queryKey);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CURSOR_CACHE_TTL_MS) {
    cursorCache.delete(queryKey);
    return undefined;
  }
  return hit;
}

function writeCursorCache(queryKey: string, page: number, next: string, hasNext: boolean): void {
  cursorCache.set(queryKey, { page, next, hasNext, at: Date.now() });
  if (cursorCache.size > CURSOR_CACHE_MAX) {
    const first = cursorCache.keys().next().value;
    if (first !== undefined) cursorCache.delete(first);
  }
}

async function listPageAt(
  variant: "exh" | "eh",
  q: string,
  page: number,
  queryKey: string,
): Promise<{ page: number; cursor: string; html: string; next: string; hasNext: boolean }> {
  let cursor = "";
  let current = 1;
  let html: EhListPage;

  // Resume from the fork only when it is strictly before the target page (its
  // `next` is the cursor for `fork.page + 1`). Otherwise restart from page 1 so
  // we never return a stale page's HTML for the requested page.
  const fork = readCursorCache(queryKey);
  if (fork && fork.page < page && fork.next) {
    cursor = fork.next;
    html = await fetchListPage(variant, q, cursor);
    current = fork.page + 1;
  } else {
    html = await fetchListPage(variant, q, "");
  }
  let next = html.next;
  let hasNext = html.hasNext;

  for (;;) {
    if (current === page) {
      return { page: current, cursor, html: html.html, next, hasNext };
    }
    if (!hasNext || !next) {
      // Reached (or exceeded) the last page. Return the last page we can reach.
      break;
    }
    cursor = next;
    html = await fetchListPage(variant, q, cursor);
    current += 1;
    next = html.next;
    hasNext = html.hasNext;
    writeCursorCache(queryKey, current, next, hasNext);
  }
  // best effort: return the deepest page we reached
  return { page: current, cursor, html: html.html, next, hasNext };
}

export async function searchEh(opts: {
  query: string;
  page?: number;
}): Promise<NormalizedSearchResult> {
  const page = Math.max(1, opts.page ?? 1);
  const query = opts.query.trim();
  const q = query ? `?f_search=${encodeURIComponent(query)}` : "";
  const key = `eh|${query}`;

  // Try exhentai first, fall back to e-hentai.
  let variant: "exh" | "eh" = "eh";
  const exhPage = await tryExh("/");
  if (exhPage !== null) variant = "exh";

  const result = await listPageAt(variant, q, page, key);
  const parsed = parseList(result.html, variant);
  debugLog(
    "[eh] search",
    JSON.stringify({ query, requestedPage: page, returnedPage: result.page, hasNext: result.hasNext }),
  );
  const perPage = 25;
  const approxPages = result.hasNext ? result.page + 1 : result.page;
  const numPages = parsed.total
    ? Math.max(1, Math.ceil(parsed.total / perPage))
    : approxPages;
  return {
    items: parsed.items,
    num_pages: numPages,
    per_page: perPage,
    total: parsed.total,
  };
}

async function fetchListPage(
  variant: "exh" | "eh",
  q: string,
  cursor: string,
): Promise<EhListPage> {
  let path = "/";
  if (q) path += q;
  if (cursor) path += (path.includes("?") ? "&" : "?") + `next=${cursor}`;
  let html: string | null = null;
  if (variant === "exh") html = await tryExh(path);
  if (html === null) html = await fetchEh(path);
  const parsed = parseList(html, variant === "exh" && html !== null ? "exh" : "eh");
  return { html, next: parsed.nextCursor, hasNext: parsed.hasNext };
}

/** Lightweight Japanese title lookup for list views (DB-cached). */
export async function getEhJapaneseTitle(id: string): Promise<string | null> {
  await load();
  const idx = id.lastIndexOf("_");
  const gid = idx >= 0 ? id.slice(0, idx) : id;
  const key = `eh_jp_${gid}`;
  try {
    const cached = await ehGet(key);
    if (cached) return cached === "__none__" ? null : cached;
  } catch {
    // fall through to network
  }
  let html: string | null = null;
  try {
    html = await tryExh(`/g/${gid}/${id.slice(idx + 1)}/`);
    if (html === null) html = await fetchEh(`/g/${gid}/${id.slice(idx + 1)}/`);
  } catch {
    html = null;
  }
  const jpRaw = html?.match(/<h1 id="gj">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const jp = stripTags(jpRaw) || null;
  try {
    await ehPut(key, jp ?? "__none__");
  } catch {
    // best effort
  }
  return jp;
}

function parseEhRootTitle(html: string, gid: string): { english: string; japanese: string | null } {
  const titleRaw = html.match(/<h1 id="gn">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const english = stripTags(titleRaw) || `#${gid}`;
  const jpRaw = html.match(/<h1 id="gj">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  return { english, japanese: stripTags(jpRaw) || null };
}

export async function ehGallery(id: string): Promise<NormalizedGallery> {
  await load();
  debugLog("[eh] gallery", id);
  // id format: "{gid}_{token}"
  const idx = id.lastIndexOf("_");
  const gid = idx >= 0 ? id.slice(0, idx) : id;
  const token = idx >= 0 ? id.slice(idx + 1) : "";

  let variant: "exh" | "eh" = "eh";
  let root: string | null = await tryExh(`/g/${gid}/${token}/`);
  if (root !== null) variant = "exh";
  else {
    debugLog("[eh] gallery: exhentai unavailable, using e-hentai");
    root = await fetchEh(`/g/${gid}/${token}/`);
  }

  const html = root;
  const titleRaw = html.match(/<h1 id="gn">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const english = stripTags(titleRaw) || `#${gid}`;
  const jpRaw = html.match(/<h1 id="gj">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const japanese = stripTags(jpRaw) || null;
  const title = japanese || english;

  const coverRaw =
    html.match(/background:transparent url\(([^)]+)\)/)?.slice(1, 2).find((u) => u.startsWith("https")) ?? "";
  const favM = html.match(/id="favcount">([\d,]+)\s*times/);
  const favs = favM ? Number(favM[1].replace(/,/g, "")) : 0;
  const lenM = html.match(/Length:<\/td><td class="gdt2">(\d+)\s*pages/);
  const numPages = lenM ? Number(lenM[1]) : 0;
  const postedM = html.match(/Posted:<\/td><td class="gdt2">(\d{4}-\d{2}-\d{2})/);
  const uploaded = postedM ? Math.floor(new Date(postedM[1]).getTime() / 1000) : 0;

  const tags: NormalizedTag[] = [];
  for (const m of html.matchAll(/toggle_tagmenu\(\d+,'([^']+)',this\)[^>]*>([\s\S]*?)<\/a>/g)) {
    const full = m[1];
    const colon = full.indexOf(":");
    const ns = colon >= 0 ? full.slice(0, colon) : "tag";
    const display = m[2] ? stripTags(m[2]) : full.slice(colon + 1);
    tags.push({ id: full, type: ns, name: display });
  }

  // collect page keys from ?p=N pages
  const pages: NonNullable<NormalizedGallery["pages"]> = [];
  const keys = new Set<string>();
  for (let listPage = 0; pages.length < numPages && listPage <= 100; listPage++) {
    const ph = listPage === 0 ? html : await loadGalleryListPage(variant, gid, token, listPage);
    for (const m of ph.matchAll(/\/s\/([0-9a-f]{10})\/(\d+)-(\d+)/g)) {
      const key = m[1];
      const g = m[2];
      const n = Number(m[3]);
      if (g !== gid || keys.has(key)) continue;
      keys.add(key);
      pages.push({
        number: n,
        path: `viewer/${gid}/${n}/${key}`,
        width: 0,
        height: 0,
        thumbnail: "",
        thumbnail_width: 0,
        thumbnail_height: 0,
      });
      if (pages.length >= numPages) break;
    }
    if (listPage === 0 && pages.length >= numPages) break;
  }
  pages.sort((a, b) => a.number - b.number);

  return {
    id,
    title,
    japanese_title: japanese ? english : null,
    pretty: title,
    scanlator: "",
    upload_date: uploaded,
    num_pages: numPages || pages.length,
    num_favorites: favs,
    cover: { path: coverRaw, width: 0, height: 0 },
    thumbnail: { path: coverRaw, width: 0, height: 0 },
    tags,
    pages,
    variant,
  };
}

async function loadGalleryListPage(
  variant: "exh" | "eh",
  gid: string,
  token: string,
  listPage: number,
): Promise<string> {
  const path = `/g/${gid}/${token}/?p=${listPage}`;
  if (variant === "exh") {
    const html = await tryExh(path);
    if (html !== null) return html;
  }
  return fetchEh(path);
}

export async function ehTags(query: string, limit: number): Promise<NormalizedTag[]> {
  // e-hentai has no public tag autocomplete API; returning prefix-free results
  // is a TODO. For now exact prefix filtering on the empty set.
  return [];
}

export async function ehBrowseTags(type: string, page: number): Promise<BrowseResult> {
  // e-hentai has a tag list at https://e-hentai.org/tags/ but it is not
  // source-stable. Placeholder until a proper tag index is added.
  return { items: [], num_pages: 1, per_page: 24 };
}

export async function ehFetchMedia(path: string, kind: "image" | "thumb"): Promise<MediaFetchResult> {
  await load();
  if (kind === "thumb") {
    if (!path.startsWith("https://")) throw new EhError(400, `bad eh thumb path`);
    const referer = memoryState?.igneous ? "https://exhentai.org/" : "https://e-hentai.org/";
    debugLog("[eh] fetch thumb", path.slice(0, 80));
    const mode = memoryState?.igneous && path.includes("exhentai") ? "exh" : "eh";
    const res = await fetch(path, {
      headers: headersFor(mode, { Referer: referer }),
    });
    if (!res.ok) throw new EhError(res.status, `eh thumb -> HTTP ${res.status}`);
    return { response: res };
  }

  // kind image -> path format: viewer/{gid}/{page}/{key}
  const m = path.match(/^viewer\/(\d+)\/(\d+)\/([0-9a-f]{10})$/);
  if (!m) throw new EhError(400, `bad eh viewer path`);
  const [, gid, page, key] = m;

  let variant: "exh" | "eh" = "eh";
  if (memoryState?.igneous) variant = "exh";
  const viewerPath = `/s/${key}/${gid}-${page}`;
  const viewerHtml =
    variant === "exh"
      ? ((await tryExh(viewerPath)) ?? (await fetchEh(viewerPath)))
      : await fetchEh(viewerPath);

  const imgUrl = viewerHtml.match(/<img id="img" src="([^"]+)"/)?.[1];
  if (!imgUrl) throw new EhError(502, "could not find image url in viewer page");
  if (!imgUrl.startsWith("https://")) throw new EhError(502, `bad image url: ${imgUrl}`);

  const base = variant === "exh" ? "https://exhentai.org" : "https://e-hentai.org";
  debugLog("[eh] fetch page", base + viewerPath, "->", imgUrl.slice(0, 90));

  const tryImage = async (url: string, refererBase: string, cookieMode: "exh" | "eh") => {
    let lastErr: unknown = new Error("image fetch failed");
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          headers: headersFor(cookieMode, { Referer: refererBase + viewerPath }),
        });
        if (res.ok) return res;
        lastErr = new EhError(res.status, `eh image -> HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  };

  try {
    return { response: await tryImage(imgUrl, base, variant) };
  } catch (err) {
    debugLog("[eh] image failed, trying e-hentai mirror:", err instanceof Error ? err.message : String(err));
    const mirrorHtml = await fetchEh(viewerPath);
    const mirrorUrl = mirrorHtml.match(/<img id="img" src="([^"]+)"/)?.[1];
    if (mirrorUrl && mirrorUrl.startsWith("https://") && mirrorUrl !== imgUrl) {
      return { response: await tryImage(mirrorUrl, "https://e-hentai.org", "eh") };
    }
    throw err;
  }
}