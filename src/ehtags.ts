import { USER_AGENT } from "./env";
import { ehGet, ehPut } from "./ehstore";
import type { NormalizedTag } from "./sources";

const DB_URL =
  "https://github.com/EhTagTranslation/Database/releases/latest/download/db.text.json";
const CACHE_KEY = "eh_tag_db_v1";
const UPDATED_KEY = "eh_tag_db_updated_at";
const TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

interface EhTagEntry {
  namespace: string;
  key: string;
  name: string;
}

let memoryTags: EhTagEntry[] | null = null;
let loading: Promise<EhTagEntry[]> | null = null;

function flatten(json: any): EhTagEntry[] {
  const out: EhTagEntry[] = [];
  const data = Array.isArray(json) ? json : json?.data ?? [];
  for (const group of data) {
    const ns = group?.namespace ?? group?.tag ?? "";
    const tags = group?.data ?? {};
    for (const key of Object.keys(tags)) {
      const entry = tags[key] ?? {};
      out.push({ namespace: ns, key, name: String(entry.name ?? key) });
    }
  }
  return out;
}

function merge(oldTags: EhTagEntry[], newTags: EhTagEntry[]): EhTagEntry[] {
  const map = new Map<string, EhTagEntry>();
  for (const t of oldTags) map.set(`${t.namespace}:${t.key}`, t);
  for (const t of newTags) map.set(`${t.namespace}:${t.key}`, t);
  return [...map.values()];
}

async function loadTags(force = false): Promise<EhTagEntry[]> {
  if (!force && memoryTags) return memoryTags;
  if (!force && loading) return loading;

  const promise = (async () => {
    try {
      if (!force) {
        const raw = await ehGet(CACHE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as EhTagEntry[];
          if (Array.isArray(parsed) && parsed.length) {
            memoryTags = parsed;
            return parsed;
          }
        }
      }
      const res = await fetch(DB_URL, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`EhTagTranslation DB -> HTTP ${res.status}`);
      const fresh = flatten(await res.json());
      if (fresh.length) {
        const merged = merge(memoryTags ?? [], fresh);
        memoryTags = merged;
        await ehPut(CACHE_KEY, JSON.stringify(merged));
        await ehPut(UPDATED_KEY, String(Date.now()));
        return merged;
      }
      return memoryTags ?? [];
    } catch (err) {
      console.error("[ehtags]", err instanceof Error ? err.message : String(err));
      return memoryTags ?? [];
    }
  })();
  loading = promise;
  promise.finally(() => {
    if (loading === promise) loading = null;
  });
  return promise;
}

async function refreshIfStale(now: number): Promise<void> {
  const raw = await ehGet(UPDATED_KEY);
  const at = raw ? Number(raw) : 0;
  if (!at || now - at > TTL_MS) {
    void loadTags(true);
  }
}

export async function suggestEhTags(query: string, limit = 5): Promise<NormalizedTag[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const now = Date.now();
  const tags = await loadTags();
  void refreshIfStale(now);
  return tags
    .filter((t) => t.key.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((t) => ({
      id: `${t.namespace}:${t.key}`,
      type: t.namespace,
      name: t.name || t.key,
      slug: t.key,
    }));
}

/** Keys whose localized name contains `q`; used by nh Chinese-alias fallback. */
export async function ehKeysForLocalizedQuery(query: string, limit = 6): Promise<string[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const tags = await loadTags();
  return tags
    .filter((t) => t.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map((t) => t.key);
}

export async function refreshEhTagsNow(): Promise<void> {
  memoryTags = null;
  await loadTags(true);
}