import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KumiError, openWorkspace } from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

describe("openWorkspace", () => {
  it("creates the folder, the database and assets/", () => {
    const dir = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "kumi-open-")),
      "nested",
      "MyWorkspace",
    );
    const ws = openWorkspace(dir);
    try {
      expect(fs.existsSync(path.join(dir, "kumi.db"))).toBe(true);
      expect(fs.existsSync(path.join(dir, "assets"))).toBe(true);
      const info = ws.commands.getWorkspaceInfo();
      expect(info.path).toBe(path.resolve(dir));
      expect(info.name).toBe("MyWorkspace");
      expect(info.icon).toBeNull();
    } finally {
      ws.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reopens an existing workspace without losing data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-reopen-"));
    const first = openWorkspace(dir);
    const page = first.commands.createPage({ title: "Persisted" });
    first.commands.renameWorkspace("Renamed");
    first.close();

    const second = openWorkspace(dir);
    try {
      expect(second.commands.getPage(page.id)?.title).toBe("Persisted");
      expect(second.commands.getWorkspaceInfo().name).toBe("Renamed");
      expect(second.commands.getBlocks(page.id)).toHaveLength(1);
    } finally {
      second.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies each migration exactly once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-migrate-"));
    openWorkspace(dir).close();
    const ws = openWorkspace(dir);
    try {
      // A second open must not re-run migration 001 (CREATE TABLE would fail).
      expect(ws.commands.listRootPages()).toEqual([]);
    } finally {
      ws.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("close() is idempotent", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-close-"));
    const ws = openWorkspace(dir);
    ws.close();
    expect(() => ws.close()).not.toThrow();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("workspace metadata", () => {
  it("renames and sets an icon", () => {
    const { commands } = tempWorkspace();
    commands.renameWorkspace("  AMP  ");
    commands.setWorkspaceIcon("🌱");
    expect(commands.getWorkspaceInfo().name).toBe("AMP");
    expect(commands.getWorkspaceInfo().icon).toBe("🌱");
    commands.setWorkspaceIcon(null);
    expect(commands.getWorkspaceInfo().icon).toBeNull();
  });

  it("rejects an empty name", () => {
    const { commands } = tempWorkspace();
    expect(() => commands.renameWorkspace("   ")).toThrowError(KumiError);
  });
});
