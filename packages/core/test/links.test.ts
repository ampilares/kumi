import { afterAll, describe, expect, it } from "vitest";
import {
  rankBetween,
  type BlockOp,
  type BlockPayload,
  type BlockType,
  type KumiCommands,
} from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

function ws(): KumiCommands {
  return tempWorkspace().commands;
}

let opCounter = 0;
const opId = (): string => `link-op-${++opCounter}`;

let rankCounter = 0;
/** A fresh rank; blocks in these tests only need to be distinct, not ordered. */
const nextRank = (): string => {
  let rank = rankBetween(null, null);
  for (let i = 0; i < rankCounter % 5; i++) rank = rankBetween(rank, null);
  rankCounter++;
  return rank;
};

function insert(
  pageId: string,
  id: string,
  payload: BlockPayload,
  type: BlockType = "paragraph",
): BlockOp {
  return {
    opId: opId(),
    kind: "insert",
    block: { id, pageId, parentBlockId: null, rank: nextRank(), type, payload },
  };
}

function update(blockId: string, baseVersion: number, payload: BlockPayload): BlockOp {
  return { opId: opId(), kind: "update", blockId, baseVersion, patch: { payload } };
}

/** A rich-text paragraph payload linking to `pageId` via an internal href. */
function hrefTo(pageId: string): BlockPayload {
  return {
    richText: [
      { type: "text", text: "see " },
      { type: "text", text: "there", href: `kumi://page/${pageId}` },
    ],
  };
}

function mentionOf(pageId: string): BlockPayload {
  return { richText: [{ type: "mention", mention: { kind: "page", pageId } }] };
}

/** Busy-wait until `Date.now()` advances, so two edits get distinct timestamps. */
function tick(): void {
  const start = Date.now();
  while (Date.now() === start) {
    /* spin: sub-millisecond */
  }
}

function sourceBlocks(c: KumiCommands, targetId: string): string[] {
  return c.getBacklinks(targetId).map((b) => b.sourceBlockId);
}

describe("links index", () => {
  it("indexes internal hrefs, page mentions and linked_page payloads", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });

    const result = c.applyBlockOps([
      insert(source.id, "by-href", hrefTo(target.id)),
      insert(source.id, "by-mention", mentionOf(target.id)),
      insert(source.id, "by-linked", { pageId: target.id }, "linked_page"),
    ]);
    expect(result.rejected).toEqual([]);

    expect(sourceBlocks(c, target.id).sort()).toEqual([
      "by-href",
      "by-linked",
      "by-mention",
    ]);
  });

  it("indexes links inside captions and table cells", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });

    c.applyBlockOps([
      insert(
        source.id,
        "captioned",
        { caption: [{ type: "text", text: "ref", href: `kumi://page/${target.id}` }] },
        "image",
      ),
      insert(
        source.id,
        "row",
        { cells: [[], [{ type: "mention", mention: { kind: "page", pageId: target.id } }]] },
        "table_row",
      ),
    ]);

    expect(sourceBlocks(c, target.id).sort()).toEqual(["captioned", "row"]);
  });

  it("ignores child_page, external links and date mentions", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    const child = c.createPage({ parentId: source.id, title: "Child" });

    c.applyBlockOps([
      // A child page is the tree, not a backlink.
      insert(source.id, "child", { pageId: child.id }, "child_page"),
      insert(source.id, "external", {
        richText: [{ type: "text", text: "web", href: "https://example.com" }],
      }),
      insert(source.id, "dated", {
        richText: [{ type: "mention", mention: { kind: "date", start: "2026-01-01" } }],
      }),
      insert(source.id, "bare", {
        richText: [{ type: "text", text: "no link", href: "kumi://page/" }],
      }),
    ]);

    expect(c.getBacklinks(child.id)).toEqual([]);
    expect(c.getBacklinks(target.id)).toEqual([]);
  });

  it("replaces a block's links on update, dropping the stale ones", () => {
    const c = ws();
    const first = c.createPage({ title: "First" });
    const second = c.createPage({ title: "Second" });
    const source = c.createPage({ title: "Source" });

    c.applyBlockOps([insert(source.id, "b", hrefTo(first.id))]);
    expect(sourceBlocks(c, first.id)).toEqual(["b"]);

    c.applyBlockOps([update("b", 1, mentionOf(second.id))]);
    expect(c.getBacklinks(first.id)).toEqual([]);
    expect(sourceBlocks(c, second.id)).toEqual(["b"]);

    // Clearing the payload clears the index too.
    c.applyBlockOps([update("b", 2, { richText: [{ type: "text", text: "plain" }] })]);
    expect(c.getBacklinks(second.id)).toEqual([]);
  });

  it("records one row per (block, target) even when a block links twice", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    c.applyBlockOps([
      insert(source.id, "twice", {
        richText: [
          { type: "text", text: "a", href: `kumi://page/${target.id}` },
          { type: "mention", mention: { kind: "page", pageId: target.id } },
        ],
      }),
    ]);
    expect(c.getBacklinks(target.id)).toHaveLength(1);
  });

  it("skips unknown targets and resolves them on a later edit", () => {
    const c = ws();
    const source = c.createPage({ title: "Source" });
    const futureId = "9f1e0f2c-0000-4000-8000-000000000001";

    c.applyBlockOps([insert(source.id, "b", hrefTo(futureId))]);
    expect(c.getBacklinks(futureId)).toEqual([]);

    // The importer creates the target afterwards; the next edit picks it up.
    c.createPage({ id: futureId, title: "Arrived" });
    c.applyBlockOps([update("b", 1, hrefTo(futureId))]);
    expect(sourceBlocks(c, futureId)).toEqual(["b"]);
  });

  it("removes the links of a deleted block and its whole subtree", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    const rank = rankBetween(null, null);

    c.applyBlockOps([
      insert(source.id, "parent", hrefTo(target.id)),
      {
        opId: opId(),
        kind: "insert",
        block: {
          id: "kid",
          pageId: source.id,
          parentBlockId: "parent",
          rank,
          type: "paragraph",
          payload: mentionOf(target.id),
        },
      },
      insert(source.id, "sibling", mentionOf(target.id)),
    ]);
    expect(sourceBlocks(c, target.id).sort()).toEqual(["kid", "parent", "sibling"]);

    c.applyBlockOps([{ opId: opId(), kind: "delete", blockId: "parent" }]);
    expect(sourceBlocks(c, target.id)).toEqual(["sibling"]);
  });
});

describe("getBacklinks", () => {
  it("returns the source page's title and icon, one entry per block", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source", icon: "🔗" });
    c.applyBlockOps([
      insert(source.id, "one", hrefTo(target.id)),
      insert(source.id, "two", mentionOf(target.id)),
    ]);

    const links = c.getBacklinks(target.id);
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.sourcePageId).toBe(source.id);
      expect(link.sourcePageTitle).toBe("Source");
      expect(link.sourcePageIcon).toBe("🔗");
    }
    expect(links.map((l) => l.sourceBlockId).sort()).toEqual(["one", "two"]);
  });

  it("returns [] for a page nothing points at", () => {
    const c = ws();
    const page = c.createPage({ title: "Lonely" });
    expect(c.getBacklinks(page.id)).toEqual([]);
    expect(c.getBacklinks("no-such-page")).toEqual([]);
  });

  it("orders by source page updated_at, newest first, and stays stable", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const older = c.createPage({ title: "Older" });
    const newer = c.createPage({ title: "Newer" });

    c.applyBlockOps([insert(older.id, "o", hrefTo(target.id))]);
    tick();
    c.applyBlockOps([
      insert(newer.id, "n1", hrefTo(target.id)),
      insert(newer.id, "n2", mentionOf(target.id)),
    ]);

    const pagesInOrder = c.getBacklinks(target.id).map((l) => l.sourcePageId);
    expect(pagesInOrder).toEqual([newer.id, newer.id, older.id]);
    // Repeating the query gives the same order.
    expect(c.getBacklinks(target.id)).toEqual(c.getBacklinks(target.id));

    // Touching the older page floats it to the top.
    tick();
    c.applyBlockOps([update("o", 1, hrefTo(target.id))]);
    expect(c.getBacklinks(target.id).map((l) => l.sourcePageId)).toEqual([
      older.id,
      newer.id,
      newer.id,
    ]);
  });

  it("hides links from a trashed source page and shows them again on restore", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    c.applyBlockOps([insert(source.id, "b", hrefTo(target.id))]);
    expect(c.getBacklinks(target.id)).toHaveLength(1);

    c.trashPage(source.id);
    expect(c.getBacklinks(target.id)).toEqual([]);

    c.restorePage(source.id);
    expect(sourceBlocks(c, target.id)).toEqual(["b"]);
  });

  it("hides links whose source page was trashed as a descendant", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ parentId: root.id, title: "Child" });
    c.applyBlockOps([insert(child.id, "b", hrefTo(target.id))]);

    c.trashPage(root.id);
    expect(c.getBacklinks(target.id)).toEqual([]);
    c.restorePage(root.id);
    expect(sourceBlocks(c, target.id)).toEqual(["b"]);
  });

  it("drops the rows for good when the source page is deleted permanently", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    c.applyBlockOps([insert(source.id, "b", hrefTo(target.id))]);

    c.trashPage(source.id);
    c.deletePagePermanently(source.id);
    expect(c.getBacklinks(target.id)).toEqual([]);
    // Restoring is no longer possible, so nothing can resurrect the row.
    expect(c.getPage(source.id)).toBeNull();
  });

  it("survives the permanent deletion of the target page", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    c.applyBlockOps([insert(source.id, "b", hrefTo(target.id))]);

    c.trashPage(target.id);
    c.deletePagePermanently(target.id);
    expect(c.getBacklinks(target.id)).toEqual([]);
    // The source page is untouched and still editable.
    expect(c.getBlock("b")).not.toBeNull();
    expect(c.applyBlockOps([update("b", 1, hrefTo(target.id))]).rejected).toEqual([]);
  });
});

describe("duplicatePage links", () => {
  it("gives the copy its own rows, still pointing at the original target", () => {
    const c = ws();
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    c.applyBlockOps([insert(source.id, "b", hrefTo(target.id))]);

    const copy = c.duplicatePage(source.id);
    const links = c.getBacklinks(target.id);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.sourcePageId).sort()).toEqual(
      [source.id, copy.id].sort(),
    );
    // Each entry names a distinct block: the original and its copy.
    expect(new Set(links.map((l) => l.sourceBlockId)).size).toBe(2);
    expect(links.some((l) => l.sourcePageTitle === "Source (Copy)")).toBe(true);
  });

  it("re-points a linked_page block at the copied page", () => {
    const c = ws();
    const source = c.createPage({ title: "Source" });
    const child = c.createPage({ parentId: source.id, title: "Child" });
    c.applyBlockOps([insert(source.id, "link", { pageId: child.id }, "linked_page")]);

    const copy = c.duplicatePage(source.id);
    const childCopy = c.listChildren(copy.id)[0]?.page;
    expect(childCopy?.title).toBe("Child");

    // The original still has exactly its own backlink…
    expect(c.getBacklinks(child.id).map((l) => l.sourcePageId)).toEqual([source.id]);
    // …and the copy's linked_page points at the copied child.
    expect(c.getBacklinks(childCopy?.id ?? "").map((l) => l.sourcePageId)).toEqual([
      copy.id,
    ]);
  });
});
