/**
 * Browser stand-in for the Electron preload bridge (web dev mode).
 *
 * Installs `window.kumi` backed by the dev-web server (HTTP + SSE via the
 * Vite `/kumi-dev` proxy) so the untouched renderer runs in a plain browser.
 * Electron-only capabilities (OS dialogs, drag-drop file paths, PDF export,
 * show-in-folder) degrade to their "cancelled/empty" shapes so the UI stays
 * usable without special-casing.
 */
import type { Asset } from "@kumi/core";
import type {
  ChangedEvent,
  ExportPdfRequest,
  ExportPdfResult,
  ImportAssetsRequest,
  ImportDoneEvent,
  ImportPlanRequest,
  ImportProgressEvent,
  ImportRunRequest,
  ImportSourceKind,
  SaveJsonRequest,
  SaveJsonResult,
  UrlMeta,
  WorkspaceStatus,
} from "../../shared/ipc";

const BASE = "/kumi-dev";

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as T;
}

const WEB_UNSUPPORTED = "Not available in web dev mode — use the desktop app.";

export function installWebBridge(): void {
  (globalThis as { __KUMI_WEB__?: boolean }).__KUMI_WEB__ = true;

  const bridge = {
    invoke(method: string, ...args: unknown[]): Promise<unknown> {
      return post("/invoke", { method, args });
    },
    async status(): Promise<WorkspaceStatus> {
      const response = await fetch(`${BASE}/status`);
      return (await response.json()) as WorkspaceStatus;
    },
    onChanged(listener: (event: ChangedEvent) => void): () => void {
      const source = new EventSource(`${BASE}/events`);
      source.onmessage = (e) => {
        try {
          listener(JSON.parse(e.data as string) as ChangedEvent);
        } catch {
          /* malformed frame — ignore */
        }
      };
      return () => source.close();
    },
    async importAssets(_request: ImportAssetsRequest): Promise<Asset[]> {
      console.warn(`[kumi] importAssets: ${WEB_UNSUPPORTED}`);
      return [];
    },
    fetchUrlMeta(url: string): Promise<UrlMeta> {
      return post("/url-meta", { url });
    },
    async openAsset(assetId: string): Promise<void> {
      window.open(`${BASE}/asset/${encodeURIComponent(assetId)}`, "_blank");
    },
    async pickDirectory(_title?: string): Promise<string | null> {
      console.warn(`[kumi] pickDirectory: ${WEB_UNSUPPORTED}`);
      return null; // callers treat null as "dialog cancelled"
    },
    async showInFolder(_path: string): Promise<void> {
      console.warn(`[kumi] showInFolder: ${WEB_UNSUPPORTED}`);
    },
    async exportPdf(_request: ExportPdfRequest): Promise<ExportPdfResult> {
      return { saved: false, path: null } as unknown as ExportPdfResult;
    },
    importPlan(request: ImportPlanRequest): Promise<unknown> {
      return post("/invoke", { method: "planNotionImport", args: [request.sourcePath] });
    },
    importRun(_request: ImportRunRequest): Promise<unknown> {
      // Progress streaming needs the Electron child-process runner.
      return Promise.reject(new Error(WEB_UNSUPPORTED));
    },
    async importJobs(): Promise<unknown> {
      return post("/invoke", { method: "listImportJobs", args: [] });
    },
    onImportProgress(_listener: (event: ImportProgressEvent) => void): () => void {
      return () => {};
    },
    onImportDone(_listener: (event: ImportDoneEvent) => void): () => void {
      return () => {};
    },
    async pickImportSource(_kind: ImportSourceKind): Promise<string | null> {
      console.warn(`[kumi] pickImportSource: ${WEB_UNSUPPORTED}`);
      return null;
    },
    async saveJson(_request: SaveJsonRequest): Promise<SaveJsonResult> {
      return { saved: false, path: null } as unknown as SaveJsonResult;
    },
    pathForFile(_file: File): string {
      return ""; // drag-drop import is Electron-only
    },
  };

  (window as unknown as { kumi: typeof bridge }).kumi = bridge;
}
