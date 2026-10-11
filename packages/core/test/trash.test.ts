import { afterAll, describe, expect, it } from "vitest";
import { KumiError, type KumiCommands } from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

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

function tree(c: KumiCommands): { root: string; child: string; grand: string } {
  const root = c.createPage({ title: "Root" });
  const child = c.createPage({ parentId: root.id, title: "Child" });
  const grand = c.createPage({ parentId: child.id, title: "Grand" });
  return { root: root.id, child: child.id, grand: grand.id };
}

describe("trashPage", () => {
  it("soft-deletes the whole subtree and hides it from the tree", () => {
    const c = ws();
    const { root, child, grand } = tree(c);
    c.trashPage(root);

    expect(c.listRootPages()).toEqual([]);
    for (const id of [root, child, grand]) {
      expect(c.getPage(id)?.deletedAt, id).toBeTypeOf("number");
    }
  });

  it("lists only the trashed subtree roots", () => {
    const c = ws();
    const { root } = tree(c);
    const other = c.createPage({ title: "Other" });
    c.trashPage(root);
    c.trashPage(other.id);

    const trash = c.listTrash();
    expect(trash.map((p) => p.title).sort()).toEqual(["Other", "Root"]);
  });

  it("refuses to trash twice", () => {
    const c = ws();
    const { root } = tree(c);
    c.trashPage(root);
    expect(codeOf(() => c.trashPage(root))).toBe("invalid");
    expect(codeOf(() => c.trashPage("missing"))).toBe("not_found");
  });

  it("blocks creating or moving live pages into the trash", () => {
    const c = ws();
    const { root } = tree(c);
    const live = c.createPage({ title: "Live" });
    c.trashPage(root);
    expect(codeOf(() => c.createPage({ parentId: root }))).toBe("invalid");
    expect(codeOf(() => c.movePage(live.id, root))).toBe("invalid");
  });
});

describe("restorePage", () => {
  it("restores exactly the pages trashed by that operation", () => {
    const c = ws();
    const { root, child, grand } = tree(c);
    c.trashPage(root);
    c.restorePage(root);

    expect(c.listTrash()).toEqual([]);
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([root]);
    expect(c.listChildren(root).map((n) => n.page.id)).toEqual([child]);
    expect(c.listChildren(child).map((n) => n.page.id)).toEqual([grand]);
  });

  it("leaves pages trashed by an earlier, separate operation in the trash", () => {
    const c = ws();
    const { root, child, grand } = tree(c);
    c.trashPage(child); // batch A: child + grand
    c.trashPage(root); // batch B: root only (child was already trashed)

    c.restorePage(root);
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([root]);
    expect(c.listChildren(root)).toEqual([]);
    expect(c.listTrash().map((p) => p.id)).toEqual([child]);

    c.restorePage(child);
    expect(c.listChildren(root).map((n) => n.page.id)).toEqual([child]);
    expect(c.listChildren(child).map((n) => n.page.id)).toEqual([grand]);
    expect(c.listTrash()).toEqual([]);
  });

  it("re-parents to the workspace root when the original parent is still trashed", () => {
    const c = ws();
    const { root, child } = tree(c);
    c.trashPage(child);
    c.trashPage(root);

    c.restorePage(child);
    const restored = c.getPage(child);
    expect(restored?.parentId).toBeNull();
    expect(restored?.deletedAt).toBeNull();
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([child]);
  });

  it("rejects restoring a non-root member of a trash batch", () => {
    const c = ws();
    const { root, child } = tree(c);
    c.trashPage(root);
    expect(codeOf(() => c.restorePage(child))).toBe("invalid");
    expect(codeOf(() => c.restorePage("missing"))).toBe("not_found");
  });

  it("rejects restoring a page that is not in the trash", () => {
    const c = ws();
    const { root } = tree(c);
    expect(codeOf(() => c.restorePage(root))).toBe("invalid");
  });
});

describe("deletePagePermanently", () => {
  it("refuses pages that are not in the trash", () => {
    const c = ws();
    const { root } = tree(c);
    expect(codeOf(() => c.deletePagePermanently(root))).toBe("invalid");
    expect(codeOf(() => c.deletePagePermanently("missing"))).toBe("not_found");
  });

  it("removes the subtree, its blocks and its search rows", () => {
    const c = ws();
    const { root, child, grand } = tree(c);
    c.updatePage(grand, { title: "Findable Grandchild" });
    expect(c.search("Findable").map((r) => r.pageId)).toEqual([grand]);

    c.trashPage(root);
    c.deletePagePermanently(root);

    for (const id of [root, child, grand]) expect(c.getPage(id), id).toBeNull();
    expect(c.listTrash()).toEqual([]);
    expect(c.listRootPages()).toEqual([]);
    expect(c.search("Findable")).toEqual([]);
  });

  it("drops the deleted pages from favorites, recents and expansion state", () => {
    const c = ws();
    const { root, child } = tree(c);
    const keep = c.createPage({ title: "Keep" });
    c.setFavorite(child, true);
    c.setFavorite(keep.id, true);
    c.touchRecent(child);
    c.touchRecent(keep.id);
    c.setExpanded(root, true);

    c.trashPage(root);
    c.deletePagePermanently(root);

    const state = c.getUserState();
    expect(state.favorites).toEqual([keep.id]);
    expect(state.recents).toEqual([keep.id]);
    expect(state.expandedPageIds).toEqual([]);
  });
});
