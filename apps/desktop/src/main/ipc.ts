/**
 * Single generic IPC dispatcher: `kumi:invoke` → direct method lookup on the
 * core commands object. Errors are serialized as `{ code, message }` inside an
 * envelope so the renderer can rethrow them as typed `KumiError`s.
 */
import { BrowserWindow, ipcMain } from "electron";
import type { KumiCommands } from "@kumi/core";
import {
  CHANGED_CHANNEL,
  EXPORT_PDF_CHANNEL,
  FETCH_URL_META_CHANNEL,
  IMPORT_ASSETS_CHANNEL,
  IMPORT_DONE_CHANNEL,
  IMPORT_JOBS_CHANNEL,
  IMPORT_PLAN_CHANNEL,
  IMPORT_PROGRESS_CHANNEL,
  IMPORT_RUN_CHANNEL,
  INVOKE_CHANNEL,
  MUTATING_COMMANDS,
  OPEN_ASSET_CHANNEL,
  PICK_DIRECTORY_CHANNEL,
  PICK_IMPORT_SOURCE_CHANNEL,
  SAVE_JSON_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  STATUS_CHANNEL,
  type ChangedEvent,
  type CommandName,
  type ExportPdfRequest,
  type ExportPdfResult,
  type ImportAssetsRequest,
  type ImportDoneEvent,
  type ImportPlanRequest,
  type ImportProgressEvent,
  type ImportRunRequest,
  type ImportRunStarted,
  type ImportSourceKind,
  type InvokeRequest,
  type InvokeResponse,
  type KumiErrorShape,
  type SaveJsonRequest,
} from "../shared/ipc";
import { getCommands, getStatus } from "./workspace";
import { importAssets, openAsset } from "./assets";
import { fetchUrlMeta } from "./urlMeta";
import { exportPdf, pickDirectory, pickImportSource, saveJson, showInFolder } from "./exporting";
import { ImportError, planImport, startImport } from "./importRunner";

function fail(code: string, message: string): InvokeResponse {
  return { ok: false, error: { code, message } };
}

function workspaceNotReady(): InvokeResponse {
  const status = getStatus();
  return {
    ok: false,
    error: status.error ?? { code: "WORKSPACE_NOT_READY", message: "Workspace is not open." },
  };
}

function serializeError(err: unknown): KumiErrorShape {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return {
      code: typeof code === "string" ? code : "COMMAND_FAILED",
      message: err.message,
    };
  }
  return { code: "COMMAND_FAILED", message: String(err) };
}

function broadcastChanged(method: CommandName): void {
  const event: ChangedEvent = { method };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(CHANGED_CHANNEL, event);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function isValidRequest(payload: unknown): payload is InvokeRequest {
  if (typeof payload !== "object" || payload === null) return false;
  const req = payload as Partial<InvokeRequest>;
  return typeof req.method === "string" && Array.isArray(req.args);
}

export function registerIpc(): void {
  ipcMain.handle(STATUS_CHANNEL, () => getStatus());

  // Electron-only capabilities. Everything else goes through INVOKE_CHANNEL.
  ipcMain.handle(IMPORT_ASSETS_CHANNEL, async (_event, request: unknown) => {
    const payload: ImportAssetsRequest =
      typeof request === "object" && request !== null ? (request as ImportAssetsRequest) : {};
    const assets = await importAssets(payload);
    if (assets.length > 0) broadcastChanged("importAsset");
    return assets;
  });

  ipcMain.handle(FETCH_URL_META_CHANNEL, (_event, url: unknown) =>
    fetchUrlMeta(typeof url === "string" ? url : ""),
  );

  ipcMain.handle(OPEN_ASSET_CHANNEL, (_event, assetId: unknown) =>
    openAsset(typeof assetId === "string" ? assetId : ""),
  );

  ipcMain.handle(PICK_DIRECTORY_CHANNEL, (_event, title: unknown) =>
    pickDirectory(typeof title === "string" && title !== "" ? title : "Choose a folder"),
  );

  ipcMain.handle(SHOW_IN_FOLDER_CHANNEL, (_event, path: unknown) => {
    showInFolder(typeof path === "string" ? path : "");
  });

  ipcMain.handle(EXPORT_PDF_CHANNEL, async (_event, request: unknown): Promise<ExportPdfResult> => {
    const payload = (typeof request === "object" && request !== null ? request : {}) as
      Partial<ExportPdfRequest>;
    if (typeof payload.pageId !== "string" || payload.pageId === "") return { path: null };
    return exportPdf({
      pageId: payload.pageId,
      suggestedName: typeof payload.suggestedName === "string" ? payload.suggestedName : "Untitled",
    });
  });

  /* --------------------------------------------------------- Phase 7: import */

  ipcMain.handle(PICK_IMPORT_SOURCE_CHANNEL, (_event, kind: unknown) =>
    pickImportSource(kind === "folder" ? "folder" : ("zip" as ImportSourceKind)),
  );

  ipcMain.handle(SAVE_JSON_CHANNEL, (_event, request: unknown) => {
    const payload = (typeof request === "object" && request !== null ? request : {}) as
      Partial<SaveJsonRequest>;
    if (typeof payload.json !== "string") return { path: null };
    return saveJson({
      suggestedName:
        typeof payload.suggestedName === "string" && payload.suggestedName !== ""
          ? payload.suggestedName
          : "kumi-import-report",
      json: payload.json,
    });
  });

  ipcMain.handle(IMPORT_JOBS_CHANNEL, (): InvokeResponse => {
    const commands = getCommands();
    if (!commands) return workspaceNotReady();
    if (typeof commands.listImportJobs !== "function") {
      return fail("IMPORT_UNAVAILABLE", "This build of @kumi/core has no import history yet.");
    }
    try {
      return { ok: true, value: commands.listImportJobs() };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });

  ipcMain.handle(IMPORT_PLAN_CHANNEL, async (_event, request: unknown): Promise<InvokeResponse> => {
    const payload = (typeof request === "object" && request !== null ? request : {}) as
      Partial<ImportPlanRequest>;
    if (typeof payload.sourcePath !== "string" || payload.sourcePath === "") {
      return fail("BAD_REQUEST", "Choose a Notion export first.");
    }
    const status = getStatus();
    if (!status.ready) return workspaceNotReady();
    try {
      // The child parses the whole archive; main's event loop stays free so the
      // window keeps painting while a multi-gigabyte export is inspected.
      return { ok: true, value: await planImport(status.path, payload.sourcePath) };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });

  ipcMain.handle(IMPORT_RUN_CHANNEL, (_event, request: unknown): InvokeResponse => {
    const payload = (typeof request === "object" && request !== null ? request : {}) as
      Partial<ImportRunRequest>;
    if (typeof payload.sourcePath !== "string" || payload.sourcePath === "") {
      return fail("BAD_REQUEST", "Choose a Notion export first.");
    }
    const status = getStatus();
    if (!status.ready) return workspaceNotReady();

    try {
      const jobId = startImport(status.path, payload.sourcePath, {
        onProgress: (progress) => {
          const event: ImportProgressEvent = { jobId, ...progress };
          broadcast(IMPORT_PROGRESS_CHANNEL, event);
        },
        onDone: (report, error) => {
          const event: ImportDoneEvent = { jobId, report, error };
          broadcast(IMPORT_DONE_CHANNEL, event);
          // A committed import created pages the rail knows nothing about.
          if (report) broadcastChanged("createPage");
        },
      });
      const started: ImportRunStarted = { jobId };
      return { ok: true, value: started };
    } catch (err) {
      if (err instanceof ImportError) return fail(err.code, err.message);
      return { ok: false, error: serializeError(err) };
    }
  });

  ipcMain.handle(INVOKE_CHANNEL, async (_event, payload: unknown): Promise<InvokeResponse> => {
    if (!isValidRequest(payload)) {
      return fail("BAD_REQUEST", "Expected { method: string, args: unknown[] }.");
    }

    const commands = getCommands();
    if (!commands) return workspaceNotReady();

    const { method, args } = payload;
    const fn = (commands as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") {
      return fail("UNKNOWN_METHOD", `@kumi/core has no command "${String(method)}".`);
    }

    try {
      const value = await (fn as (...a: unknown[]) => unknown).apply(commands, args);
      if (MUTATING_COMMANDS.has(method)) broadcastChanged(method);
      return { ok: true, value };
    } catch (err) {
      return { ok: false, error: serializeError(err) };
    }
  });
}

/** Compile-time guard: every mutating name is a real command. */
export type _MutatingAreCommands = Extract<CommandName, keyof KumiCommands>;
