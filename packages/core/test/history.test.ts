import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { KumiError, rankBetween, type BlockOp, type KumiCommands } from "../src";
import { cleanupWorkspaces, tempWorkspace, type TestWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

let opCounter = 0;
const opId = (): string => `hist-op-${++opCounter}`;

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

function insertOp(
  pageId: string,
  id: string,
  rank: string,
  text: string,
  href?: string,
): BlockOp {
  return {
    opId: opId(),
    kind: "insert",
    block: {
      id,
      pageId,
      parentBlockId: null,
      rank,
      type: "paragraph",
      payload: { richText: [{ type: "text", text, ...(href === undefined ? {} : { href }) }] },
    },
  };
}

/**
 * Age every snapshot of the workspace by `ms`. A second connection is the
 * cheapest clock injection available: the auto-snapshot gate only ever reads
 * `created_at`, so moving the rows back is indistinguishable from waiting.
 */
function backdateSnapshots(w: TestWorkspace, ms: number): void {
  const db = new DatabaseSync(path.join(w.dir, "kumi.db"));
  db.exec(`UPDATE page_snapshots SET created_at = created_at - ${ms}`);
  db.close();
}

function snapshotCount(w: TestWorkspace, pageId: string): number {
  return w.commands.listSnapshots(pageId).length;
}

describe("snapshotPage", () => {
  it("captures the page's title, icon and live block tree", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "Notes", icon: "📓" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([insertOp(page.id, "h-b1", r1, "hello")]);

    const meta = c.snapshotPage(page.id);
    expect(meta.pageId).toBe(page.id);
    expect(meta.cause).toBe("manual");

    const snapshot = c.getSnapshot(meta.id);
    expect(snapshot.title).toBe("Notes");
    expect(snapshot.icon).toBe("📓");
    expect(snapshot.blocks.map((b) => b.id)).toEqual(
      c.getBlocks(page.id).map((b) => b.id),
    );
  });

  it("rejects an unknown page", () => {
    const c: KumiCommands = ws().commands;
    expect(codeOf(() => c.snapshotPage("nope"))).toBe("not_found");
  });

  it("prunes a page's history to the newest 200 entries", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Busy" });

    const ids: string[] = [];
    for (let i = 0; i < 205; i += 1) ids.push(c.snapshotPage(page.id).id);

    const kept = c.listSnapshots(page.id);
    expect(kept).toHaveLength(200);
    // The five oldest are the ones that went.
    const keptIds = new Set(kept.map((m) => m.id));
    expect(ids.slice(0, 5).some((id) => keptIds.has(id))).toBe(false);
    expect(ids.slice(-200).every((id) => keptIds.has(id))).toBe(true);
  });
});

describe("listSnapshots / getSnapshot", () => {
  it("lists newest first", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "P" });
    const first = c.snapshotPage(page.id);
    const second = c.snapshotPage(page.id);
    const third = c.snapshotPage(page.id);

    expect(c.listSnapshots(page.id).map((m) => m.id)).toEqual([
      third.id,
      second.id,
      first.id,
    ]);
  });

  it("rejects an unknown page and an unknown snapshot", () => {
    const c: KumiCommands = ws().commands;
    expect(codeOf(() => c.listSnapshots("nope"))).toBe("not_found");
    expect(codeOf(() => c.getSnapshot("nope"))).toBe("not_found");
  });
});

describe("restoreSnapshot", () => {
  it("puts the title, icon and blocks back", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "Draft", icon: "✏️" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([insertOp(page.id, "h-r1", r1, "original")]);

    const meta = c.snapshotPage(page.id);

    c.updatePage(page.id, { title: "Changed", icon: "🔥" });
    const block = c.getBlock("h-r1");
    c.applyBlockOps([
      {
        opId: opId(),
        kind: "update",
        blockId: "h-r1",
        baseVersion: block?.version ?? 1,
        patch: { payload: { richText: [{ type: "text", text: "edited" }] } },
      },
      { opId: opId(), kind: "delete", blockId: "h-r1" },
    ]);
    expect(c.getBlock("h-r1")).toBeNull();

    c.restoreSnapshot(meta.id);

    const restored = c.getPage(page.id);
    expect(restored?.title).toBe("Draft");
    expect(restored?.icon).toBe("✏️");
    const texts = c
      .getBlocks(page.id)
      .map((b) => (b.payload.richText ?? []).map((s) => (s.type === "text" ? s.text : "")).join(""));
    expect(texts).toContain("original");
  });

  it("snapshots the pre-restore state first, so a restore is undoable", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "One" });
    const target = c.snapshotPage(page.id);
    c.updatePage(page.id, { title: "Two" });

    c.restoreSnapshot(target.id);
    expect(c.getPage(page.id)?.title).toBe("One");

    const history = c.listSnapshots(page.id);
    const newest = history[0];
    expect(newest?.cause).toBe("restore");
    // …and the "restore" entry holds the state we just left behind.
    expect(c.getSnapshot(newest?.id ?? "").title).toBe("Two");

    c.restoreSnapshot(newest?.id ?? "");
    expect(c.getPage(page.id)?.title).toBe("Two");
  });

  it("keeps block ids, so links and backlinks survive", () => {
    const c: KumiCommands = ws().commands;
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([
      insertOp(source.id, "h-link", r1, "see", `kumi://page/${target.id}`),
    ]);
    expect(c.getBacklinks(target.id).map((b) => b.sourceBlockId)).toEqual(["h-link"]);

    const meta = c.snapshotPage(source.id);
    c.applyBlockOps([{ opId: opId(), kind: "delete", blockId: "h-link" }]);
    expect(c.getBacklinks(target.id)).toEqual([]);

    c.restoreSnapshot(meta.id);
    expect(c.getBlock("h-link")?.id).toBe("h-link");
    expect(c.getBacklinks(target.id).map((b) => b.sourceBlockId)).toEqual(["h-link"]);
  });

  it("bumps block versions past whatever the live rows were at", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "P" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([insertOp(page.id, "h-v1", r1, "v1")]);
    const meta = c.snapshotPage(page.id);

    for (let i = 0; i < 3; i += 1) {
      const current = c.getBlock("h-v1");
      c.applyBlockOps([
        {
          opId: opId(),
          kind: "update",
          blockId: "h-v1",
          baseVersion: current?.version ?? 1,
          patch: { payload: { richText: [{ type: "text", text: `v${i}` }] } },
        },
      ]);
    }
    const before = c.getBlock("h-v1")?.version ?? 0;
    expect(before).toBeGreaterThan(1);

    c.restoreSnapshot(meta.id);
    expect(c.getBlock("h-v1")?.version ?? 0).toBeGreaterThan(before);
  });

  it("refuses a locked page and a trashed page", () => {
    const c: KumiCommands = ws().commands;
    const locked = c.createPage({ title: "Locked" });
    const lockedSnapshot = c.snapshotPage(locked.id);
    c.updatePage(locked.id, { locked: true });
    expect(codeOf(() => c.restoreSnapshot(lockedSnapshot.id))).toBe("locked");

    const trashed = c.createPage({ title: "Trashed" });
    const trashedSnapshot = c.snapshotPage(trashed.id);
    c.trashPage(trashed.id);
    expect(codeOf(() => c.restoreSnapshot(trashedSnapshot.id))).toBe("invalid");
  });

  it("rejects an unknown snapshot", () => {
    const c: KumiCommands = ws().commands;
    expect(codeOf(() => c.restoreSnapshot("nope"))).toBe("not_found");
  });

  it("reindexes search from the restored content", () => {
    const c: KumiCommands = ws().commands;
    const page = c.createPage({ title: "Searchable" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([insertOp(page.id, "h-s1", r1, "kingfisher")]);
    const meta = c.snapshotPage(page.id);

    c.applyBlockOps([{ opId: opId(), kind: "delete", blockId: "h-s1" }]);
    expect(c.search("kingfisher")).toEqual([]);

    c.restoreSnapshot(meta.id);
    expect(c.search("kingfisher").map((r) => r.pageId)).toEqual([page.id]);
  });
});

describe("auto-snapshot inside applyBlockOps", () => {
  it("captures the pre-edit state when the page has no history", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Fresh" });
    const scaffold = c.getBlocks(page.id).map((b) => b.id);

    c.applyBlockOps([insertOp(page.id, "h-a1", rankBetween(null, null), "new")]);

    const history = c.listSnapshots(page.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.cause).toBe("auto");
    // The snapshot predates the op it was taken for.
    expect(c.getSnapshot(history[0]?.id ?? "").blocks.map((b) => b.id)).toEqual(
      scaffold,
    );
  });

  it("takes at most one snapshot per page per batch", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Batch" });
    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    const r3 = rankBetween(r2, null);

    c.applyBlockOps([
      insertOp(page.id, "h-c1", r1, "one"),
      insertOp(page.id, "h-c2", r2, "two"),
      insertOp(page.id, "h-c3", r3, "three"),
    ]);
    expect(snapshotCount(w, page.id)).toBe(1);
  });

  it("does not take another one inside the ten-minute window", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Quiet" });

    c.applyBlockOps([insertOp(page.id, "h-w1", rankBetween(null, null), "one")]);
    expect(snapshotCount(w, page.id)).toBe(1);

    backdateSnapshots(w, 9 * 60 * 1000);
    c.applyBlockOps([insertOp(page.id, "h-w2", rankBetween(null, null), "two")]);
    expect(snapshotCount(w, page.id)).toBe(1);
  });

  it("takes another one once the newest is older than ten minutes", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Long session" });

    c.applyBlockOps([insertOp(page.id, "h-l1", rankBetween(null, null), "one")]);
    backdateSnapshots(w, 11 * 60 * 1000);
    c.applyBlockOps([insertOp(page.id, "h-l2", rankBetween(null, null), "two")]);

    const history = c.listSnapshots(page.id);
    expect(history).toHaveLength(2);
    expect(history.map((m) => m.cause)).toEqual(["auto", "auto"]);
    // The newer one already contains the first edit.
    expect(c.getSnapshot(history[0]?.id ?? "").blocks.map((b) => b.id)).toContain(
      "h-l1",
    );
  });

  it("snapshots each affected page separately", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const first = c.createPage({ title: "A" });
    const second = c.createPage({ title: "B" });

    c.applyBlockOps([
      insertOp(first.id, "h-m1", rankBetween(null, null), "a"),
      insertOp(second.id, "h-m2", rankBetween(null, null), "b"),
    ]);
    expect(snapshotCount(w, first.id)).toBe(1);
    expect(snapshotCount(w, second.id)).toBe(1);
  });

  it("leaves locked and trashed pages alone", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Locked" });
    c.updatePage(page.id, { locked: true });

    const result = c.applyBlockOps([
      insertOp(page.id, "h-x1", rankBetween(null, null), "nope"),
    ]);
    expect(result.rejected[0]?.reason).toBe("invalid");
    expect(snapshotCount(w, page.id)).toBe(0);
  });
});
