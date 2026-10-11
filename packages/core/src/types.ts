/**
 * Kumi shared contract.
 *
 * This file is the single source of truth for the entity shapes and the
 * command surface. The SQLite layer implements `KumiCommands`, Electron IPC
 * exposes it 1:1 to the renderer, and the `kumi` CLI wraps the same interface.
 * Do not add renderer-only or CLI-only concepts here.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** UUID v4. */
export type Id = string;

/** Fractional-index rank string; ordered lexicographically. */
export type Rank = string;

/** Unix epoch milliseconds. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Rich text
// ---------------------------------------------------------------------------

export interface RichTextAnnotations {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  /** Notion-style color name, e.g. "red", "red_background", "default". */
  color?: string;
}

export type RichTextSpan =
  | {
      type: "text";
      text: string;
      annotations?: RichTextAnnotations;
      /** External URL or internal `kumi://page/<id>` link. */
      href?: string;
    }
  | {
      type: "mention";
      mention:
        | { kind: "page"; pageId: Id }
        | { kind: "date"; start: string; end?: string };
      annotations?: RichTextAnnotations;
    }
  | {
      type: "equation";
      expression: string;
      annotations?: RichTextAnnotations;
    };

export type RichText = RichTextSpan[];

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

export type BlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  | "code"
  | "equation"
  | "bookmark"
  | "table_of_contents"
  | "image"
  | "file"
  | "video"
  | "audio"
  | "embed"
  | "child_page"
  | "linked_page"
  | "column_list"
  | "column"
  | "table"
  | "table_row"
  | "synced_block"
  | "synced_reference"
  | "child_database";

/**
 * Typed per-block payload. `richText` carries the text content for text-like
 * blocks; other fields are type-specific and optional so the payload stays
 * forward-compatible (unknown keys are preserved verbatim on import).
 */
export interface BlockPayload {
  richText?: RichText;
  /** to_do */
  checked?: boolean;
  /** code */
  language?: string;
  /** callout */
  icon?: string;
  /** image/file/video/audio: asset id */
  assetId?: Id;
  /** image/file/video/audio: display caption */
  caption?: RichText;
  /** bookmark/embed */
  url?: string;
  /** child_page / linked_page */
  pageId?: Id;
  /** column: fractional width 0..1 */
  widthRatio?: number;
  /** equation block */
  expression?: string;
  /** synced_reference: id of the source synced_block */
  syncedSourceId?: Id;
  /** child_database: the embedded data source */
  dataSourceId?: Id;
  /** child_database: currently selected view */
  activeViewId?: Id;
  /** table */
  hasColumnHeader?: boolean;
  hasRowHeader?: boolean;
  /** table_row: one RichText per cell */
  cells?: RichText[];
  /** Unknown/imported extras preserved round-trip. */
  [key: string]: unknown;
}

export interface Block {
  id: Id;
  pageId: Id;
  /** Parent block id, or null when a direct child of the page. */
  parentBlockId: Id | null;
  rank: Rank;
  type: BlockType;
  payload: BlockPayload;
  version: number;
  archived: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export interface Page {
  id: Id;
  /** Parent page id, or null for a workspace root page. */
  parentId: Id | null;
  title: string;
  /** Emoji or `asset:<id>`. */
  icon: string | null;
  /** Asset id for the cover image. */
  coverAssetId: string | null;
  locked: boolean;
  fullWidth: boolean;
  smallText: boolean;
  rank: Rank;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  /** Set when the page is in the trash. */
  deletedAt: Timestamp | null;
}

/** Sidebar tree node: a page plus its ordered children. */
export interface PageTreeNode {
  page: Page;
  hasChildren: boolean;
  children?: PageTreeNode[];
}

// ---------------------------------------------------------------------------
// Editor operations (batched, optimistic)
// ---------------------------------------------------------------------------

/**
 * Atomic editor mutations. Each op carries a client-generated `opId` so
 * retries are idempotent: an opId that was already applied is acknowledged
 * without being re-applied.
 */
export type BlockOp =
  | {
      opId: Id;
      kind: "insert";
      block: {
        id: Id;
        pageId: Id;
        parentBlockId: Id | null;
        rank: Rank;
        type: BlockType;
        payload: BlockPayload;
      };
    }
  | {
      opId: Id;
      kind: "update";
      blockId: Id;
      /** Base version for conflict detection; server rejects stale writes. */
      baseVersion: number;
      patch: Partial<Pick<Block, "type" | "payload">>;
    }
  | {
      opId: Id;
      kind: "move";
      blockId: Id;
      parentBlockId: Id | null;
      rank: Rank;
    }
  | {
      opId: Id;
      kind: "delete";
      blockId: Id;
    };

export interface BatchResult {
  applied: Id[]; // opIds applied (or previously applied)
  rejected: { opId: Id; reason: "conflict" | "not_found" | "invalid"; message: string }[];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
  pageId: Id;
  title: string;
  icon: string | null;
  /** Highlighted snippet with <b>…</b> markers around matches. */
  snippet: string;
  /** Breadcrumb titles from root to parent. */
  breadcrumb: string[];
  updatedAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Workspace-level user state
// ---------------------------------------------------------------------------

export interface WorkspaceInfo {
  /** Absolute path of the workspace folder (contains kumi.db + assets/). */
  path: string;
  name: string;
  icon: string | null;
}

export interface UserState {
  /** Explicitly ordered favorite page ids. */
  favorites: Id[];
  /** Most-recently-visited page ids, newest first, capped. */
  recents: Id[];
  /** Sidebar expansion state. */
  expandedPageIds: Id[];
  theme: "system" | "light" | "dark";
}

// ---------------------------------------------------------------------------
// Databases (data sources, properties, views) — rows are pages
// ---------------------------------------------------------------------------

/** Property types. Person/files/formula are future phases. */
export type PropertyType =
  | "title"
  | "text"
  | "number"
  | "select"
  | "multi_select"
  | "date"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "relation"
  | "rollup";

export type RollupAggregation =
  | "count" // related rows
  | "count_values" // non-empty target values
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "show_originals";

export interface RelationConfig {
  /** The related data source. */
  dataSourceId: Id;
  /**
   * The paired reverse relation property on the target data source, kept in
   * sync bidirectionally. null = one-way relation.
   */
  pairedPropertyId: Id | null;
}

export interface RollupConfig {
  /** A relation property on the SAME data source. */
  relationPropertyId: Id;
  /** Property on the related data source to aggregate; null = the rows themselves (count/show_originals). */
  targetPropertyId: Id | null;
  aggregation: RollupAggregation;
}

/** Notion-style option: id is stable, name/color are editable. */
export interface SelectOption {
  id: Id;
  name: string;
  /** Palette name, e.g. "gray", "red", "blue". */
  color: string;
}

export type NumberFormat =
  | "number"
  | "number_with_commas"
  | "percent"
  | "dollar"
  | "euro"
  | "pound"
  | "yen";

export interface PropertyConfig {
  /** select / multi_select */
  options?: SelectOption[];
  /** number */
  numberFormat?: NumberFormat;
  /** relation */
  relation?: RelationConfig;
  /** rollup */
  rollup?: RollupConfig;
  /** Unknown/imported extras preserved verbatim. */
  [key: string]: unknown;
}

export interface PropertyDef {
  id: Id;
  dataSourceId: Id;
  name: string;
  type: PropertyType;
  config: PropertyConfig;
  rank: Rank;
}

/**
 * Typed cell value. The variant `type` always matches the property's type;
 * writes with a mismatched variant are rejected as invalid — values are never
 * silently coerced.
 */
export type PropertyValue =
  | { type: "title"; richText: RichText }
  | { type: "text"; richText: RichText }
  | { type: "number"; number: number | null }
  | { type: "select"; optionId: Id | null }
  | { type: "multi_select"; optionIds: Id[] }
  | { type: "date"; start: string | null; end?: string | null }
  | { type: "checkbox"; checked: boolean }
  | { type: "url"; value: string | null }
  | { type: "email"; value: string | null }
  | { type: "phone"; value: string | null }
  /** Ordered related row page ids. */
  | { type: "relation"; pageIds: Id[] }
  /**
   * Computed at read time — never stored, and rejected by setPropertyValues.
   * `number` for count/count_values/sum/avg/min/max over numbers; `date` range
   * for min/max over dates; `values` for show_originals.
   */
  | {
      type: "rollup";
      aggregation: RollupAggregation;
      number?: number | null;
      date?: { start: string | null; end?: string | null } | null;
      values?: PropertyValue[];
    };

export interface DataSource {
  id: Id;
  /** The page that owns this database (inline container or full-page DB). */
  pageId: Id;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/** A database row: a real page plus its typed property values. */
export interface RowRecord {
  page: Page;
  /** Keyed by property id; absent key = empty value. */
  values: Record<Id, PropertyValue>;
}

// Filters ------------------------------------------------------------------

export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "before"
  | "after"
  | "on_or_before"
  | "on_or_after";

export interface FilterCondition {
  kind: "condition";
  propertyId: Id;
  op: FilterOperator;
  /** Comparison operand; shape depends on the property type (documented per implementation). */
  value?: unknown;
}

export interface FilterGroup {
  kind: "group";
  op: "and" | "or";
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

export interface SortSpec {
  propertyId: Id;
  direction: "asc" | "desc";
}

// Views --------------------------------------------------------------------

export type ViewType = "table" | "board" | "list" | "gallery" | "calendar" | "timeline";

export interface ViewConfig {
  filter: FilterGroup | null;
  sorts: SortSpec[];
  /** Board/list grouping property (select/multi_select/checkbox/date). */
  groupByPropertyId?: Id | null;
  /** Calendar/timeline: the date property that places rows. */
  datePropertyId?: Id | null;
  /** Board/gallery card size. */
  cardSize?: "small" | "medium" | "large";
  /** Board: collapsed group keys (option ids, "checked"/"unchecked", or "__none__"). */
  collapsedGroups?: string[];
  /** Visible property ids in display order; null = all, natural order. */
  visibleProperties: Id[] | null;
  /** Table column widths in px, keyed by property id. */
  propertyWidths: Record<Id, number>;
  openMode: "center_peek" | "side_peek" | "full_page";
  /** Unknown/imported extras preserved verbatim. */
  [key: string]: unknown;
}

export interface View {
  id: Id;
  dataSourceId: Id;
  name: string;
  type: ViewType;
  config: ViewConfig;
  rank: Rank;
  locked: boolean;
}

export interface QueryOptions {
  /** Extra filter ANDed over the view/caller filter. */
  filter?: FilterGroup | null;
  sorts?: SortSpec[];
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  rows: RowRecord[];
  /** Total matching rows ignoring limit/offset. */
  total: number;
}

// ---------------------------------------------------------------------------
// History (page snapshots), templates, export
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  id: Id;
  pageId: Id;
  cause: "auto" | "manual" | "restore";
  createdAt: Timestamp;
}

/** Full captured page state: metadata plus the complete live block tree. */
export interface PageSnapshot {
  meta: SnapshotMeta;
  title: string;
  icon: string | null;
  blocks: Block[];
}

export interface TemplateMeta {
  id: Id;
  name: string;
  icon: string | null;
  createdAt: Timestamp;
}

export interface ExportResult {
  /** Absolute paths of every file written. */
  files: string[];
}

// ---------------------------------------------------------------------------
// Notion import (one-time migration; spec §7 — inspectable, idempotent, honest about loss)
// ---------------------------------------------------------------------------

export interface ImportPlanSummary {
  sourcePath: string;
  /** SHA-256 of the source (zip bytes, or a stable hash of the directory tree). */
  sourceHash: string;
  pages: number;
  dataSources: number;
  rows: number;
  assets: number;
  warnings: string[];
  /** Constructs that will not import losslessly, aggregated by kind. */
  unsupported: { kind: string; detail: string; count: number }[];
}

export interface ImportProgress {
  stage: "ingest" | "parse" | "write" | "resolve" | "assets" | "verify";
  done: number;
  total: number;
}

export interface ImportLossItem {
  kind: string;
  /** Source file / row / block the loss belongs to. */
  sourceRef: string;
  detail: string;
}

export interface ImportReport {
  jobId: Id;
  sourceHash: string;
  /** Root page everything was imported under; null when the run failed. */
  rootPageId: Id | null;
  counts: { pages: number; blocks: number; dataSources: number; rows: number; assets: number };
  losses: ImportLossItem[];
  warnings: string[];
}

export interface ImportJobInfo {
  id: Id;
  sourcePath: string;
  sourceHash: string;
  status: "committed" | "failed";
  createdAt: Timestamp;
  report: ImportReport | null;
}

// ---------------------------------------------------------------------------
// Assets & backlinks
// ---------------------------------------------------------------------------

export interface Asset {
  id: Id;
  /** SHA-256 hex of the file content; identical content shares one file. */
  contentHash: string;
  mime: string;
  size: number;
  /** Path relative to the workspace `assets/` directory. */
  path: string;
  createdAt: Timestamp;
}

export interface Backlink {
  sourcePageId: Id;
  sourceBlockId: Id;
  sourcePageTitle: string;
  sourcePageIcon: string | null;
}

// ---------------------------------------------------------------------------
// Command surface
// ---------------------------------------------------------------------------

export interface CreatePageInput {
  id?: Id;
  parentId?: Id | null;
  title?: string;
  icon?: string | null;
  /** Insert position among siblings; appended last when omitted. */
  afterPageId?: Id | null;
}

export interface UpdatePageInput {
  title?: string;
  icon?: string | null;
  coverAssetId?: string | null;
  locked?: boolean;
  fullWidth?: boolean;
  smallText?: boolean;
}

/**
 * The complete headless command surface for Phase 1–2.
 * Everything the UI can do must be reachable here.
 */
export interface KumiCommands {
  // Workspace
  getWorkspaceInfo(): WorkspaceInfo;
  renameWorkspace(name: string): void;
  setWorkspaceIcon(icon: string | null): void;

  // Pages
  createPage(input: CreatePageInput): Page;
  getPage(id: Id): Page | null;
  updatePage(id: Id, patch: UpdatePageInput): Page;
  /** Move under a new parent (null = root), positioned after `afterPageId`. */
  movePage(id: Id, parentId: Id | null, afterPageId?: Id | null): Page;
  /** Soft delete into trash (descendants follow). */
  trashPage(id: Id): void;
  restorePage(id: Id): void;
  /** Permanent delete; only valid for trashed pages. */
  deletePagePermanently(id: Id): void;
  listTrash(): Page[];
  /** Ordered roots; children loaded lazily via listChildren. */
  listRootPages(): PageTreeNode[];
  listChildren(pageId: Id): PageTreeNode[];
  /** Breadcrumb from root to the page itself. */
  getBreadcrumb(pageId: Id): Pick<Page, "id" | "title" | "icon">[];
  duplicatePage(id: Id): Page;

  // Blocks
  /** Full ordered block tree of a page. */
  getBlocks(pageId: Id): Block[];
  /** Direct lookup of one live block. */
  getBlock(blockId: Id): Block | null;
  applyBlockOps(ops: BlockOp[]): BatchResult;

  // Assets
  /**
   * Copy a file into the workspace `assets/` store, deduplicated by content
   * hash. `filename` (its extension in particular) informs the stored name and
   * MIME. Returns the existing asset when the content is already stored.
   */
  importAsset(sourcePath: string, filename?: string): Asset;
  getAsset(id: Id): Asset | null;
  /** Absolute filesystem path of an asset's content. */
  assetAbsolutePath(id: Id): string;

  // Backlinks
  /**
   * Pages/blocks whose content links to or mentions `pageId`. The `links`
   * index is maintained by applyBlockOps from rich-text hrefs
   * (`kumi://page/<id>`), page mentions, and linked_page/child_page payloads.
   */
  getBacklinks(pageId: Id): Backlink[];

  // Databases ---------------------------------------------------------------
  /**
   * Create a data source owned by `ownerPageId`, with a "Name" title property
   * and one default table view. Rows become child pages of `ownerPageId` but
   * are excluded from listChildren/listRootPages (they surface through views).
   */
  createDataSource(ownerPageId: Id, title?: string): {
    dataSource: DataSource;
    properties: PropertyDef[];
    views: View[];
  };
  getDataSource(id: Id): { dataSource: DataSource; properties: PropertyDef[]; views: View[] } | null;
  /** Data sources owned by a page (an owner page can hold several inline DBs). */
  listDataSources(ownerPageId: Id): DataSource[];
  renameDataSource(id: Id, title: string): DataSource;
  /** Permanently deletes schema and views; row pages go to trash as one batch. */
  deleteDataSource(id: Id): void;

  // Properties
  addProperty(
    dataSourceId: Id,
    input: { name: string; type: PropertyType; config?: PropertyConfig; afterPropertyId?: Id | null },
  ): PropertyDef;
  /**
   * Rename/reconfigure. Changing `type` converts stored values conservatively
   * (documented per pair); values that cannot convert are dropped from the
   * typed column but preserved raw for round-trip.
   */
  updateProperty(
    propertyId: Id,
    patch: { name?: string; type?: PropertyType; config?: PropertyConfig },
  ): PropertyDef;
  removeProperty(propertyId: Id): void;
  reorderProperty(propertyId: Id, afterPropertyId: Id | null): PropertyDef;

  // Rows
  /** Creates the row page (no scaffold paragraph) and writes `values`. */
  createRow(dataSourceId: Id, values?: Record<Id, PropertyValue>, afterRowId?: Id | null): RowRecord;
  getRow(pageId: Id): RowRecord | null;
  /** Partial update; a null entry clears that property's value. */
  setPropertyValues(pageId: Id, values: Record<Id, PropertyValue | null>): RowRecord;
  /** Filtered/sorted/paginated rows. Trashed row pages are excluded. */
  queryDataSource(dataSourceId: Id, opts?: QueryOptions): QueryResult;

  // History --------------------------------------------------------------
  /**
   * Capture the page's current state. Core also auto-snapshots inside
   * applyBlockOps when the page's newest snapshot is older than 10 minutes.
   */
  snapshotPage(pageId: Id, cause?: "manual"): SnapshotMeta;
  /** Newest first. */
  listSnapshots(pageId: Id): SnapshotMeta[];
  getSnapshot(snapshotId: Id): PageSnapshot;
  /**
   * Replace the page's title/icon/blocks with the snapshot state. The
   * pre-restore state is snapshotted first (cause "restore"), so restoring
   * never destroys later history.
   */
  restoreSnapshot(snapshotId: Id): void;

  // Templates ------------------------------------------------------------
  /** Deep-copies the page subtree (and its databases) into template storage. */
  saveAsTemplate(pageId: Id, name?: string): TemplateMeta;
  listTemplates(): TemplateMeta[];
  /** Instantiate as a fresh page under `parentId` (null/undefined = root). */
  instantiateTemplate(templateId: Id, parentId?: Id | null): Page;
  deleteTemplate(templateId: Id): void;

  // Export ---------------------------------------------------------------
  /**
   * Export a page (recursive: with descendants) as Markdown files plus
   * referenced assets into `dir`. Databases export as CSV next to the page.
   */
  exportPageMarkdown(pageId: Id, dir: string, opts?: { recursive?: boolean }): ExportResult;
  /**
   * Full-fidelity native JSON export of the whole workspace (pages, blocks,
   * data sources, properties, values, views, assets manifest, user state)
   * into `dir` — the round-trip source of truth for backup/migration.
   */
  exportWorkspaceJson(dir: string): ExportResult;

  // Notion import ---------------------------------------------------------
  /**
   * Parse a Notion export (`.zip` or extracted directory, Markdown+CSV
   * format) WITHOUT writing anything: returns what an import would create
   * plus every warning and unsupported construct.
   */
  planNotionImport(sourcePath: string): ImportPlanSummary;
  /**
   * Full pipeline: parse → write (one transaction, under a new root page
   * named after the export) → resolve internal links/relations → copy assets
   * → verify → persist the job + report. Re-running the same sourceHash
   * replaces the previous import's root (updates, never duplicates).
   */
  runNotionImport(
    sourcePath: string,
    opts?: { onProgress?: (progress: ImportProgress) => void },
  ): ImportReport;
  /** Past imports, newest first. */
  listImportJobs(): ImportJobInfo[];

  // Views
  createView(
    dataSourceId: Id,
    input: { name: string; type: ViewType; config?: Partial<ViewConfig>; afterViewId?: Id | null },
  ): View;
  updateView(
    viewId: Id,
    patch: { name?: string; type?: ViewType; config?: Partial<ViewConfig>; locked?: boolean },
  ): View;
  deleteView(viewId: Id): void;
  reorderView(viewId: Id, afterViewId: Id | null): View;

  // Search
  search(query: string, opts?: { limit?: number; titleOnly?: boolean }): SearchResult[];

  // User state
  getUserState(): UserState;
  setFavorite(pageId: Id, favorite: boolean): UserState;
  reorderFavorite(pageId: Id, afterPageId: Id | null): UserState;
  touchRecent(pageId: Id): void;
  setExpanded(pageId: Id, expanded: boolean): void;
  setTheme(theme: UserState["theme"]): void;
}
