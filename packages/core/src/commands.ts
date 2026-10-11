/**
 * The command layer: the single implementation of `KumiCommands` used by both
 * Electron main (over typed IPC) and the `kumi` CLI (direct require).
 *
 * Conventions
 * -----------
 * - Every multi-step mutation runs inside a transaction.
 * - Failures throw `KumiError` with a stable `code`; the only exception is
 *   `applyBlockOps`, which reports per-op failures in `BatchResult.rejected`
 *   so a batch applies everything it can.
 * - `search_index` is maintained from here, inside the mutating transaction.
 * - Sibling positioning: `afterPageId === undefined` appends last,
 *   `afterPageId === null` inserts first, otherwise the new sibling follows the
 *   named one.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAssetStore } from "./assets";
import {
  assetsDirOf,
  statement,
  withTransaction,
  workspacePathOf,
  type Db,
  type Stmt,
} from "./db";
import { KumiError, invalid, notFound } from "./errors";
import { extractLinkTargets } from "./links";
import {
  blocksToMarkdown,
  safeFileName,
  uniqueFileName,
  type MarkdownContext,
} from "./markdown";
import { planNotionImport as planNotionImportFrom } from "./notion/plan";
import {
  listImportJobs as listImportJobRows,
  runNotionImport as runNotionImportInto,
} from "./notion/write";
import { MAX_QUERY_LIMIT, clampPagination, filterRows, sortRows } from "./query";
import { rankBetween, validateRank } from "./rank";
import {
  TEMPLATE_VERSION,
  remapTemplateState,
  type TemplateBlock,
  type TemplateDataSource,
  type TemplateDsRow,
  type TemplatePage,
  type TemplateProperty,
  type TemplatePropertyValue,
  type TemplateState,
  type TemplateView,
} from "./template";
import { buildMatchExpression, payloadToPlain, richTextToPlain } from "./text";
import type {
  Asset,
  Backlink,
  BatchResult,
  Block,
  BlockOp,
  BlockPayload,
  BlockType,
  CreatePageInput,
  DataSource,
  ExportResult,
  Id,
  ImportJobInfo,
  ImportPlanSummary,
  ImportProgress,
  ImportReport,
  KumiCommands,
  Page,
  PageSnapshot,
  PageTreeNode,
  PropertyConfig,
  PropertyDef,
  PropertyType,
  PropertyValue,
  QueryOptions,
  QueryResult,
  RelationConfig,
  RollupAggregation,
  RollupConfig,
  RowRecord,
  SearchResult,
  SnapshotMeta,
  TemplateMeta,
  UpdatePageInput,
  UserState,
  View,
  ViewConfig,
  ViewType,
  WorkspaceInfo,
} from "./types";
import {
  assertPropertyType,
  convertPropertyValue,
  dateMs,
  isEmptyValue,
  normalizeConfig,
  plainTextOf,
  pruneToConfig,
  relationConfigOf,
  rollupConfigOf,
  rollupKind,
  textToRichText,
  validatePropertyValue,
  type ValueContext,
} from "./values";

/** Every block type the storage layer accepts, for runtime validation. */
export const BLOCK_TYPES: readonly BlockType[] = [
  "paragraph",
  "heading1",
  "heading2",
  "heading3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "divider",
  "code",
  "equation",
  "bookmark",
  "table_of_contents",
  "image",
  "file",
  "video",
  "audio",
  "embed",
  "child_page",
  "linked_page",
  "column_list",
  "column",
  "table",
  "table_row",
  "synced_block",
  "synced_reference",
  "child_database",
];

/** Every view type the storage layer accepts, for runtime validation. */
export const VIEW_TYPES: readonly ViewType[] = [
  "table",
  "board",
  "list",
  "gallery",
  "calendar",
  "timeline",
];

const BLOCK_TYPE_SET = new Set<string>(BLOCK_TYPES);
const VIEW_TYPE_SET = new Set<string>(VIEW_TYPES);
const THEMES: readonly UserState["theme"][] = ["system", "light", "dark"];
const DEFAULT_DATA_SOURCE_TITLE = "Untitled";
const TITLE_PROPERTY_NAME = "Name";
const DEFAULT_VIEW_NAME = "Table";
const RECENTS_CAP = 30;
const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;
const ACTOR = "local";
const UNTITLED = "Untitled";

/** Newest snapshots kept per page; older ones are pruned as new ones land. */
const SNAPSHOT_RETENTION = 200;
/**
 * How stale a page's newest snapshot must be before `applyBlockOps` takes
 * another one. Ten minutes is the granularity of the history the user sees: a
 * long editing session leaves one restore point every ten minutes, and a page
 * that is edited once a week gets one per edit.
 */
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

const EXPORT_FORMAT_VERSION = 1;
const WORKSPACE_EXPORT_FILE = "kumi-workspace.json";
const EXPORT_ASSETS_DIR = "assets";

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface PageRow {
  id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  cover_asset_id: string | null;
  locked: number;
  full_width: number;
  small_text: number;
  rank: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  trash_batch_id: string | null;
}

interface BlockRow {
  id: string;
  page_id: string;
  parent_block_id: string | null;
  rank: string;
  type: string;
  payload: string;
  version: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

interface IdRow {
  id: string;
}

interface BacklinkRow {
  source_page_id: string;
  source_block_id: string;
  source_page_title: string;
  source_page_icon: string | null;
}

interface SearchRow {
  page_id: string;
  title: string;
  icon: string | null;
  updated_at: number;
  title_snippet: string;
  body_snippet: string;
}

interface DataSourceRow {
  id: string;
  page_id: string;
  title: string;
  created_at: number;
  updated_at: number;
}

interface PropertyRow {
  id: string;
  data_source_id: string;
  name: string;
  type: string;
  config: string;
  rank: string;
}

interface ViewRow {
  id: string;
  data_source_id: string;
  name: string;
  type: string;
  config: string;
  rank: string;
  locked: number;
}

interface DsRowRow {
  page_id: string;
  data_source_id: string;
  rank: string;
}

interface ValueRow {
  page_id: string;
  property_id: string;
  value: string;
}

interface SnapshotRow {
  id: string;
  page_id: string;
  cause: string;
  state: string;
  created_at: number;
}

interface SnapshotMetaRow {
  id: string;
  page_id: string;
  cause: string;
  created_at: number;
}

interface TemplateRow {
  id: string;
  name: string;
  icon: string | null;
  state: string;
  created_at: number;
}

interface LinkRow {
  source_block_id: string;
  source_page_id: string;
  target_page_id: string;
}

interface AssetRow {
  id: string;
  content_hash: string;
  mime: string;
  size: number;
  path: string;
  created_at: number;
}

/** A row page joined with its position inside the data source. */
type RowPageRow = PageRow & { row_rank: string };

/** Anything ordered by a fractional rank among its siblings. */
interface RankedRow {
  id: string;
  rank: string;
}

/** Everything a read needs to know about a related data source. */
interface RelatedData {
  /** Live (non-trashed) row page ids. */
  liveIds: Set<Id>;
  /** Page titles of those rows. */
  titles: Map<Id, string>;
  /** The data source's properties, by id. */
  properties: Map<Id, PropertyDef>;
  /** Cells of its live rows: page id → property id → value (title included). */
  values: Map<Id, Map<Id, PropertyValue>>;
}

/**
 * One read's view of the data sources it had to reach into. Relations and
 * rollups are recomputed on every read — nothing is cached between calls — but
 * within a single call each related data source is loaded exactly once, so a
 * query over N rows still costs a constant number of statements.
 */
interface ReadContext {
  related(dataSourceId: Id): RelatedData;
}

function parsePayload(json: string): BlockPayload {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  // JSON boundary: payloads are validated on write, trusted on read.
  return parsed as BlockPayload;
}

function rowToPage(row: PageRow): Page {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    coverAssetId: row.cover_asset_id,
    locked: row.locked !== 0,
    fullWidth: row.full_width !== 0,
    smallText: row.small_text !== 0,
    rank: row.rank,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function rowToBlock(row: BlockRow): Block {
  return {
    id: row.id,
    pageId: row.page_id,
    parentBlockId: row.parent_block_id,
    rank: row.rank,
    type: row.type as BlockType,
    payload: parsePayload(row.payload),
    version: row.version,
    archived: row.archived !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertPayload(value: unknown): BlockPayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("block payload must be an object");
  }
  return value as BlockPayload;
}

function assertBlockType(value: string): BlockType {
  if (!BLOCK_TYPE_SET.has(value)) throw invalid(`unknown block type: ${value}`);
  return value as BlockType;
}

function asIdArray(value: unknown): Id[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * JSON boundary for database payloads: configs and values are validated on
 * write, so a stored object is trusted on read (a corrupt row degrades to an
 * empty object rather than throwing mid-query).
 */
function parseJsonObject<T extends object>(json: string, fallback: T): T {
  const parsed: unknown = JSON.parse(json);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  return parsed as T;
}

function rowToDataSource(row: DataSourceRow): DataSource {
  return {
    id: row.id,
    pageId: row.page_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProperty(row: PropertyRow): PropertyDef {
  return {
    id: row.id,
    dataSourceId: row.data_source_id,
    name: row.name,
    type: row.type as PropertyType,
    config: parseJsonObject<PropertyConfig>(row.config, {}),
    rank: row.rank,
  };
}

/** View config defaults; a stored config always carries every key. */
function defaultViewConfig(): ViewConfig {
  return {
    filter: null,
    sorts: [],
    visibleProperties: null,
    propertyWidths: {},
    openMode: "center_peek",
  };
}

function rowToView(row: ViewRow): View {
  return {
    id: row.id,
    dataSourceId: row.data_source_id,
    name: row.name,
    type: row.type as ViewType,
    config: parseJsonObject<ViewConfig>(row.config, defaultViewConfig()),
    rank: row.rank,
    locked: row.locked !== 0,
  };
}

function parseValue(json: string): PropertyValue {
  // Values are validated on write; a stored value is a legal variant.
  return JSON.parse(json) as PropertyValue;
}

function assertViewType(value: string): ViewType {
  if (!VIEW_TYPE_SET.has(value)) throw invalid(`unknown view type: ${value}`);
  return value as ViewType;
}

function assertSnapshotCause(value: string): SnapshotMeta["cause"] {
  return value === "auto" || value === "manual" || value === "restore"
    ? value
    : "manual";
}

/** What `page_snapshots.state` holds: the page's metadata and its block tree. */
interface SnapshotState {
  title: string;
  icon: string | null;
  blocks: Block[];
}

function parseSnapshotState(json: string): SnapshotState {
  const parsed = parseJsonObject<Partial<SnapshotState>>(json, {});
  return {
    title: typeof parsed.title === "string" ? parsed.title : "",
    icon: typeof parsed.icon === "string" ? parsed.icon : null,
    blocks: Array.isArray(parsed.blocks) ? parsed.blocks : [],
  };
}

function emptyTemplateState(): TemplateState {
  return {
    templateVersion: TEMPLATE_VERSION,
    rootPageId: "",
    pages: [],
    blocks: [],
    dataSources: [],
    properties: [],
    views: [],
    dsRows: [],
    propertyValues: [],
  };
}

/** Templates are written by this module, so a stored state is trusted on read. */
function parseTemplateState(json: string): TemplateState {
  return parseJsonObject<TemplateState>(json, emptyTemplateState());
}

/** Percent-encode a relative path so it is a legal Markdown link target. */
function encodeHref(relative: string): string {
  return relative
    .split("/")
    .map((segment) => (segment === ".." ? segment : encodeURIComponent(segment)))
    .join("/");
}

function joinRel(dirRel: string, name: string): string {
  return dirRel === "" ? name : `${dirRel}/${name}`;
}

/** Relative POSIX href from the directory of a Markdown file to `targetRel`. */
function hrefBetween(fromDirRel: string, targetRel: string): string {
  const relative = path.posix.relative(
    fromDirRel === "" ? "." : fromDirRel,
    targetRel,
  );
  return encodeHref(relative);
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvLine(fields: string[]): string {
  return fields.map(csvField).join(",");
}

/**
 * Build the `KumiCommands` implementation bound to an open workspace database.
 * Statements are prepared once and reused for the lifetime of the connection.
 */
export function createCommands(db: Db): KumiCommands {
  const q = <R>(sql: string): Stmt<R> => statement<R>(db, sql);
  /** A statement executed only for its effect. */
  const run = (sql: string): Stmt<never> => statement<never>(db, sql);
  /** Wrap a command body so every one of its steps commits or rolls back together. */
  const tx =
    <A extends unknown[], R>(body: (...args: A) => R) =>
    (...args: A): R =>
      withTransaction(db, () => body(...args));

  const assets = createAssetStore(db);

  const s = {
    // pages
    pageById: q<PageRow>("SELECT * FROM pages WHERE id = ?"),
    pageRowid: q<{ rowid: number; title: string }>(
      "SELECT rowid AS rowid, title FROM pages WHERE id = ?",
    ),
    siblingsOfRoot: q<PageRow>(
      "SELECT * FROM pages WHERE parent_id IS NULL ORDER BY rank",
    ),
    siblingsOf: q<PageRow>(
      "SELECT * FROM pages WHERE parent_id = ? ORDER BY rank",
    ),
    // Appending is the common case and must not scan the sibling list.
    lastRootSiblingRank: q<{ rank: string }>(
      "SELECT rank FROM pages WHERE parent_id IS NULL ORDER BY rank DESC LIMIT 1",
    ),
    lastSiblingRank: q<{ rank: string }>(
      "SELECT rank FROM pages WHERE parent_id = ? ORDER BY rank DESC LIMIT 1",
    ),
    // Database rows are pages parented to the data source's owner page, but
    // they are not tree members: they surface through queryDataSource only.
    liveRoots: q<PageRow>(
      `SELECT * FROM pages
       WHERE parent_id IS NULL AND deleted_at IS NULL
         AND id NOT IN (SELECT page_id FROM ds_rows)
       ORDER BY rank`,
    ),
    liveChildren: q<PageRow>(
      `SELECT * FROM pages
       WHERE parent_id = ? AND deleted_at IS NULL
         AND id NOT IN (SELECT page_id FROM ds_rows)
       ORDER BY rank`,
    ),
    hasLiveChildren: q<{ n: number }>(
      `SELECT EXISTS (
         SELECT 1 FROM pages
         WHERE parent_id = ? AND deleted_at IS NULL
           AND id NOT IN (SELECT page_id FROM ds_rows)
       ) AS n`,
    ),
    trashRoots: q<PageRow>(
      "SELECT * FROM pages WHERE deleted_at IS NOT NULL AND trash_batch_id = id ORDER BY deleted_at DESC",
    ),
    insertPage: run(
      `INSERT INTO pages (id, parent_id, title, icon, cover_asset_id, locked, full_width,
                          small_text, rank, created_at, updated_at, deleted_at, trash_batch_id)
       VALUES (@id, @parent_id, @title, @icon, @cover_asset_id, @locked, @full_width,
               @small_text, @rank, @created_at, @updated_at, NULL, NULL)`,
    ),
    updatePageFields: run(
      `UPDATE pages SET title = @title, icon = @icon, cover_asset_id = @cover_asset_id,
                        locked = @locked, full_width = @full_width, small_text = @small_text,
                        updated_at = @updated_at
       WHERE id = @id`,
    ),
    movePageRow: run(
      "UPDATE pages SET parent_id = ?, rank = ?, updated_at = ? WHERE id = ?",
    ),
    touchPage: run("UPDATE pages SET updated_at = ? WHERE id = ?"),
    setPageTitle: run("UPDATE pages SET title = ?, updated_at = ? WHERE id = ?"),
    subtreeIds: q<IdRow>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = ?
         UNION ALL
         SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
       ) SELECT id FROM sub`,
    ),
    trashSubtree: run(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = @root
         UNION ALL
         SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
       )
       UPDATE pages SET deleted_at = @now, trash_batch_id = @root, updated_at = @now
       WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL`,
    ),
    restoreBatch: run(
      `UPDATE pages SET deleted_at = NULL, trash_batch_id = NULL, updated_at = ?
       WHERE trash_batch_id = ?`,
    ),
    deletePageRow: run("DELETE FROM pages WHERE id = ?"),

    // blocks
    blockById: q<BlockRow>("SELECT * FROM blocks WHERE id = ?"),
    liveBlocksOfPage: q<BlockRow>(
      "SELECT * FROM blocks WHERE page_id = ? AND archived = 0 ORDER BY rank",
    ),
    blockPayloadsOfPage: q<{ payload: string }>(
      "SELECT payload FROM blocks WHERE page_id = ? AND archived = 0 ORDER BY rank",
    ),
    insertBlock: run(
      `INSERT INTO blocks (id, page_id, parent_block_id, rank, type, payload, version,
                           archived, created_at, updated_at)
       VALUES (@id, @page_id, @parent_block_id, @rank, @type, @payload, @version, 0,
               @created_at, @updated_at)`,
    ),
    updateBlockContent: run(
      `UPDATE blocks SET type = ?, payload = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ),
    moveBlockRow: run(
      `UPDATE blocks SET parent_block_id = ?, rank = ?, version = version + 1, updated_at = ?
       WHERE id = ?`,
    ),
    archiveBlockSubtree: run(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM blocks WHERE id = @root
         UNION ALL
         SELECT b.id FROM blocks b JOIN sub ON b.parent_block_id = sub.id
       )
       UPDATE blocks SET archived = 1, version = version + 1, updated_at = @now
       WHERE id IN (SELECT id FROM sub) AND archived = 0`,
    ),
    blockSubtreeIds: q<IdRow>(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM blocks WHERE id = ?
         UNION ALL
         SELECT b.id FROM blocks b JOIN sub ON b.parent_block_id = sub.id
       ) SELECT id FROM sub`,
    ),

    // links index
    deleteLinksOfBlock: run("DELETE FROM links WHERE source_block_id = ?"),
    deleteLinksOfBlockSubtree: run(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM blocks WHERE id = ?
         UNION ALL
         SELECT b.id FROM blocks b JOIN sub ON b.parent_block_id = sub.id
       )
       DELETE FROM links WHERE source_block_id IN (SELECT id FROM sub)`,
    ),
    insertLink: run(
      `INSERT OR IGNORE INTO links (source_block_id, source_page_id, target_page_id)
       VALUES (?, ?, ?)`,
    ),
    pageExists: q<{ n: number }>("SELECT 1 AS n FROM pages WHERE id = ?"),
    backlinksOf: q<BacklinkRow>(
      `SELECT l.source_page_id  AS source_page_id,
              l.source_block_id AS source_block_id,
              p.title           AS source_page_title,
              p.icon            AS source_page_icon
       FROM links l
       JOIN pages p ON p.id = l.source_page_id
       JOIN blocks b ON b.id = l.source_block_id
       WHERE l.target_page_id = ?
         AND p.deleted_at IS NULL
         AND b.archived = 0
       ORDER BY p.updated_at DESC, p.id, b.rank, b.id`,
    ),

    // ops + revisions
    opApplied: q<{ op_id: string }>(
      "SELECT op_id FROM applied_ops WHERE op_id = ?",
    ),
    recordOp: run(
      "INSERT INTO applied_ops (op_id, applied_at) VALUES (?, ?)",
    ),
    insertRevision: run(
      `INSERT INTO revisions (id, entity_type, entity_id, page_id, actor, version, patch, created_at)
       VALUES (@id, @entity_type, @entity_id, @page_id, @actor, @version, @patch, @created_at)`,
    ),

    // search
    deleteSearchRow: run("DELETE FROM search_index WHERE rowid = ?"),
    insertSearchRow: run(
      "INSERT INTO search_index (rowid, page_id, title, body) VALUES (?, ?, ?, ?)",
    ),
    searchQuery: q<SearchRow>(
      `SELECT search_index.page_id AS page_id,
              p.title AS title,
              p.icon AS icon,
              p.updated_at AS updated_at,
              snippet(search_index, 1, '<b>', '</b>', '…', 12) AS title_snippet,
              snippet(search_index, 2, '<b>', '</b>', '…', 12) AS body_snippet
       FROM search_index
       JOIN pages p ON p.id = search_index.page_id
       WHERE search_index MATCH ? AND p.deleted_at IS NULL
       ORDER BY bm25(search_index, 0.0, 10.0, 1.0), p.updated_at DESC
       LIMIT ?`,
    ),

    // key/value
    getMeta: q<{ value: string }>(
      "SELECT value FROM workspace_meta WHERE key = ?",
    ),
    setMeta: run(
      `INSERT INTO workspace_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    getState: q<{ value: string }>("SELECT value FROM user_state WHERE key = ?"),
    setState: run(
      `INSERT INTO user_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ),
    isLivePage: q<{ n: number }>(
      "SELECT 1 AS n FROM pages WHERE id = ? AND deleted_at IS NULL",
    ),

    // databases
    dataSourceById: q<DataSourceRow>("SELECT * FROM data_sources WHERE id = ?"),
    dataSourcesOfPage: q<DataSourceRow>(
      "SELECT * FROM data_sources WHERE page_id = ? ORDER BY created_at, id",
    ),
    insertDataSource: run(
      `INSERT INTO data_sources (id, page_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    renameDataSourceRow: run(
      "UPDATE data_sources SET title = ?, updated_at = ? WHERE id = ?",
    ),
    touchDataSource: run("UPDATE data_sources SET updated_at = ? WHERE id = ?"),
    deleteDataSourceRow: run("DELETE FROM data_sources WHERE id = ?"),

    propertyById: q<PropertyRow>("SELECT * FROM properties WHERE id = ?"),
    propertiesOfDataSource: q<PropertyRow>(
      "SELECT * FROM properties WHERE data_source_id = ? ORDER BY rank",
    ),
    insertProperty: run(
      `INSERT INTO properties (id, data_source_id, name, type, config, rank)
       VALUES (@id, @data_source_id, @name, @type, @config, @rank)`,
    ),
    updatePropertyRow: run(
      "UPDATE properties SET name = ?, type = ?, config = ? WHERE id = ?",
    ),
    setPropertyRank: run("UPDATE properties SET rank = ? WHERE id = ?"),
    deletePropertyRow: run("DELETE FROM properties WHERE id = ?"),

    viewById: q<ViewRow>("SELECT * FROM views WHERE id = ?"),
    viewsOfDataSource: q<ViewRow>(
      "SELECT * FROM views WHERE data_source_id = ? ORDER BY rank",
    ),
    insertView: run(
      `INSERT INTO views (id, data_source_id, name, type, config, rank, locked)
       VALUES (@id, @data_source_id, @name, @type, @config, @rank, @locked)`,
    ),
    updateViewRow: run(
      "UPDATE views SET name = ?, type = ?, config = ?, locked = ? WHERE id = ?",
    ),
    setViewRank: run("UPDATE views SET rank = ? WHERE id = ?"),
    deleteViewRow: run("DELETE FROM views WHERE id = ?"),

    dsRowByPage: q<DsRowRow>("SELECT * FROM ds_rows WHERE page_id = ?"),
    dsRowEntries: q<RankedRow>(
      "SELECT page_id AS id, rank FROM ds_rows WHERE data_source_id = ? ORDER BY rank",
    ),
    lastRowRank: q<{ rank: string }>(
      "SELECT rank FROM ds_rows WHERE data_source_id = ? ORDER BY rank DESC LIMIT 1",
    ),
    firstRowRank: q<{ rank: string }>(
      "SELECT rank FROM ds_rows WHERE data_source_id = ? ORDER BY rank LIMIT 1",
    ),
    insertDsRow: run(
      "INSERT INTO ds_rows (page_id, data_source_id, rank) VALUES (?, ?, ?)",
    ),
    // One query per data source: the live row pages in row order.
    liveRowPages: q<RowPageRow>(
      `SELECT p.*, r.rank AS row_rank
       FROM ds_rows r
       JOIN pages p ON p.id = r.page_id
       WHERE r.data_source_id = ? AND p.deleted_at IS NULL
       ORDER BY r.rank`,
    ),
    // …and one for every stored cell of those rows.
    valuesOfDataSource: q<ValueRow>(
      `SELECT v.page_id AS page_id, v.property_id AS property_id, v.value AS value
       FROM property_values v
       JOIN ds_rows r ON r.page_id = v.page_id
       WHERE r.data_source_id = ?`,
    ),
    valuesOfPage: q<ValueRow>(
      "SELECT page_id, property_id, value FROM property_values WHERE page_id = ?",
    ),
    valuesOfProperty: q<ValueRow>(
      "SELECT page_id, property_id, value FROM property_values WHERE property_id = ?",
    ),
    upsertValue: run(
      `INSERT INTO property_values (page_id, property_id, value) VALUES (?, ?, ?)
       ON CONFLICT(page_id, property_id) DO UPDATE SET value = excluded.value`,
    ),
    deleteValue: run(
      "DELETE FROM property_values WHERE page_id = ? AND property_id = ?",
    ),
    // Trash a row's subtree under a caller-chosen batch id, so deleteDataSource
    // moves every row to the trash as one restorable batch.
    trashRowSubtree: run(
      `WITH RECURSIVE sub(id) AS (
         SELECT id FROM pages WHERE id = @root
         UNION ALL
         SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id
       )
       UPDATE pages SET deleted_at = @now, trash_batch_id = @batch, updated_at = @now
       WHERE id IN (SELECT id FROM sub) AND deleted_at IS NULL`,
    ),

    // relations & rollups
    dataSourceExists: q<{ n: number }>(
      "SELECT 1 AS n FROM data_sources WHERE id = ?",
    ),
    /** Every relation property in the workspace; the set is schema-sized. */
    relationProperties: q<PropertyRow>(
      "SELECT * FROM properties WHERE type = 'relation'",
    ),
    liveRowsOfDataSource: q<{ id: string; title: string }>(
      `SELECT p.id AS id, p.title AS title
       FROM ds_rows r
       JOIN pages p ON p.id = r.page_id
       WHERE r.data_source_id = ? AND p.deleted_at IS NULL`,
    ),
    isLiveRowOf: q<{ n: number }>(
      `SELECT 1 AS n
       FROM ds_rows r
       JOIN pages p ON p.id = r.page_id
       WHERE r.page_id = ? AND r.data_source_id = ? AND p.deleted_at IS NULL`,
    ),
    valueOfCell: q<ValueRow>(
      `SELECT page_id, property_id, value FROM property_values
       WHERE page_id = ? AND property_id = ?`,
    ),
    deleteValuesOfProperty: run(
      "DELETE FROM property_values WHERE property_id = ?",
    ),

    // history
    insertSnapshot: run(
      `INSERT INTO page_snapshots (id, page_id, cause, state, created_at)
       VALUES (@id, @page_id, @cause, @state, @created_at)`,
    ),
    snapshotById: q<SnapshotRow>("SELECT * FROM page_snapshots WHERE id = ?"),
    snapshotMetasOfPage: q<SnapshotMetaRow>(
      `SELECT id, page_id, cause, created_at FROM page_snapshots
       WHERE page_id = ? ORDER BY created_at DESC, rowid DESC`,
    ),
    // The auto-snapshot age probe: one hit on page_snapshots_page_created.
    newestSnapshotAt: q<{ created_at: number }>(
      `SELECT created_at FROM page_snapshots
       WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ),
    pruneSnapshots: run(
      `DELETE FROM page_snapshots
       WHERE page_id = @page_id AND id NOT IN (
         SELECT id FROM page_snapshots WHERE page_id = @page_id
         ORDER BY created_at DESC, rowid DESC LIMIT @keep
       )`,
    ),
    blockVersionsOfPage: q<{ id: string; version: number }>(
      "SELECT id, version FROM blocks WHERE page_id = ?",
    ),
    deleteBlocksOfPage: run("DELETE FROM blocks WHERE page_id = ?"),
    setPageTitleIcon: run(
      "UPDATE pages SET title = ?, icon = ?, updated_at = ? WHERE id = ?",
    ),

    // templates
    insertTemplate: run(
      `INSERT INTO templates (id, name, icon, state, created_at)
       VALUES (@id, @name, @icon, @state, @created_at)`,
    ),
    templateById: q<TemplateRow>("SELECT * FROM templates WHERE id = ?"),
    allTemplates: q<TemplateRow>(
      "SELECT * FROM templates ORDER BY created_at DESC, rowid DESC",
    ),
    deleteTemplateRow: run("DELETE FROM templates WHERE id = ?"),

    // full-workspace export: raw dumps in a stable, id-ordered sequence
    allPages: q<PageRow>("SELECT * FROM pages ORDER BY id"),
    allBlocks: q<BlockRow>("SELECT * FROM blocks ORDER BY id"),
    allDataSources: q<DataSourceRow>("SELECT * FROM data_sources ORDER BY id"),
    allProperties: q<PropertyRow>("SELECT * FROM properties ORDER BY id"),
    allPropertyValues: q<ValueRow>(
      "SELECT * FROM property_values ORDER BY page_id, property_id",
    ),
    allDsRows: q<DsRowRow>("SELECT * FROM ds_rows ORDER BY page_id"),
    allViews: q<ViewRow>("SELECT * FROM views ORDER BY id"),
    allLinks: q<LinkRow>(
      "SELECT * FROM links ORDER BY source_block_id, target_page_id",
    ),
    allAssets: q<AssetRow>("SELECT * FROM assets ORDER BY id"),
  };

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  const now = (): number => Date.now();

  const getPageRow = (id: Id): PageRow | undefined => s.pageById.get(id);

  const requirePageRow = (id: Id): PageRow => {
    const row = getPageRow(id);
    if (row === undefined) throw notFound("page", id);
    return row;
  };

  const siblingRows = (parentId: Id | null): PageRow[] =>
    parentId === null ? s.siblingsOfRoot.all() : s.siblingsOf.all(parentId);

  /**
   * Rank for a page placed among `parentId`'s children. `excludeId` drops the
   * page being moved from the reference list so it never anchors itself.
   */
  const rankForPosition = (
    parentId: Id | null,
    afterPageId: Id | null | undefined,
    excludeId?: Id,
  ): string => {
    if (afterPageId === undefined && excludeId === undefined) {
      const last =
        parentId === null
          ? s.lastRootSiblingRank.get()
          : s.lastSiblingRank.get(parentId);
      return rankBetween(last?.rank ?? null, null);
    }
    const rows = siblingRows(parentId).filter((r) => r.id !== excludeId);
    if (afterPageId === undefined) {
      const last = rows[rows.length - 1];
      return rankBetween(last === undefined ? null : last.rank, null);
    }
    if (afterPageId === null) {
      const first = rows[0];
      return rankBetween(null, first === undefined ? null : first.rank);
    }
    const index = rows.findIndex((r) => r.id === afterPageId);
    if (index < 0) {
      throw invalid(`afterPageId is not a sibling of the target parent: ${afterPageId}`);
    }
    const before = rows[index];
    const after = rows[index + 1];
    return rankBetween(
      before === undefined ? null : before.rank,
      after === undefined ? null : after.rank,
    );
  };

  const reindexPage = (pageId: Id): void => {
    const row = s.pageRowid.get(pageId);
    if (row === undefined) return;
    s.deleteSearchRow.run(row.rowid);
    const body = s.blockPayloadsOfPage
      .all(pageId)
      .map((b) => payloadToPlain(parsePayload(b.payload)))
      .filter((t) => t !== "")
      .join("\n");
    s.insertSearchRow.run(row.rowid, pageId, row.title, body);
  };

  /**
   * Replace a block's rows in the `links` index with the references its
   * current payload carries. Targets that are not (yet) pages are skipped:
   * an importer may write a link before its target exists, and the next edit
   * of the block resolves it.
   */
  const reindexBlockLinks = (
    blockId: Id,
    pageId: Id,
    type: BlockType,
    payload: BlockPayload,
  ): void => {
    s.deleteLinksOfBlock.run(blockId);
    for (const target of extractLinkTargets(type, payload)) {
      if (s.pageExists.get(target) === undefined) continue;
      s.insertLink.run(blockId, pageId, target);
    }
  };

  const dropSearchRow = (pageId: Id): void => {
    const row = s.pageRowid.get(pageId);
    if (row !== undefined) s.deleteSearchRow.run(row.rowid);
  };

  const isDescendantPage = (candidate: Id, ancestor: Id): boolean =>
    s.subtreeIds.all(ancestor).some((r) => r.id === candidate);

  const isDescendantBlock = (candidate: Id, ancestor: Id): boolean =>
    s.blockSubtreeIds.all(ancestor).some((r) => r.id === candidate);

  const breadcrumbFor = (pageId: Id): Pick<Page, "id" | "title" | "icon">[] => {
    const chain: Pick<Page, "id" | "title" | "icon">[] = [];
    const seen = new Set<string>();
    let current: PageRow | undefined = requirePageRow(pageId);
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push({ id: current.id, title: current.title, icon: current.icon });
      current =
        current.parent_id === null ? undefined : getPageRow(current.parent_id);
    }
    return chain.reverse();
  };

  const treeNodes = (rows: PageRow[]): PageTreeNode[] =>
    rows.map((row) => ({
      page: rowToPage(row),
      hasChildren: (s.hasLiveChildren.get(row.id)?.n ?? 0) !== 0,
    }));

  /** Depth-first block order: parents before children, siblings by rank. */
  const orderBlocksDepthFirst = (rows: BlockRow[]): BlockRow[] => {
    const byParent = new Map<string, BlockRow[]>();
    for (const row of rows) {
      const key = row.parent_block_id ?? "";
      const bucket = byParent.get(key);
      if (bucket === undefined) byParent.set(key, [row]);
      else bucket.push(row);
    }
    for (const bucket of byParent.values()) {
      bucket.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    }
    const out: BlockRow[] = [];
    const visit = (key: string): void => {
      for (const row of byParent.get(key) ?? []) {
        out.push(row);
        visit(row.id);
      }
    };
    visit("");
    // Blocks whose parent is missing from the set would otherwise be lost;
    // append them so the caller always sees the full page.
    if (out.length !== rows.length) {
      const seen = new Set(out.map((r) => r.id));
      for (const row of rows) if (!seen.has(row.id)) out.push(row);
    }
    return out;
  };

  const readStateJson = (key: string): unknown => {
    const row = s.getState.get(key);
    if (row === undefined) return undefined;
    return JSON.parse(row.value) as unknown;
  };

  const writeStateJson = (key: string, value: unknown): void => {
    s.setState.run(key, JSON.stringify(value));
  };

  const liveIds = (ids: Id[]): Id[] =>
    ids.filter((id) => s.isLivePage.get(id) !== undefined);

  const readTheme = (): UserState["theme"] => {
    const value = readStateJson("theme");
    return THEMES.find((t) => t === value) ?? "system";
  };

  const workspaceInfo = (): WorkspaceInfo => {
    const nameRow = s.getMeta.get("name");
    const iconRow = s.getMeta.get("icon");
    const name: unknown = nameRow === undefined ? "Kumi" : JSON.parse(nameRow.value);
    const icon: unknown = iconRow === undefined ? null : JSON.parse(iconRow.value);
    return {
      path: workspacePathOf(db),
      name: typeof name === "string" ? name : "Kumi",
      icon: typeof icon === "string" ? icon : null,
    };
  };

  const buildUserState = (): UserState => ({
    favorites: liveIds(asIdArray(readStateJson("favorites"))),
    recents: liveIds(asIdArray(readStateJson("recents"))).slice(0, RECENTS_CAP),
    expandedPageIds: liveIds(asIdArray(readStateJson("expandedPageIds"))),
    theme: readTheme(),
  });

  const recordRevision = (
    entityType: "page" | "block",
    entityId: Id,
    pageId: Id,
    version: number,
    patch: unknown,
    at: number,
  ): void => {
    s.insertRevision.run({
      id: randomUUID(),
      entity_type: entityType,
      entity_id: entityId,
      page_id: pageId,
      actor: ACTOR,
      version,
      patch: JSON.stringify(patch),
      created_at: at,
    });
  };

  const insertBlockRow = (
    block: {
      id: Id;
      pageId: Id;
      parentBlockId: Id | null;
      rank: string;
      type: BlockType;
      payload: BlockPayload;
    },
    at: number,
    /** Restores re-insert an existing block, so its version keeps climbing. */
    version = 1,
    createdAt = at,
  ): void => {
    s.insertBlock.run({
      id: block.id,
      page_id: block.pageId,
      parent_block_id: block.parentBlockId,
      rank: block.rank,
      type: block.type,
      payload: JSON.stringify(block.payload),
      version,
      created_at: createdAt,
      updated_at: at,
    });
  };

  /** The page's live block tree, exactly as `getBlocks` returns it. */
  const hydrateBlocks = (pageId: Id): Block[] =>
    orderBlocksDepthFirst(s.liveBlocksOfPage.all(pageId)).map(rowToBlock);

  // -------------------------------------------------------------------------
  // Transactional command bodies
  // -------------------------------------------------------------------------

  const txCreatePage = tx((input: CreatePageInput): Page => {
    const at = now();
    const id = input.id ?? randomUUID();
    if (getPageRow(id) !== undefined) throw invalid(`page already exists: ${id}`);

    const parentId = input.parentId ?? null;
    if (parentId !== null) {
      const parent = requirePageRow(parentId);
      if (parent.deleted_at !== null) {
        throw invalid(`cannot create a page under a trashed page: ${parentId}`);
      }
    }

    const rank = rankForPosition(parentId, input.afterPageId);
    s.insertPage.run({
      id,
      parent_id: parentId,
      title: input.title ?? "",
      icon: input.icon ?? null,
      cover_asset_id: null,
      locked: 0,
      full_width: 0,
      small_text: 0,
      rank,
      created_at: at,
      updated_at: at,
    });

    // A new page always starts with one empty paragraph so the editor has a
    // caret target.
    insertBlockRow(
      {
        id: randomUUID(),
        pageId: id,
        parentBlockId: null,
        rank: rankBetween(null, null),
        type: "paragraph",
        payload: { richText: [] },
      },
      at,
    );

    reindexPage(id);
    return rowToPage(requirePageRow(id));
  });

  const CONTENT_KEYS = [
    "title",
    "icon",
    "coverAssetId",
    "fullWidth",
    "smallText",
  ] as const;

  const txUpdatePage = tx((id: Id, patch: UpdatePageInput): Page => {
    const at = now();
    const row = requirePageRow(id);
    const touchesContent = CONTENT_KEYS.some((k) => patch[k] !== undefined);
    if (row.locked !== 0 && touchesContent) {
      throw new KumiError(
        "locked",
        `page is locked; unlock it first (update { locked: false }): ${id}`,
      );
    }

    const next = {
      id,
      title: patch.title ?? row.title,
      icon: patch.icon === undefined ? row.icon : patch.icon,
      cover_asset_id:
        patch.coverAssetId === undefined ? row.cover_asset_id : patch.coverAssetId,
      locked: patch.locked === undefined ? row.locked : patch.locked ? 1 : 0,
      full_width:
        patch.fullWidth === undefined ? row.full_width : patch.fullWidth ? 1 : 0,
      small_text:
        patch.smallText === undefined ? row.small_text : patch.smallText ? 1 : 0,
      updated_at: at,
    };
    s.updatePageFields.run(next);
    // Pages carry no version column (only blocks do), so page revisions are
    // ordered by created_at; version 0 marks "not a block revision".
    recordRevision("page", id, id, 0, patch, at);
    if (patch.title !== undefined && patch.title !== row.title) reindexPage(id);
    return rowToPage(requirePageRow(id));
  });

  const txMovePage = tx(
    (id: Id, parentId: Id | null, afterPageId: Id | null | undefined): Page => {
      const at = now();
      const row = requirePageRow(id);
      if (parentId !== null) {
        if (parentId === id) {
          throw new KumiError("cycle", `a page cannot be its own parent: ${id}`);
        }
        const parent = requirePageRow(parentId);
        if (isDescendantPage(parentId, id)) {
          throw new KumiError(
            "cycle",
            `cannot move page ${id} under its own descendant ${parentId}`,
          );
        }
        if (parent.deleted_at !== null && row.deleted_at === null) {
          throw invalid(`cannot move a live page under a trashed page: ${parentId}`);
        }
      }
      const rank = rankForPosition(parentId, afterPageId, id);
      s.movePageRow.run(parentId, rank, at, id);
      return rowToPage(requirePageRow(id));
    },
  );

  const txTrashPage = tx((id: Id): void => {
    const at = now();
    const row = requirePageRow(id);
    if (row.deleted_at !== null) throw invalid(`page is already in trash: ${id}`);
    s.trashSubtree.run({ root: id, now: at });
  });

  const txRestorePage = tx((id: Id): void => {
    const at = now();
    const row = requirePageRow(id);
    if (row.deleted_at === null) throw invalid(`page is not in trash: ${id}`);
    if (row.trash_batch_id !== id) {
      throw invalid(
        `page ${id} was trashed as part of ${row.trash_batch_id ?? "an unknown batch"}; restore that page instead`,
      );
    }
    s.restoreBatch.run(at, id);

    // Re-parent to the workspace root when the original parent is gone or is
    // itself still in the trash.
    const parentId = row.parent_id;
    const parent = parentId === null ? undefined : getPageRow(parentId);
    if (parentId !== null && (parent === undefined || parent.deleted_at !== null)) {
      s.movePageRow.run(null, rankForPosition(null, undefined, id), at, id);
    }
  });

  const txDeletePagePermanently = tx((id: Id): void => {
    const row = requirePageRow(id);
    if (row.deleted_at === null) {
      throw invalid(`page is not in trash; trash it first: ${id}`);
    }
    const ids = s.subtreeIds.all(id).map((r) => r.id);
    for (const pageId of ids) dropSearchRow(pageId);
    // blocks, revisions and links cascade from pages(parent_id / page_id).
    s.deletePageRow.run(id);

    const gone = new Set(ids);
    const prune = (key: string): void => {
      const kept = asIdArray(readStateJson(key)).filter((v) => !gone.has(v));
      writeStateJson(key, kept);
    };
    prune("favorites");
    prune("recents");
    prune("expandedPageIds");
  });

  const txDuplicatePage = tx((id: Id): Page => {
    const at = now();
    const source = requirePageRow(id);
    if (source.deleted_at !== null) {
      throw invalid(`cannot duplicate a trashed page: ${id}`);
    }

    const sourceIds = s.subtreeIds.all(id).map((r) => r.id);
    const pageIdMap = new Map<string, string>();
    for (const oldId of sourceIds) pageIdMap.set(oldId, randomUUID());
    const newRootId = pageIdMap.get(id) ?? randomUUID();

    for (const oldId of sourceIds) {
      const row = requirePageRow(oldId);
      const isRoot = oldId === id;
      const newId = pageIdMap.get(oldId) ?? randomUUID();
      const parentId = isRoot
        ? source.parent_id
        : (pageIdMap.get(row.parent_id ?? "") ?? null);
      s.insertPage.run({
        id: newId,
        parent_id: parentId,
        title: isRoot ? `${row.title} (Copy)` : row.title,
        icon: row.icon,
        cover_asset_id: row.cover_asset_id,
        locked: 0,
        full_width: row.full_width,
        small_text: row.small_text,
        rank: isRoot
          ? rankForPosition(source.parent_id, id)
          : row.rank,
        created_at: at,
        updated_at: at,
      });
    }

    for (const oldId of sourceIds) {
      const newPageId = pageIdMap.get(oldId);
      if (newPageId === undefined) continue;
      const blockIdMap = new Map<string, string>();
      const rows = orderBlocksDepthFirst(s.liveBlocksOfPage.all(oldId));
      for (const row of rows) blockIdMap.set(row.id, randomUUID());
      for (const row of rows) {
        const payload = parsePayload(row.payload);
        // Re-point child/linked page references at the copies.
        if (typeof payload.pageId === "string") {
          const mapped = pageIdMap.get(payload.pageId);
          if (mapped !== undefined) payload.pageId = mapped;
        }
        const newBlockId = blockIdMap.get(row.id) ?? randomUUID();
        const type = assertBlockType(row.type);
        insertBlockRow(
          {
            id: newBlockId,
            pageId: newPageId,
            parentBlockId:
              row.parent_block_id === null
                ? null
                : (blockIdMap.get(row.parent_block_id) ?? null),
            rank: row.rank,
            type,
            payload,
          },
          at,
        );
        // The copies get their own index rows. `payload.pageId` was re-pointed
        // at the copy above; hrefs and mentions still name the originals,
        // which is what a duplicated page should do.
        reindexBlockLinks(newBlockId, newPageId, type, payload);
      }
      reindexPage(newPageId);
    }

    return rowToPage(requirePageRow(newRootId));
  });

  // -------------------------------------------------------------------------
  // History: page snapshots
  // -------------------------------------------------------------------------

  /**
   * Capture one page's current state and prune the page's history back to
   * {@link SNAPSHOT_RETENTION} entries. Both steps live here so no caller can
   * grow history without bounding it.
   */
  const captureSnapshot = (
    page: PageRow,
    cause: SnapshotMeta["cause"],
    at: number,
  ): SnapshotMeta => {
    const id = randomUUID();
    const state: SnapshotState = {
      title: page.title,
      icon: page.icon,
      blocks: hydrateBlocks(page.id),
    };
    s.insertSnapshot.run({
      id,
      page_id: page.id,
      cause,
      state: JSON.stringify(state),
      created_at: at,
    });
    s.pruneSnapshots.run({ page_id: page.id, keep: SNAPSHOT_RETENTION });
    return { id, pageId: page.id, cause, createdAt: at };
  };

  /**
   * The auto-snapshot gate `applyBlockOps` runs before it first touches a page:
   * one indexed lookup of the newest snapshot's age, and a capture only when
   * the page has no history or its newest entry is older than the interval.
   * `seen` makes it at most once per page per batch.
   */
  const maybeAutoSnapshot = (pageId: Id, at: number, seen: Set<Id>): void => {
    if (seen.has(pageId)) return;
    seen.add(pageId);
    const page = getPageRow(pageId);
    // Pages the batch cannot edit anyway are not worth a restore point.
    if (page === undefined || page.deleted_at !== null || page.locked !== 0) return;
    const newest = s.newestSnapshotAt.get(pageId);
    if (newest !== undefined && at - newest.created_at < AUTO_SNAPSHOT_INTERVAL_MS) {
      return;
    }
    captureSnapshot(page, "auto", at);
  };

  // -------------------------------------------------------------------------
  // Block ops
  // -------------------------------------------------------------------------

  const reasonFor =(error: KumiError): "conflict" | "not_found" | "invalid" => {
    if (error.code === "conflict") return "conflict";
    if (error.code === "not_found") return "not_found";
    return "invalid";
  };

  const requireLiveBlock = (blockId: Id): BlockRow => {
    const row = s.blockById.get(blockId);
    if (row === undefined || row.archived !== 0) throw notFound("block", blockId);
    return row;
  };

  const requireEditablePage = (pageId: Id): PageRow => {
    const page = requirePageRow(pageId);
    if (page.deleted_at !== null) {
      throw invalid(`page is in the trash: ${pageId}`);
    }
    if (page.locked !== 0) {
      throw new KumiError("locked", `page is locked: ${pageId}`);
    }
    return page;
  };

  /** Applies one op; returns the page id it touched. Throws to reject. */
  const applyOp = (op: BlockOp, at: number): Id => {
    switch (op.kind) {
      case "insert": {
        const { block } = op;
        requireEditablePage(block.pageId);
        if (s.blockById.get(block.id) !== undefined) {
          throw invalid(`block already exists: ${block.id}`);
        }
        if (block.parentBlockId !== null) {
          const parent = s.blockById.get(block.parentBlockId);
          if (parent === undefined || parent.archived !== 0) {
            throw notFound("parent block", block.parentBlockId);
          }
          if (parent.page_id !== block.pageId) {
            throw invalid(
              `parent block ${block.parentBlockId} belongs to another page`,
            );
          }
        }
        validateRank(block.rank);
        const type = assertBlockType(block.type);
        const payload = assertPayload(block.payload);
        insertBlockRow(
          {
            id: block.id,
            pageId: block.pageId,
            parentBlockId: block.parentBlockId,
            rank: block.rank,
            type,
            payload,
          },
          at,
        );
        reindexBlockLinks(block.id, block.pageId, type, payload);
        return block.pageId;
      }

      case "update": {
        const row = requireLiveBlock(op.blockId);
        requireEditablePage(row.page_id);
        if (op.baseVersion !== row.version) {
          throw new KumiError(
            "conflict",
            `block ${op.blockId} is at version ${row.version}, not ${op.baseVersion}`,
          );
        }
        const type =
          op.patch.type === undefined
            ? assertBlockType(row.type)
            : assertBlockType(op.patch.type);
        const payload =
          op.patch.payload === undefined
            ? parsePayload(row.payload)
            : assertPayload(op.patch.payload);
        s.updateBlockContent.run(type, JSON.stringify(payload), at, op.blockId);
        reindexBlockLinks(op.blockId, row.page_id, type, payload);
        recordRevision(
          "block",
          op.blockId,
          row.page_id,
          row.version + 1,
          op.patch,
          at,
        );
        return row.page_id;
      }

      case "move": {
        const row = requireLiveBlock(op.blockId);
        requireEditablePage(row.page_id);
        if (op.parentBlockId !== null) {
          if (op.parentBlockId === op.blockId) {
            throw invalid(`a block cannot be its own parent: ${op.blockId}`);
          }
          const parent = s.blockById.get(op.parentBlockId);
          if (parent === undefined || parent.archived !== 0) {
            throw notFound("parent block", op.parentBlockId);
          }
          if (parent.page_id !== row.page_id) {
            throw invalid(
              `parent block ${op.parentBlockId} belongs to another page`,
            );
          }
          if (isDescendantBlock(op.parentBlockId, op.blockId)) {
            throw invalid(
              `cannot move block ${op.blockId} under its own descendant ${op.parentBlockId}`,
            );
          }
        }
        validateRank(op.rank);
        s.moveBlockRow.run(op.parentBlockId, op.rank, at, op.blockId);
        return row.page_id;
      }

      case "delete": {
        const row = requireLiveBlock(op.blockId);
        requireEditablePage(row.page_id);
        // Archiving is not a row delete, so the FK cascade never fires: drop
        // the subtree's links here or they would outlive their blocks.
        s.deleteLinksOfBlockSubtree.run(op.blockId);
        s.archiveBlockSubtree.run({ root: op.blockId, now: at });
        recordRevision(
          "block",
          op.blockId,
          row.page_id,
          row.version + 1,
          { archived: true },
          at,
        );
        return row.page_id;
      }
    }
  };

  const txApplyBlockOps = tx((ops: BlockOp[]): BatchResult => {
    const at = now();
    const result: BatchResult = { applied: [], rejected: [] };
    const touched = new Set<Id>();
    const snapshotChecked = new Set<Id>();

    for (const op of ops) {
      if (typeof op.opId !== "string" || op.opId === "") {
        result.rejected.push({
          opId: String(op.opId),
          reason: "invalid",
          message: "op is missing an opId",
        });
        continue;
      }
      if (s.opApplied.get(op.opId) !== undefined) {
        result.applied.push(op.opId);
        continue;
      }
      // Snapshot the page as it stands BEFORE this batch changes it. The op's
      // own validation happens below; resolving its page here is one indexed
      // lookup and costs nothing when the page was already checked.
      const target =
        op.kind === "insert" ? op.block.pageId : s.blockById.get(op.blockId)?.page_id;
      if (target !== undefined) maybeAutoSnapshot(target, at, snapshotChecked);

      try {
        const pageId = applyOp(op, at);
        s.recordOp.run(op.opId, at);
        touched.add(pageId);
        result.applied.push(op.opId);
      } catch (error) {
        if (error instanceof KumiError) {
          result.rejected.push({
            opId: op.opId,
            reason: reasonFor(error),
            message: error.message,
          });
        } else {
          throw error;
        }
      }
    }

    for (const pageId of touched) {
      s.touchPage.run(at, pageId);
      reindexPage(pageId);
    }
    return result;
  });

  // -------------------------------------------------------------------------
  // User state (each mutation is a read-modify-write, so transactional)
  // -------------------------------------------------------------------------

  const txSetFavorite = tx((pageId: Id, favorite: boolean): UserState => {
    requirePageRow(pageId);
    const current = asIdArray(readStateJson("favorites")).filter((v) => v !== pageId);
    if (favorite) current.push(pageId);
    writeStateJson("favorites", current);
    return buildUserState();
  });

  const txReorderFavorite = tx(
    (pageId: Id, afterPageId: Id | null): UserState => {
      const current = asIdArray(readStateJson("favorites"));
      if (!current.includes(pageId)) {
        throw invalid(`page is not a favorite: ${pageId}`);
      }
      const without = current.filter((v) => v !== pageId);
      if (afterPageId === null) {
        without.unshift(pageId);
      } else {
        const index = without.indexOf(afterPageId);
        if (index < 0) throw invalid(`afterPageId is not a favorite: ${afterPageId}`);
        without.splice(index + 1, 0, pageId);
      }
      writeStateJson("favorites", without);
      return buildUserState();
    },
  );

  const txTouchRecent = tx((pageId: Id): void => {
    requirePageRow(pageId);
    const current = asIdArray(readStateJson("recents")).filter((v) => v !== pageId);
    current.unshift(pageId);
    writeStateJson("recents", current.slice(0, RECENTS_CAP));
  });

  const txSetExpanded = tx((pageId: Id, expanded: boolean): void => {
    requirePageRow(pageId);
    const current = asIdArray(readStateJson("expandedPageIds")).filter(
      (v) => v !== pageId,
    );
    if (expanded) current.push(pageId);
    writeStateJson("expandedPageIds", current);
  });

  // -------------------------------------------------------------------------
  // Databases: data sources, properties, rows, views
  // -------------------------------------------------------------------------

  const requireDataSourceRow = (id: Id): DataSourceRow => {
    const row = s.dataSourceById.get(id);
    if (row === undefined) throw notFound("data source", id);
    return row;
  };

  const requirePropertyRow = (id: Id): PropertyRow => {
    const row = s.propertyById.get(id);
    if (row === undefined) throw notFound("property", id);
    return row;
  };

  const requireViewRow = (id: Id): ViewRow => {
    const row = s.viewById.get(id);
    if (row === undefined) throw notFound("view", id);
    return row;
  };

  const requireDsRow = (pageId: Id): DsRowRow => {
    const row = s.dsRowByPage.get(pageId);
    if (row === undefined) throw notFound("database row", pageId);
    return row;
  };

  const propertiesOf = (dataSourceId: Id): PropertyDef[] =>
    s.propertiesOfDataSource.all(dataSourceId).map(rowToProperty);

  const viewsOf = (dataSourceId: Id): View[] =>
    s.viewsOfDataSource.all(dataSourceId).map(rowToView);

  const propertyEntries = (dataSourceId: Id): RankedRow[] =>
    s.propertiesOfDataSource
      .all(dataSourceId)
      .map((row) => ({ id: row.id, rank: row.rank }));

  const viewEntries = (dataSourceId: Id): RankedRow[] =>
    s.viewsOfDataSource
      .all(dataSourceId)
      .map((row) => ({ id: row.id, rank: row.rank }));

  /**
   * Rank among ranked siblings, with the same `after` semantics as pages:
   * `undefined` appends, `null` inserts first, an id inserts after it.
   */
  const rankAmong = (
    entries: RankedRow[],
    afterId: Id | null | undefined,
    label: string,
    excludeId?: Id,
  ): string => {
    const rows = entries.filter((entry) => entry.id !== excludeId);
    if (afterId === undefined) {
      return rankBetween(rows[rows.length - 1]?.rank ?? null, null);
    }
    if (afterId === null) return rankBetween(null, rows[0]?.rank ?? null);
    const index = rows.findIndex((entry) => entry.id === afterId);
    if (index < 0) {
      throw invalid(`${label} is not a sibling in this data source: ${afterId}`);
    }
    return rankBetween(rows[index]?.rank ?? null, rows[index + 1]?.rank ?? null);
  };

  const requireName = (name: string, what: string): string => {
    const trimmed = name.trim();
    if (trimmed === "") throw invalid(`${what} must not be empty`);
    return trimmed;
  };

  const storedValuesOf = (pageId: Id): Map<Id, PropertyValue> => {
    const map = new Map<Id, PropertyValue>();
    for (const row of s.valuesOfPage.all(pageId)) {
      map.set(row.property_id, parseValue(row.value));
    }
    return map;
  };

  /** A fresh read context; related data sources load lazily, once each. */
  const readContext = (): ReadContext => {
    const cache = new Map<Id, RelatedData>();
    return {
      related(dataSourceId: Id): RelatedData {
        const hit = cache.get(dataSourceId);
        if (hit !== undefined) return hit;

        const liveIds = new Set<Id>();
        const titles = new Map<Id, string>();
        for (const row of s.liveRowsOfDataSource.all(dataSourceId)) {
          liveIds.add(row.id);
          titles.set(row.id, row.title);
        }
        const properties = new Map<Id, PropertyDef>();
        let titlePropertyId: Id | null = null;
        for (const prop of propertiesOf(dataSourceId)) {
          properties.set(prop.id, prop);
          if (prop.type === "title") titlePropertyId = prop.id;
        }
        const values = new Map<Id, Map<Id, PropertyValue>>();
        const bucketFor = (pageId: Id): Map<Id, PropertyValue> => {
          let bucket = values.get(pageId);
          if (bucket === undefined) {
            bucket = new Map<Id, PropertyValue>();
            values.set(pageId, bucket);
          }
          return bucket;
        };
        for (const row of s.valuesOfDataSource.all(dataSourceId)) {
          if (!liveIds.has(row.page_id)) continue;
          bucketFor(row.page_id).set(row.property_id, parseValue(row.value));
        }
        // A row's title value is its page title, never a stored cell.
        if (titlePropertyId !== null) {
          for (const [pageId, title] of titles) {
            bucketFor(pageId).set(titlePropertyId, {
              type: "title",
              richText: textToRichText(title),
            });
          }
        }

        const data: RelatedData = { liveIds, titles, properties, values };
        cache.set(dataSourceId, data);
        return data;
      },
    };
  };

  const requireRelationConfig = (prop: PropertyDef): RelationConfig => {
    const config = relationConfigOf(prop.config);
    if (config === null) {
      throw invalid(
        `relation property "${prop.name}" (${prop.id}) has no config.relation`,
      );
    }
    return config;
  };

  /**
   * A rollup's resolved wiring, or null when it dangles — the relation it names
   * was removed or retyped, or its target property no longer exists. A dangling
   * rollup reads as empty rather than throwing mid-query.
   */
  interface ResolvedRollup {
    config: RollupConfig;
    relationPropertyId: Id;
    relatedDataSourceId: Id;
    target: PropertyDef | null;
  }

  const resolveRollup = (
    prop: PropertyDef,
    siblings: ReadonlyMap<Id, PropertyDef>,
    ctx: ReadContext,
  ): ResolvedRollup | null => {
    const config = rollupConfigOf(prop.config);
    if (config === null) return null;
    const relationProp = siblings.get(config.relationPropertyId);
    if (relationProp === undefined || relationProp.type !== "relation") return null;
    const relation = relationConfigOf(relationProp.config);
    if (relation === null) return null;
    const related = ctx.related(relation.dataSourceId);
    const target =
      config.targetPropertyId === null
        ? null
        : (related.properties.get(config.targetPropertyId) ?? null);
    if (config.targetPropertyId !== null && target === null) return null;
    return {
      config,
      relationPropertyId: relationProp.id,
      relatedDataSourceId: relation.dataSourceId,
      target,
    };
  };

  /** The value a rollup produces when it has nothing to aggregate. */
  const emptyRollup = (
    aggregation: RollupAggregation,
    targetType: PropertyType | null,
  ): PropertyValue => {
    const kind = rollupKind(aggregation, targetType);
    if (kind === "values") return { type: "rollup", aggregation, values: [] };
    if (kind === "date") return { type: "rollup", aggregation, date: null };
    // Counting and summing nothing is 0; averaging or extremising it is null.
    const zero =
      aggregation === "count" ||
      aggregation === "count_values" ||
      aggregation === "sum";
    return { type: "rollup", aggregation, number: zero ? 0 : null };
  };

  const numbersOf = (cells: (PropertyValue | undefined)[]): number[] => {
    const out: number[] = [];
    for (const cell of cells) {
      if (cell !== undefined && cell.type === "number" && cell.number !== null) {
        out.push(cell.number);
      }
    }
    return out;
  };

  const startsOf = (cells: (PropertyValue | undefined)[]): string[] => {
    const out: string[] = [];
    for (const cell of cells) {
      if (cell === undefined || cell.type !== "date") continue;
      const start = cell.start;
      if (start === null || start === undefined) continue;
      if (dateMs(start) === null) continue;
      out.push(start);
    }
    return out;
  };

  /**
   * Compute one rollup cell from the row's (already trash-filtered) relation
   * value. Purely a read: nothing here is ever stored.
   */
  const computeRollup = (
    prop: PropertyDef,
    siblings: ReadonlyMap<Id, PropertyDef>,
    values: Record<Id, PropertyValue>,
    ctx: ReadContext,
  ): PropertyValue => {
    const declared = rollupConfigOf(prop.config);
    const aggregation: RollupAggregation = declared?.aggregation ?? "count";
    const resolved = resolveRollup(prop, siblings, ctx);
    if (resolved === null) return emptyRollup(aggregation, null);

    const related = ctx.related(resolved.relatedDataSourceId);
    const relationValue = values[resolved.relationPropertyId];
    const ids =
      relationValue !== undefined && relationValue.type === "relation"
        ? relationValue.pageIds
        : [];
    const target = resolved.target;
    const targetType = target === null ? null : target.type;
    const cells: (PropertyValue | undefined)[] =
      target === null
        ? []
        : ids.map((id) => related.values.get(id)?.get(target.id));

    switch (aggregation) {
      case "count":
        return { type: "rollup", aggregation, number: ids.length };
      case "count_values":
        return {
          type: "rollup",
          aggregation,
          number: cells.filter((cell) => !isEmptyValue(cell)).length,
        };
      case "sum": {
        const numbers = numbersOf(cells);
        return {
          type: "rollup",
          aggregation,
          number: numbers.reduce((total, entry) => total + entry, 0),
        };
      }
      case "avg": {
        const numbers = numbersOf(cells);
        return {
          type: "rollup",
          aggregation,
          number:
            numbers.length === 0
              ? null
              : numbers.reduce((total, entry) => total + entry, 0) / numbers.length,
        };
      }
      case "min":
      case "max": {
        if (rollupKind(aggregation, targetType) === "date") {
          const starts = startsOf(cells);
          let best: string | null = null;
          for (const start of starts) {
            if (best === null) {
              best = start;
              continue;
            }
            const cmp = (dateMs(start) ?? 0) - (dateMs(best) ?? 0);
            if (aggregation === "min" ? cmp < 0 : cmp > 0) best = start;
          }
          return {
            type: "rollup",
            aggregation,
            date: best === null ? null : { start: best, end: null },
          };
        }
        const numbers = numbersOf(cells);
        if (numbers.length === 0) {
          return { type: "rollup", aggregation, number: null };
        }
        return {
          type: "rollup",
          aggregation,
          number:
            aggregation === "min" ? Math.min(...numbers) : Math.max(...numbers),
        };
      }
      case "show_originals":
        return {
          type: "rollup",
          aggregation,
          // Related rows with no stored cell contribute nothing.
          values: cells.filter((cell): cell is PropertyValue => cell !== undefined),
        };
    }
  };

  /**
   * Materialise a row. The title property is not stored in `property_values`:
   * a row's title value *is* its page title, projected here as one plain span.
   * Relation cells are filtered to live rows (trashed targets vanish from reads
   * but stay stored, so restoring the row restores the link; a permanently
   * deleted row simply never comes back) and rollup cells are computed from
   * those, in that order.
   */
  const rowRecordFor = (
    page: PageRow,
    properties: PropertyDef[],
    stored: Map<Id, PropertyValue>,
    ctx: ReadContext,
  ): RowRecord => {
    const values: Record<Id, PropertyValue> = {};
    const siblings = new Map(properties.map((prop) => [prop.id, prop]));
    for (const prop of properties) {
      if (prop.type === "title") {
        values[prop.id] = { type: "title", richText: textToRichText(page.title) };
        continue;
      }
      // Rollups hold no cell of their own; they are computed below.
      if (prop.type === "rollup") continue;
      const value = stored.get(prop.id);
      // A cell whose variant no longer matches its property is stale schema
      // debris; it reads as empty and is overwritten by the next write.
      if (value === undefined || value.type !== prop.type) continue;
      if (value.type === "relation") {
        const config = relationConfigOf(prop.config);
        if (config === null) continue;
        const live = ctx.related(config.dataSourceId).liveIds;
        const kept = value.pageIds.filter((id) => live.has(id));
        // An empty relation reads as an absent key, like every other type.
        if (kept.length === 0) continue;
        values[prop.id] = { type: "relation", pageIds: kept };
        continue;
      }
      values[prop.id] = value;
    }
    for (const prop of properties) {
      if (prop.type !== "rollup") continue;
      values[prop.id] = computeRollup(prop, siblings, values, ctx);
    }
    return { page: rowToPage(page), values };
  };

  const storedRelationIds = (pageId: Id, propertyId: Id): Id[] => {
    const row = s.valueOfCell.get(pageId, propertyId);
    if (row === undefined) return [];
    const value = parseValue(row.value);
    return value.type === "relation" ? value.pageIds : [];
  };

  const writeRelationIds = (
    pageId: Id,
    propertyId: Id,
    ids: Id[],
    at: number,
  ): void => {
    if (ids.length === 0) {
      s.deleteValue.run(pageId, propertyId);
    } else {
      const value: PropertyValue = { type: "relation", pageIds: ids };
      s.upsertValue.run(pageId, propertyId, JSON.stringify(value));
    }
    s.touchPage.run(at, pageId);
  };

  /**
   * Keep the far side of a paired relation in step: a row this row now points
   * at must point back, and one it no longer points at must stop. The partner
   * cells are written directly rather than through `writeValues`, so the two
   * sides can never recurse into each other.
   */
  const syncPairedRelation = (
    partnerPropertyId: Id,
    selfPageId: Id,
    added: readonly Id[],
    removed: readonly Id[],
    at: number,
  ): void => {
    for (const other of added) {
      const ids = storedRelationIds(other, partnerPropertyId);
      if (ids.includes(selfPageId)) continue;
      writeRelationIds(other, partnerPropertyId, [...ids, selfPageId], at);
    }
    for (const other of removed) {
      const ids = storedRelationIds(other, partnerPropertyId);
      if (!ids.includes(selfPageId)) continue;
      writeRelationIds(
        other,
        partnerPropertyId,
        ids.filter((id) => id !== selfPageId),
        at,
      );
    }
  };

  /**
   * Write one relation cell: every id must name a live row of the configured
   * target data source, order is preserved and duplicates collapse onto their
   * first mention. A paired relation updates both sides in this transaction.
   */
  const writeRelationValue = (
    pageId: Id,
    prop: PropertyDef,
    requested: readonly Id[],
    at: number,
  ): void => {
    const config = requireRelationConfig(prop);
    const next: Id[] = [];
    const seen = new Set<Id>();
    for (const id of requested) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (s.isLiveRowOf.get(id, config.dataSourceId) === undefined) {
        throw invalid(
          `property "${prop.name}" (${prop.id}): ${id} is not a live row of data source ${config.dataSourceId}`,
        );
      }
      next.push(id);
    }
    const previous = storedRelationIds(pageId, prop.id);
    writeRelationIds(pageId, prop.id, next, at);

    const partner = config.pairedPropertyId;
    if (partner === null) return;
    const before = new Set(previous);
    const after = new Set(next);
    syncPairedRelation(
      partner,
      pageId,
      next.filter((id) => !before.has(id)),
      previous.filter((id) => !after.has(id)),
      at,
    );
  };

  /** Write a partial value map; returns true when the page title changed. */
  const writeValues = (
    pageId: Id,
    properties: PropertyDef[],
    values: Record<Id, PropertyValue | null>,
    at: number,
  ): boolean => {
    const byId = new Map(properties.map((prop) => [prop.id, prop]));
    let titleChanged = false;
    for (const [propertyId, value] of Object.entries(values)) {
      const prop = byId.get(propertyId);
      if (prop === undefined) {
        throw invalid(
          `property ${propertyId} does not belong to this row's data source`,
        );
      }
      if (prop.type === "rollup") {
        throw invalid(
          `property "${prop.name}" (${prop.id}): rollup values are computed and cannot be written`,
        );
      }
      if (prop.type === "relation") {
        if (value !== null) validatePropertyValue(prop, value);
        writeRelationValue(
          pageId,
          prop,
          value !== null && value.type === "relation" ? value.pageIds : [],
          at,
        );
        continue;
      }
      if (value === null) {
        if (prop.type === "title") {
          s.setPageTitle.run("", at, pageId);
          titleChanged = true;
        } else {
          s.deleteValue.run(pageId, propertyId);
        }
        continue;
      }
      validatePropertyValue(prop, value);
      if (prop.type === "title") {
        const text = value.type === "title" ? richTextToPlain(value.richText) : "";
        s.setPageTitle.run(text, at, pageId);
        titleChanged = true;
        continue;
      }
      // Stored verbatim: unknown extra keys survive round-trip.
      s.upsertValue.run(pageId, propertyId, JSON.stringify(value));
    }
    return titleChanged;
  };

  /** Rewrite one relation property's `pairedPropertyId`, leaving the rest be. */
  const setPairedPropertyId = (propertyId: Id, partner: Id | null): void => {
    const prop = rowToProperty(requirePropertyRow(propertyId));
    const config = relationConfigOf(prop.config);
    if (config === null) return;
    const next: PropertyConfig = {
      ...prop.config,
      relation: { dataSourceId: config.dataSourceId, pairedPropertyId: partner },
    };
    s.updatePropertyRow.run(prop.name, prop.type, JSON.stringify(next), propertyId);
  };

  /**
   * Break a pairing from the far side. Notion's rule: the partner survives as a
   * one-way relation and keeps every value it holds — only the link between the
   * two definitions goes.
   */
  const unpairPartnerOf = (prop: PropertyDef): void => {
    const config = relationConfigOf(prop.config);
    if (config === null || config.pairedPropertyId === null) return;
    const partnerRow = s.propertyById.get(config.pairedPropertyId);
    if (partnerRow === undefined) return;
    const partner = rowToProperty(partnerRow);
    const partnerConfig = relationConfigOf(partner.config);
    if (partnerConfig === null || partnerConfig.pairedPropertyId !== prop.id) return;
    setPairedPropertyId(partner.id, null);
  };

  /**
   * Referential checks a relation config cannot make for itself: the target
   * data source must exist, and a named partner must be an unpaired relation on
   * that data source pointing back here. A self-relation may be paired, but
   * only with a *different* property (Notion forbids pairing one with itself).
   */
  const validateRelationTarget = (
    ownDataSourceId: Id,
    config: RelationConfig,
    selfPropertyId: Id,
  ): void => {
    if (s.dataSourceExists.get(config.dataSourceId) === undefined) {
      throw notFound("data source", config.dataSourceId);
    }
    const paired = config.pairedPropertyId;
    if (paired === null) return;
    if (paired === selfPropertyId) {
      throw invalid(
        "a relation cannot be paired with itself; pair a self-relation with a second property instead",
      );
    }
    const partner = rowToProperty(requirePropertyRow(paired));
    if (partner.type !== "relation") {
      throw invalid(`paired property ${paired} is not a relation property`);
    }
    if (partner.dataSourceId !== config.dataSourceId) {
      throw invalid(
        `paired property ${paired} does not belong to data source ${config.dataSourceId}`,
      );
    }
    const partnerConfig = requireRelationConfig(partner);
    if (partnerConfig.dataSourceId !== ownDataSourceId) {
      throw invalid(
        `paired property ${paired} does not point back at data source ${ownDataSourceId}`,
      );
    }
    if (
      partnerConfig.pairedPropertyId !== null &&
      partnerConfig.pairedPropertyId !== selfPropertyId
    ) {
      throw invalid(
        `paired property ${paired} is already paired with ${partnerConfig.pairedPropertyId}`,
      );
    }
  };

  /**
   * The rollup matrix. `count` counts related rows and takes no target;
   * everything else needs one, on the related data source, and never a relation
   * or another rollup (chained rollups land in a later phase):
   *
   * | aggregation    | target                                   |
   * |----------------|------------------------------------------|
   * | count          | none (must be null)                      |
   * | count_values   | any non-relation, non-rollup property     |
   * | sum / avg      | number                                    |
   * | min / max      | number or date                            |
   * | show_originals | any non-relation, non-rollup property     |
   */
  const validateRollupConfig = (
    ownDataSourceId: Id,
    config: RollupConfig,
  ): void => {
    const relationProp = rowToProperty(
      requirePropertyRow(config.relationPropertyId),
    );
    if (relationProp.dataSourceId !== ownDataSourceId) {
      throw invalid(
        `rollup relationPropertyId ${config.relationPropertyId} must be a property of the same data source`,
      );
    }
    if (relationProp.type !== "relation") {
      throw invalid(
        `rollup relationPropertyId ${config.relationPropertyId} is not a relation property`,
      );
    }
    const relation = requireRelationConfig(relationProp);
    const { aggregation, targetPropertyId } = config;

    if (aggregation === "count") {
      if (targetPropertyId !== null) {
        throw invalid(
          "a count rollup counts related rows and takes no targetPropertyId",
        );
      }
      return;
    }
    if (targetPropertyId === null) {
      throw invalid(`a ${aggregation} rollup needs a targetPropertyId`);
    }
    const target = rowToProperty(requirePropertyRow(targetPropertyId));
    if (target.dataSourceId !== relation.dataSourceId) {
      throw invalid(
        `rollup target ${targetPropertyId} must belong to the related data source ${relation.dataSourceId}`,
      );
    }
    if (target.type === "relation" || target.type === "rollup") {
      throw invalid(
        `a rollup cannot aggregate a ${target.type} property (${targetPropertyId}); chained rollups are not supported`,
      );
    }
    if ((aggregation === "sum" || aggregation === "avg") && target.type !== "number") {
      throw invalid(
        `a ${aggregation} rollup needs a number target, got ${target.type}`,
      );
    }
    if (
      (aggregation === "min" || aggregation === "max") &&
      target.type !== "number" &&
      target.type !== "date"
    ) {
      throw invalid(
        `a ${aggregation} rollup needs a number or date target, got ${target.type}`,
      );
    }
  };

  /**
   * `config.createPaired = { name }` is the atomic two-way creation switch: it
   * is not part of the stored config, it is an instruction to create the
   * reverse relation on the target data source and wire both sides together.
   */
  const takeCreatePaired = (config: PropertyConfig): { name: string } | null => {
    const raw: unknown = config.createPaired;
    if (raw === undefined) return null;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid("config.createPaired must be an object { name }");
    }
    const name: unknown = (raw as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim() === "") {
      throw invalid("config.createPaired.name must be a non-empty string");
    }
    return { name: name.trim() };
  };

  const txCreateDataSource = tx(
    (
      ownerPageId: Id,
      title: string | undefined,
    ): { dataSource: DataSource; properties: PropertyDef[]; views: View[] } => {
      const at = now();
      const owner = requirePageRow(ownerPageId);
      if (owner.deleted_at !== null) {
        throw invalid(`cannot create a data source on a trashed page: ${ownerPageId}`);
      }
      const id = randomUUID();
      s.insertDataSource.run(
        id,
        ownerPageId,
        (title ?? DEFAULT_DATA_SOURCE_TITLE).trim(),
        at,
        at,
      );
      s.insertProperty.run({
        id: randomUUID(),
        data_source_id: id,
        name: TITLE_PROPERTY_NAME,
        type: "title",
        config: JSON.stringify({}),
        rank: rankBetween(null, null),
      });
      s.insertView.run({
        id: randomUUID(),
        data_source_id: id,
        name: DEFAULT_VIEW_NAME,
        type: "table",
        config: JSON.stringify(defaultViewConfig()),
        rank: rankBetween(null, null),
        locked: 0,
      });
      return {
        dataSource: rowToDataSource(requireDataSourceRow(id)),
        properties: propertiesOf(id),
        views: viewsOf(id),
      };
    },
  );

  const txRenameDataSource = tx((id: Id, title: string): DataSource => {
    const at = now();
    requireDataSourceRow(id);
    s.renameDataSourceRow.run(title.trim(), at, id);
    return rowToDataSource(requireDataSourceRow(id));
  });

  /**
   * Row pages go to the trash as one batch rooted at the first row, so the
   * whole database can be recovered with a single `restorePage(firstRowId)`;
   * schema, views and cells are then hard-deleted (the FK cascade from
   * `data_sources` covers properties, views, ds_rows and property_values).
   *
   * Relation properties in *other* data sources that point here are left in
   * place — deleting one database must not rewrite another's schema — but they
   * lose everything that referred to the deleted rows: their stored cells are
   * deleted and any pairing into this data source is broken, so they read as
   * empty one-way relations. A future write to one fails validation (its target
   * data source is gone), which is the loud, correct outcome.
   */
  const txDeleteDataSource = tx((id: Id): void => {
    const at = now();
    requireDataSourceRow(id);
    for (const row of s.relationProperties.all()) {
      if (row.data_source_id === id) continue;
      const prop = rowToProperty(row);
      const config = relationConfigOf(prop.config);
      if (config === null || config.dataSourceId !== id) continue;
      s.deleteValuesOfProperty.run(prop.id);
      if (config.pairedPropertyId !== null) setPairedPropertyId(prop.id, null);
    }
    const liveRowIds = s.dsRowEntries
      .all(id)
      .map((entry) => entry.id)
      .filter((pageId) => s.isLivePage.get(pageId) !== undefined);
    const batch = liveRowIds[0];
    if (batch !== undefined) {
      for (const rowId of liveRowIds) {
        s.trashRowSubtree.run({ root: rowId, batch, now: at });
      }
    }
    s.deleteDataSourceRow.run(id);
  });

  const txAddProperty = tx(
    (
      dataSourceId: Id,
      input: {
        name: string;
        type: PropertyType;
        config?: PropertyConfig;
        afterPropertyId?: Id | null;
      },
    ): PropertyDef => {
      const at = now();
      requireDataSourceRow(dataSourceId);
      const name = requireName(input.name, "property name");
      const type = assertPropertyType(input.type);
      if (type === "title") {
        throw invalid(
          "a data source has exactly one title property, created with the data source",
        );
      }
      const rawConfig: PropertyConfig = { ...(input.config ?? {}) };
      const createPaired = type === "relation" ? takeCreatePaired(rawConfig) : null;
      delete rawConfig.createPaired;

      const config = normalizeConfig(type, rawConfig, randomUUID);
      const id = randomUUID();

      const relation = type === "relation" ? relationConfigOf(config) : null;
      if (type === "relation") {
        if (relation === null) throw invalid("config.relation is malformed");
        if (createPaired !== null && relation.pairedPropertyId !== null) {
          throw invalid(
            "give either config.relation.pairedPropertyId or config.createPaired, not both",
          );
        }
        validateRelationTarget(dataSourceId, relation, id);
      }
      if (type === "rollup") {
        const rollup = rollupConfigOf(config);
        if (rollup === null) throw invalid("config.rollup is malformed");
        validateRollupConfig(dataSourceId, rollup);
      }

      s.insertProperty.run({
        id,
        data_source_id: dataSourceId,
        name,
        type,
        config: JSON.stringify(config),
        rank: rankAmong(
          propertyEntries(dataSourceId),
          input.afterPropertyId,
          "afterPropertyId",
        ),
      });

      if (relation !== null) {
        if (relation.pairedPropertyId !== null) {
          // Adopt an existing unpaired reverse relation.
          setPairedPropertyId(relation.pairedPropertyId, id);
          s.touchDataSource.run(at, relation.dataSourceId);
        } else if (createPaired !== null) {
          // Create the reverse relation and wire both sides in one step.
          const reverseId = randomUUID();
          const reverseConfig: PropertyConfig = {
            relation: { dataSourceId, pairedPropertyId: id },
          };
          s.insertProperty.run({
            id: reverseId,
            data_source_id: relation.dataSourceId,
            name: requireName(createPaired.name, "property name"),
            type: "relation",
            config: JSON.stringify(reverseConfig),
            rank: rankAmong(
              propertyEntries(relation.dataSourceId),
              undefined,
              "afterPropertyId",
            ),
          });
          setPairedPropertyId(id, reverseId);
          s.touchDataSource.run(at, relation.dataSourceId);
        }
      }

      s.touchDataSource.run(at, dataSourceId);
      return rowToProperty(requirePropertyRow(id));
    },
  );

  const txUpdateProperty = tx(
    (
      propertyId: Id,
      patch: { name?: string; type?: PropertyType; config?: PropertyConfig },
    ): PropertyDef => {
      const at = now();
      const current = rowToProperty(requirePropertyRow(propertyId));

      const name =
        patch.name === undefined
          ? current.name
          : requireName(patch.name, "property name");

      let type = current.type;
      if (patch.type !== undefined) {
        const next = assertPropertyType(patch.type);
        if (next !== current.type && (next === "title" || current.type === "title")) {
          throw invalid(
            "the title property cannot be retyped, and no other property can become the title",
          );
        }
        type = next;
      }

      // A `config` patch REPLACES the stored config; it is not merged key by
      // key. Relation and rollup sub-objects are therefore never half-lost: a
      // replacement that omits `relation`/`rollup` is rejected outright by
      // normalizeConfig, so a caller must send the whole sub-object back.
      let config = normalizeConfig(
        type,
        patch.config ?? current.config,
        randomUUID,
      );

      const currentRelation =
        current.type === "relation" ? relationConfigOf(current.config) : null;

      if (type === "relation") {
        const relation = relationConfigOf(config);
        if (relation === null) throw invalid("config.relation is malformed");
        if (currentRelation === null) {
          // Becoming a relation: cells cannot survive, and pairing is only
          // established at creation time (addProperty + config.createPaired).
          if (relation.pairedPropertyId !== null) {
            throw invalid(
              "a relation's pairing is established when the property is created (config.createPaired); updateProperty can only remove it",
            );
          }
        } else if (relation.dataSourceId !== currentRelation.dataSourceId) {
          // Retargeting invalidates every stored id, and any pairing with it.
          unpairPartnerOf(current);
          s.deleteValuesOfProperty.run(propertyId);
          config = {
            ...config,
            relation: { dataSourceId: relation.dataSourceId, pairedPropertyId: null },
          };
        } else if (relation.pairedPropertyId !== currentRelation.pairedPropertyId) {
          if (relation.pairedPropertyId !== null) {
            throw invalid(
              "a relation's pairing is established when the property is created (config.createPaired); updateProperty can only remove it",
            );
          }
          unpairPartnerOf(current);
        }
        const finalRelation = relationConfigOf(config);
        if (finalRelation === null) throw invalid("config.relation is malformed");
        validateRelationTarget(current.dataSourceId, finalRelation, propertyId);
      } else if (currentRelation !== null) {
        // Leaving relation-hood: the partner survives as a one-way relation.
        unpairPartnerOf(current);
      }

      if (type === "rollup") {
        const rollup = rollupConfigOf(config);
        if (rollup === null) throw invalid("config.rollup is malformed");
        validateRollupConfig(current.dataSourceId, rollup);
        // A rollup stores nothing; anything the old type stored is dropped.
        s.deleteValuesOfProperty.run(propertyId);
      }

      const nextProp: PropertyDef = { ...current, name, type, config };

      if (type !== current.type) {
        // Conservative conversion; unconvertible cells are dropped. A relation
        // renders as the comma-joined titles of its live related rows.
        const ctx = readContext();
        const valueCtx: ValueContext =
          currentRelation === null
            ? {}
            : {
                titleOf: (pageId) =>
                  ctx.related(currentRelation.dataSourceId).titles.get(pageId) ?? "",
              };
        for (const row of s.valuesOfProperty.all(propertyId)) {
          const converted = convertPropertyValue(
            parseValue(row.value),
            current.config,
            type,
            config,
            valueCtx,
          );
          if (converted === null) {
            s.deleteValue.run(row.page_id, propertyId);
          } else {
            s.upsertValue.run(row.page_id, propertyId, JSON.stringify(converted));
          }
          s.touchPage.run(at, row.page_id);
        }
      } else if (
        patch.config !== undefined &&
        (type === "select" || type === "multi_select")
      ) {
        // Option edits apply eagerly: a value naming a removed option is
        // rewritten (multi_select) or deleted (select / emptied multi_select).
        for (const row of s.valuesOfProperty.all(propertyId)) {
          const pruned = pruneToConfig(parseValue(row.value), config);
          if (pruned === null) {
            s.deleteValue.run(row.page_id, propertyId);
            s.touchPage.run(at, row.page_id);
          } else if (JSON.stringify(pruned) !== row.value) {
            s.upsertValue.run(row.page_id, propertyId, JSON.stringify(pruned));
            s.touchPage.run(at, row.page_id);
          }
        }
      }

      s.updatePropertyRow.run(
        nextProp.name,
        nextProp.type,
        JSON.stringify(nextProp.config),
        propertyId,
      );
      s.touchDataSource.run(at, current.dataSourceId);
      return rowToProperty(requirePropertyRow(propertyId));
    },
  );

  const txRemoveProperty = tx((propertyId: Id): void => {
    const at = now();
    const row = requirePropertyRow(propertyId);
    if (row.type === "title") {
      throw invalid(
        `the title property cannot be removed: ${propertyId}`,
      );
    }
    // A paired relation leaves its partner behind as a one-way relation, values
    // intact — removing one side must not silently gut the other data source.
    if (row.type === "relation") unpairPartnerOf(rowToProperty(row));
    // property_values cascades from properties(id).
    s.deletePropertyRow.run(propertyId);
    s.touchDataSource.run(at, row.data_source_id);
  });

  const txReorderProperty = tx(
    (propertyId: Id, afterPropertyId: Id | null): PropertyDef => {
      const at = now();
      const row = requirePropertyRow(propertyId);
      const rank = rankAmong(
        propertyEntries(row.data_source_id),
        afterPropertyId,
        "afterPropertyId",
        propertyId,
      );
      s.setPropertyRank.run(rank, propertyId);
      s.touchDataSource.run(at, row.data_source_id);
      return rowToProperty(requirePropertyRow(propertyId));
    },
  );

  const txCreateRow = tx(
    (
      dataSourceId: Id,
      values: Record<Id, PropertyValue> | undefined,
      afterRowId: Id | null | undefined,
    ): RowRecord => {
      const at = now();
      const ds = requireDataSourceRow(dataSourceId);
      const owner = requirePageRow(ds.page_id);
      if (owner.deleted_at !== null) {
        throw invalid(`cannot add a row to a trashed database: ${dataSourceId}`);
      }
      const properties = propertiesOf(dataSourceId);
      const pageId = randomUUID();
      // A row page carries no scaffold paragraph: its content starts empty and
      // the row's cells are its data.
      s.insertPage.run({
        id: pageId,
        parent_id: ds.page_id,
        title: "",
        icon: null,
        cover_asset_id: null,
        locked: 0,
        full_width: 0,
        small_text: 0,
        rank: rankForPosition(ds.page_id, undefined),
        created_at: at,
        updated_at: at,
      });
      // Appending and prepending read one neighbour; only an explicit
      // `afterRowId` needs the ordered list.
      const rowRank =
        afterRowId === undefined
          ? rankBetween(s.lastRowRank.get(dataSourceId)?.rank ?? null, null)
          : afterRowId === null
            ? rankBetween(null, s.firstRowRank.get(dataSourceId)?.rank ?? null)
            : rankAmong(s.dsRowEntries.all(dataSourceId), afterRowId, "afterRowId");
      s.insertDsRow.run(pageId, dataSourceId, rowRank);
      if (values !== undefined) writeValues(pageId, properties, values, at);
      reindexPage(pageId);
      s.touchDataSource.run(at, dataSourceId);
      return rowRecordFor(
        requirePageRow(pageId),
        properties,
        storedValuesOf(pageId),
        readContext(),
      );
    },
  );

  const txSetPropertyValues = tx(
    (pageId: Id, values: Record<Id, PropertyValue | null>): RowRecord => {
      const at = now();
      const dsRow = requireDsRow(pageId);
      const page = requirePageRow(pageId);
      if (page.locked !== 0) {
        throw new KumiError("locked", `row page is locked: ${pageId}`);
      }
      const properties = propertiesOf(dsRow.data_source_id);
      const titleChanged = writeValues(pageId, properties, values, at);
      s.touchPage.run(at, pageId);
      if (titleChanged) reindexPage(pageId);
      s.touchDataSource.run(at, dsRow.data_source_id);
      return rowRecordFor(
        requirePageRow(pageId),
        properties,
        storedValuesOf(pageId),
        readContext(),
      );
    },
  );

  /**
   * Two queries per call — the live row pages, then every cell of those rows —
   * plus a constant few per *related* data source when relations or rollups are
   * in play, then filter/sort/paginate in JS. Never N+1 per row.
   */
  const runQuery = (dataSourceId: Id, opts?: QueryOptions): QueryResult => {
    requireDataSourceRow(dataSourceId);
    const properties = propertiesOf(dataSourceId);
    const index = new Map(properties.map((prop) => [prop.id, prop]));
    const ctx = readContext();

    // The engine cannot see the related data source, so the type each rollup
    // aggregates is resolved here (it decides number vs. date min/max).
    const rollupTargetTypes = new Map<Id, PropertyType>();
    for (const prop of properties) {
      if (prop.type !== "rollup") continue;
      const target = resolveRollup(prop, index, ctx)?.target;
      if (target !== undefined && target !== null) {
        rollupTargetTypes.set(prop.id, target.type);
      }
    }
    const queryCtx = { rollupTargetTypes };

    const byPage = new Map<Id, Map<Id, PropertyValue>>();
    for (const row of s.valuesOfDataSource.all(dataSourceId)) {
      let bucket = byPage.get(row.page_id);
      if (bucket === undefined) {
        bucket = new Map<Id, PropertyValue>();
        byPage.set(row.page_id, bucket);
      }
      bucket.set(row.property_id, parseValue(row.value));
    }

    const empty = new Map<Id, PropertyValue>();
    const rows = s.liveRowPages
      .all(dataSourceId)
      .map((page) =>
        rowRecordFor(page, properties, byPage.get(page.id) ?? empty, ctx),
      );

    const matched = sortRows(
      filterRows(rows, index, opts?.filter ?? null, queryCtx),
      index,
      opts?.sorts,
      queryCtx,
    );
    const { limit, offset } = clampPagination(opts?.limit, opts?.offset);
    return { rows: matched.slice(offset, offset + limit), total: matched.length };
  };

  const txCreateView = tx(
    (
      dataSourceId: Id,
      input: {
        name: string;
        type: ViewType;
        config?: Partial<ViewConfig>;
        afterViewId?: Id | null;
      },
    ): View => {
      const at = now();
      requireDataSourceRow(dataSourceId);
      const name = requireName(input.name, "view name");
      const type = assertViewType(input.type);
      const config: ViewConfig = { ...defaultViewConfig(), ...input.config };
      const id = randomUUID();
      s.insertView.run({
        id,
        data_source_id: dataSourceId,
        name,
        type,
        config: JSON.stringify(config),
        rank: rankAmong(viewEntries(dataSourceId), input.afterViewId, "afterViewId"),
        locked: 0,
      });
      s.touchDataSource.run(at, dataSourceId);
      return rowToView(requireViewRow(id));
    },
  );

  const txUpdateView = tx(
    (
      viewId: Id,
      patch: {
        name?: string;
        type?: ViewType;
        config?: Partial<ViewConfig>;
        locked?: boolean;
      },
    ): View => {
      const at = now();
      const current = rowToView(requireViewRow(viewId));
      const changesShape =
        patch.config !== undefined ||
        (patch.type !== undefined && patch.type !== current.type);
      if (current.locked && changesShape) {
        throw new KumiError(
          "locked",
          `view is locked; unlock it first (update { locked: false }): ${viewId}`,
        );
      }
      const name =
        patch.name === undefined ? current.name : requireName(patch.name, "view name");
      const type = patch.type === undefined ? current.type : assertViewType(patch.type);
      const config: ViewConfig =
        patch.config === undefined
          ? current.config
          : { ...current.config, ...patch.config };
      const locked = patch.locked === undefined ? current.locked : patch.locked;
      s.updateViewRow.run(
        name,
        type,
        JSON.stringify(config),
        locked ? 1 : 0,
        viewId,
      );
      s.touchDataSource.run(at, current.dataSourceId);
      return rowToView(requireViewRow(viewId));
    },
  );

  const txDeleteView = tx((viewId: Id): void => {
    const at = now();
    const row = requireViewRow(viewId);
    if (s.viewsOfDataSource.all(row.data_source_id).length <= 1) {
      throw invalid(`a data source must keep at least one view: ${viewId}`);
    }
    s.deleteViewRow.run(viewId);
    s.touchDataSource.run(at, row.data_source_id);
  });

  const txReorderView = tx((viewId: Id, afterViewId: Id | null): View => {
    const at = now();
    const row = requireViewRow(viewId);
    const rank = rankAmong(
      viewEntries(row.data_source_id),
      afterViewId,
      "afterViewId",
      viewId,
    );
    s.setViewRank.run(rank, viewId);
    s.touchDataSource.run(at, row.data_source_id);
    return rowToView(requireViewRow(viewId));
  });

  // -------------------------------------------------------------------------
  // History commands
  // -------------------------------------------------------------------------

  const txSnapshotPage = tx((pageId: Id): SnapshotMeta => {
    const page = requirePageRow(pageId);
    return captureSnapshot(page, "manual", now());
  });

  /**
   * Put the page back the way the snapshot found it.
   *
   * The pre-restore state is captured first (cause "restore"), so a restore is
   * itself undoable and never destroys later history. The page's block rows are
   * then dropped and re-inserted from the snapshot **with their original ids**:
   * every link, backlink and synced reference that named a block survives, and
   * a live block whose id the snapshot also carries simply gets the snapshot's
   * content back. The one id that cannot be reused is one now held by a live
   * block on *another* page — that row keeps its id and the restored block gets
   * a fresh one, since a restore must never reach outside its page.
   *
   * Versions climb past whatever the dropped rows were at, so an editor holding
   * a stale `baseVersion` gets a clean conflict rather than a silent overwrite.
   */
  const txRestoreSnapshot = tx((snapshotId: Id): void => {
    const at = now();
    const row = s.snapshotById.get(snapshotId);
    if (row === undefined) throw notFound("snapshot", snapshotId);
    const page = requirePageRow(row.page_id);
    if (page.deleted_at !== null) {
      throw invalid(`cannot restore into a trashed page: ${page.id}`);
    }
    if (page.locked !== 0) {
      throw new KumiError(
        "locked",
        `page is locked; unlock it first (update { locked: false }): ${page.id}`,
      );
    }

    const state = parseSnapshotState(row.state);
    captureSnapshot(page, "restore", at);

    const versions = new Map<Id, number>();
    for (const live of s.blockVersionsOfPage.all(page.id)) {
      versions.set(live.id, live.version);
    }
    s.deleteBlocksOfPage.run(page.id);

    const idMap = new Map<Id, Id>();
    for (const block of state.blocks) {
      const collides = s.blockById.get(block.id) !== undefined;
      idMap.set(block.id, collides ? randomUUID() : block.id);
    }
    for (const block of state.blocks) {
      const id = idMap.get(block.id) ?? block.id;
      const type = assertBlockType(block.type);
      const payload = assertPayload(block.payload);
      const parentBlockId =
        block.parentBlockId === null
          ? null
          : (idMap.get(block.parentBlockId) ?? null);
      insertBlockRow(
        { id, pageId: page.id, parentBlockId, rank: block.rank, type, payload },
        at,
        Math.max(versions.get(block.id) ?? 0, block.version) + 1,
        block.createdAt,
      );
      reindexBlockLinks(id, page.id, type, payload);
    }

    s.setPageTitleIcon.run(state.title, state.icon, at, page.id);
    recordRevision("page", page.id, page.id, 0, { restoredFrom: snapshotId }, at);
    reindexPage(page.id);
  });

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  /** Serialize a live page subtree into a self-contained {@link TemplateState}. */
  const serializeSubtree = (root: PageRow): TemplateState => {
    // Trashed descendants are skipped: a template is a starting point, not a
    // backup. Trashing cascades, so an included page always has an included
    // parent.
    const rows: PageRow[] = [];
    const included = new Set<Id>();
    for (const entry of s.subtreeIds.all(root.id)) {
      const row = getPageRow(entry.id);
      if (row === undefined || row.deleted_at !== null) continue;
      rows.push(row);
      included.add(row.id);
    }

    const pages: TemplatePage[] = [];
    const blocks: TemplateBlock[] = [];
    const dataSources: TemplateDataSource[] = [];
    const properties: TemplateProperty[] = [];
    const views: TemplateView[] = [];
    const dsRows: TemplateDsRow[] = [];
    const propertyValues: TemplatePropertyValue[] = [];

    for (const row of rows) {
      const isRoot = row.id === root.id;
      pages.push({
        id: row.id,
        parentId:
          isRoot || row.parent_id === null || !included.has(row.parent_id)
            ? null
            : row.parent_id,
        title: row.title,
        icon: row.icon,
        coverAssetId: row.cover_asset_id,
        fullWidth: row.full_width !== 0,
        smallText: row.small_text !== 0,
        rank: row.rank,
      });
      for (const block of hydrateBlocks(row.id)) {
        blocks.push({
          id: block.id,
          pageId: block.pageId,
          parentBlockId: block.parentBlockId,
          rank: block.rank,
          type: block.type,
          payload: block.payload,
        });
      }
      for (const ds of s.dataSourcesOfPage.all(row.id)) {
        dataSources.push({ id: ds.id, pageId: ds.page_id, title: ds.title });
        for (const prop of propertiesOf(ds.id)) {
          properties.push({
            id: prop.id,
            dataSourceId: prop.dataSourceId,
            name: prop.name,
            type: prop.type,
            config: prop.config,
            rank: prop.rank,
          });
        }
        for (const view of viewsOf(ds.id)) {
          views.push({
            id: view.id,
            dataSourceId: view.dataSourceId,
            name: view.name,
            type: view.type,
            config: view.config,
            rank: view.rank,
            locked: view.locked,
          });
        }
        for (const entry of s.dsRowEntries.all(ds.id)) {
          if (!included.has(entry.id)) continue;
          dsRows.push({ pageId: entry.id, dataSourceId: ds.id, rank: entry.rank });
          for (const cell of s.valuesOfPage.all(entry.id)) {
            propertyValues.push({
              pageId: cell.page_id,
              propertyId: cell.property_id,
              value: parseValue(cell.value),
            });
          }
        }
      }
    }

    return {
      templateVersion: TEMPLATE_VERSION,
      rootPageId: root.id,
      pages,
      blocks,
      dataSources,
      properties,
      views,
      dsRows,
      propertyValues,
    };
  };

  const txSaveAsTemplate = tx((pageId: Id, name?: string): TemplateMeta => {
    const at = now();
    const root = requirePageRow(pageId);
    if (root.deleted_at !== null) {
      throw invalid(`cannot save a trashed page as a template: ${pageId}`);
    }
    const trimmed = (name ?? root.title).trim();
    const meta: TemplateMeta = {
      id: randomUUID(),
      name: trimmed === "" ? UNTITLED : trimmed,
      icon: root.icon,
      createdAt: at,
    };
    s.insertTemplate.run({
      id: meta.id,
      name: meta.name,
      icon: meta.icon,
      state: JSON.stringify(serializeSubtree(root)),
      created_at: at,
    });
    return meta;
  });

  /**
   * Rebuild the template's subtree with all-fresh ids under `parentId`.
   * Insert order follows the foreign keys: pages (parents before children, the
   * order `subtreeIds` produced), then databases, schema, views, rows and
   * cells, then blocks — so a block's internal link finds its target page
   * already in place and lands in the `links` index on the first pass.
   */
  const txInstantiateTemplate = tx(
    (templateId: Id, parentId: Id | null | undefined): Page => {
      const at = now();
      const row = s.templateById.get(templateId);
      if (row === undefined) throw notFound("template", templateId);

      const parent = parentId ?? null;
      if (parent !== null) {
        const parentRow = requirePageRow(parent);
        if (parentRow.deleted_at !== null) {
          throw invalid(`cannot instantiate a template under a trashed page: ${parent}`);
        }
      }

      const state = remapTemplateState(parseTemplateState(row.state), randomUUID);
      const rootRank = rankForPosition(parent, undefined);

      for (const page of state.pages) {
        const isRoot = page.id === state.rootPageId;
        s.insertPage.run({
          id: page.id,
          parent_id: isRoot ? parent : page.parentId,
          title: page.title,
          icon: page.icon,
          cover_asset_id: page.coverAssetId,
          locked: 0,
          full_width: page.fullWidth ? 1 : 0,
          small_text: page.smallText ? 1 : 0,
          rank: isRoot ? rootRank : page.rank,
          created_at: at,
          updated_at: at,
        });
      }
      for (const ds of state.dataSources) {
        s.insertDataSource.run(ds.id, ds.pageId, ds.title, at, at);
      }
      for (const prop of state.properties) {
        s.insertProperty.run({
          id: prop.id,
          data_source_id: prop.dataSourceId,
          name: prop.name,
          type: prop.type,
          config: JSON.stringify(prop.config),
          rank: prop.rank,
        });
      }
      for (const view of state.views) {
        s.insertView.run({
          id: view.id,
          data_source_id: view.dataSourceId,
          name: view.name,
          type: view.type,
          config: JSON.stringify(view.config),
          rank: view.rank,
          locked: view.locked ? 1 : 0,
        });
      }
      for (const dsRow of state.dsRows) {
        s.insertDsRow.run(dsRow.pageId, dsRow.dataSourceId, dsRow.rank);
      }
      for (const cell of state.propertyValues) {
        s.upsertValue.run(cell.pageId, cell.propertyId, JSON.stringify(cell.value));
      }
      for (const block of state.blocks) {
        const type = assertBlockType(block.type);
        const payload = assertPayload(block.payload);
        insertBlockRow(
          {
            id: block.id,
            pageId: block.pageId,
            parentBlockId: block.parentBlockId,
            rank: block.rank,
            type,
            payload,
          },
          at,
        );
        reindexBlockLinks(block.id, block.pageId, type, payload);
      }
      for (const page of state.pages) reindexPage(page.id);

      return rowToPage(requirePageRow(state.rootPageId));
    },
  );

  const txDeleteTemplate = tx((templateId: Id): void => {
    if (s.templateById.get(templateId) === undefined) {
      throw notFound("template", templateId);
    }
    s.deleteTemplateRow.run(templateId);
  });

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  /** One page's place in the exported file tree. */
  interface ExportNode {
    page: PageRow;
    /** Directory of this page's Markdown file, relative to `dir` ("" = root). */
    dirRel: string;
    /** Filename stem, shared by the file and the folder holding its children. */
    stem: string;
    /** The Markdown file, relative to `dir`. */
    fileRel: string;
    children: ExportNode[];
  }

  const namesIn = (taken: Map<string, Set<string>>, dirRel: string): Set<string> => {
    const hit = taken.get(dirRel);
    if (hit !== undefined) return hit;
    const fresh = new Set<string>();
    taken.set(dirRel, fresh);
    return fresh;
  };

  const buildExportTree = (
    page: PageRow,
    dirRel: string,
    taken: Map<string, Set<string>>,
    recursive: boolean,
  ): ExportNode => {
    const base = safeFileName(page.title);
    const file = uniqueFileName(base, ".md", namesIn(taken, dirRel));
    const stem = file.slice(0, -".md".length);
    const node: ExportNode = {
      page,
      dirRel,
      stem,
      fileRel: joinRel(dirRel, file),
      children: [],
    };
    if (recursive) {
      // Database rows are not tree members, so `liveChildren` is exactly the
      // set of child *pages* that deserve a file of their own.
      for (const child of s.liveChildren.all(page.id)) {
        node.children.push(
          buildExportTree(child, joinRel(dirRel, stem), taken, true),
        );
      }
    }
    return node;
  };

  const flattenExportTree = (node: ExportNode, out: ExportNode[]): ExportNode[] => {
    out.push(node);
    for (const child of node.children) flattenExportTree(child, out);
    return out;
  };

  /** The `ValueContext` a CSV cell needs: related titles and rollup targets. */
  const csvValueContext = (prop: PropertyDef): ValueContext => {
    const titleOf = (pageId: Id): string => getPageRow(pageId)?.title ?? "";
    if (prop.type !== "rollup") return { titleOf };
    const rollup = rollupConfigOf(prop.config);
    const targetId = rollup?.targetPropertyId ?? null;
    const target = targetId === null ? undefined : s.propertyById.get(targetId);
    return {
      titleOf,
      targetConfig: target === undefined ? {} : rowToProperty(target).config,
    };
  };

  /** One data source as CSV: property names as the header, one line per row. */
  const dataSourceCsv = (dataSourceId: Id): string => {
    const properties = propertiesOf(dataSourceId);
    const contexts = new Map(
      properties.map((prop) => [prop.id, csvValueContext(prop)]),
    );
    const lines = [csvLine(properties.map((prop) => prop.name))];
    // An export takes every row, so it pages past the query limit.
    let offset = 0;
    for (;;) {
      const page = runQuery(dataSourceId, { limit: MAX_QUERY_LIMIT, offset });
      for (const record of page.rows) {
        lines.push(
          csvLine(
            properties.map((prop) => {
              const value = record.values[prop.id];
              return value === undefined
                ? ""
                : plainTextOf(value, prop.config, contexts.get(prop.id));
            }),
          ),
        );
      }
      offset += page.rows.length;
      if (page.rows.length === 0 || offset >= page.total) break;
    }
    return `${lines.join("\n")}\n`;
  };

  const exportPageMarkdownTo = (
    pageId: Id,
    dir: string,
    opts?: { recursive?: boolean },
  ): ExportResult => {
    const root = requirePageRow(pageId);
    if (root.deleted_at !== null) {
      throw invalid(`cannot export a trashed page: ${pageId}`);
    }
    const target = path.resolve(dir);
    fs.mkdirSync(target, { recursive: true });

    const taken = new Map<string, Set<string>>();
    const tree = buildExportTree(root, "", taken, opts?.recursive === true);
    const nodes = flattenExportTree(tree, []);
    const pageFiles = new Map<Id, string>(
      nodes.map((node) => [node.page.id, node.fileRel]),
    );

    // Every data source owned by an exported page becomes a CSV beside it,
    // named "<page>.<database>.csv", whether or not a child_database block
    // points at it (a full-page database has no such block).
    const csvFiles = new Map<Id, { rel: string; title: string }>();
    for (const node of nodes) {
      for (const ds of s.dataSourcesOfPage.all(node.page.id)) {
        const base = `${node.stem}.${safeFileName(ds.title)}`;
        const name = uniqueFileName(base, ".csv", namesIn(taken, node.dirRel));
        csvFiles.set(ds.id, { rel: joinRel(node.dirRel, name), title: ds.title });
      }
    }

    const written: string[] = [];
    const absolute = (rel: string): string => path.join(target, ...rel.split("/"));
    const write = (rel: string, content: string): void => {
      const file = absolute(rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
      written.push(file);
    };

    const copiedAssets = new Set<Id>();
    const copyAsset = (assetId: Id): { rel: string; name: string } | null => {
      const asset = assets.getAsset(assetId);
      if (asset === null) return null;
      const rel = `${EXPORT_ASSETS_DIR}/${asset.path}`;
      if (!copiedAssets.has(assetId)) {
        copiedAssets.add(assetId);
        const source = path.join(assetsDirOf(db), asset.path);
        if (fs.existsSync(source)) {
          const destination = absolute(rel);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.copyFileSync(source, destination);
          written.push(destination);
        }
      }
      return { rel, name: asset.path };
    };

    for (const node of nodes) {
      const ctx: MarkdownContext = {
        pageHref(id: Id): string | null {
          const rel = pageFiles.get(id);
          return rel === undefined ? null : hrefBetween(node.dirRel, rel);
        },
        pageTitle(id: Id): string {
          const title = getPageRow(id)?.title ?? "";
          return title === "" ? UNTITLED : title;
        },
        asset(assetId: Id): { href: string; name: string } | null {
          const copied = copyAsset(assetId);
          return copied === null
            ? null
            : { href: hrefBetween(node.dirRel, copied.rel), name: copied.name };
        },
        database(dataSourceId: Id): { href: string; title: string } | null {
          const csv = csvFiles.get(dataSourceId);
          return csv === undefined
            ? null
            : { href: hrefBetween(node.dirRel, csv.rel), title: csv.title };
        },
      };
      const title = node.page.title === "" ? UNTITLED : node.page.title;
      const body = blocksToMarkdown(hydrateBlocks(node.page.id), ctx);
      write(node.fileRel, `# ${title}\n${body === "" ? "" : `\n${body}`}`);
      for (const ds of s.dataSourcesOfPage.all(node.page.id)) {
        const csv = csvFiles.get(ds.id);
        if (csv !== undefined) write(csv.rel, dataSourceCsv(ds.id));
      }
    }

    return { files: written };
  };

  /**
   * The native, loss-free workspace dump. Raw table rows in a stable order, so
   * two exports of an unchanged workspace differ only in `exportedAt`.
   *
   * Snapshots and templates are deliberately absent: they are history and
   * scaffolding, not workspace content, and a restore that resurrected a page's
   * every intermediate state would multiply the size of a backup for no gain.
   * The derived `search_index`, `revisions` and `applied_ops` tables are absent
   * for the same reason — an import rebuilds them from the content.
   */
  const exportWorkspaceJsonTo = (dir: string): ExportResult => {
    const target = path.resolve(dir);
    fs.mkdirSync(target, { recursive: true });
    const written: string[] = [];

    const envelope = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now(),
      workspace: (({ name, icon }) => ({ name, icon }))(workspaceInfo()),
      pages: s.allPages.all().map((row) => ({
        ...rowToPage(row),
        /** Which `trashPage` call put this row in the trash; null when live. */
        trashBatchId: row.trash_batch_id,
      })),
      blocks: s.allBlocks.all().map(rowToBlock),
      dataSources: s.allDataSources.all().map(rowToDataSource),
      properties: s.allProperties.all().map(rowToProperty),
      propertyValues: s.allPropertyValues.all().map((row) => ({
        pageId: row.page_id,
        propertyId: row.property_id,
        value: parseValue(row.value),
      })),
      dsRows: s.allDsRows.all().map((row) => ({
        pageId: row.page_id,
        dataSourceId: row.data_source_id,
        rank: row.rank,
      })),
      views: s.allViews.all().map(rowToView),
      links: s.allLinks.all().map((row) => ({
        sourceBlockId: row.source_block_id,
        sourcePageId: row.source_page_id,
        targetPageId: row.target_page_id,
      })),
      assets: s.allAssets.all().map((row) => ({
        id: row.id,
        contentHash: row.content_hash,
        mime: row.mime,
        size: row.size,
        path: row.path,
      })),
      // Unfiltered, unlike `getUserState`: a favourite of a trashed page must
      // come back when that page is restored from the same export.
      userState: {
        favorites: asIdArray(readStateJson("favorites")),
        recents: asIdArray(readStateJson("recents")),
        expandedPageIds: asIdArray(readStateJson("expandedPageIds")),
        theme: readTheme(),
      } satisfies UserState,
    };

    const file = path.join(target, WORKSPACE_EXPORT_FILE);
    fs.writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    written.push(file);

    const sourceDir = assetsDirOf(db);
    for (const asset of envelope.assets) {
      const source = path.join(sourceDir, asset.path);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(target, EXPORT_ASSETS_DIR, asset.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      written.push(destination);
    }

    return { files: written };
  };

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  const commands: KumiCommands = {
    getWorkspaceInfo(): WorkspaceInfo {
      return workspaceInfo();
    },

    renameWorkspace(name: string): void {
      const trimmed = name.trim();
      if (trimmed === "") throw invalid("workspace name must not be empty");
      s.setMeta.run("name", JSON.stringify(trimmed));
    },

    setWorkspaceIcon(icon: string | null): void {
      s.setMeta.run("icon", JSON.stringify(icon));
    },

    createPage(input: CreatePageInput): Page {
      return txCreatePage(input);
    },

    getPage(id: Id): Page | null {
      const row = getPageRow(id);
      return row === undefined ? null : rowToPage(row);
    },

    updatePage(id: Id, patch: UpdatePageInput): Page {
      return txUpdatePage(id, patch);
    },

    movePage(id: Id, parentId: Id | null, afterPageId?: Id | null): Page {
      return txMovePage(id, parentId, afterPageId);
    },

    trashPage(id: Id): void {
      txTrashPage(id);
    },

    restorePage(id: Id): void {
      txRestorePage(id);
    },

    deletePagePermanently(id: Id): void {
      txDeletePagePermanently(id);
    },

    listTrash(): Page[] {
      return s.trashRoots.all().map(rowToPage);
    },

    listRootPages(): PageTreeNode[] {
      return treeNodes(s.liveRoots.all());
    },

    listChildren(pageId: Id): PageTreeNode[] {
      requirePageRow(pageId);
      return treeNodes(s.liveChildren.all(pageId));
    },

    getBreadcrumb(pageId: Id): Pick<Page, "id" | "title" | "icon">[] {
      return breadcrumbFor(pageId);
    },

    duplicatePage(id: Id): Page {
      return txDuplicatePage(id);
    },

    getBlocks(pageId: Id): Block[] {
      requirePageRow(pageId);
      return hydrateBlocks(pageId);
    },

    getBlock(blockId: Id): Block | null {
      const row = s.blockById.get(blockId);
      if (row === undefined || row.archived !== 0) return null;
      const page = getPageRow(row.page_id);
      if (page === undefined || page.deleted_at !== null) return null;
      return rowToBlock(row);
    },

    applyBlockOps(ops: BlockOp[]): BatchResult {
      return txApplyBlockOps(ops);
    },

    importAsset(sourcePath: string, filename?: string): Asset {
      return assets.importAsset(sourcePath, filename);
    },

    getAsset(id: Id): Asset | null {
      return assets.getAsset(id);
    },

    assetAbsolutePath(id: Id): string {
      return assets.assetAbsolutePath(id);
    },

    getBacklinks(pageId: Id): Backlink[] {
      return s.backlinksOf.all(pageId).map((row) => ({
        sourcePageId: row.source_page_id,
        sourceBlockId: row.source_block_id,
        sourcePageTitle: row.source_page_title,
        sourcePageIcon: row.source_page_icon,
      }));
    },

    createDataSource(
      ownerPageId: Id,
      title?: string,
    ): { dataSource: DataSource; properties: PropertyDef[]; views: View[] } {
      return txCreateDataSource(ownerPageId, title);
    },

    getDataSource(
      id: Id,
    ): { dataSource: DataSource; properties: PropertyDef[]; views: View[] } | null {
      const row = s.dataSourceById.get(id);
      if (row === undefined) return null;
      return {
        dataSource: rowToDataSource(row),
        properties: propertiesOf(id),
        views: viewsOf(id),
      };
    },

    listDataSources(ownerPageId: Id): DataSource[] {
      requirePageRow(ownerPageId);
      return s.dataSourcesOfPage.all(ownerPageId).map(rowToDataSource);
    },

    renameDataSource(id: Id, title: string): DataSource {
      return txRenameDataSource(id, title);
    },

    deleteDataSource(id: Id): void {
      txDeleteDataSource(id);
    },

    addProperty(
      dataSourceId: Id,
      input: {
        name: string;
        type: PropertyType;
        config?: PropertyConfig;
        afterPropertyId?: Id | null;
      },
    ): PropertyDef {
      return txAddProperty(dataSourceId, input);
    },

    updateProperty(
      propertyId: Id,
      patch: { name?: string; type?: PropertyType; config?: PropertyConfig },
    ): PropertyDef {
      return txUpdateProperty(propertyId, patch);
    },

    removeProperty(propertyId: Id): void {
      txRemoveProperty(propertyId);
    },

    reorderProperty(propertyId: Id, afterPropertyId: Id | null): PropertyDef {
      return txReorderProperty(propertyId, afterPropertyId);
    },

    createRow(
      dataSourceId: Id,
      values?: Record<Id, PropertyValue>,
      afterRowId?: Id | null,
    ): RowRecord {
      return txCreateRow(dataSourceId, values, afterRowId);
    },

    getRow(pageId: Id): RowRecord | null {
      const dsRow = s.dsRowByPage.get(pageId);
      if (dsRow === undefined) return null;
      const page = getPageRow(pageId);
      if (page === undefined) return null;
      return rowRecordFor(
        page,
        propertiesOf(dsRow.data_source_id),
        storedValuesOf(pageId),
        readContext(),
      );
    },

    setPropertyValues(
      pageId: Id,
      values: Record<Id, PropertyValue | null>,
    ): RowRecord {
      return txSetPropertyValues(pageId, values);
    },

    queryDataSource(dataSourceId: Id, opts?: QueryOptions): QueryResult {
      return runQuery(dataSourceId, opts);
    },

    createView(
      dataSourceId: Id,
      input: {
        name: string;
        type: ViewType;
        config?: Partial<ViewConfig>;
        afterViewId?: Id | null;
      },
    ): View {
      return txCreateView(dataSourceId, input);
    },

    updateView(
      viewId: Id,
      patch: {
        name?: string;
        type?: ViewType;
        config?: Partial<ViewConfig>;
        locked?: boolean;
      },
    ): View {
      return txUpdateView(viewId, patch);
    },

    deleteView(viewId: Id): void {
      txDeleteView(viewId);
    },

    reorderView(viewId: Id, afterViewId: Id | null): View {
      return txReorderView(viewId, afterViewId);
    },

    search(
      query: string,
      opts?: { limit?: number; titleOnly?: boolean },
    ): SearchResult[] {
      const limit = Math.min(
        Math.max(1, Math.trunc(opts?.limit ?? DEFAULT_SEARCH_LIMIT)),
        MAX_SEARCH_LIMIT,
      );
      const titleOnly = opts?.titleOnly === true;
      const titleExpr = buildMatchExpression(query, { titleOnly: true });
      if (titleExpr === null) return [];

      const results: SearchResult[] = [];
      const seen = new Set<string>();
      const collect = (rows: SearchRow[]): void => {
        for (const row of rows) {
          if (seen.has(row.page_id) || results.length >= limit) continue;
          seen.add(row.page_id);
          const hasBody = row.body_snippet.includes("<b>");
          const hasTitle = row.title_snippet.includes("<b>");
          const snippet = hasBody
            ? row.body_snippet
            : hasTitle
              ? row.title_snippet
              : row.body_snippet !== ""
                ? row.body_snippet
                : row.title_snippet;
          const breadcrumb = breadcrumbFor(row.page_id)
            .slice(0, -1)
            .map((p) => p.title);
          results.push({
            pageId: row.page_id,
            title: row.title,
            icon: row.icon,
            snippet,
            breadcrumb,
            updatedAt: row.updated_at,
          });
        }
      };

      // Title hits first, then everything else.
      collect(s.searchQuery.all(titleExpr, limit));
      if (!titleOnly && results.length < limit) {
        const allExpr = buildMatchExpression(query);
        if (allExpr !== null) collect(s.searchQuery.all(allExpr, limit));
      }
      return results;
    },

    getUserState(): UserState {
      return buildUserState();
    },

    setFavorite(pageId: Id, favorite: boolean): UserState {
      return txSetFavorite(pageId, favorite);
    },

    reorderFavorite(pageId: Id, afterPageId: Id | null): UserState {
      return txReorderFavorite(pageId, afterPageId);
    },

    touchRecent(pageId: Id): void {
      txTouchRecent(pageId);
    },

    setExpanded(pageId: Id, expanded: boolean): void {
      txSetExpanded(pageId, expanded);
    },

    setTheme(theme: UserState["theme"]): void {
      if (!THEMES.includes(theme)) throw invalid(`unknown theme: ${String(theme)}`);
      writeStateJson("theme", theme);
    },

    snapshotPage(pageId: Id): SnapshotMeta {
      return txSnapshotPage(pageId);
    },

    listSnapshots(pageId: Id): SnapshotMeta[] {
      requirePageRow(pageId);
      return s.snapshotMetasOfPage.all(pageId).map((row) => ({
        id: row.id,
        pageId: row.page_id,
        cause: assertSnapshotCause(row.cause),
        createdAt: row.created_at,
      }));
    },

    getSnapshot(snapshotId: Id): PageSnapshot {
      const row = s.snapshotById.get(snapshotId);
      if (row === undefined) throw notFound("snapshot", snapshotId);
      const state = parseSnapshotState(row.state);
      return {
        meta: {
          id: row.id,
          pageId: row.page_id,
          cause: assertSnapshotCause(row.cause),
          createdAt: row.created_at,
        },
        title: state.title,
        icon: state.icon,
        blocks: state.blocks,
      };
    },

    restoreSnapshot(snapshotId: Id): void {
      txRestoreSnapshot(snapshotId);
    },

    saveAsTemplate(pageId: Id, name?: string): TemplateMeta {
      return txSaveAsTemplate(pageId, name);
    },

    listTemplates(): TemplateMeta[] {
      return s.allTemplates.all().map((row) => ({
        id: row.id,
        name: row.name,
        icon: row.icon,
        createdAt: row.created_at,
      }));
    },

    instantiateTemplate(templateId: Id, parentId?: Id | null): Page {
      return txInstantiateTemplate(templateId, parentId);
    },

    deleteTemplate(templateId: Id): void {
      txDeleteTemplate(templateId);
    },

    exportPageMarkdown(
      pageId: Id,
      dir: string,
      opts?: { recursive?: boolean },
    ): ExportResult {
      return exportPageMarkdownTo(pageId, dir, opts);
    },

    exportWorkspaceJson(dir: string): ExportResult {
      return exportWorkspaceJsonTo(dir);
    },

    planNotionImport(sourcePath: string): ImportPlanSummary {
      return planNotionImportFrom(sourcePath);
    },

    runNotionImport(
      sourcePath: string,
      opts?: { onProgress?: (progress: ImportProgress) => void },
    ): ImportReport {
      return runNotionImportInto(db, commands, sourcePath, opts);
    },

    listImportJobs(): ImportJobInfo[] {
      return listImportJobRows(db);
    },
  };

  return commands;
}
