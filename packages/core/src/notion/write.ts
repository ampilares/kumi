/**
 * Stages 4–8 of the Notion import: allocate, write, resolve, assets, verify,
 * report.
 *
 * Everything the pipeline writes goes through the public `KumiCommands`
 * surface — the same code path the editor and the CLI use — so imported pages
 * get the same validation, search indexing and backlink index as hand-typed
 * ones. The only raw SQL here is the `import_jobs` bookkeeping table.
 *
 * Order (each stage reports progress with real counts):
 *
 * 1. **ingest**   zip/dir → file tree + `sourceHash` (see ingest.ts).
 * 2. **parse**    → the normalized model (see plan.ts).
 * 3. **write**    one transaction: import root page, every page and block,
 *    every data source, property, row and cell.
 * 4. **resolve**  rewrite internal links to `kumi://page/<uuid>`; unresolved
 *    ones become plain text plus an `unresolved_link` loss.
 * 5. **assets**   `importAsset` every referenced file (hash-deduplicated, so a
 *    re-import copies nothing) and point the media blocks at it.
 * 6. **verify**   source counts vs. written counts, plus sampled titles.
 * 7. **report**   persist the job row and return the report.
 *
 * Idempotency: a re-run of the same `sourceHash` TRASHES the previous import's
 * root page — one trash batch, restorable from the trash like any other page —
 * and imports fresh under a new root, reusing the same job row (its id and
 * `createdAt` are kept, its status/report replaced, and a warning records what
 * happened). For a one-time migration tool this is the honest reading of
 * "updates, never duplicates": the newest run is always what the workspace
 * shows, and the previous one is recoverable until the trash is emptied.
 *
 * Never silently coerce: a cell whose value fails validation for its column's
 * inferred type DOWNGRADES the whole column to text — every value in it is then
 * stored verbatim — and the downgrade is reported as a warning.
 */

import { randomUUID } from "node:crypto";
import type { Db } from "../db";
import { statement, withTransaction } from "../db";
import { invalid } from "../errors";
import { rankBetween } from "../rank";
import type {
  BlockOp,
  BlockPayload,
  Id,
  ImportJobInfo,
  ImportLossItem,
  ImportProgress,
  ImportReport,
  KumiCommands,
  PropertyDef,
  PropertyType,
  PropertyValue,
  RichTextSpan,
  SelectOption,
} from "../types";
import { validatePropertyValue } from "../values";
import {
  parseCheckbox,
  parseDateValue,
  parseNumber,
  splitTokens,
  type InferredColumn,
} from "./parseCsv";
import {
  SRC_HREF_PREFIX,
  absoluteOf,
  aggregateLosses,
  buildModel,
  contentPageCount,
  rowCount,
  type NDataSource,
  type NormalizedModel,
} from "./plan";
import { ingestNotionExport } from "./ingest";
import { relTargetOf, type ParsedBlock } from "./parseMd";

/** Pages sampled for title equality in the verify stage. */
const VERIFY_SAMPLE = 25;

export type ProgressFn = (progress: ImportProgress) => void;

interface JobRow {
  id: string;
  source_path: string;
  source_hash: string;
  status: string;
  report: string | null;
  created_at: number;
}

function jobStatements(db: Db): {
  byHash: { get(hash: string): JobRow | undefined };
  all(): JobRow[];
  insert(row: JobRow): void;
  update(row: JobRow): void;
} {
  const byHash = statement<JobRow>(db, "SELECT * FROM import_jobs WHERE source_hash = ?");
  const all = statement<JobRow>(db, "SELECT * FROM import_jobs ORDER BY created_at DESC, rowid DESC");
  const insert = statement<never>(
    db,
    `INSERT INTO import_jobs (id, source_path, source_hash, status, report, created_at)
     VALUES (@id, @source_path, @source_hash, @status, @report, @created_at)`,
  );
  const update = statement<never>(
    db,
    `UPDATE import_jobs SET source_path = @source_path, status = @status, report = @report
     WHERE id = @id`,
  );
  return {
    byHash: { get: (hash) => byHash.get(hash) },
    all: () => all.all(),
    insert: (row) => {
      insert.run({ ...row });
    },
    update: (row) => {
      update.run({
        id: row.id,
        source_path: row.source_path,
        status: row.status,
        report: row.report,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Cell conversion
// ---------------------------------------------------------------------------

/** Property type a column maps to; `title` is the page title itself. */
function propertyTypeOf(column: InferredColumn): PropertyType {
  return column.type === "title" ? "title" : (column.type as PropertyType);
}

/**
 * Convert one raw CSV cell to a typed value. Returns `null` for an empty cell
 * (no value is stored) and throws `KumiError` when the cell does not fit the
 * column's type — which is what triggers the column downgrade.
 */
function cellValue(
  column: InferredColumn,
  optionIds: Map<string, Id>,
  raw: string,
): PropertyValue | null {
  const text = raw.trim();
  if (text === "") return null;
  switch (column.type) {
    case "title":
      return { type: "title", richText: [{ type: "text", text }] };
    case "text":
      return { type: "text", richText: [{ type: "text", text: raw }] };
    case "number": {
      const value = parseNumber(text);
      if (value === null) throw invalid(`"${text}" is not a number`);
      return { type: "number", number: value };
    }
    case "checkbox": {
      const value = parseCheckbox(text);
      if (value === null) throw invalid(`"${text}" is not a checkbox value`);
      return { type: "checkbox", checked: value };
    }
    case "date": {
      const value = parseDateValue(text);
      if (value === null) throw invalid(`"${text}" is not a date`);
      return value.end === null
        ? { type: "date", start: value.start }
        : { type: "date", start: value.start, end: value.end };
    }
    case "url":
      return { type: "url", value: text };
    case "select": {
      const optionId = optionIds.get(text);
      if (optionId === undefined) throw invalid(`"${text}" is not a known option`);
      return { type: "select", optionId };
    }
    case "multi_select": {
      const ids = splitTokens(text).map((token) => {
        const optionId = optionIds.get(token);
        if (optionId === undefined) throw invalid(`"${token}" is not a known option`);
        return optionId;
      });
      return { type: "multi_select", optionIds: ids };
    }
  }
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

interface PendingBlock {
  blockId: Id;
  /** Export-relative path of the asset this block needs. */
  assetRef?: string;
  /** True when the block's rich text still holds `notion-src:` hrefs. */
  links: boolean;
}

class ImportRun {
  private readonly losses: ImportLossItem[] = [];
  private readonly warnings: string[] = [];
  private readonly pageIds = new Map<string, Id>();
  private readonly dataSourceIds = new Map<string, Id>();
  private readonly pending: PendingBlock[] = [];
  private blocks = 0;
  private assetCount = 0;

  constructor(
    private readonly commands: KumiCommands,
    private readonly model: NormalizedModel,
    private readonly onProgress: ProgressFn,
  ) {}

  private loss(kind: string, sourceRef: string, detail: string): void {
    this.losses.push({ kind, sourceRef, detail });
  }

  // --- blocks -------------------------------------------------------------

  /** Write a parsed tree as this page's content, replacing the scaffold. */
  private writeBlocks(pageId: Id, blocks: ParsedBlock[]): void {
    const ops: BlockOp[] = [];
    for (const existing of this.commands.getBlocks(pageId)) {
      ops.push({ opId: randomUUID(), kind: "delete", blockId: existing.id });
    }
    const emit = (list: ParsedBlock[], parentBlockId: Id | null): void => {
      let rank: string | null = null;
      for (const block of list) {
        const id = randomUUID();
        rank = rankBetween(rank, null);
        const payload: BlockPayload = { ...block.payload };
        ops.push({
          opId: randomUUID(),
          kind: "insert",
          block: { id, pageId, parentBlockId, rank, type: block.type, payload },
        });
        this.blocks += 1;
        const links = hasSourceHref(payload);
        if (block.assetRef !== undefined || links) {
          this.pending.push({ blockId: id, assetRef: block.assetRef, links });
        }
        emit(block.children, id);
      }
    };
    emit(blocks, null);
    if (ops.length === 0) return;
    const result = this.commands.applyBlockOps(ops);
    const rejected = result.rejected[0];
    if (rejected !== undefined) {
      throw invalid(`import could not write page ${pageId}: ${rejected.message}`);
    }
  }

  // --- write stage --------------------------------------------------------

  /** Create the import root, every page, and every database. */
  write(rootTitle: string): Id {
    const model = this.model;
    const total = contentPageCount(model) + model.dataSources.length + rowCount(model);
    let done = 0;
    const step = (): void => {
      done += 1;
      this.onProgress({ stage: "write", done, total });
    };

    const rootPage = this.commands.createPage({ title: rootTitle });

    for (const page of model.pages) {
      if (page.rowOf !== null) continue;
      const parentId =
        page.parentSourceId === null ? rootPage.id : (this.pageIds.get(page.parentSourceId) ?? rootPage.id);
      const created = this.commands.createPage({ parentId, title: page.title });
      this.pageIds.set(page.sourceId, created.id);
      this.writeBlocks(created.id, page.blocks);
      step();
    }

    for (const ds of model.dataSources) {
      this.writeDataSource(ds, rootPage.id, step);
    }
    if (total === 0) this.onProgress({ stage: "write", done: 0, total: 0 });
    return rootPage.id;
  }

  private writeDataSource(ds: NDataSource, rootPageId: Id, step: () => void): void {
    const ownerId =
      ds.ownerPageSourceId === null
        ? rootPageId
        : (this.pageIds.get(ds.ownerPageSourceId) ?? rootPageId);
    const created = this.commands.createDataSource(ownerId, ds.title);
    const dataSourceId = created.dataSource.id;
    this.dataSourceIds.set(ds.sourceId, dataSourceId);

    // The title property already exists; the rest are added in column order.
    const titleProperty = created.properties.find((prop) => prop.type === "title");
    const columns = [...ds.columns];
    const properties: (PropertyDef | null)[] = [];
    const optionIds: Map<string, Id>[] = [];

    for (const [index, column] of columns.entries()) {
      const options = new Map<string, Id>();
      for (const name of column.options) options.set(name, randomUUID());
      optionIds.push(options);
      if (index === 0 || column.type === "title") {
        if (titleProperty !== undefined && column.name !== titleProperty.name) {
          this.commands.updateProperty(titleProperty.id, { name: column.name });
        }
        properties.push(titleProperty ?? null);
        continue;
      }
      properties.push(this.addColumn(dataSourceId, column, options));
    }

    // Convert every cell before writing anything: a value that does not fit
    // downgrades its whole column to text, values preserved verbatim.
    const converted: (PropertyValue | null)[][] = ds.rows.map(() => []);
    for (const [index, column] of columns.entries()) {
      const property = properties[index];
      const options = optionIds[index] ?? new Map<string, Id>();
      if (property === null || property === undefined) {
        for (const row of converted) row.push(null);
        continue;
      }
      let values: (PropertyValue | null)[];
      try {
        values = ds.rows.map((row) => {
          const value = cellValue(column, options, row.cells[index] ?? "");
          if (value !== null) validatePropertyValue(property, value);
          return value;
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const downgraded = this.downgradeColumn(property, column, ds, message);
        properties[index] = downgraded;
        values = ds.rows.map((row) => {
          const raw = row.cells[index] ?? "";
          return raw.trim() === "" ? null : { type: "text", richText: [{ type: "text", text: raw }] };
        });
      }
      for (const [rowIndex, value] of values.entries()) {
        converted[rowIndex]?.push(value);
      }
    }

    for (const [rowIndex, row] of ds.rows.entries()) {
      const values: Record<Id, PropertyValue> = {};
      for (const [index, property] of properties.entries()) {
        const value = converted[rowIndex]?.[index];
        if (property === null || property === undefined || value === null || value === undefined) continue;
        values[property.id] = value;
      }
      const record = this.commands.createRow(dataSourceId, values);
      if (row.pageSourceId !== null) {
        this.pageIds.set(row.pageSourceId, record.page.id);
        const rowPage = this.model.pages.find((page) => page.sourceId === row.pageSourceId);
        if (rowPage !== undefined) this.writeBlocks(record.page.id, rowPage.blocks);
      }
      step();
    }
    step();
  }

  private addColumn(
    dataSourceId: Id,
    column: InferredColumn,
    options: Map<string, Id>,
  ): PropertyDef {
    const type = propertyTypeOf(column);
    const config =
      type === "select" || type === "multi_select"
        ? {
            options: [...options].map<SelectOption>(([name, id]) => ({
              id,
              name,
              color: "default",
            })),
          }
        : {};
    return this.commands.addProperty(dataSourceId, { name: column.name, type, config });
  }

  /** Turn a column into text, preserving every value verbatim. */
  private downgradeColumn(
    property: PropertyDef,
    column: InferredColumn,
    ds: NDataSource,
    reason: string,
  ): PropertyDef {
    this.warnings.push(
      `${ds.rel}: column "${column.name}" was inferred as ${column.type} but a value did not ` +
        `fit (${reason}); the column was imported as text with every value preserved`,
    );
    this.loss(
      "column_downgraded",
      ds.rel,
      `column "${column.name}" imported as text instead of ${column.type}: ${reason}`,
    );
    return this.commands.updateProperty(property.id, { type: "text", config: {} });
  }

  // --- resolve stage ------------------------------------------------------

  /** Rewrite `notion-src:` hrefs to `kumi://page/<uuid>` (or drop them). */
  resolveLinks(): void {
    const targets = this.pending.filter((entry) => entry.links);
    let done = 0;
    for (const entry of targets) {
      const block = this.commands.getBlock(entry.blockId);
      done += 1;
      this.onProgress({ stage: "resolve", done, total: targets.length });
      if (block === null) continue;
      const payload = { ...block.payload };
      let changed = false;
      forEachSpan(payload, (span) => {
        if (span.type !== "text" || typeof span.href !== "string") return;
        if (!span.href.startsWith(SRC_HREF_PREFIX)) {
          // A target that never resolved during parsing: keep the text, drop
          // the dangling href, and say so.
          const rel = relTargetOf(span.href);
          if (rel === null) return;
          delete span.href;
          changed = true;
          this.loss("unresolved_link", rel, "link target is not part of the export");
          return;
        }
        const sourceId = span.href.slice(SRC_HREF_PREFIX.length);
        if (sourceId.startsWith("file:")) return; // handled by the asset stage
        const pageId = this.pageIds.get(sourceId);
        if (pageId === undefined) {
          delete span.href;
          changed = true;
          this.loss("unresolved_link", sourceId, "link target page was not imported");
          return;
        }
        span.href = `kumi://page/${pageId}`;
        changed = true;
      });
      if (!changed) continue;
      this.update(block.id, block.version, payload);
    }
    if (targets.length === 0) this.onProgress({ stage: "resolve", done: 0, total: 0 });
  }

  // --- asset stage --------------------------------------------------------

  /** Import every referenced file and point its blocks at the stored asset. */
  writeAssets(): void {
    const assetIds = new Map<string, Id>();
    const importRel = (rel: string, sourceRef: string): Id | null => {
      const existing = assetIds.get(rel);
      if (existing !== undefined) return existing;
      try {
        const asset = this.commands.importAsset(
          absoluteOf(this.model, rel),
          rel.split("/").pop() ?? rel,
        );
        assetIds.set(rel, asset.id);
        this.assetCount += 1;
        return asset.id;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.loss("asset_unreadable", sourceRef, message);
        return null;
      }
    };

    const media = this.pending.filter((entry) => entry.assetRef !== undefined);
    const fileLinks = this.pending.filter((entry) => entry.links);
    const total = media.length + fileLinks.length;
    let done = 0;

    for (const entry of media) {
      const rel = entry.assetRef;
      done += 1;
      this.onProgress({ stage: "assets", done, total });
      if (rel === undefined) continue;
      const block = this.commands.getBlock(entry.blockId);
      if (block === null) continue;
      const assetId = importRel(rel, rel);
      if (assetId === null) continue;
      this.update(block.id, block.version, { ...block.payload, assetId });
    }

    // `[label](Report.pdf)` — a link to an exported file rather than a page.
    // The file is imported so nothing is lost, and the href names the asset.
    for (const entry of fileLinks) {
      done += 1;
      this.onProgress({ stage: "assets", done, total });
      const block = this.commands.getBlock(entry.blockId);
      if (block === null) continue;
      const payload = { ...block.payload };
      let changed = false;
      forEachSpan(payload, (span) => {
        if (span.type !== "text" || typeof span.href !== "string") return;
        if (!span.href.startsWith(`${SRC_HREF_PREFIX}file:`)) return;
        const rel = span.href.slice(`${SRC_HREF_PREFIX}file:`.length);
        const assetId = importRel(rel, rel);
        changed = true;
        if (assetId === null) {
          delete span.href;
          return;
        }
        span.href = `kumi://asset/${assetId}`;
        this.loss(
          "file_link",
          rel,
          "link to an exported file: the file was imported as an asset and the link points at it",
        );
      });
      if (changed) this.update(block.id, block.version, payload);
    }
    if (total === 0) this.onProgress({ stage: "assets", done: 0, total: 0 });
  }

  private update(blockId: Id, version: number, payload: BlockPayload): void {
    const result = this.commands.applyBlockOps([
      { opId: randomUUID(), kind: "update", blockId, baseVersion: version, patch: { payload } },
    ]);
    const rejected = result.rejected[0];
    if (rejected !== undefined) {
      throw invalid(`import could not update block ${blockId}: ${rejected.message}`);
    }
  }

  // --- verify stage -------------------------------------------------------

  /** Compare what the export said with what the workspace now holds. */
  verify(): void {
    const expectedPages = contentPageCount(this.model);
    const written = this.model.pages.filter(
      (page) => page.rowOf === null && this.pageIds.has(page.sourceId),
    ).length;
    if (written !== expectedPages) {
      this.loss(
        "verify_mismatch",
        this.model.sourcePath,
        `export holds ${expectedPages} page file(s) but ${written} page(s) were created`,
      );
    }

    for (const ds of this.model.dataSources) {
      const dataSourceId = this.dataSourceIds.get(ds.sourceId) ?? null;
      if (dataSourceId === null) {
        this.loss("verify_mismatch", ds.rel, "the imported database could not be found");
        continue;
      }
      const result = this.commands.queryDataSource(dataSourceId, { limit: 1 });
      if (result.total !== ds.rows.length) {
        this.loss(
          "verify_mismatch",
          ds.rel,
          `CSV holds ${ds.rows.length} row(s) but ${result.total} row(s) were created`,
        );
      }
    }

    let sampled = 0;
    for (const page of this.model.pages) {
      if (sampled >= VERIFY_SAMPLE) break;
      const pageId = this.pageIds.get(page.sourceId);
      if (pageId === undefined) continue;
      sampled += 1;
      const stored = this.commands.getPage(pageId);
      if (stored !== null && stored.title === page.title) continue;
      this.loss(
        "verify_mismatch",
        page.rel,
        `title "${page.title}" was stored as "${stored?.title ?? "(missing page)"}"`,
      );
    }
    this.onProgress({ stage: "verify", done: 1, total: 1 });
  }

  // --- result -------------------------------------------------------------

  addWarning(warning: string): void {
    this.warnings.push(warning);
  }

  report(jobId: Id, rootPageId: Id | null): ImportReport {
    return {
      jobId,
      sourceHash: this.model.sourceHash,
      rootPageId,
      counts: {
        pages: contentPageCount(this.model),
        blocks: this.blocks,
        dataSources: this.model.dataSources.length,
        rows: rowCount(this.model),
        assets: this.assetCount,
      },
      losses: [...this.model.losses, ...this.losses],
      warnings: [...this.model.warnings, ...this.warnings],
    };
  }

  /** Page ids created by this run, keyed by Notion source id. */
  get idMap(): ReadonlyMap<string, Id> {
    return this.pageIds;
  }
}

function forEachSpan(payload: BlockPayload, visit: (span: RichTextSpan) => void): void {
  const lists: unknown[] = [payload.richText, payload.caption];
  if (Array.isArray(payload.cells)) lists.push(...payload.cells);
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const span of list as RichTextSpan[]) visit(span);
  }
}

function hasSourceHref(payload: BlockPayload): boolean {
  let found = false;
  forEachSpan(payload, (span) => {
    if (span.type === "text" && typeof span.href === "string") {
      if (span.href.startsWith(SRC_HREF_PREFIX) || relTargetOf(span.href) !== null) found = true;
    }
  });
  return found;
}

function rootTitleFor(now: Date): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `Imported from Notion ${date}`;
}

/**
 * Run the full import pipeline. Every write happens in one transaction: a
 * failure anywhere leaves the workspace exactly as it was (asset *files* are
 * content-addressed and simply become unreferenced bytes).
 */
export function runNotionImport(
  db: Db,
  commands: KumiCommands,
  sourcePath: string,
  opts?: { onProgress?: (progress: ImportProgress) => void },
): ImportReport {
  const onProgress: ProgressFn = opts?.onProgress ?? ((): void => undefined);
  const ingest = ingestNotionExport(sourcePath);
  onProgress({ stage: "ingest", done: ingest.files.length, total: ingest.files.length });
  let model: NormalizedModel;
  try {
    model = buildModel(ingest, (done, total) => {
      onProgress({ stage: "parse", done, total });
    });
  } catch (error) {
    ingest.cleanup();
    throw error;
  }

  try {
    const jobs = jobStatements(db);
    const run = new ImportRun(commands, model, onProgress);

    return withTransaction(db, () => {
      const previous = jobs.byHash.get(model.sourceHash);
      if (previous !== undefined) {
        const previousRoot = previousRootOf(previous);
        const page = previousRoot === null ? null : commands.getPage(previousRoot);
        if (page !== null && page.deletedAt === null) {
          commands.trashPage(page.id);
          run.addWarning(
            `this export was imported before (${new Date(previous.created_at).toISOString()}); ` +
              `the previous import's root page was moved to the trash and can be restored from there`,
          );
        } else {
          run.addWarning(
            `this export was imported before (${new Date(previous.created_at).toISOString()}); ` +
              "the previous root page was already gone",
          );
        }
      }

      const rootPageId = run.write(rootTitleFor(new Date()));
      run.resolveLinks();
      run.writeAssets();
      run.verify();

      const jobId = previous?.id ?? randomUUID();
      const report = run.report(jobId, rootPageId);
      const row: JobRow = {
        id: jobId,
        source_path: model.sourcePath,
        source_hash: model.sourceHash,
        status: "committed",
        report: JSON.stringify(report),
        created_at: previous?.created_at ?? Date.now(),
      };
      if (previous === undefined) jobs.insert(row);
      else jobs.update(row);
      return report;
    });
  } catch (error) {
    // A failed run is recorded too, so the import hub can show what happened.
    recordFailure(db, model, error);
    throw error;
  } finally {
    ingest.cleanup();
  }
}

function previousRootOf(row: JobRow): Id | null {
  if (row.report === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.report);
    if (parsed === null || typeof parsed !== "object") return null;
    const rootPageId = (parsed as { rootPageId?: unknown }).rootPageId;
    return typeof rootPageId === "string" ? rootPageId : null;
  } catch {
    return null;
  }
}

function recordFailure(db: Db, model: NormalizedModel, error: unknown): void {
  const jobs = jobStatements(db);
  const message = error instanceof Error ? error.message : String(error);
  const previous = jobs.byHash.get(model.sourceHash);
  const jobId = previous?.id ?? randomUUID();
  const report: ImportReport = {
    jobId,
    sourceHash: model.sourceHash,
    rootPageId: null,
    counts: { pages: 0, blocks: 0, dataSources: 0, rows: 0, assets: 0 },
    losses: aggregateLosses(model.losses).map((entry) => ({
      kind: entry.kind,
      sourceRef: model.sourcePath,
      detail: `${entry.detail} (×${entry.count})`,
    })),
    warnings: [...model.warnings, `import failed: ${message}`],
  };
  const row: JobRow = {
    id: jobId,
    source_path: model.sourcePath,
    source_hash: model.sourceHash,
    status: "failed",
    report: JSON.stringify(report),
    created_at: previous?.created_at ?? Date.now(),
  };
  try {
    withTransaction(db, () => {
      if (previous === undefined) jobs.insert(row);
      else jobs.update(row);
    });
  } catch {
    // Recording the failure must never mask the original error.
  }
}

/** Past imports, newest first, with their reports parsed. */
export function listImportJobs(db: Db): ImportJobInfo[] {
  return jobStatements(db)
    .all()
    .map((row) => ({
      id: row.id,
      sourcePath: row.source_path,
      sourceHash: row.source_hash,
      status: row.status === "failed" ? ("failed" as const) : ("committed" as const),
      createdAt: row.created_at,
      report: parseReport(row.report),
    }));
}

function parseReport(json: string | null): ImportReport | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return parsed !== null && typeof parsed === "object" ? (parsed as ImportReport) : null;
  } catch {
    return null;
  }
}
