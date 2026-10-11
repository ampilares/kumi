import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KumiError, openWorkspace, type KumiCommands } from "../src";
import { cleanupWorkspaces, tempWorkspace, type TestWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

const sourceDirs: string[] = [];

afterAll(() => {
  for (const dir of sourceDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** Write `content` to a throwaway file named `name` and return its path. */
function sourceFile(name: string, content: string | Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-src-"));
  sourceDirs.push(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function ws(): TestWorkspace {
  return tempWorkspace();
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

function assetsDir(w: TestWorkspace): string {
  return path.join(w.dir, "assets");
}

function assetFiles(w: TestWorkspace): string[] {
  return fs.readdirSync(assetsDir(w)).sort();
}

describe("importAsset", () => {
  it("copies the file into assets/ under a content-derived name", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const file = sourceFile("photo.PNG", "pixels");

    const asset = c.importAsset(file);
    const hash = createHash("sha256").update("pixels").digest("hex");

    expect(asset.contentHash).toBe(hash);
    expect(asset.mime).toBe("image/png");
    expect(asset.size).toBe(6);
    expect(asset.path).toBe(`${hash.slice(0, 12)}.png`);
    expect(assetFiles(w)).toEqual([asset.path]);
    expect(fs.readFileSync(path.join(assetsDir(w), asset.path), "utf8")).toBe(
      "pixels",
    );
    // The source is left alone.
    expect(fs.existsSync(file)).toBe(true);
  });

  it("deduplicates by content: same bytes, same row, one copy on disk", () => {
    const w = ws();
    const c = w.commands;
    const first = c.importAsset(sourceFile("a.png", "same bytes"));
    const second = c.importAsset(sourceFile("b-renamed.png", "same bytes"));

    expect(second).toEqual(first);
    expect(assetFiles(w)).toHaveLength(1);
  });

  it("keeps distinct content apart", () => {
    const w = ws();
    const c = w.commands;
    const first = c.importAsset(sourceFile("a.png", "one"));
    const second = c.importAsset(sourceFile("b.png", "two"));

    expect(second.id).not.toBe(first.id);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(assetFiles(w)).toHaveLength(2);
  });

  it("takes the extension and MIME from `filename` when given", () => {
    const c = ws().commands;
    // A temp upload with no meaningful name plus the real filename beside it.
    const asset = c.importAsset(sourceFile("upload-tmp", "%PDF-"), "Report.PDF");
    expect(asset.mime).toBe("application/pdf");
    expect(asset.path.endsWith(".pdf")).toBe(true);
  });

  it("infers MIME from every known extension and falls back otherwise", () => {
    const c = ws().commands;
    const cases: [string, string][] = [
      ["a.png", "image/png"],
      ["a.jpg", "image/jpeg"],
      ["a.jpeg", "image/jpeg"],
      ["a.gif", "image/gif"],
      ["a.webp", "image/webp"],
      ["a.svg", "image/svg+xml"],
      ["a.pdf", "application/pdf"],
      ["a.mp4", "video/mp4"],
      ["a.webm", "video/webm"],
      ["a.mov", "video/quicktime"],
      ["a.mp3", "audio/mpeg"],
      ["a.wav", "audio/wav"],
      ["a.m4a", "audio/mp4"],
      ["a.ogg", "audio/ogg"],
      ["a.txt", "text/plain"],
      ["a.md", "text/markdown"],
      ["a.weirdext", "application/octet-stream"],
      ["no-extension-at-all", "application/octet-stream"],
    ];
    for (const [name, mime] of cases) {
      // Distinct content per case so nothing dedupes into an earlier row.
      const asset = c.importAsset(sourceFile("src.bin", `bytes-${name}`), name);
      expect(asset.mime, name).toBe(mime);
    }
  });

  it("never uses the source filename as a path component", () => {
    const w = ws();
    const asset = w.commands.importAsset(
      sourceFile("innocent.png", "traversal"),
      "../../escape.png",
    );
    expect(asset.path).not.toContain("/");
    expect(asset.path).not.toContain("\\");
    expect(assetFiles(w)).toEqual([asset.path]);
  });

  it("rejects a missing or unreadable source with `invalid` and the OS message", () => {
    const c = ws().commands;
    const missing = path.join(os.tmpdir(), "kumi-does-not-exist-1234.png");
    expect(codeOf(() => c.importAsset(missing))).toBe("invalid");
    try {
      c.importAsset(missing);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("ENOENT");
    }

    // A directory is readable as a path but not as a file.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-dir-"));
    sourceDirs.push(dir);
    expect(codeOf(() => c.importAsset(dir))).toBe("invalid");
  });
});

describe("getAsset / assetAbsolutePath", () => {
  it("round-trips an imported asset and resolves it on disk", () => {
    const w = ws();
    const c = w.commands;
    const asset = c.importAsset(sourceFile("doc.md", "# hi"));

    expect(c.getAsset(asset.id)).toEqual(asset);
    const abs = c.assetAbsolutePath(asset.id);
    expect(abs).toBe(path.join(assetsDir(w), asset.path));
    expect(path.isAbsolute(abs)).toBe(true);
    expect(fs.readFileSync(abs, "utf8")).toBe("# hi");
  });

  it("returns null / throws not_found for an unknown id", () => {
    const c = ws().commands;
    expect(c.getAsset("nope")).toBeNull();
    expect(codeOf(() => c.assetAbsolutePath("nope"))).toBe("not_found");
  });

  it("survives a reopen of the workspace", () => {
    const w = ws();
    const asset = w.commands.importAsset(sourceFile("keep.txt", "durable"));
    w.close();

    const reopened = openWorkspace(w.dir);
    try {
      const c = reopened.commands;
      expect(c.getAsset(asset.id)).toEqual(asset);
      expect(fs.readFileSync(c.assetAbsolutePath(asset.id), "utf8")).toBe(
        "durable",
      );
      // Re-importing the same bytes still dedupes across sessions.
      expect(c.importAsset(sourceFile("again.txt", "durable")).id).toBe(asset.id);
      expect(assetFiles(w)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
