/**
 * Relation chip resolution.
 *
 * A relation value stores page *ids*; the chips show page *titles*, which are
 * fetched once each through the shared page cache. This module is the pure
 * reducer in the middle: given the stored ids and whatever stubs have landed so
 * far, it decides what each chip reads and which ids still need fetching.
 *
 * Order is the value's order, never the cache's — Notion treats a relation as
 * an ordered list, and re-sorting chips on a cache hit would be visible churn.
 */

import type { PageStub } from "../lib/pageCache";

export interface RelationChip {
  pageId: string;
  title: string;
  /** True while the title is still being fetched. */
  pending: boolean;
  /** True when the target page is gone — a dangling reference, shown not hidden. */
  missing: boolean;
}

export const RELATION_PENDING_TITLE = "…";
export const RELATION_MISSING_TITLE = "Untitled";

export function resolveRelationChips(
  pageIds: readonly string[],
  stubs: ReadonlyMap<string, PageStub>,
): RelationChip[] {
  return pageIds.map((pageId) => {
    const stub = stubs.get(pageId);
    if (stub === undefined) {
      return { pageId, title: RELATION_PENDING_TITLE, pending: true, missing: false };
    }
    const title = stub.title.trim();
    return {
      pageId,
      title: title === "" || stub.missing ? RELATION_MISSING_TITLE : title,
      pending: false,
      missing: stub.missing,
    };
  });
}

/** Ids with no stub yet — exactly what the caller should ask the cache for. */
export function unresolvedIds(
  pageIds: readonly string[],
  stubs: ReadonlyMap<string, PageStub>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of pageIds) {
    if (stubs.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Chip summary for a collapsed presentation ("Alpha, Beta +2"). */
export function relationSummary(chips: readonly RelationChip[], max = 2): string {
  if (chips.length === 0) return "";
  const shown = chips.slice(0, max).map((chip) => chip.title);
  const rest = chips.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} +${rest}` : shown.join(", ");
}
