/**
 * `@kumi/core` — headless workspace storage and command layer.
 *
 * A workspace is a folder containing `kumi.db` and `assets/`; both are created
 * on demand. Everything the UI can do is reachable through `KumiCommands`.
 *
 * ```ts
 * const ws = openWorkspace("C:/Users/me/Kumi");
 * const page = ws.commands.createPage({ title: "Hello" });
 * ws.close();
 * ```
 */

import { createCommands } from "./commands";
import { openWorkspaceDb } from "./db";
import type { KumiCommands } from "./types";

export * from "./types";
export { KumiError, type KumiErrorCode } from "./errors";
export { rankBetween, validateRank } from "./rank";
export { BLOCK_TYPES, VIEW_TYPES, createCommands } from "./commands";
export {
  PROPERTY_TYPES,
  ROLLUP_AGGREGATIONS,
  isIsoDateString,
  plainTextOf,
  isEmptyValue,
  isNumericAggregation,
  relationConfigOf,
  rollupConfigOf,
  rollupKind,
  type RollupKind,
  type ValueContext,
} from "./values";
export {
  DEFAULT_QUERY_LIMIT,
  MAX_QUERY_LIMIT,
  type QueryContext,
} from "./query";
export {
  MIGRATIONS,
  openWorkspaceDb,
  assetsDirOf,
  withTransaction,
  workspacePathOf,
  type Db,
  type Migration,
} from "./db";
export { extensionOf, mimeForExtension } from "./assets";
export { extractLinkTargets, pageIdFromHref } from "./links";
export { payloadToPlain, richTextToPlain, tokenizeQuery } from "./text";
export {
  blocksToMarkdown,
  richTextToMarkdown,
  safeFileName,
  uniqueFileName,
  type MarkdownContext,
} from "./markdown";
export {
  MAX_FILE_COUNT,
  MAX_TOTAL_BYTES,
  ingestNotionExport,
  notionIdOf,
  notionTitleOf,
  type IngestLimits,
  type IngestResult,
  type SourceFile,
} from "./notion/ingest";
export {
  REL_HREF_PREFIX,
  hrefForTarget,
  isExternalTarget,
  mediaTypeForPath,
  parseInline,
  parseNotionMarkdown,
  relHrefsOf,
  relTargetOf,
  walkParsedBlocks,
  type MarkdownLoss,
  type ParsedBlock,
  type ParsedMarkdown,
} from "./notion/parseMd";
export {
  inferColumn,
  inferSchema,
  isUrlValue,
  parseCheckbox,
  parseCsv,
  parseDatePoint,
  parseDateValue,
  parseNumber,
  splitTokens,
  type CsvTable,
  type InferredColumn,
  type InferredPropertyType,
} from "./notion/parseCsv";
export {
  SRC_HREF_PREFIX,
  aggregateLosses,
  buildModel,
  contentPageCount,
  rowCount,
  summarize,
  type NDataSource,
  type NPage,
  type NRow,
  type NormalizedModel,
} from "./notion/plan";
export {
  listImportJobs as readImportJobs,
  runNotionImport as runImportPipeline,
  type ProgressFn,
} from "./notion/write";
export {
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

export interface Workspace {
  commands: KumiCommands;
  /** Close the underlying SQLite connection. Safe to call once. */
  close(): void;
}

/**
 * Open (creating if absent) the workspace folder at `path` and return its
 * command surface. The folder is created recursively, `assets/` is created when
 * missing, and pending migrations are applied before returning.
 */
export function openWorkspace(path: string): Workspace {
  const db = openWorkspaceDb(path);
  return {
    commands: createCommands(db),
    close(): void {
      if (db.isOpen) db.close();
    },
  };
}
