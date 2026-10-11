/**
 * Stage 1 of the Notion import: turn a `.zip` or an extracted directory into a
 * normalized, hashed file tree.
 *
 * A zip is extracted into a fresh directory under the OS temp folder before
 * anything reads it, under three hard limits — path traversal ("zip slip"),
 * total uncompressed bytes, and entry count. All three fail loudly with a
 * `KumiError("invalid")` rather than writing a single byte outside the
 * extraction root.
 *
 * The `sourceHash` is what makes an import idempotent:
 * - zip: SHA-256 of the archive bytes;
 * - directory: SHA-256 of `<relative path>\0<size>\0<mtimeMs>` lines, sorted,
 *   which changes whenever a file is added, removed, resized or touched.
 */

import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { invalid } from "../errors";

/** Maximum total uncompressed size of an archive (build plan: 5 GB ZIPs). */
export const MAX_TOTAL_BYTES = 5 * 1024 * 1024 * 1024;

/** Maximum number of files an archive may expand to. */
export const MAX_FILE_COUNT = 100_000;

export interface SourceFile {
  /** Path relative to the export root, POSIX separators. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
  size: number;
}

/** Overridable safety limits; the defaults are the constants above. */
export interface IngestLimits {
  maxBytes?: number;
  maxFiles?: number;
}

export interface IngestResult {
  /** Absolute path of the export root (a temp dir for zip sources). */
  root: string;
  /** Every file in the tree, sorted by `rel`. Directories are not listed. */
  files: SourceFile[];
  sourceHash: string;
  /** The path the caller named, echoed into the plan/report. */
  sourcePath: string;
  /** Remove the temp extraction directory; a no-op for directory sources. */
  cleanup(): void;
}

/** Notion names every exported file `<Title> <32 hex>.<ext>`. */
const ID_SUFFIX = /[ _-]([0-9a-f]{32})$/i;

/**
 * The 32-hex Notion id at the end of a file or folder name, lowercased, or
 * null when the name carries none.
 */
export function notionIdOf(name: string): string | null {
  const base = name.replace(/\.[^.]*$/, "").replace(/_all$/, "");
  const match = ID_SUFFIX.exec(base);
  return match?.[1] === undefined ? null : match[1].toLowerCase();
}

/** The human title part of a Notion export name (id and extension removed). */
export function notionTitleOf(name: string): string {
  const base = name.replace(/\.[^.]*$/, "").replace(/_all$/, "");
  return base.replace(ID_SUFFIX, "").trim();
}

function listFilesRecursive(root: string, maxFiles: number): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(abs, rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (out.length >= maxFiles) {
        throw invalid(`Notion export has more than ${maxFiles} files; refusing to import`);
      }
      out.push({ rel, abs, size: fs.statSync(abs).size });
    }
  };
  walk(root, "");
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return out;
}

function hashDirectory(files: SourceFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    const mtime = Math.trunc(fs.statSync(file.abs).mtimeMs);
    hash.update(`${file.rel}\0${file.size}\0${mtime}\n`);
  }
  return hash.digest("hex");
}

/**
 * Notion wraps its export in a single `Export-<uuid>/` folder. When `root`
 * holds exactly one entry and that entry is a directory, that directory is the
 * real export root.
 */
function unwrapSingleDirectory(root: string): string {
  let current = root;
  for (let depth = 0; depth < 4; depth += 1) {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only === undefined || !only.isDirectory()) return current;
    current = path.join(current, only.name);
  }
  return current;
}

/**
 * Reject an entry whose resolved destination escapes `root` — the zip-slip
 * attack, where an entry is named `../../evil.txt`.
 */
function safeDestination(root: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw invalid(`zip entry has an absolute path: ${entryName}`);
  }
  const dest = path.resolve(root, normalized);
  const prefix = path.resolve(root) + path.sep;
  if (dest !== path.resolve(root) && !dest.startsWith(prefix)) {
    throw invalid(`zip entry escapes the extraction directory: ${entryName}`);
  }
  return dest;
}

function extractZip(
  zipPath: string,
  maxBytes: number,
  maxFiles: number,
): { root: string; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-notion-"));
  const cleanup = (): void => {
    fs.rmSync(root, { recursive: true, force: true });
  };
  try {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
      const dest = safeDestination(root, entry.entryName);
      if (entry.isDirectory) {
        fs.mkdirSync(dest, { recursive: true });
        continue;
      }
      files += 1;
      if (files > maxFiles) {
        throw invalid(`Notion export has more than ${maxFiles} files; refusing to import`);
      }
      // Trust the declared size only as a first gate; the written bytes are
      // counted too, so a lying header cannot get past the cap either.
      bytes += entry.header.size;
      if (bytes > maxBytes) {
        throw invalid(
          `Notion export expands to more than ${maxBytes} bytes; refusing to import`,
        );
      }
      const content = entry.getData();
      bytes += Math.max(0, content.byteLength - entry.header.size);
      if (bytes > maxBytes) {
        throw invalid(
          `Notion export expands to more than ${maxBytes} bytes; refusing to import`,
        );
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
    }
    return { root, cleanup };
  } catch (error) {
    cleanup();
    if (error instanceof Error && error.name === "KumiError") throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw invalid(`cannot read Notion export ${zipPath}: ${message}`);
  }
}

/**
 * Read `sourcePath` (a `.zip` archive or an extracted export directory) and
 * return its file tree plus the hash that identifies this import.
 *
 * Callers must call `cleanup()` when done: for a zip source it removes the temp
 * extraction directory.
 */
export function ingestNotionExport(
  sourcePath: string,
  limits?: IngestLimits,
): IngestResult {
  const maxBytes = limits?.maxBytes ?? MAX_TOTAL_BYTES;
  const maxFiles = limits?.maxFiles ?? MAX_FILE_COUNT;
  const abs = path.resolve(sourcePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw invalid(`Notion export not found: ${sourcePath}`);
  }

  if (stat.isDirectory()) {
    const root = unwrapSingleDirectory(abs);
    const files = listFilesRecursive(root, maxFiles);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > maxBytes) {
      throw invalid(`Notion export is larger than ${maxBytes} bytes; refusing to import`);
    }
    return {
      root,
      files,
      sourceHash: hashDirectory(files),
      sourcePath: abs,
      cleanup: () => undefined,
    };
  }

  if (!abs.toLowerCase().endsWith(".zip")) {
    throw invalid(
      `a Notion export must be a .zip archive or an extracted directory: ${sourcePath}`,
    );
  }

  const sourceHash = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  const extracted = extractZip(abs, maxBytes, maxFiles);
  try {
    const root = unwrapSingleDirectory(extracted.root);
    return {
      root,
      files: listFilesRecursive(root, maxFiles),
      sourceHash,
      sourcePath: abs,
      cleanup: extracted.cleanup,
    };
  } catch (error) {
    extracted.cleanup();
    throw error;
  }
}
