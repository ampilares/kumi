/**
 * Pure logic behind the search modal (spec Fig. 11).
 *
 * The modal itself is React + IPC; everything that is easy to get subtly wrong
 * — which date bucket a result falls in across midnight/DST/year boundaries,
 * whether a snippet actually came from the body, how a scope filter reads a
 * breadcrumb, how recents are shaped into result rows — lives here so it can be
 * unit-tested without a workspace database.
 */
import type { Block, Page, PageTreeNode, SearchResult } from "@kumi/core";
import { dayKey, formatDate } from "./phase6";

/* ------------------------------------------------------------- date buckets */

export interface SearchBucket {
  /** Stable identity for the group ("today", "yesterday", "past-week", or a day key). */
  key: string;
  /** The gray header text Fig. 11 shows above each run of results. */
  label: string;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Whole calendar days between two timestamps, local time.
 *
 * Rounded rather than floored because a DST shift makes one of the days 23 or
 * 25 hours long, and "yesterday" must not become "today" twice a year.
 */
export function calendarDaysAgo(ts: number, now = Date.now()): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
}

/**
 * Which header a timestamp sits under: Today / Yesterday / Past week, then one
 * group per calendar day labelled with its full date (year included, so a
 * result from last December never reads as this December).
 *
 * A future timestamp — clock skew, an imported page dated ahead — buckets as
 * Today rather than inventing a "Tomorrow" header the reference does not have.
 */
export function searchBucket(ts: number, now = Date.now()): SearchBucket {
  const days = calendarDaysAgo(ts, now);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  if (days <= 7) return { key: "past-week", label: "Past week" };
  return { key: dayKey(ts), label: formatDate(ts) };
}

export interface SearchGroup extends SearchBucket {
  results: SearchResult[];
}

/**
 * Newest-first groups, each holding its newest-first results.
 *
 * Groups are ordered by their newest member rather than by bucket name, which
 * keeps the sequence right without a separate rank table: Today's newest is
 * always after Yesterday's, and dated groups fall out in calendar order.
 */
export function groupResultsByDate(results: SearchResult[], now = Date.now()): SearchGroup[] {
  const byKey = new Map<string, SearchGroup>();
  for (const hit of results) {
    const bucket = searchBucket(hit.updatedAt, now);
    const group = byKey.get(bucket.key);
    if (group) group.results.push(hit);
    else byKey.set(bucket.key, { ...bucket, results: [hit] });
  }
  const groups = [...byKey.values()];
  for (const group of groups) group.results.sort((a, b) => b.updatedAt - a.updatedAt);
  return groups.sort((a, b) => newest(b.results) - newest(a.results));
}

function newest(results: SearchResult[]): number {
  let max = -Infinity;
  for (const hit of results) if (hit.updatedAt > max) max = hit.updatedAt;
  return max;
}

/** Groups flattened back into the order the arrow keys walk. */
export function flattenGroups(groups: SearchGroup[]): SearchResult[] {
  return groups.flatMap((group) => group.results);
}

/* -------------------------------------------------------------------- scope */

export interface ScopeOption {
  id: string;
  title: string;
}

/**
 * The "In ▾" choices: the workspace's top-level pages.
 *
 * Titles, not ids, are what the filter can actually compare against — a
 * `SearchResult` carries its breadcrumb as titles only — so the option list
 * carries the id purely as a React key.
 */
export function scopeOptions(roots: PageTreeNode[]): ScopeOption[] {
  return roots.map((node) => ({
    id: node.page.id,
    title: node.page.title.trim() === "" ? "Untitled" : node.page.title,
  }));
}

/**
 * The top-level page a result lives under. A root page has an empty breadcrumb
 * and is its own scope, which is what makes "In: Projects" match the Projects
 * page itself as well as everything beneath it.
 */
export function scopeRootTitle(hit: SearchResult): string {
  const root = hit.breadcrumb[0];
  if (root !== undefined && root.trim() !== "") return root;
  return hit.title.trim() === "" ? "Untitled" : hit.title;
}

/** Client-side "In" filter. A null scope means Everywhere and filters nothing. */
export function applyScope(results: SearchResult[], scope: string | null): SearchResult[] {
  if (scope === null) return results;
  return results.filter((hit) => scopeRootTitle(hit) === scope);
}

/* ----------------------------------------------------------------- snippets */

/** Drops core's `<b>` highlight markers, leaving the raw matched text. */
export function stripHighlight(snippet: string): string {
  return snippet.replace(/<\/?b>/g, "");
}

/**
 * The snippet line, or null when there is nothing extra to say.
 *
 * Core falls back to the *title* snippet when a query only matched a title, and
 * echoing the title immediately under itself is noise — Fig. 11 shows a second
 * line only for body matches.
 */
export function bodySnippet(hit: SearchResult): string | null {
  const text = stripHighlight(hit.snippet).trim();
  if (text === "") return null;
  if (text === hit.title.trim()) return null;
  return hit.snippet;
}

/** Escapes everything, then re-enables the `<b>` markers core emits. */
export function sanitizeSnippet(snippet: string): string {
  const escaped = snippet.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped.replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");
}

/* ---------------------------------------------------------------- highlight */

export interface Segment {
  text: string;
  hit: boolean;
}

/**
 * Splits `text` into matched/unmatched runs for the bolded title in Fig. 11.
 *
 * Every whitespace-separated query term matches independently, so "sales board"
 * highlights both words wherever they appear. Rendered as segments rather than
 * as HTML because titles are user data and must never reach `innerHTML`.
 */
export function highlightSegments(text: string, query: string): Segment[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== "")
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0 || text === "") return text === "" ? [] : [{ text, hit: false }];

  const lower = text.toLowerCase();
  const segments: Segment[] = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const term = terms.find((t) => lower.startsWith(t, i));
    if (term === undefined) {
      plain += text[i];
      i += 1;
      continue;
    }
    if (plain !== "") {
      segments.push({ text: plain, hit: false });
      plain = "";
    }
    segments.push({ text: text.slice(i, i + term.length), hit: true });
    i += term.length;
  }
  if (plain !== "") segments.push({ text: plain, hit: false });
  return segments;
}

/* ------------------------------------------------------------------ recents */

export interface RecentEntry {
  page: Page;
  /** Breadcrumb titles from root to *parent*, matching `SearchResult`. */
  breadcrumb: string[];
}

/**
 * Recents reshaped into result rows so the idle modal can reuse one renderer
 * and one date grouping. Order follows `recentIds` (newest first, core's
 * ordering) rather than `updatedAt`; the grouping then re-sorts inside each day.
 */
export function recentsToResults(recentIds: string[], entries: RecentEntry[]): SearchResult[] {
  const byId = new Map(entries.map((entry) => [entry.page.id, entry]));
  const out: SearchResult[] = [];
  for (const id of recentIds) {
    const entry = byId.get(id);
    if (entry === undefined) continue;
    out.push({
      pageId: entry.page.id,
      title: entry.page.title,
      icon: entry.page.icon,
      snippet: "",
      breadcrumb: entry.breadcrumb,
      updatedAt: entry.page.updatedAt,
    });
  }
  return out;
}

/** Breadcrumb line for a row — Fig. 11's gray path, or "Private" at the root. */
export function breadcrumbLabel(breadcrumb: string[]): string {
  const parts = breadcrumb.filter((p) => p.trim() !== "");
  return parts.length > 0 ? parts.join(" / ") : "Private";
}

/* ------------------------------------------------------------------ preview */

/**
 * The first `limit` top-level blocks of a page plus their descendants.
 *
 * Slicing the flat block array directly would orphan children mid-list and the
 * read-only renderer would drop them, so the cut is made on top-level blocks
 * and the subtree is pulled along.
 */
export function previewBlocks(blocks: Block[], limit = 15): Block[] {
  const keep = new Set<string>();
  let taken = 0;
  for (const block of blocks) {
    if (block.parentBlockId !== null) continue;
    if (taken >= limit) break;
    keep.add(block.id);
    taken += 1;
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const block of blocks) {
      if (keep.has(block.id)) continue;
      if (block.parentBlockId !== null && keep.has(block.parentBlockId)) {
        keep.add(block.id);
        grew = true;
      }
    }
  }
  return blocks.filter((block) => keep.has(block.id));
}
