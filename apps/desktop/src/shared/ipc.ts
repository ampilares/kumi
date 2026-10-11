/**
 * The IPC contract shared by main, preload and renderer.
 *
 * There is exactly one request channel (`kumi:invoke`) carrying a method name
 * from `KumiCommands` plus its argument tuple. Main dispatches by direct method
 * lookup on the core commands object — no per-command handler registration, so
 * the IPC surface can never drift from the core command surface.
 */
import type {
  Asset,
  ImportJobInfo,
  ImportPlanSummary,
  ImportProgress,
  ImportReport,
  KumiCommands,
} from "@kumi/core";

export const INVOKE_CHANNEL = "kumi:invoke";
export const STATUS_CHANNEL = "kumi:status";
export const CHANGED_CHANNEL = "kumi:changed";

/* -------------------------------------------------------- Phase 3 channels */

/**
 * The generic dispatcher covers every `KumiCommands` method. These four are the
 * only capabilities that are *not* core commands: they need Electron itself
 * (native dialogs, the shell, the network stack), so they get their own
 * channels rather than being smuggled into the contract.
 */
export const IMPORT_ASSETS_CHANNEL = "kumi:importAssetFromPaths";
export const FETCH_URL_META_CHANNEL = "kumi:fetchUrlMeta";
export const OPEN_ASSET_CHANNEL = "kumi:openAsset";

/* --------------------------------------------------- Phase 6 (export) channels */

/**
 * Export needs three more Electron-only capabilities: choose a destination
 * folder, reveal a written file, and render a page to PDF (Chromium's print
 * pipeline lives in main). Core still writes every file — these only supply the
 * directory and the bytes Chromium alone can produce.
 */
export const PICK_DIRECTORY_CHANNEL = "kumi:pickDirectory";
export const SHOW_IN_FOLDER_CHANNEL = "kumi:showInFolder";
export const EXPORT_PDF_CHANNEL = "kumi:exportPdf";

export interface ExportPdfRequest {
  pageId: string;
  /** Suggested file name (no extension) for the save dialog. */
  suggestedName: string;
}

export interface ExportPdfResult {
  /** Absolute path written, or null when the user cancelled the save dialog. */
  path: string | null;
}

/* --------------------------------------------------- Phase 7 (import) channels */

/**
 * The import hub. Plan and run both execute in a child process (see
 * `shared/importProtocol.ts`), so these are request/notify channels rather than
 * `KumiCommands` calls: `kumi:importRun` answers with a job handle *immediately*
 * and the real work reports back through the two broadcast channels.
 *
 * `kumi:importJobs` is a plain read and could ride the generic dispatcher, but
 * the hub is easier to reason about — and to stub in tests — when the whole
 * import surface is one named group.
 */
export const IMPORT_PLAN_CHANNEL = "kumi:importPlan";
export const IMPORT_RUN_CHANNEL = "kumi:importRun";
export const IMPORT_JOBS_CHANNEL = "kumi:importJobs";
export const IMPORT_PROGRESS_CHANNEL = "kumi:importProgress";
export const IMPORT_DONE_CHANNEL = "kumi:importDone";
/** Native picker for an export archive/folder, and the loss-report save dialog. */
export const PICK_IMPORT_SOURCE_CHANNEL = "kumi:pickImportSource";
export const SAVE_JSON_CHANNEL = "kumi:saveJson";

/** A Notion export is either a `.zip` archive or an already-extracted folder. */
export type ImportSourceKind = "zip" | "folder";

export interface ImportPlanRequest {
  sourcePath: string;
}

export interface ImportRunRequest {
  sourcePath: string;
}

/** Answer to `kumi:importRun`: the handle its progress events are tagged with. */
export interface ImportRunStarted {
  jobId: string;
}

export interface ImportProgressEvent extends ImportProgress {
  jobId: string;
}

/** Terminal event for a run. Exactly one of `report` / `error` is non-null. */
export interface ImportDoneEvent {
  jobId: string;
  report: ImportReport | null;
  error: KumiErrorShape | null;
}

export interface SaveJsonRequest {
  /** File name (no extension) offered in the save dialog. */
  suggestedName: string;
  /** Already-serialized JSON — main never re-encodes what the hub composed. */
  json: string;
}

export interface SaveJsonResult {
  path: string | null;
}

/** Custom protocol serving workspace assets to the renderer. */
export const ASSET_SCHEME = "kumi-asset";

export function assetUrl(assetId: string): string {
  // Web dev mode (browser, no custom protocol): the dev server streams assets.
  // `globalThis` keeps this file compilable under the DOM-less main tsconfig.
  if ((globalThis as { __KUMI_WEB__?: boolean }).__KUMI_WEB__ === true) {
    return `/kumi-dev/asset/${encodeURIComponent(assetId)}`;
  }
  return `${ASSET_SCHEME}://${encodeURIComponent(assetId)}`;
}

export type MediaKind = "image" | "file" | "video" | "audio";

export interface ImportAssetsRequest {
  /** Absolute paths, typically from a drag-drop. Empty ⇒ open a file dialog. */
  paths?: string[];
  /** Dialog filter to use when `paths` is empty. */
  accept?: MediaKind;
}

/** Open-Graph-ish metadata scraped from a page's `<head>`. */
export interface UrlMeta {
  url: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
}

export type CommandName = keyof KumiCommands;

export interface InvokeRequest {
  method: CommandName;
  args: unknown[];
}

export interface KumiErrorShape {
  code: string;
  message: string;
}

export type InvokeResponse<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: KumiErrorShape };

/** Payload of the `kumi:changed` broadcast: which command mutated state. */
export interface ChangedEvent {
  method: CommandName;
}

export interface WorkspaceStatus {
  ready: boolean;
  path: string;
  error: KumiErrorShape | null;
}

/**
 * Commands that mutate workspace state. After any of these succeeds, main
 * broadcasts `kumi:changed` to every window so panels can refetch.
 */
export const MUTATING_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  "renameWorkspace",
  "setWorkspaceIcon",
  "createPage",
  "updatePage",
  "movePage",
  "trashPage",
  "restorePage",
  "deletePagePermanently",
  "duplicatePage",
  "applyBlockOps",
  "importAsset",
  // Databases (Phase 4): schema, rows and views all drive live table refetches.
  "createDataSource",
  "renameDataSource",
  "deleteDataSource",
  "addProperty",
  "updateProperty",
  "removeProperty",
  "reorderProperty",
  "createRow",
  "setPropertyValues",
  "createView",
  "updateView",
  "deleteView",
  "reorderView",
  "setFavorite",
  "reorderFavorite",
  "touchRecent",
  "setExpanded",
  "setTheme",
  // History & templates (Phase 6). Reads (listSnapshots/getSnapshot/
  // listTemplates/export*) stay out — only writes trigger a refetch broadcast.
  "snapshotPage",
  "restoreSnapshot",
  "saveAsTemplate",
  "instantiateTemplate",
  "deleteTemplate",
]);

/** Async mirror of `KumiCommands` — every call crosses IPC, so it returns a promise. */
export type AsyncCommands = {
  [K in keyof KumiCommands]: KumiCommands[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** Shape exposed on `window.kumi` by the preload bridge. */
export interface KumiBridge {
  invoke<K extends CommandName>(
    method: K,
    ...args: KumiCommands[K] extends (...args: infer A) => unknown ? A : never
  ): Promise<
    KumiCommands[K] extends (...args: never[]) => infer R ? Awaited<R> : never
  >;
  status(): Promise<WorkspaceStatus>;
  onChanged(listener: (event: ChangedEvent) => void): () => void;
  /** Copy files into the workspace asset store (dialog when no paths given). */
  importAssets(request: ImportAssetsRequest): Promise<Asset[]>;
  fetchUrlMeta(url: string): Promise<UrlMeta>;
  /** Open an asset with the OS default application. */
  openAsset(assetId: string): Promise<void>;
  /** Native folder picker. Resolves null when the user cancels. */
  pickDirectory(title?: string): Promise<string | null>;
  /** Reveal a written file in Explorer/Finder. */
  showInFolder(path: string): Promise<void>;
  /** Render one page to PDF via Chromium's print pipeline. */
  exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult>;
  /* ------------------------------------------------------------ Phase 7 */
  /** Dry-run a Notion export in a child process. Rejects with a `KumiError`. */
  importPlan(request: ImportPlanRequest): Promise<InvokeResponse<ImportPlanSummary>>;
  /** Start the import; resolves as soon as the child is spawned. */
  importRun(request: ImportRunRequest): Promise<InvokeResponse<ImportRunStarted>>;
  importJobs(): Promise<InvokeResponse<ImportJobInfo[]>>;
  onImportProgress(listener: (event: ImportProgressEvent) => void): () => void;
  onImportDone(listener: (event: ImportDoneEvent) => void): () => void;
  /** Native picker for a `.zip` archive or an extracted export folder. */
  pickImportSource(kind: ImportSourceKind): Promise<string | null>;
  /** Save dialog for the machine-readable loss report. */
  saveJson(request: SaveJsonRequest): Promise<SaveJsonResult>;
  /**
   * Absolute path of a dropped `File`. Chromium stopped exposing `File.path` in
   * Electron 32; `webUtils.getPathForFile` is the supported replacement and it
   * can only be called from preload.
   */
  pathForFile(file: File): string;
}
