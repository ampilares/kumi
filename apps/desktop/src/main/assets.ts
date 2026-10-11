/**
 * Asset delivery and import.
 *
 * The renderer never sees a filesystem path. Media blocks reference
 * `kumi-asset://<assetId>`, which this module resolves through
 * `commands.assetAbsolutePath` and streams with `net.fetch(file://…)` — that
 * path (rather than reading the file into a Buffer) is what gives `<video>` and
 * `<audio>` working range requests, so seeking a large file does not load it.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, dialog, net, protocol, shell } from "electron";
import type { Asset } from "@kumi/core";
import {
  ASSET_SCHEME,
  type ImportAssetsRequest,
  type MediaKind,
} from "../shared/ipc";
import { getCommands } from "./workspace";

/**
 * Must run before `app.whenReady()`. `standard` makes `kumi-asset://<id>` parse
 * with the id as the host; `stream` and `supportFetchAPI` let media elements
 * range-request it.
 */
export function registerAssetSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

function assetIdFromUrl(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname !== "" ? url.hostname : url.pathname.replace(/^\/+/, "");
  return decodeURIComponent(host);
}

export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const commands = getCommands();
    if (!commands) return new Response("Workspace not open", { status: 503 });

    let asset: Asset | null;
    let absolute: string;
    try {
      const id = assetIdFromUrl(request.url);
      asset = commands.getAsset(id);
      if (!asset) return new Response("No such asset", { status: 404 });
      absolute = commands.assetAbsolutePath(id);
    } catch (err) {
      return new Response(String(err), { status: 404 });
    }

    // Forwarding the Range header is what makes seeking work.
    const response = await net.fetch(pathToFileURL(absolute).toString(), {
      headers: request.headers,
      method: request.method,
    });
    const headers = new Headers(response.headers);
    if (asset.mime !== "") headers.set("Content-Type", asset.mime);
    headers.set("Cache-Control", "no-cache");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

/* ------------------------------------------------------------------ import */

const FILTERS: Record<MediaKind, Electron.FileFilter[]> = {
  image: [
    { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"] },
    { name: "All files", extensions: ["*"] },
  ],
  video: [
    { name: "Video", extensions: ["mp4", "webm", "mov", "m4v", "ogv"] },
    { name: "All files", extensions: ["*"] },
  ],
  audio: [
    { name: "Audio", extensions: ["mp3", "wav", "m4a", "ogg", "flac", "aac"] },
    { name: "All files", extensions: ["*"] },
  ],
  file: [{ name: "All files", extensions: ["*"] }],
};

/**
 * Copy files into the workspace asset store. With no `paths` it opens the
 * native picker first — that keeps "click the placeholder" a single round trip.
 */
export async function importAssets(request: ImportAssetsRequest): Promise<Asset[]> {
  const commands = getCommands();
  if (!commands) return [];

  let paths = (request.paths ?? []).filter((p) => typeof p === "string" && p !== "");
  if (paths.length === 0) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const options: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
      filters: FILTERS[request.accept ?? "file"],
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    paths = result.filePaths;
  }

  const assets: Asset[] = [];
  for (const path of paths) {
    try {
      assets.push(commands.importAsset(path, basename(path)));
    } catch (err) {
      console.error("[kumi] importAsset failed for", path, err);
    }
  }
  return assets;
}

export async function openAsset(assetId: string): Promise<void> {
  const commands = getCommands();
  if (!commands) return;
  try {
    await shell.openPath(commands.assetAbsolutePath(assetId));
  } catch (err) {
    console.error("[kumi] openPath failed", err);
  }
}
