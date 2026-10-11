/**
 * Stage 2c–3 of the Notion import: the normalized model, and the plan summary
 * built from it.
 *
 * The model is the whole export expressed in Kumi's vocabulary, with source
 * identity preserved and nothing written yet:
 *
 * ```
 * NormalizedModel
 *   pages        NPage[]         one per exported .md that is not a database row
 *   dataSources  NDataSource[]   one per <Title> <id>.csv (`_all` preferred)
 *     columns    InferredColumn[]  the re-derived schema (parseCsv)
 *     rows       NRow[]            CSV rows, matched to their row .md page
 *   assets       string[]        export-relative paths actually referenced
 *   losses       ImportLossItem[]  every construct that will not survive intact
 *   warnings     string[]          everything the operator should read first
 * ```
 *
 * Identity is the 32-hex id Notion puts at the end of every file and folder
 * name: a page's id comes from its `.md`, a database's from its `.csv`, and the
 * folder that shares an id with a page holds that page's children. Links
 * between files are rewritten from `notion-rel:<path>` to `notion-src:<id>`
 * here, so the write stage only has to swap in the allocated Kumi UUIDs.
 *
 * Nothing in this module touches the database.
 */

import path from "node:path";
import fs from "node:fs";
import type { ImportLossItem, ImportPlanSummary, RichTextSpan } from "../types";
import {
  ingestNotionExport,
  notionIdOf,
  notionTitleOf,
  type IngestResult,
  type SourceFile,
} from "./ingest";
import {
  parseCsv,
  inferSchema,
  type CsvTable,
  type InferredColumn,
} from "./parseCsv";
import {
  parseNotionMarkdown,
  relTargetOf,
  walkParsedBlocks,
  type ParsedBlock,
  type ParsedMarkdown,
} from "./parseMd";

/** Prefix of an href that has been resolved to a source page id. */
export const SRC_HREF_PREFIX = "notion-src:";

export interface NPage {
  /** 32-hex Notion id, or a synthetic `path:<rel>` for files without one. */
  sourceId: string;
  /** Export-relative path of the `.md` file. */
  rel: string;
  title: string;
  /** Parent page's sourceId; null means "directly under the import root". */
  parentSourceId: string | null;
  blocks: ParsedBlock[];
  /** Data source sourceId when this page is a database row. */
  rowOf: string | null;
}

export interface NRow {
  /** sourceId of the row's own `.md` page, when the export has one. */
  pageSourceId: string | null;
  title: string;
  /** Raw cell strings, aligned with the data source's columns. */
  cells: string[];
  /** 1-based line in the CSV, for loss items. */
  line: number;
}

export interface NDataSource {
  sourceId: string;
  /** Export-relative path of the CSV the schema and rows came from. */
  rel: string;
  title: string;
  /** Owning page's sourceId; null means "directly under the import root". */
  ownerPageSourceId: string | null;
  columns: InferredColumn[];
  rows: NRow[];
}

export interface NormalizedModel {
  sourcePath: string;
  sourceHash: string;
  root: string;
  /** Parents always precede their children. */
  pages: NPage[];
  dataSources: NDataSource[];
  /** Export-relative paths of files referenced by media blocks. */
  assets: string[];
  warnings: string[];
  losses: ImportLossItem[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function dirOf(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

function baseOf(rel: string): string {
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? rel : rel.slice(cut + 1);
}

/** Resolve `target` (a link inside `fromDir`) to an export-relative path. */
function resolveRel(fromDir: string, target: string): string {
  const withoutAnchor = target.split("#")[0]?.split("?")[0] ?? target;
  const joined = withoutAnchor.startsWith("/")
    ? withoutAnchor.slice(1)
    : `${fromDir === "" ? "" : `${fromDir}/`}${withoutAnchor}`;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/** The container id of whatever directory `rel` sits in, or null for the root. */
function containerIdOf(rel: string): string | null {
  const dir = dirOf(rel);
  if (dir === "") return null;
  return notionIdOf(baseOf(dir));
}

function syntheticId(rel: string): string {
  return `path:${rel.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface Losses {
  items: ImportLossItem[];
  add(kind: string, sourceRef: string, detail: string): void;
}

function newLosses(): Losses {
  const items: ImportLossItem[] = [];
  return {
    items,
    add(kind, sourceRef, detail) {
      items.push({ kind, sourceRef, detail });
    },
  };
}

interface MdFile {
  file: SourceFile;
  sourceId: string;
  parsed: ParsedMarkdown;
}

/**
 * Build the normalized model from an ingested file tree. Reads the export's
 * files; writes nothing.
 */
export function buildModel(
  ingest: IngestResult,
  onFile?: (done: number, total: number) => void,
): NormalizedModel {
  let parseable = ingest.files.filter((file) => /\.md$/i.test(file.rel)).length;
  let parsedCount = 0;
  const tick = (): void => {
    parsedCount += 1;
    onFile?.(parsedCount, parseable);
  };
  const losses = newLosses();
  const warnings: string[] = [];
  const byRel = new Map<string, SourceFile>();
  for (const file of ingest.files) byRel.set(file.rel, file);

  // --- CSVs: one data source per id, `_all` preferred over the view export.
  const csvByKey = new Map<string, { file: SourceFile; all: boolean }>();
  for (const file of ingest.files) {
    if (!file.rel.toLowerCase().endsWith(".csv")) continue;
    const base = baseOf(file.rel);
    const all = /_all\.csv$/i.test(base);
    const key = notionIdOf(base) ?? syntheticId(`${dirOf(file.rel)}/${notionTitleOf(base)}`);
    const existing = csvByKey.get(key);
    if (existing === undefined || (all && !existing.all)) {
      csvByKey.set(key, { file, all });
    }
  }
  const dataSourceIds = new Set(csvByKey.keys());
  // Only the chosen CSV of each database is parsed, so that is what the parse
  // stage's progress counts.
  parseable += csvByKey.size;

  // --- Markdown files, classified as ordinary pages or database row pages.
  const mdFiles: MdFile[] = [];
  const rowPagesByDs = new Map<string, MdFile[]>();
  for (const file of ingest.files) {
    if (!file.rel.toLowerCase().endsWith(".md")) continue;
    const base = baseOf(file.rel);
    const sourceId = notionIdOf(base) ?? syntheticId(file.rel);
    const container = containerIdOf(file.rel);
    const isRow = container !== null && dataSourceIds.has(container);
    const text = fs.readFileSync(file.abs, "utf8");
    const parsed = parseNotionMarkdown(text, { stripProperties: isRow });
    const entry: MdFile = { file, sourceId, parsed };
    mdFiles.push(entry);
    tick();
    for (const loss of parsed.losses) {
      losses.add(loss.kind, `${file.rel}:${loss.line}`, loss.detail);
    }
    if (isRow && container !== null) {
      const list = rowPagesByDs.get(container) ?? [];
      list.push(entry);
      rowPagesByDs.set(container, list);
    }
  }

  const titleOf = (entry: MdFile): string => {
    const fromFile = notionTitleOf(baseOf(entry.file.rel));
    const title = entry.parsed.title ?? fromFile;
    return title.trim() === "" ? (fromFile === "" ? "Untitled" : fromFile) : title.trim();
  };

  // --- Data sources and their rows.
  const rowPageIds = new Set<string>();
  const dataSources: NDataSource[] = [];
  for (const [sourceId, { file, all }] of csvByKey) {
    const table: CsvTable = parseCsv(fs.readFileSync(file.abs, "utf8"));
    tick();
    const columns = inferSchema(table);
    for (const column of columns) {
      if (column.warning !== null) warnings.push(`${file.rel}: ${column.warning}`);
    }
    if (!all && csvByKey.get(sourceId)?.file === file) {
      const hasAll = ingest.files.some(
        (candidate) => notionIdOf(baseOf(candidate.rel)) === sourceId && /_all\.csv$/i.test(candidate.rel),
      );
      if (hasAll) warnings.push(`${file.rel}: used the visible-view CSV`);
    }

    // Row pages match their CSV row by title; each page is claimed once.
    const pages = rowPagesByDs.get(sourceId) ?? [];
    const byTitle = new Map<string, MdFile[]>();
    for (const page of pages) {
      const key = titleOf(page);
      const list = byTitle.get(key) ?? [];
      list.push(page);
      byTitle.set(key, list);
    }
    const claimed = new Set<MdFile>();
    const rows: NRow[] = table.rows.map((cells, index) => {
      const title = (cells[0] ?? "").trim();
      const candidates = byTitle.get(title) ?? [];
      const match = candidates.find((candidate) => !claimed.has(candidate));
      if (match !== undefined) claimed.add(match);
      return {
        pageSourceId: match?.sourceId ?? null,
        title,
        cells,
        line: table.rowLines[index] ?? index + 2,
      };
    });
    for (const page of pages) {
      rowPageIds.add(page.sourceId);
      if (claimed.has(page)) continue;
      // A row page with no CSV row still holds content; it becomes a row of its
      // own rather than being dropped.
      rows.push({
        pageSourceId: page.sourceId,
        title: titleOf(page),
        cells: [titleOf(page)],
        line: 0,
      });
      losses.add(
        "row_page_unmatched",
        page.file.rel,
        `no CSV row titled "${titleOf(page)}"; imported as an extra row with its page content`,
      );
    }

    dataSources.push({
      sourceId,
      rel: file.rel,
      title: notionTitleOf(baseOf(file.rel)) || "Untitled",
      ownerPageSourceId: containerIdOf(file.rel),
      columns,
      rows,
    });
  }

  // --- Pages (row pages included: they are pages too, just owned by a row).
  const pages: NPage[] = mdFiles.map((entry) => {
    const container = containerIdOf(entry.file.rel);
    const isRow = rowPageIds.has(entry.sourceId);
    return {
      sourceId: entry.sourceId,
      rel: entry.file.rel,
      title: titleOf(entry),
      parentSourceId: isRow ? null : container,
      blocks: entry.parsed.blocks,
      rowOf: isRow && container !== null ? container : null,
    };
  });

  const pageBySourceId = new Map(pages.map((page) => [page.sourceId, page]));
  const dsBySourceId = new Map(dataSources.map((ds) => [ds.sourceId, ds]));

  // A page whose folder has no matching `.md` (or points at a database) lands
  // at the import root rather than vanishing.
  for (const page of pages) {
    if (page.parentSourceId === null) continue;
    if (pageBySourceId.has(page.parentSourceId)) continue;
    losses.add(
      "orphan_parent",
      page.rel,
      `parent page ${page.parentSourceId} is not part of the export; imported at the top level`,
    );
    page.parentSourceId = null;
  }
  for (const ds of dataSources) {
    if (ds.ownerPageSourceId === null) continue;
    if (pageBySourceId.has(ds.ownerPageSourceId)) continue;
    ds.ownerPageSourceId = null;
  }

  // --- Resolve internal links and media references against the file tree.
  const assets = new Set<string>();
  const resolveInPage = (page: NPage): void => {
    const dir = dirOf(page.rel);
    walkParsedBlocks(page.blocks, (block) => {
      if (block.assetRef !== undefined) {
        const rel = resolveRel(dir, block.assetRef);
        if (byRel.has(rel)) {
          block.assetRef = rel;
          assets.add(rel);
        } else {
          losses.add(
            "missing_asset",
            `${page.rel} → ${block.assetRef}`,
            "referenced file is not part of the export; imported as a caption",
          );
          block.assetRef = undefined;
          block.type = "paragraph";
          block.payload = { richText: block.payload.caption ?? [] };
        }
      }
      const lists: unknown[] = [block.payload.richText, block.payload.caption];
      if (Array.isArray(block.payload.cells)) lists.push(...block.payload.cells);
      for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const span of list as RichTextSpan[]) {
          if (span.type !== "text" || typeof span.href !== "string") continue;
          const target = relTargetOf(span.href);
          if (target === null) continue;
          const rel = resolveRel(dir, target);
          const targetId = notionIdOf(baseOf(rel)) ?? syntheticId(rel);
          const targetPage = pageBySourceId.get(targetId);
          const targetDs = dsBySourceId.get(targetId);
          if (targetPage !== undefined) {
            span.href = `${SRC_HREF_PREFIX}${targetPage.sourceId}`;
          } else if (targetDs !== undefined && targetDs.ownerPageSourceId !== null) {
            span.href = `${SRC_HREF_PREFIX}${targetDs.ownerPageSourceId}`;
          } else if (byRel.has(rel)) {
            // A link to a file rather than a page: import it as an asset link.
            assets.add(rel);
            span.href = `${SRC_HREF_PREFIX}file:${rel}`;
          } else {
            losses.add(
              "unresolved_link",
              `${page.rel} → ${target}`,
              "link target is not part of the export; kept as plain text",
            );
            delete span.href;
          }
        }
      }
    });
  };
  for (const page of pages) resolveInPage(page);

  // --- Warnings the operator should see before committing.
  if (dataSources.length > 0) {
    const textColumns = dataSources.reduce(
      (count, ds) => count + ds.columns.filter((column) => column.type === "text").length,
      0,
    );
    warnings.push(
      "Notion's Markdown & CSV export does not mark relation columns: a relation exports as " +
        `plain text and imports as a text column (${textColumns} text column(s) in this export)`,
    );
  }
  const unreferenced = ingest.files.filter(
    (file) =>
      !/\.(md|csv)$/i.test(file.rel) && !assets.has(file.rel),
  ).length;
  if (unreferenced > 0) {
    warnings.push(`${unreferenced} file(s) in the export are referenced by nothing and are skipped`);
  }

  // Parents before children so the write stage can create pages in one pass.
  const ordered: NPage[] = [];
  const emitted = new Set<string>();
  const emit = (page: NPage, guard: Set<string>): void => {
    if (emitted.has(page.sourceId) || guard.has(page.sourceId)) return;
    guard.add(page.sourceId);
    const parent = page.parentSourceId === null ? undefined : pageBySourceId.get(page.parentSourceId);
    if (parent !== undefined) emit(parent, guard);
    if (emitted.has(page.sourceId)) return;
    emitted.add(page.sourceId);
    ordered.push(page);
  };
  for (const page of pages) emit(page, new Set());

  return {
    sourcePath: ingest.sourcePath,
    sourceHash: ingest.sourceHash,
    root: ingest.root,
    pages: ordered,
    dataSources,
    assets: [...assets].sort(),
    warnings,
    losses: losses.items,
  };
}

/** Group losses by kind for {@link ImportPlanSummary.unsupported}. */
export function aggregateLosses(
  losses: ImportLossItem[],
): { kind: string; detail: string; count: number }[] {
  const byKind = new Map<string, { kind: string; detail: string; count: number }>();
  for (const loss of losses) {
    const existing = byKind.get(loss.kind);
    if (existing === undefined) {
      byKind.set(loss.kind, { kind: loss.kind, detail: loss.detail, count: 1 });
      continue;
    }
    existing.count += 1;
  }
  return [...byKind.values()].sort((a, b) => (a.kind < b.kind ? -1 : 1));
}

/** Pages the import will create, excluding database rows and the import root. */
export function contentPageCount(model: NormalizedModel): number {
  return model.pages.filter((page) => page.rowOf === null).length;
}

/** Rows the import will create; each is also a page. */
export function rowCount(model: NormalizedModel): number {
  return model.dataSources.reduce((count, ds) => count + ds.rows.length, 0);
}

/** Summarize a model as the plan the operator confirms. */
export function summarize(model: NormalizedModel): ImportPlanSummary {
  return {
    sourcePath: model.sourcePath,
    sourceHash: model.sourceHash,
    pages: contentPageCount(model),
    dataSources: model.dataSources.length,
    rows: rowCount(model),
    assets: model.assets.length,
    warnings: [...model.warnings],
    unsupported: aggregateLosses(model.losses),
  };
}

/**
 * Parse an export and report what an import would create — the full pipeline
 * up to (but not including) the first write.
 */
export function planNotionImport(sourcePath: string): ImportPlanSummary {
  const ingest = ingestNotionExport(sourcePath);
  try {
    return summarize(buildModel(ingest));
  } finally {
    ingest.cleanup();
  }
}

/** Ingest + parse in one step, for callers that go on to write. */
export function loadModel(
  sourcePath: string,
  onFile?: (done: number, total: number) => void,
): { model: NormalizedModel; ingest: IngestResult } {
  const ingest = ingestNotionExport(sourcePath);
  try {
    return { model: buildModel(ingest, onFile), ingest };
  } catch (error) {
    ingest.cleanup();
    throw error;
  }
}

/** Absolute path of an export-relative file. */
export function absoluteOf(model: NormalizedModel, rel: string): string {
  return path.join(model.root, ...rel.split("/"));
}
