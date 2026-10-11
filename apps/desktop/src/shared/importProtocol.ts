/**
 * Wire protocol between the main process and the import child process.
 *
 * A Notion import can take minutes and holds the SQLite write lock the whole
 * time. Running it on main's event loop would freeze the window, so it runs in
 * a `utilityProcess` that opens the *same* workspace path with its own
 * `@kumi/core` connection (WAL keeps main's reader alive throughout) and talks
 * back over these two message unions.
 */
import type { ImportPlanSummary, ImportProgress, ImportReport } from "@kumi/core";
import type { KumiErrorShape } from "./ipc";

/** Parent → child. Exactly one request per child; the child exits afterwards. */
export type ImportChildRequest =
  | { kind: "plan"; workspacePath: string; sourcePath: string }
  | { kind: "run"; workspacePath: string; sourcePath: string };

/** Child → parent. `plan`, `done` and `error` are terminal. */
export type ImportChildMessage =
  | { kind: "progress"; progress: ImportProgress }
  | { kind: "plan"; summary: ImportPlanSummary }
  | { kind: "done"; report: ImportReport }
  | { kind: "error"; error: KumiErrorShape };

export function isChildMessage(value: unknown): value is ImportChildMessage {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "progress" || kind === "plan" || kind === "done" || kind === "error";
}
