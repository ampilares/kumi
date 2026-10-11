/**
 * Child-process supervisor for Notion imports.
 *
 * Both entry points fork `importChild.js`, hand it one request and wait. Plan
 * is a promise; run is fire-and-forget with callbacks, because a 5 GB archive
 * can occupy the child for minutes and the renderer must stay live the whole
 * time. Main's own database connection is left open on purpose: WAL lets it
 * keep serving reads while the child holds the write lock.
 *
 * Only one run at a time — two concurrent imports would just fight over that
 * lock, and the hub has no sane way to show a race.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import type { ImportPlanSummary, ImportProgress, ImportReport } from "@kumi/core";
import { isChildMessage, type ImportChildRequest } from "../shared/importProtocol";
import type { KumiErrorShape } from "../shared/ipc";

export class ImportError extends Error {
  readonly code: string;

  constructor(shape: KumiErrorShape) {
    super(shape.message);
    this.name = "ImportError";
    this.code = shape.code;
  }
}

function childPath(): string {
  return join(__dirname, "importChild.js");
}

function fork(): UtilityProcess {
  return utilityProcess.fork(childPath(), [], {
    serviceName: "kumi-import",
    // Inherit so a crash inside core surfaces in the terminal during dev.
    stdio: "inherit",
  });
}

export function planImport(workspacePath: string, sourcePath: string): Promise<ImportPlanSummary> {
  return new Promise<ImportPlanSummary>((resolve, reject) => {
    let settled = false;
    const child = fork();

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    };

    child.on("spawn", () => child.postMessage({ kind: "plan", workspacePath, sourcePath }));
    child.on("message", (raw: unknown) => {
      if (!isChildMessage(raw)) return;
      if (raw.kind === "plan") finish(() => resolve(raw.summary));
      else if (raw.kind === "error") finish(() => reject(new ImportError(raw.error)));
    });
    child.on("exit", (code: number) =>
      finish(() =>
        reject(
          new ImportError({
            code: "IMPORT_CHILD_EXIT",
            message: `The import worker exited before it could read that export (code ${code}).`,
          }),
        ),
      ),
    );
  });
}

export interface RunHooks {
  onProgress(progress: ImportProgress): void;
  /** Exactly one argument is non-null. Called once. */
  onDone(report: ImportReport | null, error: KumiErrorShape | null): void;
}

let active: { jobId: string; child: UtilityProcess } | null = null;

export function isImportRunning(): boolean {
  return active !== null;
}

/**
 * Starts an import and returns its job handle immediately. The handle is a
 * main-side id: core's own job id only exists once the run commits, and the
 * renderer needs something to tag progress with from the first millisecond.
 */
export function startImport(workspacePath: string, sourcePath: string, hooks: RunHooks): string {
  if (active) {
    throw new ImportError({
      code: "IMPORT_BUSY",
      message: "Another import is already running. Wait for it to finish first.",
    });
  }

  const jobId = randomUUID();
  const child = fork();
  active = { jobId, child };
  let settled = false;

  const finish = (report: ImportReport | null, error: KumiErrorShape | null): void => {
    if (settled) return;
    settled = true;
    active = null;
    hooks.onDone(report, error);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  };

  child.on("spawn", () => child.postMessage({ kind: "run", workspacePath, sourcePath }));

  child.on("message", (raw: unknown) => {
    if (!isChildMessage(raw)) return;
    if (raw.kind === "progress") hooks.onProgress(raw.progress);
    else if (raw.kind === "done") finish(raw.report, null);
    else if (raw.kind === "error") finish(null, raw.error);
  });

  child.on("exit", (code: number) =>
    finish(null, {
      code: "IMPORT_CHILD_EXIT",
      message: `The import worker stopped unexpectedly (code ${code}). Nothing was committed.`,
    }),
  );

  return jobId;
}

/** Best-effort teardown on quit so a run never outlives the app. */
export function stopImport(): void {
  const current = active;
  active = null;
  try {
    current?.child.kill();
  } catch {
    /* shutting down anyway */
  }
}

export type { ImportChildRequest };
