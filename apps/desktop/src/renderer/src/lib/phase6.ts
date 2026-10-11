/**
 * Phase 6 pure logic: history grouping and labelling, template list reducers,
 * and export summarization.
 *
 * Everything here is deliberately free of React and IPC so the parts that are
 * easy to get subtly wrong — day bucketing across midnight, "would this restore
 * delete anything?", pluralised toast copy — are unit-testable on their own.
 */
import type { Block, SnapshotMeta, TemplateMeta } from "@kumi/core";
import { plainText } from "./richText";

/* --------------------------------------------------------------- history */

export interface SnapshotDay {
  /** Local calendar day key, `YYYY-MM-DD`. Stable sort key. */
  key: string;
  /** "November 4, 2025", or "Today" / "Yesterday" relative to `now`. */
  label: string;
  snapshots: SnapshotMeta[];
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local-calendar day key for a timestamp (never UTC — buckets must match the clock). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "November 4, 2025" — the Fig. 6 revision date format. */
export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Same, but collapses the two most recent days to "Today"/"Yesterday". */
export function formatDayLabel(ts: number, now = Date.now()): string {
  const key = dayKey(ts);
  if (key === dayKey(now)) return "Today";
  if (key === dayKey(now - 86_400_000)) return "Yesterday";
  return formatDate(ts);
}

/** "9:05 AM" — 12-hour clock, no seconds. */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  const hours = d.getHours();
  const suffix = hours < 12 ? "AM" : "PM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${pad(d.getMinutes())} ${suffix}`;
}

/** The full entry label: "November 4, 2025 · 9:05 AM". */
export function formatSnapshotLabel(meta: SnapshotMeta): string {
  return `${formatDate(meta.createdAt)} · ${formatTime(meta.createdAt)}`;
}

export function causeLabel(cause: SnapshotMeta["cause"]): string {
  switch (cause) {
    case "manual":
      return "Saved";
    case "restore":
      return "Restored";
    default:
      return "Auto";
  }
}

/**
 * Newest-first days, each holding its newest-first snapshots. Core is free to
 * return any order; the panel depends on this one, so it is imposed here.
 */
export function groupSnapshotsByDay(snapshots: SnapshotMeta[], now = Date.now()): SnapshotDay[] {
  const byKey = new Map<string, SnapshotMeta[]>();
  for (const snap of snapshots) {
    const key = dayKey(snap.createdAt);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(snap);
    else byKey.set(key, [snap]);
  }
  return [...byKey.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
      return {
        key,
        // Every snapshot in the bucket is the same day, so any of them labels it.
        label: formatDayLabel(sorted[0]!.createdAt, now),
        snapshots: sorted,
      };
    })
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/** The newest snapshot, which the panel selects on open. */
export function newestSnapshotId(snapshots: SnapshotMeta[]): string | null {
  let best: SnapshotMeta | null = null;
  for (const snap of snapshots) {
    if (!best || snap.createdAt > best.createdAt) best = snap;
  }
  return best?.id ?? null;
}

/**
 * Block ids that exist on the live page but not in the snapshot — i.e. the
 * content a restore would take away. Fig. 6 shows these as red strips.
 */
export function removedByRestore(live: Block[], snapshot: Block[]): string[] {
  const kept = new Set(snapshot.filter((b) => !b.archived).map((b) => b.id));
  return live.filter((b) => !b.archived && !kept.has(b.id)).map((b) => b.id);
}

export interface RemovedStrip {
  id: string;
  /** One line of preview text, or the block type when it carries none. */
  text: string;
}

/**
 * The Fig. 6 red "Deleted content" strips: live blocks the snapshot lacks,
 * reduced to a single readable line each.
 */
export function removedStrips(live: Block[], snapshot: Block[], limit = 12): RemovedStrip[] {
  const removed = new Set(removedByRestore(live, snapshot));
  const strips: RemovedStrip[] = [];
  for (const block of live) {
    if (!removed.has(block.id)) continue;
    const text = plainText(block.payload.richText).trim();
    strips.push({ id: block.id, text: text === "" ? block.type.replace(/_/g, " ") : text });
    if (strips.length >= limit) break;
  }
  return strips;
}

/** Human summary of what a restore costs, or null when it costs nothing. */
export function restoreWarning(removedCount: number): string | null {
  if (removedCount <= 0) return null;
  return removedCount === 1
    ? "1 block added since this version would be removed."
    : `${removedCount} blocks added since this version would be removed.`;
}

/* -------------------------------------------------------------- templates */

/** Case-insensitive name sort — core stores creation order, the menu wants names. */
export function sortTemplates(templates: TemplateMeta[]): TemplateMeta[] {
  return [...templates].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}

/** Optimistic removal so a deleted template leaves the menu before the refetch. */
export function withoutTemplate(templates: TemplateMeta[], id: string): TemplateMeta[] {
  return templates.filter((t) => t.id !== id);
}

/**
 * Default name for "Save as template": the page title, or a placeholder when
 * the page is still untitled (core would otherwise store an empty name).
 */
export function defaultTemplateName(pageTitle: string): string {
  const trimmed = pageTitle.trim();
  return trimmed === "" ? "Untitled template" : trimmed;
}

/** Trim + cap. Returns null when the user cleared the field. */
export function normalizeTemplateName(raw: string): string | null {
  const trimmed = raw.trim().slice(0, 100);
  return trimmed === "" ? null : trimmed;
}

/* ----------------------------------------------------------------- export */

/** Last path segment of a Windows or POSIX path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] !== "") return parts[i]!;
  }
  return path;
}

/**
 * The page id from the PDF print route's `?print=1&page=<id>`, or null on the
 * normal app route. Main builds this URL; the renderer has to trust nothing
 * about it, hence the explicit gate on both parameters.
 */
export function printRoutePageId(search: string): string | null {
  const params = new URLSearchParams(search);
  if (params.get("print") !== "1") return null;
  const pageId = params.get("page");
  return pageId !== null && pageId !== "" ? pageId : null;
}

/**
 * Toast copy for a finished export: file count plus where it landed.
 * `label` names the format ("Markdown", "Workspace JSON").
 */
export function summarizeExport(label: string, files: string[], dir: string): string {
  const count = files.length;
  if (count === 0) return `${label} export wrote no files.`;
  const noun = count === 1 ? "file" : "files";
  return `${label} export: ${count} ${noun} in ${baseName(dir)}`;
}
