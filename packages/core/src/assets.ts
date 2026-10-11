/**
 * The workspace asset store: `<workspace>/assets/` plus the `assets` table.
 *
 * Files are content-addressed. Importing the same bytes twice returns the row
 * that already exists — one copy on disk, however many blocks point at it — so
 * a page duplicated ten times costs ten rows and zero extra bytes.
 *
 * Stored names are `<first 12 hex of the sha256><ext>`: short enough to read in
 * a file listing, wide enough (48 bits) that a collision needs millions of
 * assets, and free of anything the source filename might have smuggled in — the
 * original name is never used as a path component.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assetsDirOf, statement, withTransaction, type Db } from "./db";
import { invalid, notFound } from "./errors";
import type { Asset, Id } from "./types";

/**
 * Extension → MIME. Deliberately small and dependency-free: it covers what the
 * editor can embed, and everything else is a generic download.
 */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

const DEFAULT_MIME = "application/octet-stream";

/** Hex characters of the content hash used in the stored filename. */
const HASH_PREFIX_LENGTH = 12;

/**
 * The lowercased extension of `filename`, or `""` when it has none or the one
 * it has is not a plausible extension (too long, or non-alphanumeric — both
 * signs of a dotted filename rather than a real suffix).
 */
export function extensionOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,12}$/.test(ext) ? ext : "";
}

/** MIME type for an extension as produced by {@link extensionOf}. */
export function mimeForExtension(ext: string): string {
  return MIME_BY_EXTENSION[ext] ?? DEFAULT_MIME;
}

interface AssetRow {
  id: string;
  content_hash: string;
  mime: string;
  size: number;
  path: string;
  created_at: number;
}

function rowToAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    contentHash: row.content_hash,
    mime: row.mime,
    size: row.size,
    path: row.path,
    createdAt: row.created_at,
  };
}

export interface AssetStore {
  importAsset(sourcePath: string, filename?: string): Asset;
  getAsset(id: Id): Asset | null;
  assetAbsolutePath(id: Id): string;
}

/**
 * Build the asset commands bound to an open workspace database. Statements are
 * prepared once and reused for the lifetime of the connection.
 */
export function createAssetStore(db: Db): AssetStore {
  const s = {
    byId: statement<AssetRow>(db, "SELECT * FROM assets WHERE id = ?"),
    byHash: statement<AssetRow>(
      db,
      "SELECT * FROM assets WHERE content_hash = ? ORDER BY created_at LIMIT 1",
    ),
    insert: statement<never>(
      db,
      `INSERT INTO assets (id, content_hash, mime, size, path, created_at)
       VALUES (@id, @content_hash, @mime, @size, @path, @created_at)`,
    ),
  };

  const readSource = (sourcePath: string): Buffer => {
    try {
      return fs.readFileSync(path.resolve(sourcePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw invalid(`cannot read asset source ${sourcePath}: ${message}`);
    }
  };

  const importAsset = (sourcePath: string, filename?: string): Asset =>
    withTransaction(db, () => {
      const content = readSource(sourcePath);
      const contentHash = createHash("sha256").update(content).digest("hex");

      // Same bytes, same asset: no second row and no second copy on disk.
      const existing = s.byHash.get(contentHash);
      if (existing !== undefined) return rowToAsset(existing);

      const ext = extensionOf(filename ?? path.basename(sourcePath));
      const storedName = `${contentHash.slice(0, HASH_PREFIX_LENGTH)}${ext}`;
      const dir = assetsDirOf(db);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, storedName), content);

      const asset: Asset = {
        id: randomUUID(),
        contentHash,
        mime: mimeForExtension(ext),
        size: content.byteLength,
        path: storedName,
        createdAt: Date.now(),
      };
      s.insert.run({
        id: asset.id,
        content_hash: asset.contentHash,
        mime: asset.mime,
        size: asset.size,
        path: asset.path,
        created_at: asset.createdAt,
      });
      return asset;
    });

  const getAsset = (id: Id): Asset | null => {
    const row = s.byId.get(id);
    return row === undefined ? null : rowToAsset(row);
  };

  return {
    importAsset,
    getAsset,
    assetAbsolutePath(id: Id): string {
      const row = s.byId.get(id);
      if (row === undefined) throw notFound("asset", id);
      return path.join(assetsDirOf(db), row.path);
    },
  };
}
