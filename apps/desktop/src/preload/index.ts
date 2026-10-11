import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { Asset } from "@kumi/core";
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
  OPEN_ASSET_CHANNEL,
  PICK_DIRECTORY_CHANNEL,
  PICK_IMPORT_SOURCE_CHANNEL,
  SAVE_JSON_CHANNEL,
  SHOW_IN_FOLDER_CHANNEL,
  STATUS_CHANNEL,
  type ChangedEvent,
  type ExportPdfRequest,
  type ExportPdfResult,
  type ImportAssetsRequest,
  type ImportDoneEvent,
  type ImportPlanRequest,
  type ImportProgressEvent,
  type ImportRunRequest,
  type ImportSourceKind,
  type SaveJsonRequest,
  type SaveJsonResult,
  type UrlMeta,
  type WorkspaceStatus,
} from "../shared/ipc";

const bridge = {
  /** Raw envelope passthrough; the renderer unwraps it into a typed proxy. */
  invoke(method: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(INVOKE_CHANNEL, { method, args });
  },
  status(): Promise<WorkspaceStatus> {
    return ipcRenderer.invoke(STATUS_CHANNEL) as Promise<WorkspaceStatus>;
  },
  onChanged(listener: (event: ChangedEvent) => void): () => void {
    const handler = (_e: IpcRendererEvent, event: ChangedEvent): void => listener(event);
    ipcRenderer.on(CHANGED_CHANNEL, handler);
    return () => {
      ipcRenderer.off(CHANGED_CHANNEL, handler);
    };
  },
  importAssets(request: ImportAssetsRequest): Promise<Asset[]> {
    return ipcRenderer.invoke(IMPORT_ASSETS_CHANNEL, request) as Promise<Asset[]>;
  },
  fetchUrlMeta(url: string): Promise<UrlMeta> {
    return ipcRenderer.invoke(FETCH_URL_META_CHANNEL, url) as Promise<UrlMeta>;
  },
  openAsset(assetId: string): Promise<void> {
    return ipcRenderer.invoke(OPEN_ASSET_CHANNEL, assetId) as Promise<void>;
  },
  pickDirectory(title?: string): Promise<string | null> {
    return ipcRenderer.invoke(PICK_DIRECTORY_CHANNEL, title ?? "") as Promise<string | null>;
  },
  showInFolder(path: string): Promise<void> {
    return ipcRenderer.invoke(SHOW_IN_FOLDER_CHANNEL, path) as Promise<void>;
  },
  exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult> {
    return ipcRenderer.invoke(EXPORT_PDF_CHANNEL, request) as Promise<ExportPdfResult>;
  },
  /* ------------------------------------------------------- Phase 7: import */
  importPlan(request: ImportPlanRequest): Promise<unknown> {
    return ipcRenderer.invoke(IMPORT_PLAN_CHANNEL, request);
  },
  importRun(request: ImportRunRequest): Promise<unknown> {
    return ipcRenderer.invoke(IMPORT_RUN_CHANNEL, request);
  },
  importJobs(): Promise<unknown> {
    return ipcRenderer.invoke(IMPORT_JOBS_CHANNEL);
  },
  onImportProgress(listener: (event: ImportProgressEvent) => void): () => void {
    const handler = (_e: IpcRendererEvent, event: ImportProgressEvent): void => listener(event);
    ipcRenderer.on(IMPORT_PROGRESS_CHANNEL, handler);
    return () => {
      ipcRenderer.off(IMPORT_PROGRESS_CHANNEL, handler);
    };
  },
  onImportDone(listener: (event: ImportDoneEvent) => void): () => void {
    const handler = (_e: IpcRendererEvent, event: ImportDoneEvent): void => listener(event);
    ipcRenderer.on(IMPORT_DONE_CHANNEL, handler);
    return () => {
      ipcRenderer.off(IMPORT_DONE_CHANNEL, handler);
    };
  },
  pickImportSource(kind: ImportSourceKind): Promise<string | null> {
    return ipcRenderer.invoke(PICK_IMPORT_SOURCE_CHANNEL, kind) as Promise<string | null>;
  },
  saveJson(request: SaveJsonRequest): Promise<SaveJsonResult> {
    return ipcRenderer.invoke(SAVE_JSON_CHANNEL, request) as Promise<SaveJsonResult>;
  },
  /**
   * Chromium no longer exposes `File.path`, and `webUtils` is a preload-only
   * API — so translating a dropped file into a path the main process can import
   * has to happen right here.
   */
  pathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
};

contextBridge.exposeInMainWorld("kumi", bridge);
