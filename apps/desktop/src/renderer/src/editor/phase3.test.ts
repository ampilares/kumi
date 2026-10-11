/**
 * @vitest-environment jsdom
 *
 * Phase 3 editor behaviour: the formatting toolbar's mark logic, KaTeX-backed
 * equations, media blocks, mentions, embeds and column layouts — all exercised
 * against a real TipTap instance so the schema, the structure plugin and the
 * persistence diff are all in the loop.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "@tiptap/core";
import type { Content } from "@tiptap/core";
import { kumiExtensions } from "./extensions";
import { allBlocks, topBlocks } from "./doc";
import { applySlashItem, filterSlashItems, insertInlineEquation } from "./slash";
import { applyMention, getMentionState } from "./mention";
import { setBlockAttrs } from "./blockCommands";
import { createColumnsFromDrop, insertColumnLayout } from "./columns";
import { embedSrc } from "./nodeViews";
import {
  activeMarks,
  colorLabel,
  looksLikeUrl,
  normalizeUrl,
  pageHref,
  parsePageHref,
} from "./marks";
import { COLUMN, COLUMN_LIST, docToOps } from "../lib/blockSync";
import type { PmDoc } from "../lib/pmjson";

vi.mock("../ipc", () => ({
  commands: {
    getAsset: () => Promise.resolve(null),
    search: () => Promise.resolve([]),
    getPage: () => Promise.resolve(null),
    getUserState: () => Promise.resolve({ recents: [] }),
  },
  assetUrl: (id: string) => `kumi-asset://${id}`,
  openAsset: () => Promise.resolve(),
  importAssets: () => Promise.resolve([]),
  fetchUrlMeta: () => Promise.resolve({ url: "", title: null, description: null, favicon: null }),
  pathForFile: () => "",
}));

const editors: Editor[] = [];

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
  document.body.innerHTML = "";
});

function makeEditor(content?: Content): Editor {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: kumiExtensions({}),
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] },
  });
  editors.push(editor);
  return editor;
}

/** Type text one character at a time, exactly like a keyboard does. */
function type(editor: Editor, text: string): void {
  for (const char of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (fn) =>
      fn(editor.view, from, to, char, () => editor.state.tr.insertText(char, from, to)),
    );
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

function paragraphs(texts: string[]): Content {
  return {
    type: "doc",
    content: texts.map((text, index) => ({
      type: "paragraph",
      attrs: { blockId: `b${index}`, depth: 0 },
      ...(text === "" ? {} : { content: [{ type: "text", text }] }),
    })),
  } as Content;
}

function types(editor: Editor): string[] {
  return topBlocks(editor.state.doc).map((block) => block.node.type.name);
}

function slashItem(label: string): ReturnType<typeof filterSlashItems>[number] {
  const item = filterSlashItems("").find((candidate) => candidate.label === label);
  if (!item) throw new Error(`no slash item labelled ${label}`);
  return item;
}

/* -------------------------------------------------------------- URL logic */

describe("link helpers", () => {
  it("upgrades bare hosts to https and leaves explicit schemes alone", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com/");
    expect(normalizeUrl("example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeUrl("http://a.test/")).toBe("http://a.test/");
    expect(normalizeUrl("kumi://page/abc")).toBe("kumi://page/abc");
  });

  it("refuses text that cannot be a URL", () => {
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("just some words")).toBeNull();
    expect(normalizeUrl("nodot")).toBeNull();
  });

  it("round-trips an internal page link", () => {
    expect(parsePageHref(pageHref("p-1"))).toBe("p-1");
    expect(parsePageHref("https://example.com")).toBeNull();
  });

  it("only offers the paste menu for an explicit http(s) URL", () => {
    expect(looksLikeUrl("https://a.test/x")).toBe(true);
    expect(looksLikeUrl("a.test")).toBe(false);
    expect(looksLikeUrl("https://a.test x")).toBe(false);
  });

  it("labels colours the way the menu shows them", () => {
    expect(colorLabel("red")).toBe("Red");
    expect(colorLabel("red_background")).toBe("Red background");
  });
});

describe("embed URLs", () => {
  it("turns every YouTube spelling into the embed player", () => {
    expect(embedSrc("https://www.youtube.com/watch?v=abc123")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123",
    );
    expect(embedSrc("https://youtu.be/abc123")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123",
    );
    expect(embedSrc("https://www.youtube.com/shorts/abc123")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123",
    );
    expect(embedSrc("https://www.youtube.com/watch?v=abc123&t=90")).toBe(
      "https://www.youtube-nocookie.com/embed/abc123?start=90",
    );
  });

  it("passes any other https page straight through, and refuses non-web schemes", () => {
    expect(embedSrc("https://example.com/x")).toBe("https://example.com/x");
    expect(embedSrc("file:///etc/passwd")).toBeNull();
    expect(embedSrc("not a url")).toBeNull();
  });
});

/* ------------------------------------------------------- formatting marks */

describe("selection toolbar mark state", () => {
  it("reports a mark active only when it covers the whole selection", () => {
    const editor = makeEditor(paragraphs(["hello world"]));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().toggleMark("bold").run();

    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(activeMarks(editor.state).bold).toBe(true);

    // Extending past the bold run makes it a partial selection.
    editor.commands.setTextSelection({ from: 1, to: 12 });
    expect(activeMarks(editor.state).bold).toBe(false);
  });

  it("stays in sync with the keyboard shortcuts", () => {
    const editor = makeEditor(paragraphs(["hello"]));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    // Inline code excludes every other mark, so it is checked on its own.
    for (const mark of ["bold", "italic", "underline", "strike"]) {
      editor.chain().toggleMark(mark).run();
    }
    expect(activeMarks(editor.state)).toMatchObject({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      code: false,
    });

    editor.chain().toggleMark("inlineCode").run();
    expect(activeMarks(editor.state).code).toBe(true);

    editor.chain().toggleMark("inlineCode").run();
    expect(activeMarks(editor.state).code).toBe(false);
  });

  it("surfaces the colour and the link href of a fully covered selection", () => {
    const editor = makeEditor(paragraphs(["hello"]));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().setMark("kumiColor", { color: "red_background" }).run();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.chain().setMark("link", { href: pageHref("p-9") }).run();

    editor.commands.setTextSelection({ from: 1, to: 6 });
    const marks = activeMarks(editor.state);
    expect(marks.color).toBe("red_background");
    expect(marks.link).toBe(pageHref("p-9"));
  });

  it("reports nothing for an empty document selection", () => {
    const editor = makeEditor(paragraphs([""]));
    editor.commands.setTextSelection(1);
    expect(activeMarks(editor.state).bold).toBe(false);
  });
});

/* --------------------------------------------------------------- mentions */

describe("mentions", () => {
  it("inserts a page mention chip and persists it as a mention span", () => {
    const editor = makeEditor(paragraphs(["hi "]));
    editor.commands.setTextSelection(4);
    applyMention(editor, { id: "page-7", title: "Roadmap", icon: "🚀" });

    const paragraph = editor.state.doc.firstChild;
    const chip = paragraph?.child(1);
    expect(chip?.type.name).toBe("mention_span");
    expect(chip?.attrs["mention"]).toEqual({ kind: "page", pageId: "page-7" });

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.payload.richText).toEqual([
      { type: "text", text: "hi " },
      { type: "mention", mention: { kind: "page", pageId: "page-7" } },
      { type: "text", text: " " },
    ]);
  });

  it('"@" opens the menu and accepting replaces the trigger and the query', () => {
    const editor = makeEditor(paragraphs([""]));
    editor.commands.setTextSelection(1);
    type(editor, "@road");
    expect(getMentionState(editor.state)).toMatchObject({ active: true, trigger: "@", query: "road" });

    applyMention(editor, { id: "page-7", title: "Roadmap", icon: null });
    expect(editor.state.doc.textContent).toBe(" ");
    expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe("mention_span");
  });

  it('"[[" opens the same menu, Notion-style', () => {
    const editor = makeEditor(paragraphs([""]));
    editor.commands.setTextSelection(1);
    type(editor, "[[plan");
    expect(getMentionState(editor.state)).toMatchObject({ active: true, trigger: "[[", query: "plan" });

    applyMention(editor, { id: "page-3", title: "Plan", icon: null });
    expect(editor.state.doc.textContent).toBe(" ");
  });

  it("does not open mid-word, so an email address is left alone", () => {
    const editor = makeEditor(paragraphs([""]));
    editor.commands.setTextSelection(1);
    type(editor, "allen@example.com");
    expect(getMentionState(editor.state).active).toBe(false);
  });
});

/* -------------------------------------------------------------- equations */

describe("equations", () => {
  it("the slash menu offers both a block and an inline equation", () => {
    expect(filterSlashItems("equation").map((item) => item.label)).toEqual([
      "Block equation",
      "Inline equation",
    ]);
  });

  it("Block equation turns the caret's block into an equation node", () => {
    const editor = makeEditor();
    applySlashItem(editor, slashItem("Block equation"));
    expect(types(editor)).toEqual(["equation"]);

    const block = topBlocks(editor.state.doc)[0];
    if (!block) throw new Error("no block");
    setBlockAttrs(block.pos, { expression: "e=mc^2" })(editor.state, editor.view.dispatch);

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.type).toBe("equation");
    expect(ops[0].block.payload.expression).toBe("e=mc^2");
  });

  it("Inline equation drops an atom into the current line", () => {
    const editor = makeEditor(paragraphs(["x = "]));
    editor.commands.setTextSelection(5);
    insertInlineEquation(editor);
    expect(editor.state.doc.firstChild?.lastChild?.type.name).toBe("equation_span");
  });
});

/* ------------------------------------------------------------------ media */

describe("media blocks", () => {
  for (const label of ["Image", "File", "Video", "Audio"]) {
    it(`${label} inserts an empty placeholder block`, () => {
      const editor = makeEditor();
      applySlashItem(editor, slashItem(label));
      const block = topBlocks(editor.state.doc)[0];
      expect(block?.node.type.name).toBe(label.toLowerCase());
      expect(block?.node.attrs["assetId"]).toBeNull();
    });
  }

  it("attaching an asset writes payload.assetId and nothing else", () => {
    const editor = makeEditor();
    applySlashItem(editor, slashItem("Image"));
    const block = topBlocks(editor.state.doc)[0];
    if (!block) throw new Error("no block");
    setBlockAttrs(block.pos, { assetId: "asset-1" })(editor.state, editor.view.dispatch);

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.type).toBe("image");
    expect(ops[0].block.payload).toEqual({ assetId: "asset-1" });
  });

  it("a resize stores the width as a fraction of the content column", () => {
    const editor = makeEditor();
    applySlashItem(editor, slashItem("Image"));
    const block = topBlocks(editor.state.doc)[0];
    if (!block) throw new Error("no block");
    setBlockAttrs(block.pos, { assetId: "a", width: 0.65 })(editor.state, editor.view.dispatch);

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.payload.width).toBe(0.65);
  });
});

/* -------------------------------------------------------- bookmark / embed */

describe("bookmark and embed", () => {
  it("a bookmark stores the fetched metadata in its payload", () => {
    const editor = makeEditor();
    applySlashItem(editor, slashItem("Web bookmark"));
    const block = topBlocks(editor.state.doc)[0];
    if (!block) throw new Error("no block");
    setBlockAttrs(block.pos, {
      url: "https://kumi.test",
      title: "Kumi",
      description: "Local Notion",
      favicon: "https://kumi.test/f.ico",
    })(editor.state, editor.view.dispatch);

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.type).toBe("bookmark");
    expect(ops[0].block.payload).toEqual({
      url: "https://kumi.test",
      title: "Kumi",
      description: "Local Notion",
      favicon: "https://kumi.test/f.ico",
    });
  });

  it("an embed stores only its URL", () => {
    const editor = makeEditor();
    applySlashItem(editor, slashItem("Embed"));
    const block = topBlocks(editor.state.doc)[0];
    if (!block) throw new Error("no block");
    setBlockAttrs(block.pos, { url: "https://youtu.be/abc" })(editor.state, editor.view.dispatch);

    const ops = docToOps([], editor.getJSON() as PmDoc, "p");
    if (ops[0]?.kind !== "insert") throw new Error("expected an insert");
    expect(ops[0].block.payload).toEqual({ url: "https://youtu.be/abc" });
  });
});

/* ---------------------------------------------------------------- columns */

function columnList(editor: Editor): { pos: number; node: ReturnType<Editor["state"]["doc"]["child"]> } | null {
  const block = topBlocks(editor.state.doc).find((b) => b.node.type.name === COLUMN_LIST);
  return block ? { pos: block.pos, node: block.node } : null;
}

describe("columns", () => {
  it('the slash item "2 columns" builds a two-column layout', () => {
    const editor = makeEditor(paragraphs(["hello"]));
    editor.commands.setTextSelection(3);
    insertColumnLayout(2)(editor.state, editor.view.dispatch);

    const list = columnList(editor);
    expect(list?.node.type.name).toBe(COLUMN_LIST);
    expect(list?.node.childCount).toBe(2);
    // The block the caret was in moves into the first column.
    expect(list?.node.child(0).firstChild?.textContent).toBe("hello");
    expect(list?.node.child(1).childCount).toBe(1);
  });

  it("every column and its content gets a stable blockId", () => {
    const editor = makeEditor(paragraphs(["hello"]));
    editor.commands.setTextSelection(3);
    insertColumnLayout(2)(editor.state, editor.view.dispatch);

    const ids = allBlocks(editor.state.doc).map((b) => b.node.attrs["blockId"]);
    const list = columnList(editor);
    const columnIds: unknown[] = [];
    list?.node.forEach((column) => columnIds.push(column.attrs["blockId"]));

    for (const id of [...ids, ...columnIds]) {
      expect(typeof id).toBe("string");
      expect(String(id).length).toBeGreaterThan(0);
    }
    expect(new Set([...ids, ...columnIds]).size).toBe(ids.length + columnIds.length);
  });

  it("dropping a block on another block's right edge creates the layout", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);

    expect(types(editor)).toEqual([COLUMN_LIST]);
    const list = columnList(editor);
    expect(list?.node.child(0).textContent).toBe("one");
    expect(list?.node.child(1).textContent).toBe("two");
  });

  it("carries a dragged block's descendants into the new column", () => {
    const editor = makeEditor(paragraphs(["target", "parent", "child"]));
    editor.commands.setTextSelection(17); // inside "child"
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(topBlocks(editor.state.doc)[2]?.pos ?? 0, undefined, {
        blockId: "b2",
        depth: 1,
      }),
    );
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);

    const list = columnList(editor);
    const dropped = list?.node.child(1);
    expect(dropped?.childCount).toBe(2);
    expect(dropped?.child(0).attrs["depth"]).toBe(0);
    expect(dropped?.child(1).attrs["depth"]).toBe(1);
  });

  it("a column may not contain another column layout", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);
    const column = editor.state.schema.nodes[COLUMN];
    const list = editor.state.schema.nodes[COLUMN_LIST];
    if (!column || !list) throw new Error("schema");
    expect(column.contentMatch.matchType(list)).toBeNull();
  });

  it("emptying a column dissolves the layout back into page blocks", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);
    const list = columnList(editor);
    if (!list) throw new Error("no layout");

    // Delete everything in the second column — the drag-the-last-block-out case.
    const second = list.node.child(1);
    const from = list.pos + 1 + list.node.child(0).nodeSize + 1;
    editor.view.dispatch(editor.state.tr.delete(from, from + second.content.size));

    expect(types(editor)).toEqual(["paragraph"]);
    expect(editor.state.doc.textContent).toBe("one");
  });

  it("keeps the remaining columns when a three-column layout loses one", () => {
    const editor = makeEditor(paragraphs(["hello"]));
    editor.commands.setTextSelection(3);
    insertColumnLayout(3)(editor.state, editor.view.dispatch);
    const list = columnList(editor);
    if (!list) throw new Error("no layout");
    expect(list.node.childCount).toBe(3);

    const third = list.node.child(2);
    const from =
      list.pos + 1 + list.node.child(0).nodeSize + list.node.child(1).nodeSize + 1;
    editor.view.dispatch(editor.state.tr.delete(from, from + third.content.size));

    expect(columnList(editor)?.node.childCount).toBe(2);
  });

  it("typing inside a column edits that column, not the layout", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);
    const list = columnList(editor);
    if (!list) throw new Error("no layout");

    editor.commands.setTextSelection(list.pos + 3);
    editor.commands.insertContent("!");
    expect(columnList(editor)?.node.child(0).textContent).toBe("!one");
    expect(types(editor)).toEqual([COLUMN_LIST]);
  });

  it("a layout round-trips through the persistence diff without ops", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    createColumnsFromDrop(1, 0, "right")(editor.state, editor.view.dispatch);

    const doc = editor.getJSON() as PmDoc;
    const ops = docToOps([], doc, "p");
    const blocks = ops
      .filter((op): op is Extract<(typeof ops)[number], { kind: "insert" }> => op.kind === "insert")
      .map((op) => ({
        ...op.block,
        version: 1,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
      }));
    expect(docToOps(blocks, doc, "p")).toEqual([]);
  });
});
