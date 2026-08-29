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

export function setEhAcquireFetcher(fn: AcquireFetcher): void {
  acquireFetcher = fn;
}

export function setEhPersistBridge(bridge: PersistBridge): void {
  persistBridge = bridge;
}

function env(name: string): string | undefined {
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
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Cookie: cookieFor("exh") },
    });
    if (res.ok) return await res.text();
    // e.g. 302 to e-hentai / expired igneous
    if (res.status === 302 || res.status === 301) return null;
    throw new EhError(res.status, `exhentai ${path} -> HTTP ${res.status}`);
  } catch (err) {
    if (err instanceof EhError) throw err;
    // network failure or igneous expired: try to refresh once
    debugLog("[eh] tryExh failed, refreshing igneous:", err instanceof Error ? err.message : String(err));
    const ig = await acquireIgneous();
    if (!ig) throw err;
    const retry = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Cookie: cookieFor("exh") },
    });
    if (retry.ok) return await retry.text();
    throw new EhError(retry.status, `exhentai ${path} -> HTTP ${retry.status}`);
  }
}

async function fetchEh(path: string): Promise<string> {
  const res = await fetch(`https://e-hentai.org${path}`, {
    headers: { "User-Agent": USER_AGENT, Cookie: cookieFor("eh") },
  });
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
// It only remembers the "start cursor" for the highest page we've seen; when
// the requested page is behind the cache we restart from that fork.
const cursorCache = new Map<string, { page: number; next: string; hasNext: boolean; at: number }>();

async function listPageAt(
  variant: "exh" | "eh",
  q: string,
  page: number,
  queryKey: string,
): Promise<{ page: number; cursor: string; html: string; next: string; hasNext: boolean }> {
  let cursor = "";
  let html = await fetchListPage(variant, q, "");
  let current = 1;
  let next = html.next;
  let hasNext = html.hasNext;
  let cached = cursorCache.get(queryKey);
  if (cached) {
    current = cached.page;
    next = cached.next;
    hasNext = cached.hasNext;
    if (cached.page === page) {
      // reuse cached html is not stored; just its cursor would need refetch of current page,
      // so we fall through and walk only when needed.
    }
  }

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
    cursorCache.set(queryKey, {
      page: current,
      next,
      hasNext,
      at: Date.now(),
    });
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
  return {
    items: parsed.items,
    num_pages: result.hasNext ? result.page + 1 : result.page,
    per_page: 25,
    total: parsed.total,
  };
}

async function fetchListPage(
  variant: "exh" | "eh",
  q: string,
  cursor: string,
): Promise<EhListPage> {
  const cursorPart = cursor ? `&next=${cursor}` : "";
  const path = `/${q}${cursorPart}`;
  let html: string | null = null;
  if (variant === "exh") html = await tryExh(path);
  if (html === null) html = await fetchEh(path);
  const parsed = parseList(html, variant === "exh" && html !== null ? "exh" : "eh");
  return { html, next: parsed.nextCursor, hasNext: parsed.hasNext };
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
  const title = stripTags(titleRaw) || `#${gid}`;
  const jpRaw = html.match(/<h1 id="gj">([\s\S]*?)<\/h1>/)?.[1] ?? "";
  const japanese = stripTags(jpRaw) || null;

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
    japanese_title: japanese,
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
    const res = await fetch(path, {
      headers: {
        "User-Agent": USER_AGENT,
        Referer: referer,
        Cookie: cookieFor(memoryState?.igneous && path.includes("exhentai") ? "exh" : "eh"),
      },
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
  const res = await fetch(imgUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: base + viewerPath,
      Cookie: cookieFor(variant),
    },
  });
  if (!res.ok) throw new EhError(res.status, `eh image -> HTTP ${res.status}`);
  return { response: res };
}