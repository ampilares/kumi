import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rankBetween, type KumiCommands } from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

let c: KumiCommands;
let projects: string;
let quarterly: string;
let nested: string;
let unicode: string;

let ops = 0;
function writeText(pageId: string, text: string): void {
  const blockId = c.getBlocks(pageId)[0]?.id ?? "";
  const version = c.getBlocks(pageId)[0]?.version ?? 1;
  const result = c.applyBlockOps([
    {
      opId: `search-op-${++ops}`,
      kind: "update",
      blockId,
      baseVersion: version,
      patch: { payload: { richText: [{ type: "text", text }] } },
    },
  ]);
  expect(result.rejected).toEqual([]);
}

beforeAll(() => {
  c = tempWorkspace().commands;

  const p = c.createPage({ title: "Projects" });
  projects = p.id;
  writeText(projects, "Everything the team is building this year.");

  const q = c.createPage({ parentId: projects, title: "Quarterly Report" });
  quarterly = q.id;
  writeText(quarterly, "Revenue grew and the pipeline widened considerably.");

  const n = c.createPage({ parentId: quarterly, title: "Deep Notes" });
  nested = n.id;
  writeText(nested, "The quarterly numbers are in the appendix.");

  const u = c.createPage({ title: "Café Möbel 日本語" });
  unicode = u.id;
  writeText(unicode, "naïve résumé 東京 🌸 emoji line");
});

describe("search", () => {
  it("finds pages by title and by body", () => {
    expect(c.search("Quarterly").map((r) => r.pageId)).toContain(quarterly);
    expect(c.search("pipeline").map((r) => r.pageId)).toEqual([quarterly]);
  });

  it("ranks title matches ahead of body matches", () => {
    const results = c.search("quarterly");
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]?.pageId).toBe(quarterly);
    expect(results.map((r) => r.pageId)).toContain(nested);
  });

  it("prefix-matches the last token as the user types", () => {
    expect(c.search("quart").map((r) => r.pageId)).toContain(quarterly);
    expect(c.search("revenue grew pipe").map((r) => r.pageId)).toEqual([quarterly]);
    // Non-final tokens are whole-word matches.
    expect(c.search("reven grew")).toEqual([]);
  });

  it("returns highlighted snippets and a breadcrumb of ancestors", () => {
    const [hit] = c.search("appendix");
    expect(hit?.pageId).toBe(nested);
    expect(hit?.snippet).toContain("<b>appendix</b>");
    expect(hit?.breadcrumb).toEqual(["Projects", "Quarterly Report"]);
    expect(hit?.title).toBe("Deep Notes");
    expect(hit?.updatedAt).toBeTypeOf("number");
    expect(hit?.icon).toBeNull();
  });

  it("restricts to titles when titleOnly is set", () => {
    expect(c.search("appendix", { titleOnly: true })).toEqual([]);
    expect(c.search("Deep", { titleOnly: true }).map((r) => r.pageId)).toEqual([
      nested,
    ]);
  });

  it("honours the limit", () => {
    expect(c.search("the", { limit: 1 })).toHaveLength(1);
    expect(c.search("the", { limit: 0 })).toHaveLength(1);
  });

  it("never lets user input reach FTS5 as syntax", () => {
    const hostile = [
      "a AND b",
      "a OR b",
      "NOT quarterly",
      'quarterly NEAR "report"',
      '"unterminated',
      "((()))",
      "*",
      "^caret",
      "col:value",
      "a-b",
      "--",
      "{title}",
      "\\",
      "🌸",
      "'; DROP TABLE pages; --",
    ];
    for (const query of hostile) {
      expect(() => c.search(query), query).not.toThrow();
    }
    // Operators are literal terms: "AND" only matches because the Quarterly
    // Report body really contains the word "and"...
    expect(c.search("quarterly AND report").map((r) => r.pageId)).toEqual([
      quarterly,
    ]);
    // ...and an unmatched literal narrows to nothing instead of being parsed.
    expect(c.search("quarterly OR zebra")).toEqual([]);
    expect(c.search("quarterly NOT report")).toEqual([]);
    expect(c.search("")).toEqual([]);
    expect(c.search("   ")).toEqual([]);
  });

  it("matches unicode content, with and without diacritics", () => {
    expect(c.search("Café").map((r) => r.pageId)).toContain(unicode);
    expect(c.search("cafe").map((r) => r.pageId)).toContain(unicode);
    expect(c.search("naive").map((r) => r.pageId)).toContain(unicode);
    expect(c.search("日本語").map((r) => r.pageId)).toContain(unicode);
    expect(c.search("東京").map((r) => r.pageId)).toContain(unicode);
  });

  it("reflects edits, renames and trashing immediately", () => {
    const local = tempWorkspace().commands;
    const page = local.createPage({ title: "Draft" });
    const blockId = local.getBlocks(page.id)[0]?.id ?? "";

    expect(local.search("Draft").map((r) => r.pageId)).toEqual([page.id]);
    expect(local.search("chameleon")).toEqual([]);

    local.applyBlockOps([
      {
        opId: "edit-1",
        kind: "update",
        blockId,
        baseVersion: 1,
        patch: { payload: { richText: [{ type: "text", text: "chameleon prose" }] } },
      },
    ]);
    expect(local.search("chameleon").map((r) => r.pageId)).toEqual([page.id]);

    local.updatePage(page.id, { title: "Renamed" });
    expect(local.search("Draft")).toEqual([]);
    expect(local.search("Renamed").map((r) => r.pageId)).toEqual([page.id]);

    local.applyBlockOps([{ opId: "edit-2", kind: "delete", blockId }]);
    expect(local.search("chameleon")).toEqual([]);

    local.trashPage(page.id);
    expect(local.search("Renamed")).toEqual([]);
    local.restorePage(page.id);
    expect(local.search("Renamed").map((r) => r.pageId)).toEqual([page.id]);
  });

  it("indexes nested blocks, captions, code and table cells", () => {
    const local = tempWorkspace().commands;
    const page = local.createPage({ title: "Rich" });
    const rank = rankBetween(null, null);
    local.applyBlockOps([
      {
        opId: "rich-1",
        kind: "insert",
        block: {
          id: "toggle",
          pageId: page.id,
          parentBlockId: null,
          rank,
          type: "toggle",
          payload: { richText: [{ type: "text", text: "outer" }] },
        },
      },
      {
        opId: "rich-2",
        kind: "insert",
        block: {
          id: "inner",
          pageId: page.id,
          parentBlockId: "toggle",
          rank,
          type: "paragraph",
          payload: { richText: [{ type: "text", text: "hidden treasure" }] },
        },
      },
      {
        opId: "rich-3",
        kind: "insert",
        block: {
          id: "img",
          pageId: page.id,
          parentBlockId: null,
          rank: rankBetween(rank, null),
          type: "image",
          payload: { caption: [{ type: "text", text: "seagull photograph" }] },
        },
      },
      {
        opId: "rich-4",
        kind: "insert",
        block: {
          id: "row",
          pageId: page.id,
          parentBlockId: null,
          rank: rankBetween(rankBetween(rank, null), null),
          type: "table_row",
          payload: {
            cells: [
              [{ type: "text", text: "alpha" }],
              [{ type: "text", text: "omega" }],
            ],
          },
        },
      },
      {
        opId: "rich-5",
        kind: "insert",
        block: {
          id: "eq",
          pageId: page.id,
          parentBlockId: null,
          rank: rankBetween(rankBetween(rankBetween(rank, null), null), null),
          type: "equation",
          payload: { expression: "sigma squared" },
        },
      },
    ]);

    for (const term of ["treasure", "seagull", "omega", "sigma"]) {
      expect(local.search(term).map((r) => r.pageId), term).toEqual([page.id]);
    }
  });
});
