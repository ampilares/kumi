/**
 * The import worker. Bundled as a second main-process entry (`out/main/
 * importChild.js`) and launched by `importRunner.ts` with
 * `utilityProcess.fork` — an Electron Node process, so the same
 * `better-sqlite3` binary the main process uses loads without a rebuild.
 *
 * It handles exactly one request, then exits. Everything it can go wrong with
 * (core missing, workspace locked, a corrupt archive) is reported as an
 * `error` message rather than a crash, so the hub can show a readable card.
 */
import type { ImportProgress, KumiCommands } from "@kumi/core";
import type { ImportChildMessage, ImportChildRequest } from "../shared/importProtocol";

interface WorkspaceHandle {
  commands: KumiCommands;
  close(): void;
}

interface CoreModule {
  openWorkspace(path: string): WorkspaceHandle;
}

/**
 * `process.parentPort` only exists inside a utility process. Typing it locally
 * keeps this file honest about that instead of leaning on an ambient global.
 */
interface ParentPort {
  on(channel: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

/** Give the message port a beat to flush before the process disappears. */
const EXIT_DELAY_MS = 200;

function send(message: ImportChildMessage): void {
  parentPort?.postMessage(message);
}

function toError(code: string, err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    const existing = (err as Error & { code?: unknown }).code;
    return {
      code: typeof existing === "string" ? existing : code,
      message: err.message,
    };
  }
  return { code, message: String(err) };
}

function handle(request: ImportChildRequest): void {
  let workspace: WorkspaceHandle | null = null;
  try {
    // Runtime require: @kumi/core is external to this bundle and may be
    // unbuilt, exactly as in `main/workspace.ts`.
    const core = require("@kumi/core") as CoreModule;
    if (typeof core?.openWorkspace !== "function") {
      send({
        kind: "error",
        error: { code: "CORE_INCOMPLETE", message: "@kumi/core does not export openWorkspace(path)." },
      });
      return;
    }

    workspace = core.openWorkspace(request.workspacePath);
    const commands = workspace.commands;

    if (request.kind === "plan") {
      if (typeof commands.planNotionImport !== "function") {
        send({
          kind: "error",
          error: { code: "IMPORT_UNAVAILABLE", message: "This build of @kumi/core cannot plan Notion imports yet." },
        });
        return;
      }
      send({ kind: "plan", summary: commands.planNotionImport(request.sourcePath) });
      return;
    }

    if (typeof commands.runNotionImport !== "function") {
      send({
        kind: "error",
        error: { code: "IMPORT_UNAVAILABLE", message: "This build of @kumi/core cannot run Notion imports yet." },
      });
      return;
    }
    const report = commands.runNotionImport(request.sourcePath, {
      onProgress: (progress: ImportProgress) => send({ kind: "progress", progress }),
    });
    send({ kind: "done", report });
  } catch (err) {
    send({ kind: "error", error: toError("IMPORT_FAILED", err) });
  } finally {
    try {
      workspace?.close();
    } catch {
      /* the process is going away anyway */
    }
    setTimeout(() => process.exit(0), EXIT_DELAY_MS);
  }
}

if (parentPort) {
  parentPort.on("message", (event) => {
    const request = event.data as ImportChildRequest;
    if (request && (request.kind === "plan" || request.kind === "run")) handle(request);
  });
} else {
  // Started outside a utility process — nothing can hear us; fail loudly.
  console.error("[kumi] importChild started without a parent port");
  process.exit(1);
}
