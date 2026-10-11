/**
 * Adapter around `@kumi/core`.
 *
 * The core package is developed in parallel with this shell, so it is loaded
 * lazily and defensively: if the module is missing, fails to compile, or throws
 * while opening the workspace, the app still boots and the renderer shows an
 * error screen built from `getStatus()`.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KumiCommands } from "@kumi/core";
import type { KumiErrorShape, WorkspaceStatus } from "../shared/ipc";

interface WorkspaceHandle {
  commands: KumiCommands;
  close(): void;
}

interface CoreModule {
  openWorkspace(path: string): WorkspaceHandle;
}

/** `%USERPROFILE%\Kumi` on Windows, `~/Kumi` elsewhere. */
export function defaultWorkspacePath(): string {
  return join(homedir(), "Kumi");
}

let handle: WorkspaceHandle | null = null;
let failure: KumiErrorShape | null = null;
let workspacePath = defaultWorkspacePath();

function toError(code: string, err: unknown): KumiErrorShape {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err);
  return { code, message };
}

/**
 * Opens (or creates) the workspace folder. Never throws — inspect
 * `getStatus()` afterwards.
 */
export function openWorkspaceSafely(path = defaultWorkspacePath()): WorkspaceStatus {
  workspacePath = path;
  handle = null;
  failure = null;

  try {
    mkdirSync(path, { recursive: true });
  } catch (err) {
    failure = toError("WORKSPACE_MKDIR_FAILED", err);
    return getStatus();
  }

  let core: CoreModule;
  try {
    // Runtime require: @kumi/core is externalized, and may not be built yet.
    core = require("@kumi/core") as CoreModule;
  } catch (err) {
    failure = toError("CORE_NOT_AVAILABLE", err);
    return getStatus();
  }

  if (typeof core?.openWorkspace !== "function") {
    failure = {
      code: "CORE_INCOMPLETE",
      message: "@kumi/core loaded but does not export openWorkspace(path).",
    };
    return getStatus();
  }

  try {
    handle = core.openWorkspace(path);
  } catch (err) {
    failure = toError("WORKSPACE_OPEN_FAILED", err);
  }

  return getStatus();
}

export function getCommands(): KumiCommands | null {
  return handle?.commands ?? null;
}

export function getStatus(): WorkspaceStatus {
  return { ready: handle !== null, path: workspacePath, error: failure };
}

export function closeWorkspace(): void {
  try {
    handle?.close();
  } catch {
    /* shutting down anyway */
  }
  handle = null;
}
