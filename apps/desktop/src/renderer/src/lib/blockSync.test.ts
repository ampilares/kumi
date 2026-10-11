import { describe, expect, it } from "vitest";
import type { Block, BlockOp, BlockPayload, BlockType } from "@kumi/core";
import {
  applyOpsLocally,
  blocksToDoc,
  docToOps,
  emptyDoc,
  normalizeDepths,
  orderBlocks,
} from "./blockSync";
import { inlineToRichText, richTextToInline } from "./richText";
import type { PmDoc, PmNode } from "./pmjson";
import { rankBetween } from "./rank";

const PAGE = "page-1";

/* --------------------------------------------------------------- fixtures */

let seq = 0;
const ids = (): string => `gen-${++seq}`;
const gen = { newId: ids };

function text(value: string): BlockPayload {
  return { richText: value === "" ? [] : [{ type: "text", text: value }] };
}

interface BlockSpec {
  id: string;
  type?: BlockType;
  parent?: string | null;
  rank: string;
  payload?: BlockPayload;
  version?: number;
}

function block(spec: BlockSpec): Block {
  return {
    id: spec.id,
    pageId: PAGE,
    parentBlockId: spec.parent ?? null,
    rank: spec.rank,
    type: spec.type ?? "paragraph",
    payload: spec.payload ?? text(spec.id),
    version: spec.version ?? 1,
    archived: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** Three sibling paragraphs A, B, C. */
function abc(): Block[] {
  const r1 = rankBetween(null, null);
  const r2 = rankBetween(r1, null);
  const r3 = rankBetween(r2, null);
  return [
    block({ id: "A", rank: r1, payload: text("alpha"), version: 2 }),
    block({ id: "B", rank: r2, payload: text("bravo"), version: 5 }),
    block({ id: "C", rank: r3, payload: text("charlie"), version: 1 }),
  ];
}

function nodes(doc: PmDoc): PmNode[] {
  return doc.content ?? [];
}

function ofKind(ops: BlockOp[], kind: BlockOp["kind"]): BlockOp[] {
  return ops.filter((op) => op.kind === kind);
}

/* ------------------------------------------------------------------- tests */

describe("orderBlocks", () => {
  it("walks the tree depth-first and reports outline depth", () => {
    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    const blocks = [
      block({ id: "child", parent: "root", rank: r1 }),
      block({ id: "root", rank: r1 }),
      block({ id: "after", rank: r2 }),
    ];
    expect(orderBlocks(blocks).map((p) => [p.block.id, p.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["after", 0],
    ]);
  });

  it("re-roots orphans instead of dropping them", () => {
    const r1 = rankBetween(null, null);
    const blocks = [block({ id: "lost", parent: "missing", rank: r1 })];
    expect(orderBlocks(blocks).map((p) => p.block.id)).toEqual(["lost"]);
  });

  it("skips archived blocks", () => {
    const r1 = rankBetween(null, null);
    const archived = { ...block({ id: "gone", rank: r1 }), archived: true };
    expect(orderBlocks([archived])).toEqual([]);
  });
});

describe("normalizeDepths", () => {
  it("clamps to one level deeper than the previous block", () => {
    const list: PmNode[] = [
      { type: "paragraph", attrs: { depth: 4 } },
      { type: "paragraph", attrs: { depth: 9 } },
      { type: "paragraph", attrs: { depth: 1 } },
      { type: "paragraph", attrs: { depth: -3 } },
    ];
    expect(normalizeDepths(list)).toEqual([0, 1, 1, 0]);
  });
});

describe("blocksToDoc", () => {
  it("maps every Phase 2 block type onto a node of the same name", () => {
    let rank = rankBetween(null, null);
    const next = (): string => (rank = rankBetween(rank, null));
    const blocks = [
      block({ id: "p", rank, type: "paragraph" }),
      block({ id: "h", rank: next(), type: "heading2" }),
      block({ id: "t", rank: next(), type: "to_do", payload: { ...text("task"), checked: true } }),
      block({ id: "g", rank: next(), type: "toggle", payload: { ...text("more"), collapsed: true } }),
      block({ id: "c", rank: next(), type: "callout", payload: { ...text("note"), icon: "🔥" } }),
      block({ id: "d", rank: next(), type: "divider", payload: {} }),
      block({
        id: "k",
        rank: next(),
        type: "code",
        payload: { richText: [{ type: "text", text: "const a = 1" }], language: "typescript" },
      }),
    ];
    const list = nodes(blocksToDoc(blocks));
    expect(list.map((n) => n.type)).toEqual([
      "paragraph",
      "heading2",
      "to_do",
      "toggle",
      "callout",
      "divider",
      "code",
    ]);
    expect(list[2]?.attrs?.["checked"]).toBe(true);
    expect(list[3]?.attrs?.["collapsed"]).toBe(true);
    expect(list[4]?.attrs?.["icon"]).toBe("🔥");
    expect(list[6]?.attrs?.["language"]).toBe("typescript");
    expect(list[6]?.content?.[0]?.text).toBe("const a = 1");
  });

  it("preserves block types the editor cannot render", () => {
    const rank = rankBetween(null, null);
    const payload: BlockPayload = { hasColumnHeader: true, cells: [] };
    const blocks = [block({ id: "tbl", rank, type: "table", payload })];
    const node = nodes(blocksToDoc(blocks))[0];
    expect(node?.type).toBe("unsupported_block");
    expect(node?.attrs?.["kumiType"]).toBe("table");
    expect(node?.attrs?.["payload"]).toEqual(payload);
  });

  it("maps every Phase 3 block type onto a node of the same name", () => {
    let rank = rankBetween(null, null);
    const next = (): string => (rank = rankBetween(rank, null));
    const blocks = [
      block({ id: "eq", rank, type: "equation", payload: { expression: "e=mc^2" } }),
      block({
        id: "im",
        rank: next(),
        type: "image",
        payload: { assetId: "a1", caption: [{ type: "text", text: "cat" }], width: 0.5 },
      }),
      block({ id: "fi", rank: next(), type: "file", payload: { assetId: "a2" } }),
      block({ id: "vi", rank: next(), type: "video", payload: { assetId: "a3" } }),
      block({ id: "au", rank: next(), type: "audio", payload: { assetId: "a4" } }),
      block({
        id: "bm",
        rank: next(),
        type: "bookmark",
        payload: { url: "https://kumi.test", title: "Kumi", description: "notes", favicon: "f.ico" },
      }),
      block({ id: "em", rank: next(), type: "embed", payload: { url: "https://youtu.be/x" } }),
    ];
    const list = nodes(blocksToDoc(blocks));
    expect(list.map((n) => n.type)).toEqual([
      "equation",
      "image",
      "file",
      "video",
      "audio",
      "bookmark",
      "embed",
    ]);
    expect(list[0]?.attrs?.["expression"]).toBe("e=mc^2");
    expect(list[1]?.attrs?.["assetId"]).toBe("a1");
    expect(list[1]?.attrs?.["width"]).toBe(0.5);
    expect(list[1]?.attrs?.["caption"]).toEqual([{ type: "text", text: "cat" }]);
    // A block that never had a caption keeps a null attribute, not an empty one.
    expect(list[2]?.attrs?.["caption"]).toBeNull();
    expect(list[5]?.attrs?.["title"]).toBe("Kumi");
    expect(list[6]?.attrs?.["url"]).toBe("https://youtu.be/x");
  });

  it("falls back to a single empty paragraph for a blockless page", () => {
    expect(blocksToDoc([])).toEqual(emptyDoc());
  });
});

describe("docToOps — round trip", () => {
  it("produces no ops when nothing changed", () => {
    const blocks = abc();
    expect(docToOps(blocks, blocksToDoc(blocks), PAGE, gen)).toEqual([]);
  });

  it("produces no ops for a page of mixed and unsupported block types", () => {
    let rank = rankBetween(null, null);
    const next = (): string => (rank = rankBetween(rank, null));
    const blocks = [
      block({ id: "h", rank, type: "heading1" }),
      block({ id: "u", rank: next(), type: "table", payload: { hasColumnHeader: true } }),
      block({ id: "t", rank: next(), type: "to_do", payload: { ...text("x"), checked: false } }),
      block({ id: "d", rank: next(), type: "divider", payload: {} }),
    ];
    expect(docToOps(blocks, blocksToDoc(blocks), PAGE, gen)).toEqual([]);
  });

  it("round-trips the full annotation set", () => {
    const rich = richTextToInline([
      { type: "text", text: "bold", annotations: { bold: true } },
      { type: "text", text: "link", href: "https://example.com" },
      { type: "text", text: "red", annotations: { color: "red_background", italic: true } },
      { type: "equation", expression: "e=mc^2" },
      { type: "mention", mention: { kind: "page", pageId: "p9" } },
    ]);
    expect(inlineToRichText(rich)).toEqual([
      { type: "text", text: "bold", annotations: { bold: true } },
      { type: "text", text: "link", href: "https://example.com" },
      { type: "text", text: "red", annotations: { italic: true, color: "red_background" } },
      { type: "equation", expression: "e=mc^2" },
      { type: "mention", mention: { kind: "page", pageId: "p9" } },
    ]);
  });
});

describe("Phase 3 blocks — round trip", () => {
  /** Every new node type, diffed against the blocks it was built from. */
  const cases: Array<[string, BlockType, BlockPayload]> = [
    ["equation", "equation", { expression: "\\frac{a}{b}" }],
    [
      "image with caption and width",
      "image",
      { assetId: "a1", caption: [{ type: "text", text: "a cat" }], width: 0.42 },
    ],
    ["bare image", "image", { assetId: "a1" }],
    ["file", "file", { assetId: "a2" }],
    ["video", "video", { assetId: "a3", width: 1 }],
    ["audio", "audio", { assetId: "a4" }],
    [
      "bookmark with cached metadata",
      "bookmark",
      {
        url: "https://kumi.test/docs",
        title: "Kumi docs",
        description: "Everything is a block.",
        favicon: "https://kumi.test/favicon.ico",
      },
    ],
    ["embed", "embed", { url: "https://www.youtube.com/watch?v=abc" }],
    ["child database", "child_database", { dataSourceId: "ds-1", activeViewId: "view-1" }],
    ["child database with no view chosen", "child_database", { dataSourceId: "ds-1" }],
    ["child page", "child_page", { pageId: "page-1" }],
    ["child page still being created", "child_page", {}],
  ];

  for (const [name, type, payload] of cases) {
    it(`produces no ops for an unchanged ${name}`, () => {
      const blocks = [block({ id: "X", rank: rankBetween(null, null), type, payload })];
      expect(docToOps(blocks, blocksToDoc(blocks), PAGE, gen)).toEqual([]);
    });
  }

  it("maps a child_database to its reference attributes", () => {
    const blocks = [
      block({
        id: "D",
        rank: rankBetween(null, null),
        type: "child_database",
        payload: { dataSourceId: "ds-1", activeViewId: "v-1" },
      }),
    ];
    const node = nodes(blocksToDoc(blocks))[0];
    expect(node?.type).toBe("child_database");
    expect(node?.attrs?.["dataSourceId"]).toBe("ds-1");
    expect(node?.attrs?.["activeViewId"]).toBe("v-1");
    // A database block is an atom: it never carries inline content.
    expect(node?.content).toBeUndefined();
  });

  it("maps a child_page to its page reference and stamps it back", () => {
    const blocks = [
      block({
        id: "P",
        rank: rankBetween(null, null),
        type: "child_page",
        payload: { pageId: "page-9" },
      }),
    ];
    const node = nodes(blocksToDoc(blocks))[0];
    expect(node?.type).toBe("child_page");
    expect(node?.attrs?.["pageId"]).toBe("page-9");
    expect(node?.content).toBeUndefined();

    // Stamping the pageId onto a freshly inserted (null-reference) block emits
    // exactly one update carrying the reference — the /page creation path.
    const fresh = [
      block({ id: "P", rank: rankBetween(null, null), type: "child_page", payload: {} }),
    ];
    const doc = blocksToDoc(fresh);
    const stamped = {
      ...doc,
      content: doc.content?.map((n) =>
        n.type === "child_page" ? { ...n, attrs: { ...n.attrs, pageId: "page-9" } } : n,
      ),
    };
    const ops = docToOps(fresh, stamped, PAGE, gen);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "update",
      blockId: "P",
      patch: { type: "child_page", payload: { pageId: "page-9" } },
    });
  });

  it("switching the active view emits one update carrying only that change", () => {
    const blocks = [
      block({
        id: "D",
        rank: rankBetween(null, null),
        type: "child_database",
        payload: { dataSourceId: "ds-1", activeViewId: "v-1" },
      }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node?.attrs) node.attrs["activeViewId"] = "v-2";

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect(ops[0].patch.payload?.["activeViewId"]).toBe("v-2");
    expect(ops[0].patch.payload?.["dataSourceId"]).toBe("ds-1");
  });

  it("a database block with no data source yet stores no dataSourceId key", () => {
    const blocks = [
      block({ id: "D", rank: rankBetween(null, null), type: "child_database", payload: {} }),
    ];
    const doc = blocksToDoc(blocks);
    expect(nodes(doc)[0]?.attrs?.["dataSourceId"]).toBeNull();
    expect(docToOps(blocks, doc, PAGE, gen)).toEqual([]);
  });

  it("keeps unknown media payload keys when the caption changes", () => {
    const blocks = [
      block({
        id: "M",
        rank: rankBetween(null, null),
        type: "image",
        payload: { assetId: "a1", notionCrop: { x: 1 } },
      }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node?.attrs) node.attrs["caption"] = [{ type: "text", text: "new" }];

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect(ops[0].patch.payload?.caption).toEqual([{ type: "text", text: "new" }]);
    expect(ops[0].patch.payload?.["notionCrop"]).toEqual({ x: 1 });
    expect(ops[0].patch.payload?.assetId).toBe("a1");
  });

  it("clearing an asset removes the key rather than storing an empty string", () => {
    const blocks = [
      block({ id: "M", rank: rankBetween(null, null), type: "image", payload: { assetId: "a1" } }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node?.attrs) node.attrs["assetId"] = null;

    const ops = docToOps(blocks, doc, PAGE, gen);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect("assetId" in (ops[0].patch.payload ?? {})).toBe(false);
  });
});

/* ------------------------------------------------------------------ columns */

/** A two-column layout: left holds A, right holds B (with a child of its own). */
function columnLayout(): Block[] {
  const r = rankBetween(null, null);
  const r2 = rankBetween(r, null);
  return [
    block({ id: "CL", rank: r, type: "column_list", payload: {} }),
    block({ id: "C1", parent: "CL", rank: r, type: "column", payload: { widthRatio: 0.6 } }),
    block({ id: "C2", parent: "CL", rank: r2, type: "column", payload: { widthRatio: 0.4 } }),
    block({ id: "A", parent: "C1", rank: r, payload: text("alpha") }),
    block({ id: "B", parent: "C2", rank: r, payload: text("bravo") }),
    block({ id: "B1", parent: "B", rank: r, payload: text("nested") }),
  ];
}

describe("columns — blocksToDoc", () => {
  it("nests column_list → column → flat block run", () => {
    const doc = blocksToDoc(columnLayout());
    const list = nodes(doc)[0];
    expect(list?.type).toBe("column_list");
    expect(list?.attrs?.["blockId"]).toBe("CL");
    expect(list?.content?.map((c) => c.type)).toEqual(["column", "column"]);

    const [left, right] = [list?.content?.[0], list?.content?.[1]];
    expect(left?.attrs?.["widthRatio"]).toBe(0.6);
    expect(right?.attrs?.["widthRatio"]).toBe(0.4);
    expect(left?.content?.map((c) => c.attrs?.["blockId"])).toEqual(["A"]);
    // Depth restarts inside a column, exactly like the page root.
    expect(right?.content?.map((c) => [c.attrs?.["blockId"], c.attrs?.["depth"]])).toEqual([
      ["B", 0],
      ["B1", 1],
    ]);
  });

  it("gives an empty column a paragraph so the schema stays satisfied", () => {
    const r = rankBetween(null, null);
    const blocks = [
      block({ id: "CL", rank: r, type: "column_list", payload: {} }),
      block({ id: "C1", parent: "CL", rank: r, type: "column", payload: {} }),
      block({ id: "C2", parent: "CL", rank: rankBetween(r, null), type: "column", payload: {} }),
    ];
    const list = nodes(blocksToDoc(blocks))[0];
    expect(list?.content?.[0]?.content?.map((c) => c.type)).toEqual(["paragraph"]);
    expect(list?.content?.[1]?.content?.map((c) => c.type)).toEqual(["paragraph"]);
  });

  it("pulls mis-parented children into the first column rather than losing them", () => {
    const r = rankBetween(null, null);
    const blocks = [
      block({ id: "CL", rank: r, type: "column_list", payload: {} }),
      block({ id: "C1", parent: "CL", rank: r, type: "column", payload: {} }),
      block({ id: "C2", parent: "CL", rank: rankBetween(r, null), type: "column", payload: {} }),
      block({ id: "STRAY", parent: "CL", rank: rankBetween(r, null), payload: text("orphan") }),
    ];
    const list = nodes(blocksToDoc(blocks))[0];
    expect(list?.content?.[0]?.content?.map((c) => c.attrs?.["blockId"])).toEqual(["STRAY"]);
  });
});

describe("columns — docToOps", () => {
  it("produces no ops for an unchanged layout", () => {
    const blocks = columnLayout();
    expect(docToOps(blocks, blocksToDoc(blocks), PAGE, gen)).toEqual([]);
  });

  it("rebuilds parentBlockId from the nesting, not from depth", () => {
    const blocks = columnLayout();
    const ops = docToOps([], blocksToDoc(blocks), PAGE, gen);
    const parents = new Map(
      ops
        .filter((op): op is Extract<BlockOp, { kind: "insert" }> => op.kind === "insert")
        .map((op) => [op.block.id, op.block.parentBlockId]),
    );
    expect(parents.get("CL")).toBeNull();
    expect(parents.get("C1")).toBe("CL");
    expect(parents.get("C2")).toBe("CL");
    expect(parents.get("A")).toBe("C1");
    expect(parents.get("B")).toBe("C2");
    expect(parents.get("B1")).toBe("B");
  });

  it("inserts a column_list before the columns that reference it", () => {
    const doc = blocksToDoc(columnLayout());
    const ops = docToOps([], doc, PAGE, gen);
    const order = ops
      .filter((op): op is Extract<BlockOp, { kind: "insert" }> => op.kind === "insert")
      .map((op) => op.block.id);
    expect(order.indexOf("CL")).toBeLessThan(order.indexOf("C1"));
    expect(order.indexOf("C1")).toBeLessThan(order.indexOf("A"));
    expect(order.indexOf("C2")).toBeLessThan(order.indexOf("B"));
  });

  it("dragging the divider writes payload.widthRatio on both columns", () => {
    const blocks = columnLayout();
    const doc = blocksToDoc(blocks);
    const list = nodes(doc)[0];
    if (list?.content?.[0]?.attrs) list.content[0].attrs["widthRatio"] = 0.75;
    if (list?.content?.[1]?.attrs) list.content[1].attrs["widthRatio"] = 0.25;

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(2);
    const ratios = ops
      .filter((op): op is Extract<BlockOp, { kind: "update" }> => op.kind === "update")
      .map((op) => [op.blockId, op.patch.payload?.widthRatio]);
    expect(ratios).toEqual([
      ["C1", 0.75],
      ["C2", 0.25],
    ]);
  });

  it("moving a block between columns is a single move op", () => {
    const blocks = columnLayout();
    const doc = blocksToDoc(blocks);
    const list = nodes(doc)[0];
    const left = list?.content?.[0];
    const right = list?.content?.[1];
    if (!left || !right) throw new Error("fixture");
    const moved = left.content?.[0];
    if (!moved) throw new Error("fixture");
    left.content = [{ type: "paragraph", attrs: { blockId: "FILL", depth: 0 } }];
    right.content = [moved, ...(right.content ?? [])];

    const ops = docToOps(blocks, doc, PAGE, gen);
    const moves = ofKind(ops, "move");
    expect(moves).toHaveLength(1);
    if (moves[0]?.kind !== "move") throw new Error("expected a move");
    expect(moves[0].blockId).toBe("A");
    expect(moves[0].parentBlockId).toBe("C2");
  });

  it("dissolving a layout deletes only the container, not its former content", () => {
    const blocks = columnLayout();
    // The document after `dissolveColumns` lifted C2's content to page level.
    const doc: PmDoc = {
      type: "doc",
      content: [
        { type: "paragraph", attrs: { blockId: "B", depth: 0 }, content: [{ type: "text", text: "bravo" }] },
        { type: "paragraph", attrs: { blockId: "B1", depth: 1 }, content: [{ type: "text", text: "nested" }] },
      ],
    };
    const ops = docToOps(blocks, doc, PAGE, gen);
    const deleted = ofKind(ops, "delete").map((op) => (op.kind === "delete" ? op.blockId : ""));
    // Deleting CL archives its whole subtree, so C1/C2/A need no op of their own.
    expect(deleted).toEqual(["CL"]);
    const moves = ofKind(ops, "move");
    expect(moves.map((op) => (op.kind === "move" ? op.blockId : ""))).toEqual(["B"]);
    if (moves[0]?.kind !== "move") throw new Error("expected a move");
    expect(moves[0].parentBlockId).toBeNull();
  });
});

describe("docToOps — edits", () => {
  it("a text edit produces exactly one update carrying the base version", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const target = nodes(doc)[1];
    if (target) target.content = [{ type: "text", text: "bravo!" }];

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op?.kind).toBe("update");
    if (op?.kind !== "update") throw new Error("expected an update");
    expect(op.blockId).toBe("B");
    expect(op.baseVersion).toBe(5);
    expect(op.patch.payload?.richText).toEqual([{ type: "text", text: "bravo!" }]);
  });

  it("toggling a to-do checkbox updates payload.checked", () => {
    const rank = rankBetween(null, null);
    const blocks = [
      block({ id: "T", rank, type: "to_do", payload: { ...text("milk"), checked: false } }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node?.attrs) node.attrs["checked"] = true;

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect(ops[0].patch.payload?.checked).toBe(true);
  });

  it("preserves unknown payload keys when updating", () => {
    const rank = rankBetween(null, null);
    const blocks = [
      block({ id: "P", rank, payload: { ...text("hi"), notionFlavour: { a: 1 } } }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node) node.content = [{ type: "text", text: "hi there" }];

    const ops = docToOps(blocks, doc, PAGE, gen);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect(ops[0].patch.payload?.["notionFlavour"]).toEqual({ a: 1 });
  });

  it("a turn-into changes the block type in place", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[0];
    if (node) node.type = "heading1";

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "update") throw new Error("expected an update");
    expect(ops[0].patch.type).toBe("heading1");
  });
});

describe("docToOps — structure", () => {
  it("splitting a paragraph produces one insert plus one update", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const list = nodes(doc);
    const first = list[0];
    if (first) first.content = [{ type: "text", text: "al" }];
    list.splice(1, 0, {
      type: "paragraph",
      attrs: { blockId: null, depth: 0 },
      content: [{ type: "text", text: "pha" }],
    });

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ofKind(ops, "insert")).toHaveLength(1);
    expect(ofKind(ops, "update")).toHaveLength(1);
    expect(ofKind(ops, "move")).toHaveLength(0);
    expect(ofKind(ops, "delete")).toHaveLength(0);

    const insert = ofKind(ops, "insert")[0];
    if (insert?.kind !== "insert") throw new Error("expected an insert");
    expect(insert.block.pageId).toBe(PAGE);
    expect(insert.block.parentBlockId).toBeNull();
    // The new rank must sort between the two existing siblings.
    expect(insert.block.rank > blocks[0]!.rank).toBe(true);
    expect(insert.block.rank < blocks[1]!.rank).toBe(true);
  });

  it("appending at the end of the page inserts without touching neighbours", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    nodes(doc).push({ type: "paragraph", attrs: { blockId: null, depth: 0 } });

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.rank > blocks[2]!.rank).toBe(true);
  });

  it("reordering two siblings produces a single move", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const list = nodes(doc);
    const [a, b, c] = [list[0], list[1], list[2]];
    if (!a || !b || !c) throw new Error("fixture");
    doc.content = [b, a, c];

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ofKind(ops, "update")).toHaveLength(0);
    expect(ofKind(ops, "move")).toHaveLength(1);
    const move = ops[0];
    if (move?.kind !== "move") throw new Error("expected a move");
    expect(move.blockId).toBe("A");
    expect(move.rank > blocks[1]!.rank).toBe(true);
    expect(move.rank < blocks[2]!.rank).toBe(true);
  });

  it("indenting a block re-parents it under the block above", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[1];
    if (node?.attrs) node.attrs["depth"] = 1;

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "move") throw new Error("expected a move");
    expect(ops[0].blockId).toBe("B");
    expect(ops[0].parentBlockId).toBe("A");
  });

  it("outdenting a nested block returns it to the root", () => {
    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    const blocks = [
      block({ id: "P", rank: r1 }),
      block({ id: "K", parent: "P", rank: r1 }),
      block({ id: "Q", rank: r2 }),
    ];
    const doc = blocksToDoc(blocks);
    const node = nodes(doc)[1];
    if (node?.attrs) node.attrs["depth"] = 0;

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "move") throw new Error("expected a move");
    expect(ops[0].blockId).toBe("K");
    expect(ops[0].parentBlockId).toBeNull();
    expect(ops[0].rank > blocks[0]!.rank).toBe(true);
    expect(ops[0].rank < blocks[2]!.rank).toBe(true);
  });

  it("indenting a subtree moves only the block whose parent changed", () => {
    const r1 = rankBetween(null, null);
    const r2 = rankBetween(r1, null);
    const blocks = [
      block({ id: "A", rank: r1 }),
      block({ id: "B", rank: r2 }),
      block({ id: "C", parent: "B", rank: r1 }),
    ];
    const doc = blocksToDoc(blocks);
    const list = nodes(doc);
    if (list[1]?.attrs) list[1].attrs["depth"] = 1;
    if (list[2]?.attrs) list[2].attrs["depth"] = 2;

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "move") throw new Error("expected a move");
    expect(ops[0].blockId).toBe("B");
    expect(ops[0].parentBlockId).toBe("A");
  });

  it("deleting a block produces one delete", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    doc.content = nodes(doc).filter((n) => n.attrs?.["blockId"] !== "B");

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "delete") throw new Error("expected a delete");
    expect(ops[0].blockId).toBe("B");
  });

  it("deleting a parent emits one delete, not one per descendant", () => {
    const r1 = rankBetween(null, null);
    const blocks = [
      block({ id: "P", rank: r1 }),
      block({ id: "K", parent: "P", rank: r1 }),
      block({ id: "G", parent: "K", rank: r1 }),
    ];
    const ops = docToOps(blocks, { type: "doc", content: [] }, PAGE, gen);
    expect(ops).toHaveLength(1);
    if (ops[0]?.kind !== "delete") throw new Error("expected a delete");
    expect(ops[0].blockId).toBe("P");
  });

  it("re-minting is never triggered by an id the server has not seen yet", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    nodes(doc).push({ type: "paragraph", attrs: { blockId: "fresh-1", depth: 0 } });

    const first = docToOps(blocks, doc, PAGE, gen);
    if (first[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(first[0].block.id).toBe("fresh-1");

    // Same document diffed against the mirror it just produced: nothing left.
    expect(docToOps(applyOpsLocally(blocks, first), doc, PAGE, gen)).toEqual([]);
  });
});

describe("applyOpsLocally", () => {
  it("mirrors core's version arithmetic", () => {
    const blocks = abc();
    const ops: BlockOp[] = [
      { opId: "o1", kind: "update", blockId: "A", baseVersion: 2, patch: { payload: text("x") } },
      { opId: "o2", kind: "move", blockId: "A", parentBlockId: null, rank: rankBetween(null, null) },
    ];
    const next = applyOpsLocally(blocks, ops);
    expect(next.find((b) => b.id === "A")?.version).toBe(4);
  });

  it("drops the whole subtree on delete", () => {
    const r1 = rankBetween(null, null);
    const blocks = [
      block({ id: "P", rank: r1 }),
      block({ id: "K", parent: "P", rank: r1 }),
      block({ id: "G", parent: "K", rank: r1 }),
    ];
    const next = applyOpsLocally(blocks, [{ opId: "o", kind: "delete", blockId: "P" }]);
    expect(next).toEqual([]);
  });

  it("closes the loop: mirror after ops matches the document that produced them", () => {
    const blocks = abc();
    const doc = blocksToDoc(blocks);
    const list = nodes(doc);
    if (list[0]) list[0].content = [{ type: "text", text: "edited" }];
    // The structure plugin stamps ids as soon as a node appears, so the diff
    // sees a real id here rather than a placeholder.
    list.splice(1, 0, { type: "paragraph", attrs: { blockId: "new-1", depth: 1 } });
    doc.content = list.filter((n) => n.attrs?.["blockId"] !== "C");

    const ops = docToOps(blocks, doc, PAGE, gen);
    expect(ops.length).toBeGreaterThan(0);
    const mirror = applyOpsLocally(blocks, ops);
    expect(docToOps(mirror, doc, PAGE, gen)).toEqual([]);
  });
});
