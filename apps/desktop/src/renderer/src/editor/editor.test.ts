/**
 * @vitest-environment jsdom
 *
 * Headless keyboard/markdown parity tests. A real TipTap instance is mounted in
 * jsdom; typing is fed through `handleTextInput` (so input rules run exactly as
 * they do for a human) and keys through `handleKeyDown` (so the keymap and the
 * slash/selection plugins run in their real priority order).
 */

import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import type { Content } from "@tiptap/core";
import { kumiExtensions } from "./extensions";
import { topBlocks } from "./doc";
import { getSlashState, filterSlashItems, applySlashItem } from "./slash";
import { getBlockSelection } from "./selection";
import { docToOps } from "../lib/blockSync";
import type { PmDoc } from "../lib/pmjson";

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

function press(
  editor: Editor,
  key: string,
  mods: { shift?: boolean; ctrl?: boolean } = {},
): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    shiftKey: mods.shift === true,
    ctrlKey: mods.ctrl === true,
    bubbles: true,
    cancelable: true,
  });
  return editor.view.someProp("handleKeyDown", (fn) => fn(editor.view, event)) === true;
}

/** `type@depth:text` for each top-level block. */
function summary(editor: Editor): string[] {
  return topBlocks(editor.state.doc).map(
    (block) => `${block.node.type.name}@${block.depth}:${block.node.textContent}`,
  );
}

function types(editor: Editor): string[] {
  return topBlocks(editor.state.doc).map((block) => block.node.type.name);
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

/* ------------------------------------------------------------ input rules */

describe("markdown input shortcuts", () => {
  const cases: Array<[string, string]> = [
    ["# ", "heading1"],
    ["## ", "heading2"],
    ["### ", "heading3"],
    ["- ", "bulleted_list_item"],
    ["* ", "bulleted_list_item"],
    ["1. ", "numbered_list_item"],
    ["[] ", "to_do"],
    ["> ", "toggle"],
    ['" ', "quote"],
    ["``` ", "code"],
  ];

  for (const [shortcut, expected] of cases) {
    it(`turns ${JSON.stringify(shortcut)} into ${expected}`, () => {
      const editor = makeEditor();
      type(editor, shortcut);
      expect(types(editor)).toEqual([expected]);
      expect(editor.state.doc.textContent).toBe("");
    });
  }

  it("[x] produces a checked to-do", () => {
    const editor = makeEditor();
    type(editor, "[x] ");
    expect(topBlocks(editor.state.doc)[0]?.node.attrs["checked"]).toBe(true);
  });

  it("``` with a language sets it", () => {
    const editor = makeEditor();
    type(editor, "```typescript ");
    expect(topBlocks(editor.state.doc)[0]?.node.attrs["language"]).toBe("typescript");
  });

  it("--- inserts a divider and leaves an empty paragraph below", () => {
    const editor = makeEditor();
    type(editor, "---");
    expect(types(editor)).toEqual(["divider", "paragraph"]);
  });

  it("does not fire mid-line", () => {
    const editor = makeEditor();
    type(editor, "a - b");
    expect(types(editor)).toEqual(["paragraph"]);
    expect(editor.state.doc.textContent).toBe("a - b");
  });

  it("**bold** applies the bold mark", () => {
    const editor = makeEditor();
    type(editor, "**loud**");
    const marks = editor.state.doc.firstChild?.firstChild?.marks.map((m) => m.type.name);
    expect(marks).toEqual(["bold"]);
    expect(editor.state.doc.textContent).toBe("loud");
  });

  it("~strike~ applies the strike mark", () => {
    const editor = makeEditor();
    type(editor, "x ~gone~");
    const last = editor.state.doc.firstChild?.lastChild;
    expect(last?.marks.map((m) => m.type.name)).toEqual(["strike"]);
  });
});

/* ---------------------------------------------------------------- Enter */

describe("Enter", () => {
  it("splits a paragraph in two", () => {
    const editor = makeEditor(paragraphs(["hello world"]));
    editor.commands.setTextSelection(6);
    press(editor, "Enter");
    expect(summary(editor)).toEqual(["paragraph@0:hello", "paragraph@0: world"]);
  });

  it("continues a bulleted list", () => {
    const editor = makeEditor();
    type(editor, "- one");
    press(editor, "Enter");
    type(editor, "two");
    expect(summary(editor)).toEqual([
      "bulleted_list_item@0:one",
      "bulleted_list_item@0:two",
    ]);
  });

  it("continues a to-do with the checkbox reset", () => {
    const editor = makeEditor();
    type(editor, "[x] done");
    press(editor, "Enter");
    const blocks = topBlocks(editor.state.doc);
    expect(blocks.map((b) => b.node.type.name)).toEqual(["to_do", "to_do"]);
    expect(blocks[0]?.node.attrs["checked"]).toBe(true);
    expect(blocks[1]?.node.attrs["checked"]).toBe(false);
  });

  it("exits an empty list item to a paragraph", () => {
    const editor = makeEditor();
    type(editor, "- one");
    press(editor, "Enter");
    press(editor, "Enter");
    expect(summary(editor)).toEqual(["bulleted_list_item@0:one", "paragraph@0:"]);
  });

  it("outdents an empty nested list item before turning it into a paragraph", () => {
    const editor = makeEditor();
    type(editor, "- one");
    press(editor, "Enter");
    press(editor, "Tab");
    press(editor, "Enter");
    expect(summary(editor)).toEqual([
      "bulleted_list_item@0:one",
      "bulleted_list_item@0:",
    ]);
  });

  it("starts a nested child inside a toggle", () => {
    const editor = makeEditor();
    type(editor, "> section");
    press(editor, "Enter");
    type(editor, "inside");
    expect(summary(editor)).toEqual(["toggle@0:section", "paragraph@1:inside"]);
  });

  it("leaves a heading for a paragraph when split at the end", () => {
    const editor = makeEditor();
    type(editor, "# Title");
    press(editor, "Enter");
    expect(types(editor)).toEqual(["heading1", "paragraph"]);
  });

  it("inserts a newline inside a code block", () => {
    const editor = makeEditor();
    type(editor, "``` ");
    type(editor, "a");
    press(editor, "Enter");
    type(editor, "b");
    expect(types(editor)).toEqual(["code"]);
    expect(editor.state.doc.textContent).toBe("a\nb");
  });
});

/* ------------------------------------------------------------ Backspace */

describe("Backspace at block start", () => {
  it("turns a heading back into a paragraph", () => {
    const editor = makeEditor();
    type(editor, "# Title");
    editor.commands.setTextSelection(1);
    press(editor, "Backspace");
    expect(summary(editor)).toEqual(["paragraph@0:Title"]);
  });

  it("outdents before merging", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    editor.commands.setTextSelection(6); // start of "two"
    press(editor, "Tab");
    expect(topBlocks(editor.state.doc)[1]?.depth).toBe(1);
    press(editor, "Backspace");
    expect(summary(editor)).toEqual(["paragraph@0:one", "paragraph@0:two"]);
  });

  it("merges with the previous block", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    editor.commands.setTextSelection(6); // start of "two"
    press(editor, "Backspace");
    expect(summary(editor)).toEqual(["paragraph@0:onetwo"]);
  });

  it("hands focus back to the title from the first block", () => {
    let left = 0;
    const element = document.createElement("div");
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: kumiExtensions({ onLeaveTop: () => (left += 1) }),
      content: paragraphs([""]),
    });
    editors.push(editor);
    editor.commands.setTextSelection(1);
    press(editor, "Backspace");
    expect(left).toBe(1);
  });
});

/* ------------------------------------------------- indent / move blocks */

describe("Tab and block movement", () => {
  it("indents at most one level deeper than the block above", () => {
    const editor = makeEditor(paragraphs(["one", "two"]));
    editor.commands.setTextSelection(6); // start of "two"
    press(editor, "Tab");
    press(editor, "Tab");
    expect(topBlocks(editor.state.doc)[1]?.depth).toBe(1);
  });

  it("never indents the first block", () => {
    const editor = makeEditor(paragraphs(["only"]));
    editor.commands.setTextSelection(1);
    press(editor, "Tab");
    expect(topBlocks(editor.state.doc)[0]?.depth).toBe(0);
  });

  it("carries descendants when indenting", () => {
    const editor = makeEditor(paragraphs(["a", "b", "c"]));
    editor.commands.setTextSelection(8); // inside "c"
    press(editor, "Tab");
    editor.commands.setTextSelection(5); // inside "b"
    press(editor, "Tab");
    expect(summary(editor)).toEqual(["paragraph@0:a", "paragraph@1:b", "paragraph@2:c"]);
  });

  it("Shift+Tab outdents", () => {
    const editor = makeEditor(paragraphs(["a", "b"]));
    editor.commands.setTextSelection(5);
    press(editor, "Tab");
    press(editor, "Tab", { shift: true });
    expect(topBlocks(editor.state.doc)[1]?.depth).toBe(0);
  });

  it("Ctrl+Shift+ArrowUp moves the block above its sibling", () => {
    const editor = makeEditor(paragraphs(["a", "b"]));
    editor.commands.setTextSelection(5);
    press(editor, "ArrowUp", { ctrl: true, shift: true });
    expect(summary(editor)).toEqual(["paragraph@0:b", "paragraph@0:a"]);
  });

  it("Ctrl+Shift+ArrowDown moves a block past its sibling's subtree", () => {
    const editor = makeEditor(paragraphs(["a", "b", "c"]));
    editor.commands.setTextSelection(8);
    press(editor, "Tab"); // c becomes a child of b
    editor.commands.setTextSelection(1); // inside "a"
    press(editor, "ArrowDown", { ctrl: true, shift: true });
    expect(summary(editor)).toEqual(["paragraph@0:b", "paragraph@1:c", "paragraph@0:a"]);
  });
});

/* --------------------------------------------------------- the slash menu */

describe("slash menu", () => {
  it("opens on / at the start of a block and filters as you type", () => {
    const editor = makeEditor();
    type(editor, "/");
    expect(getSlashState(editor.state).active).toBe(true);
    type(editor, "quo");
    const state = getSlashState(editor.state);
    expect(state.query).toBe("quo");
    expect(filterSlashItems(state.query).map((item) => item.label)).toEqual(["Quote"]);
  });

  it("does not open mid-word", () => {
    const editor = makeEditor();
    type(editor, "and/or");
    expect(getSlashState(editor.state).active).toBe(false);
  });

  it("closes when nothing matches", () => {
    const editor = makeEditor();
    type(editor, "/zzzz");
    expect(getSlashState(editor.state).active).toBe(false);
  });

  it("Escape closes it", () => {
    const editor = makeEditor();
    type(editor, "/");
    press(editor, "Escape");
    expect(getSlashState(editor.state).active).toBe(false);
  });

  it("applying an item removes the query and turns the block", () => {
    const editor = makeEditor();
    type(editor, "/quo");
    const item = filterSlashItems("quo")[0];
    expect(item).toBeDefined();
    if (item) applySlashItem(editor, item);
    expect(summary(editor)).toEqual(["quote@0:"]);
    expect(getSlashState(editor.state).active).toBe(false);
  });

  it("arrow keys move the highlighted row", () => {
    const editor = makeEditor();
    type(editor, "/");
    press(editor, "ArrowDown");
    press(editor, "ArrowDown");
    expect(getSlashState(editor.state).index).toBe(2);
    press(editor, "ArrowUp");
    expect(getSlashState(editor.state).index).toBe(1);
  });
});

/* ------------------------------------------------------- block selection */

describe("block selection", () => {
  it("Escape selects the current block", () => {
    const editor = makeEditor(paragraphs(["a", "b"]));
    editor.commands.setTextSelection(5);
    press(editor, "Escape");
    expect(getBlockSelection(editor.state)).toEqual({ anchor: 1, head: 1 });
  });

  it("arrows extend and move the selection", () => {
    const editor = makeEditor(paragraphs(["a", "b", "c"]));
    editor.commands.setTextSelection(1);
    press(editor, "Escape");
    press(editor, "ArrowDown", { shift: true });
    expect(getBlockSelection(editor.state)).toEqual({ anchor: 0, head: 1 });
  });

  it("Backspace deletes the selected blocks", () => {
    const editor = makeEditor(paragraphs(["a", "b", "c"]));
    editor.commands.setTextSelection(1);
    press(editor, "Escape");
    press(editor, "ArrowDown", { shift: true });
    press(editor, "Backspace");
    expect(summary(editor)).toEqual(["paragraph@0:c"]);
  });

  it("Ctrl+D duplicates the selected blocks with fresh ids", () => {
    const editor = makeEditor(paragraphs(["a"]));
    editor.commands.setTextSelection(1);
    press(editor, "Escape");
    press(editor, "d", { ctrl: true });
    const blocks = topBlocks(editor.state.doc);
    expect(blocks.map((b) => b.node.textContent)).toEqual(["a", "a"]);
    expect(blocks[0]?.node.attrs["blockId"]).not.toBe(blocks[1]?.node.attrs["blockId"]);
  });

  it("a text selection across blocks becomes a block selection", () => {
    const editor = makeEditor(paragraphs(["alpha", "bravo"]));
    editor.commands.setTextSelection({ from: 2, to: 10 });
    expect(getBlockSelection(editor.state)).toEqual({ anchor: 0, head: 1 });
  });
});

/* -------------------------------------------------------------- identity */

describe("structure invariants", () => {
  it("stamps a unique blockId on every new block", () => {
    const editor = makeEditor();
    type(editor, "one");
    press(editor, "Enter");
    type(editor, "two");
    const ids = topBlocks(editor.state.doc).map((b) => b.node.attrs["blockId"]);
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a live editing session diffs into exactly the ops the page needs", () => {
    const editor = makeEditor(paragraphs(["one"]));
    const before = [
      {
        id: "b0",
        pageId: "p",
        parentBlockId: null,
        rank: "a0",
        type: "paragraph" as const,
        payload: { richText: [{ type: "text" as const, text: "one" }] },
        version: 1,
        archived: false,
        createdAt: 0,
        updatedAt: 0,
      },
    ];
    editor.commands.setTextSelection(4);
    press(editor, "Enter");
    type(editor, "- two");

    const ops = docToOps(before, editor.getJSON() as PmDoc, "p");
    expect(ops.map((op) => op.kind)).toEqual(["insert"]);
    const insert = ops[0];
    if (insert?.kind !== "insert") throw new Error("expected an insert");
    expect(insert.block.type).toBe("bulleted_list_item");
    expect(insert.block.rank > "a0").toBe(true);
  });
});
