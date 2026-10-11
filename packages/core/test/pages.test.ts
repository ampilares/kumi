import { afterAll, describe, expect, it } from "vitest";
import { KumiError, type KumiCommands } from "../src";
import { cleanupWorkspaces, makeRandom, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

function ws(): KumiCommands {
  return tempWorkspace().commands;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

describe("createPage", () => {
  it("creates a root page with one empty paragraph block", () => {
    const c = ws();
    const page = c.createPage({ title: "Home" });
    expect(page.parentId).toBeNull();
    expect(page.title).toBe("Home");
    expect(page.deletedAt).toBeNull();
    expect(page.locked).toBe(false);

    const blocks = c.getBlocks(page.id);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[0]?.payload).toEqual({ richText: [] });
    expect(blocks[0]?.version).toBe(1);
    expect(blocks[0]?.parentBlockId).toBeNull();
  });

  it("honours a caller-supplied id and rejects duplicates", () => {
    const c = ws();
    const page = c.createPage({ id: "fixed-id", title: "A" });
    expect(page.id).toBe("fixed-id");
    expect(codeOf(() => c.createPage({ id: "fixed-id" }))).toBe("invalid");
  });

  it("appends siblings in creation order", () => {
    const c = ws();
    const parent = c.createPage({ title: "Parent" });
    const a = c.createPage({ parentId: parent.id, title: "A" });
    const b = c.createPage({ parentId: parent.id, title: "B" });
    const cc = c.createPage({ parentId: parent.id, title: "C" });
    expect(c.listChildren(parent.id).map((n) => n.page.id)).toEqual([
      a.id,
      b.id,
      cc.id,
    ]);
  });

  it("inserts after afterPageId, and first when afterPageId is null", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    const mid = c.createPage({ title: "Mid", afterPageId: a.id });
    const first = c.createPage({ title: "First", afterPageId: null });
    expect(c.listRootPages().map((n) => n.page.title)).toEqual([
      "First",
      "A",
      "Mid",
      "B",
    ]);
    expect(a.rank < mid.rank && mid.rank < b.rank).toBe(true);
    expect(first.rank < a.rank).toBe(true);
  });

  it("rejects an unknown parent and an unrelated afterPageId", () => {
    const c = ws();
    const parent = c.createPage({ title: "Parent" });
    const stranger = c.createPage({ title: "Stranger" });
    expect(codeOf(() => c.createPage({ parentId: "nope" }))).toBe("not_found");
    expect(
      codeOf(() => c.createPage({ parentId: parent.id, afterPageId: stranger.id })),
    ).toBe("invalid");
  });

  it("keeps hundreds of random insertions correctly ordered", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    const order: string[] = [];
    const random = makeRandom(7);
    for (let i = 0; i < 200; i++) {
      const at = Math.floor(random() * (order.length + 1));
      const after = at === 0 ? null : (order[at - 1] ?? null);
      const page = c.createPage({
        parentId: root.id,
        title: `p${i}`,
        afterPageId: after,
      });
      order.splice(at, 0, page.id);
    }
    expect(c.listChildren(root.id).map((n) => n.page.id)).toEqual(order);
  });
});

describe("getPage / updatePage", () => {
  it("returns null for an unknown page", () => {
    expect(ws().getPage("missing")).toBeNull();
  });

  it("patches only the provided fields", () => {
    const c = ws();
    const page = c.createPage({ title: "Original" });
    const updated = c.updatePage(page.id, { title: "New", smallText: true });
    expect(updated.title).toBe("New");
    expect(updated.smallText).toBe(true);
    expect(updated.fullWidth).toBe(false);
    expect(updated.icon).toBeNull();
    expect(c.updatePage(page.id, { icon: "📄" }).title).toBe("New");
    expect(c.updatePage(page.id, { icon: null }).icon).toBeNull();
  });

  it("rejects content edits on a locked page but allows unlocking", () => {
    const c = ws();
    const page = c.createPage({ title: "Locked" });
    c.updatePage(page.id, { locked: true });
    expect(codeOf(() => c.updatePage(page.id, { title: "Nope" }))).toBe("locked");
    expect(codeOf(() => c.updatePage(page.id, { fullWidth: true }))).toBe("locked");
    expect(codeOf(() => c.updatePage(page.id, { locked: false, title: "x" }))).toBe(
      "locked",
    );
    expect(c.updatePage(page.id, { locked: false }).locked).toBe(false);
    expect(c.updatePage(page.id, { title: "Now allowed" }).title).toBe(
      "Now allowed",
    );
  });

  it("reports not_found for unknown ids", () => {
    const c = ws();
    expect(codeOf(() => c.updatePage("missing", { title: "x" }))).toBe("not_found");
    expect(codeOf(() => c.listChildren("missing"))).toBe("not_found");
    expect(codeOf(() => c.getBreadcrumb("missing"))).toBe("not_found");
    expect(codeOf(() => c.getBlocks("missing"))).toBe("not_found");
  });
});

describe("movePage", () => {
  it("re-parents and re-ranks", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    const child = c.createPage({ parentId: a.id, title: "Child" });

    const moved = c.movePage(child.id, b.id);
    expect(moved.parentId).toBe(b.id);
    expect(c.listChildren(a.id)).toEqual([]);
    expect(c.listChildren(b.id).map((n) => n.page.id)).toEqual([child.id]);

    const root = c.movePage(child.id, null, a.id);
    expect(root.parentId).toBeNull();
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([a.id, child.id, b.id]);
  });

  it("moves to the front when afterPageId is null", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    c.movePage(b.id, null, null);
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([b.id, a.id]);
  });

  it("rejects cycles", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ parentId: root.id, title: "Child" });
    const grand = c.createPage({ parentId: child.id, title: "Grand" });

    expect(codeOf(() => c.movePage(root.id, root.id))).toBe("cycle");
    expect(codeOf(() => c.movePage(root.id, child.id))).toBe("cycle");
    expect(codeOf(() => c.movePage(root.id, grand.id))).toBe("cycle");
    // The reverse direction is legal.
    expect(c.movePage(grand.id, null).parentId).toBeNull();
  });

  it("rejects unknown targets", () => {
    const c = ws();
    const page = c.createPage({ title: "A" });
    expect(codeOf(() => c.movePage(page.id, "missing"))).toBe("not_found");
    expect(codeOf(() => c.movePage("missing", null))).toBe("not_found");
  });
});

describe("listRootPages / listChildren / getBreadcrumb", () => {
  it("reports hasChildren from live children only", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    expect(c.listRootPages()[0]?.hasChildren).toBe(false);
    const child = c.createPage({ parentId: root.id, title: "Child" });
    expect(c.listRootPages()[0]?.hasChildren).toBe(true);
    c.trashPage(child.id);
    expect(c.listRootPages()[0]?.hasChildren).toBe(false);
  });

  it("returns the chain from root to the page itself", () => {
    const c = ws();
    const a = c.createPage({ title: "A", icon: "🅰" });
    const b = c.createPage({ parentId: a.id, title: "B" });
    const d = c.createPage({ parentId: b.id, title: "D" });
    expect(c.getBreadcrumb(d.id)).toEqual([
      { id: a.id, title: "A", icon: "🅰" },
      { id: b.id, title: "B", icon: null },
      { id: d.id, title: "D", icon: null },
    ]);
  });
});

describe("duplicatePage", () => {
  it("deep-copies the subtree with fresh ids, placed after the original", () => {
    const c = ws();
    const root = c.createPage({ title: "Root", icon: "📘" });
    const child = c.createPage({ parentId: root.id, title: "Child" });
    const grand = c.createPage({ parentId: child.id, title: "Grand" });
    const sibling = c.createPage({ title: "Sibling" });

    const rootBlock = c.getBlocks(root.id)[0];
    c.applyBlockOps([
      {
        opId: "op-1",
        kind: "update",
        blockId: rootBlock?.id ?? "",
        baseVersion: 1,
        patch: { payload: { richText: [{ type: "text", text: "hello world" }] } },
      },
    ]);

    const copy = c.duplicatePage(root.id);
    expect(copy.id).not.toBe(root.id);
    expect(copy.title).toBe("Root (Copy)");
    expect(copy.icon).toBe("📘");
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([
      root.id,
      copy.id,
      sibling.id,
    ]);

    const copiedChildren = c.listChildren(copy.id);
    expect(copiedChildren).toHaveLength(1);
    const copiedChild = copiedChildren[0]?.page;
    expect(copiedChild?.id).not.toBe(child.id);
    expect(copiedChild?.title).toBe("Child");

    const copiedGrand = c.listChildren(copiedChild?.id ?? "")[0]?.page;
    expect(copiedGrand?.id).not.toBe(grand.id);
    expect(copiedGrand?.title).toBe("Grand");

    const copiedBlocks = c.getBlocks(copy.id);
    expect(copiedBlocks).toHaveLength(1);
    expect(copiedBlocks[0]?.id).not.toBe(rootBlock?.id);
    expect(copiedBlocks[0]?.payload).toEqual({
      richText: [{ type: "text", text: "hello world" }],
    });

    // Editing the copy must not touch the original.
    c.updatePage(copy.id, { title: "Diverged" });
    expect(c.getPage(root.id)?.title).toBe("Root");
  });

  it("copies nested block structure and re-points child page references", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ parentId: root.id, title: "Child" });
    const toggle = c.getBlocks(root.id)[0]?.id ?? "";
    c.applyBlockOps([
      {
        opId: "op-a",
        kind: "update",
        blockId: toggle,
        baseVersion: 1,
        patch: { type: "toggle", payload: { richText: [{ type: "text", text: "T" }] } },
      },
      {
        opId: "op-b",
        kind: "insert",
        block: {
          id: "nested-1",
          pageId: root.id,
          parentBlockId: toggle,
          rank: "a1",
          type: "child_page",
          payload: { pageId: child.id },
        },
      },
    ]);

    const copy = c.duplicatePage(root.id);
    const blocks = c.getBlocks(copy.id);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("toggle");
    expect(blocks[1]?.parentBlockId).toBe(blocks[0]?.id);
    const copiedChildId = c.listChildren(copy.id)[0]?.page.id;
    expect(blocks[1]?.payload.pageId).toBe(copiedChildId);
    expect(blocks[1]?.payload.pageId).not.toBe(child.id);
  });

  it("refuses to duplicate a trashed page", () => {
    const c = ws();
    const page = c.createPage({ title: "Gone" });
    c.trashPage(page.id);
    expect(codeOf(() => c.duplicatePage(page.id))).toBe("invalid");
  });
});
