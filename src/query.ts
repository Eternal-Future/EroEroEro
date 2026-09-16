import { getSource, type NormalizedListItem, type NormalizedSearchResult } from "./sources";
import { ehCanonicalTagsFor } from "./ehtags";
import { debugLog } from "./debug";

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
  bk: "bk",
  bika: "bk",
  picacg: "bk",
  picacomic: "bk",
};

const TAG_RE = /(-)?(nh|eh|jm|bk|nhentai|ehentai|exhentai|jmcomic|18comic|bika|picacg|picacomic):(?:"([^"]+)"|([^\s&]+))/gi;

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

interface BranchResult {
  items: NormalizedListItem[];
  num_pages: number;
  failed?: string;
}

/** nh/eh understand native exclusions; everything else needs a local filter. */
function supportsNativeNegation(sourceId: string): boolean {
  return sourceId === "nh" || sourceId === "eh";
}

/** Keyword-only sources get their negatives applied to the returned titles. */
function applyNegativeFilter(items: NormalizedListItem[], negatives: string[]): NormalizedListItem[] {
  if (!negatives.length) return items;
  const needles = negatives.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!needles.length) return items;
  return items.filter((it) => {
    const hay = `${it.title} ${it.japanese_title ?? ""}`.toLowerCase();
    return !needles.some((n) => hay.includes(n));
  });
}

async function branchItems(
  branch: Branch,
  page: number,
  key: string | undefined,
  defaultSources: string[],
  globalNegatives: Map<string, string[]>,
  sort?: string,
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

  // One source failing must not fail the whole query; only a total wipeout
  // surfaces the error (see branchItems callers).
  const settled = await Promise.all(
    sources.map(async (source): Promise<BranchResult> => {
      const adapter = getSource(source);
      if (!adapter) return { items: [], num_pages: 1 };
      try {
        const qParts = [...keywords, ...(keywordScopes.get(source) ?? [])];
        for (const rawTag of positiveTags.get(source) ?? []) {
          if (adapter.id === "nh") {
            qParts.push(`tag:"${rawTag.replace(/"/g, "")}"`);
          } else if (adapter.id === "eh") {
            const canonical = await ehCanonicalTagsFor(rawTag, 1);
            qParts.push(canonical[0] ?? rawTag);
          } else {
            // jm / bk / future keyword-only sources keep the plain keyword.
            qParts.push(rawTag);
          }
        }
        const negatives = negativeTags.get(source) ?? [];
        for (const rawNeg of negatives) {
          if (adapter.id === "eh") {
            const canonical = await ehCanonicalTagsFor(rawNeg, 1);
            qParts.push(`-${canonical[0] ?? rawNeg}`);
          } else if (adapter.id === "nh") {
            qParts.push(`-tag:"${rawNeg.replace(/"/g, "")}"`);
          }
        }
        const query = qParts.join(" ");
        if (!query.trim()) return { items: [], num_pages: 1 };
        const res = await adapter.search({ query, page, key, sort });
        const items = supportsNativeNegation(adapter.id)
          ? res.items
          : applyNegativeFilter(res.items, negatives);
        return { items, num_pages: res.num_pages };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("[query] source failed:", source, message);
        return { items: [], num_pages: 1, failed: `${source}: ${message}` };
      }
    }),
  );

  const ok = settled.filter((r) => !r.failed);
  if (!ok.length && settled.length) {
    throw new Error(settled[0].failed ?? "all sources failed");
  }
  const items = interleave(ok.map((r) => r.items));
  const numPages = Math.max(1, ...ok.map((r) => r.num_pages));
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
          : it.variant === "bk"
            ? "bk"
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
  sort?: string,
): Promise<NormalizedSearchResult> {
  const defaultSources = scope && scope.length ? scope : ["nh", "eh", "jm", "bk"];
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
  // A branch only rejects when every source it touches failed; otherwise the
  // branches that worked are still returned.
  const settled = await Promise.allSettled(
    branches.map((b) => branchItems(b, page, key, defaultSources, globalNegatives, sort)),
  );
  const ok = settled.filter(
    (s): s is PromiseFulfilledResult<{ items: NormalizedListItem[]; num_pages: number }> =>
      s.status === "fulfilled",
  );
  if (!ok.length && settled.length) {
    const first = settled.find((s) => s.status === "rejected") as PromiseRejectedResult | undefined;
    const reason = first?.reason;
    throw reason instanceof Error ? reason : new Error(String(reason ?? "all sources failed"));
  }
  const items = dedupe(interleave(ok.map((s) => s.value.items)).slice(0, 50));
  const numPages = Math.max(1, ...ok.map((s) => s.value.num_pages));
  return { items, num_pages: numPages, per_page: 25, total: null };
}