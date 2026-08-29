import { getSource, type NormalizedListItem, type NormalizedSearchResult } from "./sources";
import { ehCanonicalTagsFor } from "./ehtags";

type SrcTag = { source: string; value: string; quoted: boolean; negative: boolean };

interface Branch {
  tags: SrcTag[];
  keywords: string[];
}

const SOURCE_ALIASES: Record<string, string> = {
  nh: "nh",
  nhentai: "nh",
  eh: "eh",
  ehentai: "eh",
  "e-hentai": "eh",
  exhentai: "eh",
  jm: "jm",
  jmcomic: "jm",
  "18comic": "jm",
};

const TAG_RE = /(-)?(nh|eh|jm|nhentai|ehentai|exhentai|jmcomic|18comic):(?:"([^"]+)"|([^\s&]+))/gi;

function canonicalSource(rawAlias: string): string {
  return SOURCE_ALIASES[rawAlias.toLowerCase()] ?? rawAlias.toLowerCase();
}

export function parseBranches(raw: string): Branch[] {
  return raw
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tags: SrcTag[] = [];
      const leftover: string[] = [];
      let last = 0;
      for (const m of part.matchAll(TAG_RE)) {
        const before = part.slice(last, m.index);
        if (before.trim()) leftover.push(before.trim());
        const negative = m[1] === "-";
        const quoted = m[3] !== undefined;
        const value = m[3] ?? m[4];
        tags.push({ source: canonicalSource(m[2]), value, quoted, negative });
        last = m.index + m[0].length;
      }
      const tail = part.slice(last);
      if (tail.trim()) leftover.push(tail.trim());
      return { tags, keywords: leftover.filter((s) => s !== "&") };
    });
}

async function branchItems(
  branch: Branch,
  page: number,
  key: string | undefined,
  defaultSources: string[],
  globalNegatives: Map<string, string[]>,
): Promise<{ items: NormalizedListItem[]; num_pages: number }> {
  // Quoted `source:"term"` is a scoped keyword search (good for titles).
  // Unquoted `source:term` keeps tag semantics; `-source:term` filters.
  const positiveTags = new Map<string, string[]>();
  const negativeTags = new Map<string, string[]>();
  const keywordScopes = new Map<string, string[]>();
  const keywords = [...branch.keywords];

  for (const t of branch.tags) {
    if (t.quoted) {
      const list = keywordScopes.get(t.source) ?? [];
      if (t.negative) throw new Error("negative quoted terms are not supported");
      list.push(t.value);
      keywordScopes.set(t.source, list);
    } else if (t.negative) {
      const list = negativeTags.get(t.source) ?? [];
      list.push(t.value);
      negativeTags.set(t.source, list);
    } else {
      const list = positiveTags.get(t.source) ?? [];
      list.push(t.value);
      positiveTags.set(t.source, list);
    }
  }

  for (const [src, list] of globalNegatives) {
    negativeTags.set(src, [...(negativeTags.get(src) ?? []), ...list]);
  }

  const mentioned = new Set([...positiveTags.keys(), ...keywordScopes.keys()]);
  const sources = mentioned.size ? [...mentioned] : defaultSources;

  const results = await Promise.all(
    sources.map(async (source) => {
      const adapter = getSource(source);
      if (!adapter) return { items: [] as NormalizedListItem[], num_pages: 1 };
      const qParts = [...keywords, ...(keywordScopes.get(source) ?? [])];
      for (const rawTag of positiveTags.get(source) ?? []) {
        if (adapter.id === "eh") {
          const canonical = await ehCanonicalTagsFor(rawTag, 1);
          qParts.push(canonical[0] ?? rawTag);
        } else if (adapter.id === "jm") {
          qParts.push(rawTag);
        } else {
          qParts.push(`tag:"${rawTag.replace(/"/g, "")}"`);
        }
      }
      for (const rawNeg of negativeTags.get(source) ?? []) {
        if (adapter.id === "eh") {
          const canonical = await ehCanonicalTagsFor(rawNeg, 1);
          qParts.push(`-${canonical[0] ?? rawNeg}`);
        } else if (adapter.id === "jm") {
          // jm does not support tag filters; ignore.
        } else {
          qParts.push(`-tag:"${rawNeg.replace(/"/g, "")}"`);
        }
      }
      const query = qParts.join(" ");
      if (!query.trim()) return { items: [] as NormalizedListItem[], num_pages: 1 };
      const res = await adapter.search({ query, page, key });
      return { items: res.items, num_pages: res.num_pages };
    }),
  );
  const items = interleave(results.map((r) => r.items));
  const numPages = Math.max(1, ...results.map((r) => r.num_pages));
  return { items, num_pages: numPages };
}

function interleave(lists: NormalizedListItem[][]): NormalizedListItem[] {
  const out: NormalizedListItem[] = [];
  let added = true;
  for (let i = 0; added; i++) {
    added = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        added = true;
      }
    }
  }
  return out;
}

function dedupe(items: NormalizedListItem[]): NormalizedListItem[] {
  const seen = new Set<string>();
  const out: NormalizedListItem[] = [];
  for (const it of items) {
    const src =
      it.variant === "exh" || it.variant === "eh"
        ? "eh"
        : it.variant === "jm"
          ? "jm"
          : "nh";
    const key = `${src}:${it.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

export async function aggregateSearch(
  raw: string,
  page: number,
  key?: string,
  scope?: string[],
): Promise<NormalizedSearchResult> {
  const defaultSources = scope && scope.length ? scope : ["nh", "eh", "jm"];
  const branches = parseBranches(raw);
  const globalNegatives = new Map<string, string[]>();
  for (const branch of branches) {
    branch.tags = branch.tags.filter((t) => {
      if (!t.negative) return true;
      const list = globalNegatives.get(t.source) ?? [];
      list.push(t.value);
      globalNegatives.set(t.source, list);
      return false;
    });
  }
  const all = await Promise.all(
    branches.map((b) => branchItems(b, page, key, defaultSources, globalNegatives)),
  );
  const items = dedupe(interleave(all.map((b) => b.items)).slice(0, 50));
  const numPages = Math.max(1, ...all.map((b) => b.num_pages));
  return { items, num_pages: numPages, per_page: 25, total: null };
}