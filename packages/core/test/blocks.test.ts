import { afterAll, describe, expect, it } from "vitest";
import {
  rankBetween,
  type BlockOp,
  type BlockType,
  type KumiCommands,
} from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

function ws(): KumiCommands {
  return tempWorkspace().commands;
}

let opCounter = 0;
const opId = (): string => `op-${++opCounter}`;

function insertOp(
  pageId: string,
  id: string,
  rank: string,
  parentBlockId: string | null = null,
  text = "",
): BlockOp {
  return {
    opId: opId(),
    kind: "insert",
    block: {
      id,
      pageId,
      parentBlockId,
      rank,
      type: "paragraph",
      payload: { richText: [{ type: "text", text }] },
    },
  };
}

describe("getBlocks", () => {
  it("returns the tree depth-first by (parent, rank)", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const first = c.getBlocks(page.id)[0]?.id ?? "";

    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    const result = c.applyBlockOps([
      insertOp(page.id, "b1", r1, null, "one"),
      insertOp(page.id, "b1a", r1, "b1", "one-a"),
      insertOp(page.id, "b1b", r2, "b1", "one-b"),
      insertOp(page.id, "b2", r2, null, "two"),
      insertOp(page.id, "b1a1", r1, "b1a", "deep"),
    ]);
    expect(result.rejected).toEqual([]);

    const ids = c.getBlocks(page.id).map((b) => b.id);
    // The page's original paragraph sorts by its own rank among the roots.
    expect(ids.filter((id) => id !== first)).toEqual([
      "b1",
      "b1a",
      "b1a1",
      "b1b",
      "b2",
    ]);
  });

  it("hydrates payloads and flags", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    c.applyBlockOps([insertOp(page.id, "b1", rankBetween(null, null), null, "hi")]);
    const block = c.getBlocks(page.id).find((b) => b.id === "b1");
    expect(block?.pageId).toBe(page.id);
    expect(block?.archived).toBe(false);
    expect(block?.version).toBe(1);
    expect(block?.payload).toEqual({ richText: [{ type: "text", text: "hi" }] });
    expect(block?.createdAt).toBeTypeOf("number");
  });
});

describe("getBlock", () => {
  it("returns one live block, hydrated like getBlocks", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    c.applyBlockOps([insertOp(page.id, "b1", rankBetween(null, null), null, "hi")]);

    const block = c.getBlock("b1");
    expect(block).toEqual(c.getBlocks(page.id).find((b) => b.id === "b1"));
    expect(block?.payload).toEqual({ richText: [{ type: "text", text: "hi" }] });
  });

  it("returns null for an unknown id", () => {
    expect(ws().getBlock("nope")).toBeNull();
  });

  it("returns null for an archived block", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([
      insertOp(page.id, "a", r1),
      insertOp(page.id, "a1", r1, "a"),
    ]);
    c.applyBlockOps([{ opId: opId(), kind: "delete", blockId: "a" }]);

    expect(c.getBlock("a")).toBeNull();
    // The archived descendant is invisible too.
    expect(c.getBlock("a1")).toBeNull();
  });

  it("returns null for a block on a trashed page, and again after restore", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ parentId: root.id, title: "Child" });
    c.applyBlockOps([insertOp(child.id, "b", rankBetween(null, null), null, "x")]);

    c.trashPage(root.id);
    expect(c.getBlock("b")).toBeNull();

    c.restorePage(root.id);
    expect(c.getBlock("b")?.id).toBe("b");
  });
});

describe("applyBlockOps", () => {
  it("is idempotent per opId across retries", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const op = insertOp(page.id, "b1", rankBetween(null, null), null, "once");

    const first = c.applyBlockOps([op]);
    const second = c.applyBlockOps([op]);
    expect(first.applied).toEqual([op.opId]);
    expect(second.applied).toEqual([op.opId]);
    expect(second.rejected).toEqual([]);
    expect(c.getBlocks(page.id).filter((b) => b.id === "b1")).toHaveLength(1);
  });

  it("deduplicates a repeated opId inside one batch", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const op = insertOp(page.id, "b1", rankBetween(null, null));
    const result = c.applyBlockOps([op, op]);
    expect(result.applied).toEqual([op.opId, op.opId]);
    expect(result.rejected).toEqual([]);
  });

  it("bumps the block version and the page timestamp on every applied op", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const blockId = c.getBlocks(page.id)[0]?.id ?? "";
    const before = c.getPage(page.id)?.updatedAt ?? 0;

    c.applyBlockOps([
      {
        opId: opId(),
        kind: "update",
        blockId,
        baseVersion: 1,
        patch: { type: "heading1", payload: { richText: [{ type: "text", text: "H" }] } },
      },
    ]);
    const updated = c.getBlocks(page.id)[0];
    expect(updated?.version).toBe(2);
    expect(updated?.type).toBe("heading1");
    expect(c.getPage(page.id)?.updatedAt).toBeGreaterThanOrEqual(before);

    c.applyBlockOps([
      {
        opId: opId(),
        kind: "update",
        blockId,
        baseVersion: 2,
        patch: { payload: { richText: [{ type: "text", text: "H2" }] } },
      },
    ]);
    const again = c.getBlocks(page.id)[0];
    expect(again?.version).toBe(3);
    expect(again?.type).toBe("heading1");
  });

  it("rejects stale updates with a conflict and leaves the block untouched", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const blockId = c.getBlocks(page.id)[0]?.id ?? "";
    c.applyBlockOps([
      {
        opId: opId(),
        kind: "update",
        blockId,
        baseVersion: 1,
        patch: { payload: { richText: [{ type: "text", text: "winner" }] } },
      },
    ]);

    const stale: BlockOp = {
      opId: opId(),
      kind: "update",
      blockId,
      baseVersion: 1,
      patch: { payload: { richText: [{ type: "text", text: "loser" }] } },
    };
    const result = c.applyBlockOps([stale]);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([
      { opId: stale.opId, reason: "conflict", message: expect.any(String) },
    ]);
    expect(c.getBlocks(page.id)[0]?.payload).toEqual({
      richText: [{ type: "text", text: "winner" }],
    });
    // A rejected op is not recorded, so a corrected retry with the same opId works.
    const retry = c.applyBlockOps([{ ...stale, baseVersion: 2 }]);
    expect(retry.applied).toEqual([stale.opId]);
  });

  it("applies what it can and reports the rest", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const good = insertOp(page.id, "ok", rankBetween(null, null), null, "kept");
    const missingBlock: BlockOp = {
      opId: opId(),
      kind: "update",
      blockId: "nope",
      baseVersion: 1,
      patch: { payload: {} },
    };
    const badPage = insertOp("no-such-page", "x", rankBetween(null, null));
    const badRank: BlockOp = {
      opId: opId(),
      kind: "insert",
      block: {
        id: "y",
        pageId: page.id,
        parentBlockId: null,
        rank: "!!!",
        type: "paragraph",
        payload: {},
      },
    };

    const result = c.applyBlockOps([good, missingBlock, badPage, badRank]);
    expect(result.applied).toEqual([good.opId]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "not_found",
      "not_found",
      "invalid",
    ]);
    expect(c.getBlocks(page.id).some((b) => b.id === "ok")).toBe(true);
    expect(c.getBlocks(page.id).some((b) => b.id === "y")).toBe(false);
  });

  it("rejects duplicate block ids, unknown types and foreign parents", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const other = c.createPage({ title: "Other" });
    const rank = rankBetween(null, null);
    c.applyBlockOps([insertOp(page.id, "b1", rank)]);

    const dup = insertOp(page.id, "b1", rank);
    const foreignParent = insertOp(other.id, "b2", rank, "b1");
    const unknownType: BlockOp = {
      opId: opId(),
      kind: "insert",
      block: {
        id: "b3",
        pageId: page.id,
        parentBlockId: null,
        rank,
        type: "not_a_block" as unknown as BlockType,
        payload: {},
      },
    };

    const result = c.applyBlockOps([dup, foreignParent, unknownType]);
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "invalid",
      "invalid",
      "invalid",
    ]);
  });

  it("moves blocks between parents and rejects block cycles", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    c.applyBlockOps([
      insertOp(page.id, "a", r1),
      insertOp(page.id, "b", r2),
      insertOp(page.id, "a1", r1, "a"),
    ]);

    const moved = c.applyBlockOps([
      { opId: opId(), kind: "move", blockId: "a1", parentBlockId: "b", rank: r1 },
    ]);
    expect(moved.rejected).toEqual([]);
    expect(c.getBlocks(page.id).find((x) => x.id === "a1")?.parentBlockId).toBe("b");
    expect(c.getBlocks(page.id).find((x) => x.id === "a1")?.version).toBe(2);

    const cycles = c.applyBlockOps([
      { opId: opId(), kind: "move", blockId: "b", parentBlockId: "a1", rank: r1 },
      { opId: opId(), kind: "move", blockId: "b", parentBlockId: "b", rank: r1 },
    ]);
    expect(cycles.applied).toEqual([]);
    expect(cycles.rejected.map((r) => r.reason)).toEqual(["invalid", "invalid"]);
  });

  it("archives a deleted block together with its descendants", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const r1 = rankBetween(null, null);
    c.applyBlockOps([
      insertOp(page.id, "a", r1),
      insertOp(page.id, "a1", r1, "a"),
      insertOp(page.id, "a1x", r1, "a1"),
    ]);
    expect(c.getBlocks(page.id)).toHaveLength(4);

    const result = c.applyBlockOps([{ opId: opId(), kind: "delete", blockId: "a" }]);
    expect(result.rejected).toEqual([]);
    expect(c.getBlocks(page.id).map((b) => b.id)).not.toContain("a1x");
    expect(c.getBlocks(page.id)).toHaveLength(1);

    // Operating on an archived block is a not_found.
    const after = c.applyBlockOps([
      { opId: opId(), kind: "delete", blockId: "a1" },
    ]);
    expect(after.rejected.map((r) => r.reason)).toEqual(["not_found"]);
  });

  it("refuses every block op on a locked page", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    const blockId = c.getBlocks(page.id)[0]?.id ?? "";
    c.updatePage(page.id, { locked: true });

    const result = c.applyBlockOps([
      insertOp(page.id, "new", rankBetween(null, null)),
      {
        opId: opId(),
        kind: "update",
        blockId,
        baseVersion: 1,
        patch: { payload: {} },
      },
      { opId: opId(), kind: "delete", blockId },
    ]);
    expect(result.applied).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(result.rejected[0]?.message).toMatch(/locked/);

    c.updatePage(page.id, { locked: false });
    expect(
      c.applyBlockOps([insertOp(page.id, "new", rankBetween(null, null))]).rejected,
    ).toEqual([]);
  });

  it("refuses block ops on a trashed page", () => {
    const c = ws();
    const page = c.createPage({ title: "P" });
    c.trashPage(page.id);
    const result = c.applyBlockOps([
      insertOp(page.id, "b", rankBetween(null, null)),
    ]);
    expect(result.rejected.map((r) => r.reason)).toEqual(["invalid"]);
  });

  it("accepts an empty batch", () => {
    const c = ws();
    expect(c.applyBlockOps([])).toEqual({ applied: [], rejected: [] });
  });
});
