/**
 * Renderer side of the IPC bridge.
 *
 * `commands` is a typed proxy over the single `kumi:invoke` channel: every
 * member of `KumiCommands` is callable with its real argument types and
 * resolves with its real return type (wrapped in a promise).
 */
import type { Asset, ImportJobInfo, ImportPlanSummary } from "@kumi/core";
import type {
  AsyncCommands,
  ChangedEvent,
  CommandName,
  ExportPdfRequest,
  ExportPdfResult,
  ImportAssetsRequest,
  ImportDoneEvent,
  ImportProgressEvent,
  ImportRunStarted,
  ImportSourceKind,
  InvokeResponse,
  KumiErrorShape,
  MediaKind,
  SaveJsonRequest,
  SaveJsonResult,
  UrlMeta,
  WorkspaceStatus,
} from "../../shared/ipc";
import { assetUrl } from "../../shared/ipc";

interface KumiBridgeRaw {
  invoke(method: string, ...args: unknown[]): Promise<unknown>;
  status(): Promise<WorkspaceStatus>;
  onChanged(listener: (event: ChangedEvent) => void): () => void;
  importAssets(request: ImportAssetsRequest): Promise<Asset[]>;
  fetchUrlMeta(url: string): Promise<UrlMeta>;
  openAsset(assetId: string): Promise<void>;
  pickDirectory(title?: string): Promise<string | null>;
  showInFolder(path: string): Promise<void>;
  exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult>;
  importPlan(request: { sourcePath: string }): Promise<InvokeResponse<ImportPlanSummary>>;
  importRun(request: { sourcePath: string }): Promise<InvokeResponse<ImportRunStarted>>;
  importJobs(): Promise<InvokeResponse<ImportJobInfo[]>>;
  onImportProgress(listener: (event: ImportProgressEvent) => void): () => void;
  onImportDone(listener: (event: ImportDoneEvent) => void): () => void;
  pickImportSource(kind: ImportSourceKind): Promise<string | null>;
  saveJson(request: SaveJsonRequest): Promise<SaveJsonResult>;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    kumi: KumiBridgeRaw;
  }
}

export class KumiError extends Error {
  readonly code: string;

  constructor(shape: KumiErrorShape) {
    super(shape.message);
    this.name = "KumiError";
    this.code = shape.code;
  }
}

async function call(method: string, args: unknown[]): Promise<unknown> {
  const response = (await window.kumi.invoke(method, ...args)) as InvokeResponse;
  if (!response || typeof response !== "object") {
    throw new KumiError({ code: "BAD_RESPONSE", message: `No response for ${method}.` });
  }
  if (!response.ok) throw new KumiError(response.error);
  return response.value;
}

/** Fully typed async mirror of the core command surface. */
export const commands: AsyncCommands = new Proxy({} as AsyncCommands, {
  get(_target, prop: string | symbol) {
    if (typeof prop !== "string") return undefined;
    return (...args: unknown[]) => call(prop, args);
  },
});

export function getStatus(): Promise<WorkspaceStatus> {
  return window.kumi.status();
}

/** Subscribe to the post-mutation broadcast. Returns an unsubscribe fn. */
export function onChanged(listener: (event: ChangedEvent) => void): () => void {
  return window.kumi.onChanged(listener);
}

/* -------------------------------------------------------------- Phase 3 IPC */

/** Import specific files; with no paths this opens the native file picker. */
export function importAssets(paths: string[], accept?: MediaKind): Promise<Asset[]> {
  return window.kumi.importAssets(accept === undefined ? { paths } : { paths, accept });
}

export function fetchUrlMeta(url: string): Promise<UrlMeta> {
  return window.kumi.fetchUrlMeta(url);
}

export function openAsset(assetId: string): Promise<void> {
  return window.kumi.openAsset(assetId);
}

/** Absolute path of a dropped OS file, or "" when the drop was not a real file. */
export function pathForFile(file: File): string {
  return window.kumi.pathForFile(file);
}

/* -------------------------------------------------------------- Phase 6 IPC */

/** Native folder picker for exports. Resolves null when the user cancels. */
export function pickDirectory(title?: string): Promise<string | null> {
  return window.kumi.pickDirectory(title);
}

/** Reveal an exported file in the OS file manager. */
export function showInFolder(path: string): Promise<void> {
  return window.kumi.showInFolder(path);
}

/** Render one page to PDF; resolves `{ path: null }` when the save is cancelled. */
export function exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult> {
  return window.kumi.exportPdf(request);
}

/* -------------------------------------------------------------- Phase 7 IPC */

/** Unwraps an import envelope the same way `commands` unwraps a core call. */
function unwrap<T>(response: InvokeResponse<T>): T {
  if (!response || typeof response !== "object") {
    throw new KumiError({ code: "BAD_RESPONSE", message: "The import service did not answer." });
  }
  if (!response.ok) throw new KumiError(response.error);
  return response.value;
}

/** Dry-run a Notion export. Runs in a child process; can take a while. */
export async function importPlan(sourcePath: string): Promise<ImportPlanSummary> {
  return unwrap(await window.kumi.importPlan({ sourcePath }));
}

/** Start an import. Resolves with the job handle progress events are tagged with. */
export async function importRun(sourcePath: string): Promise<string> {
  return unwrap(await window.kumi.importRun({ sourcePath })).jobId;
}

export async function importJobs(): Promise<ImportJobInfo[]> {
  return unwrap(await window.kumi.importJobs());
}

export function onImportProgress(listener: (event: ImportProgressEvent) => void): () => void {
  return window.kumi.onImportProgress(listener);
}

export function onImportDone(listener: (event: ImportDoneEvent) => void): () => void {
  return window.kumi.onImportDone(listener);
}

/** Native picker for a `.zip` archive or an extracted export folder. */
export function pickImportSource(kind: ImportSourceKind): Promise<string | null> {
  return window.kumi.pickImportSource(kind);
}

/** Save dialog for the loss report. Resolves `{ path: null }` when cancelled. */
export function saveJson(suggestedName: string, json: string): Promise<SaveJsonResult> {
  return window.kumi.saveJson({ suggestedName, json });
}

export { assetUrl };
export type {
  Asset,
  ChangedEvent,
  CommandName,
  ExportPdfRequest,
  ExportPdfResult,
  ImportDoneEvent,
  ImportProgressEvent,
  ImportSourceKind,
  MediaKind,
  UrlMeta,
  WorkspaceStatus,
};
