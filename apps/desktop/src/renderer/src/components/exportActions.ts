/**
 * Export flows shared by the page menu and the settings popover.
 *
 * Each one is the same three beats: ask for a destination, let core write the
 * files, then report. They live outside the components because two different
 * menus start the same flow, and because "did the user cancel the dialog?" is
 * the kind of branch that should exist once.
 */
import { commands, exportPdf, pickDirectory, showInFolder } from "../ipc";
import { summarizeExport } from "../lib/phase6";
import { toastAction, toastError, toastInfo } from "./Toasts";

export async function exportPageMarkdown(pageId: string): Promise<void> {
  const dir = await pickDirectory("Export Markdown to…");
  if (!dir) return;
  try {
    const result = await commands.exportPageMarkdown(pageId, dir, { recursive: true });
    const first = result.files[0];
    const message = summarizeExport("Markdown", result.files, dir);
    if (first) toastAction(message, "Show in folder", () => void showInFolder(first));
    else toastInfo(message);
  } catch (err) {
    toastError(err, "The Markdown export failed.");
  }
}

export async function exportWorkspaceJson(): Promise<void> {
  const dir = await pickDirectory("Export workspace JSON to…");
  if (!dir) return;
  try {
    const result = await commands.exportWorkspaceJson(dir);
    const first = result.files[0];
    const message = summarizeExport("Workspace JSON", result.files, dir);
    if (first) toastAction(message, "Show in folder", () => void showInFolder(first));
    else toastInfo(message);
  } catch (err) {
    toastError(err, "The workspace export failed.");
  }
}

export async function exportPagePdf(pageId: string, title: string): Promise<void> {
  try {
    const result = await exportPdf({ pageId, suggestedName: title });
    if (!result.path) return; // Save dialog cancelled.
    const path = result.path;
    toastAction("PDF exported.", "Show in folder", () => void showInFolder(path));
  } catch (err) {
    toastError(err, "The PDF export failed.");
  }
}
