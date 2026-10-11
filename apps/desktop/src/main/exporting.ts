/**
 * Export capabilities that need Electron rather than `@kumi/core`.
 *
 * Core writes the Markdown and JSON files itself; it just cannot ask the user
 * where to put them, reveal them afterwards, or produce a PDF — those three are
 * Chromium/OS jobs, so they live here.
 *
 * The PDF path renders the page in an offscreen `BrowserWindow` pointed at the
 * renderer with `?print=1&page=<id>`. That route draws a stripped, read-only
 * version of the page (no rail, no topbar, no editor chrome) and sets
 * `window.__kumiPrintReady` when its blocks have loaded — printing the visible
 * window instead would bake the app shell into every export.
 */
import { join } from "node:path";
import { app, BrowserWindow, dialog, shell } from "electron";
import { writeFile } from "node:fs/promises";
import type {
  ExportPdfRequest,
  ExportPdfResult,
  ImportSourceKind,
  SaveJsonRequest,
  SaveJsonResult,
} from "../shared/ipc";

/** Longest we wait for the print route to report itself ready. */
const PRINT_READY_TIMEOUT_MS = 15_000;
const PRINT_POLL_MS = 100;

function parentWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

export async function pickDirectory(title: string): Promise<string | null> {
  const parent = parentWindow();
  const options: Electron.OpenDialogOptions = {
    title,
    buttonLabel: "Export here",
    properties: ["openDirectory", "createDirectory"],
  };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

export function showInFolder(path: string): void {
  if (path) shell.showItemInFolder(path);
}

/**
 * Import source picker (Phase 7). A Notion export arrives either as the `.zip`
 * Notion hands you or as the folder you unzipped it into, so the hub asks for
 * one or the other explicitly — a single dialog cannot offer both on Windows.
 */
export async function pickImportSource(kind: ImportSourceKind): Promise<string | null> {
  const parent = parentWindow();
  const options: Electron.OpenDialogOptions =
    kind === "zip"
      ? {
          title: "Choose a Notion export archive",
          buttonLabel: "Choose",
          filters: [{ name: "Notion export", extensions: ["zip"] }],
          properties: ["openFile"],
        }
      : {
          title: "Choose an extracted Notion export folder",
          buttonLabel: "Choose",
          properties: ["openDirectory"],
        };
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/** Save dialog for the import loss report. The renderer supplies the bytes. */
export async function saveJson(request: SaveJsonRequest): Promise<SaveJsonResult> {
  const parent = parentWindow();
  const options: Electron.SaveDialogOptions = {
    title: "Save import report",
    defaultPath: `${safeFileName(request.suggestedName)}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  };
  const save = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options);
  if (save.canceled || !save.filePath) return { path: null };
  await writeFile(save.filePath, request.json, "utf8");
  return { path: save.filePath };
}

/** Strip characters Windows forbids in a file name. */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "").trim();
  return cleaned === "" ? "Untitled" : cleaned.slice(0, 80);
}

function printUrl(pageId: string): string {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  const query = `print=1&page=${encodeURIComponent(pageId)}`;
  if (!app.isPackaged && devUrl) return `${devUrl}?${query}`;
  return `file://${join(__dirname, "../renderer/index.html").replace(/\\/g, "/")}?${query}`;
}

async function waitForPrintReady(win: BrowserWindow): Promise<void> {
  const deadline = Date.now() + PRINT_READY_TIMEOUT_MS;
  for (;;) {
    if (win.isDestroyed()) return;
    const ready = await win.webContents
      .executeJavaScript("window.__kumiPrintReady === true")
      .catch(() => false);
    if (ready === true) return;
    if (Date.now() >= deadline) return; // Print what rendered rather than failing.
    await new Promise((resolve) => setTimeout(resolve, PRINT_POLL_MS));
  }
}

export async function exportPdf(request: ExportPdfRequest): Promise<ExportPdfResult> {
  const parent = parentWindow();
  const saveOptions: Electron.SaveDialogOptions = {
    title: "Export page as PDF",
    defaultPath: `${safeFileName(request.suggestedName)}.pdf`,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  };
  const save = parent
    ? await dialog.showSaveDialog(parent, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (save.canceled || !save.filePath) return { path: null };

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: true,
    },
  });

  try {
    await win.loadURL(printUrl(request.pageId));
    await waitForPrintReady(win);
    const pdf = await win.webContents.printToPDF({
      landscape: false,
      printBackground: true,
      pageSize: "A4",
    });
    await writeFile(save.filePath, pdf);
    return { path: save.filePath };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
