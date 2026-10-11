import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createCommands, openWorkspaceDb, withTransaction, type Db } from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

const dirs: string[] = [];

function rawDb(): Db {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-raw-"));
  dirs.push(dir);
  return openWorkspaceDb(dir);
}

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function scalar(db: Db, sql: string): unknown {
  const row = db.prepare(sql).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

describe("connection setup", () => {
  it("enables WAL, foreign keys and a busy timeout", () => {
    const db = rawDb();
    try {
      expect(scalar(db, "PRAGMA journal_mode")).toBe("wal");
      expect(scalar(db, "PRAGMA foreign_keys")).toBe(1);
      expect(scalar(db, "PRAGMA busy_timeout")).toBe(5000);
    } finally {
      db.close();
    }
  });

  it("provides FTS5", () => {
    const db = rawDb();
    try {
      expect(scalar(db, "SELECT sqlite_compileoption_used('ENABLE_FTS5')")).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("withTransaction", () => {
  it("commits on return and rolls back on throw", () => {
    const db = rawDb();
    try {
      const commands = createCommands(db);
      const kept = withTransaction(db, () => commands.createPage({ title: "Kept" }));
      expect(commands.getPage(kept.id)?.title).toBe("Kept");

      expect(() =>
        withTransaction(db, () => {
          commands.createPage({ id: "rolled-back", title: "Gone" });
          throw new Error("boom");
        }),
      ).toThrowError("boom");

      expect(commands.getPage("rolled-back")).toBeNull();
      expect(db.isTransaction).toBe(false);
      // The connection is still usable afterwards.
      expect(commands.createPage({ title: "After" }).title).toBe("After");
    } finally {
      db.close();
    }
  });

  it("nests: an inner failure rolls back only the inner work", () => {
    const db = rawDb();
    try {
      const commands = createCommands(db);
      withTransaction(db, () => {
        commands.createPage({ id: "outer", title: "Outer" });
        expect(() =>
          withTransaction(db, () => {
            commands.createPage({ id: "inner", title: "Inner" });
            throw new Error("inner failed");
          }),
        ).toThrowError("inner failed");
      });

      expect(commands.getPage("outer")?.title).toBe("Outer");
      expect(commands.getPage("inner")).toBeNull();
      expect(db.isTransaction).toBe(false);
    } finally {
      db.close();
    }
  });

  it("lets a caller wrap several commands into one atomic unit", () => {
    const db = rawDb();
    try {
      const commands = createCommands(db);
      expect(() =>
        withTransaction(db, () => {
          const page = commands.createPage({ id: "batch", title: "Batch" });
          commands.updatePage(page.id, { title: "Renamed" });
          commands.createPage({ parentId: page.id, title: "Child" });
          throw new Error("abort");
        }),
      ).toThrowError("abort");

      expect(commands.getPage("batch")).toBeNull();
      expect(commands.listRootPages()).toEqual([]);
      expect(commands.search("Renamed")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("command atomicity", () => {
  it("leaves no partial page behind when creation fails", () => {
    const c = tempWorkspace().commands;
    const parent = c.createPage({ title: "Parent" });
    const stranger = c.createPage({ title: "Stranger" });

    expect(() =>
      c.createPage({
        id: "half-made",
        parentId: parent.id,
        afterPageId: stranger.id,
      }),
    ).toThrow();

    expect(c.getPage("half-made")).toBeNull();
    expect(c.listChildren(parent.id)).toEqual([]);
  });
});
