/**
 * The "/" command menu.
 *
 * The plugin owns everything stateful — whether the menu is open, the query
 * text, and the highlighted row — so keyboard handling runs inside ProseMirror
 * (ahead of the editor's own keymap) and React is a pure renderer of that state.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { BLOCK_TYPE_INFO, INSERT_BLOCK_INFO, type EditorBlockType } from "../lib/blockTypes";
import { EQUATION_SPAN } from "../lib/richText";
import { setBlockType, currentIndex } from "./blockCommands";
import { insertColumnLayout } from "./columns";
import { BLOCK_EDIT_EVENT, type BlockEditDetail, type BlockEditKind } from "./interactions";
import { blocksIn, caretContainer } from "./doc";

export interface SlashState {
  active: boolean;
  /** Position of the "/" itself. */
  from: number;
  query: string;
  index: number;
}

const CLOSED: SlashState = { active: false, from: 0, query: "", index: 0 };

export const slashKey = new PluginKey<SlashState>("kumiSlash");

export function getSlashState(state: EditorState): SlashState {
  return slashKey.getState(state) ?? CLOSED;
}

export type SlashGroup = "basic" | "media" | "advanced";

export interface SlashItem {
  key: string;
  label: string;
  hint: string;
  glyph: string;
  shortcut?: string;
  keywords: string[];
  group: SlashGroup;
  /** Block type to turn the caret's block into, or null for a custom action. */
  blockType: EditorBlockType | null;
  /** Non-block insertions that have no block type of their own. */
  action?: "inline_equation";
}

export const SLASH_GROUP_LABEL: Readonly<Record<SlashGroup, string>> = {
  basic: "Basic blocks",
  media: "Media",
  advanced: "Advanced",
};

const INLINE_EQUATION: SlashItem = {
  key: "inline_equation",
  label: "Inline equation",
  hint: "Insert math inside a line of text.",
  glyph: "𝑥",
  shortcut: "Ctrl+Shift+E",
  keywords: ["inline", "equation", "math", "katex", "latex", "tex"],
  group: "advanced",
  blockType: null,
  action: "inline_equation",
};

export const SLASH_ITEMS: readonly SlashItem[] = [
  ...BLOCK_TYPE_INFO.map(
    (info): SlashItem => ({
      key: info.type,
      label: info.label,
      hint: info.hint,
      glyph: info.glyph,
      ...(info.shortcut === undefined ? {} : { shortcut: info.shortcut }),
      keywords: info.keywords,
      group: "basic",
      blockType: info.type,
    }),
  ),
  ...INSERT_BLOCK_INFO.map(
    (info): SlashItem => ({
      key: info.type,
      label: info.label,
      hint: info.hint,
      glyph: info.glyph,
      ...(info.shortcut === undefined ? {} : { shortcut: info.shortcut }),
      keywords: info.keywords,
      group: info.group ?? "advanced",
      blockType: info.type,
    }),
  ),
  INLINE_EQUATION,
];

export function filterSlashItems(query: string): SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...SLASH_ITEMS];
  return SLASH_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(needle) ||
      item.keywords.some((keyword) => keyword.startsWith(needle)),
  );
}

/** Attributes a freshly inserted block of `type` needs to be well-formed. */
function initialAttrs(type: EditorBlockType): Record<string, unknown> {
  switch (type) {
    case "to_do":
      return { checked: false };
    case "toggle":
      return { collapsed: false };
    case "callout":
      return { icon: "💡" };
    case "code":
      return { language: "plain text" };
    case "equation":
      return { expression: "" };
    case "image":
    case "file":
    case "video":
    case "audio":
      return { assetId: null, caption: null, width: null };
    case "bookmark":
      return { url: null, title: null, description: null, favicon: null };
    case "embed":
      return { url: null };
    case "child_database":
      // The data source is created after insertion, by the BlockEditor.
      return { dataSourceId: null, activeViewId: null };
    case "child_page":
      // The page is created after insertion, by the BlockEditor.
      return { pageId: null };
    default:
      return {};
  }
}

/** Blocks whose editor opens the moment they are inserted, Notion-style. */
const PROMPT_ON_INSERT: Readonly<Partial<Record<EditorBlockType, BlockEditKind>>> = {
  equation: "equation",
  image: "media",
  file: "media",
  video: "media",
  audio: "media",
  bookmark: "url",
  embed: "url",
  child_database: "database",
  child_page: "page",
};

function promptFor(editor: Editor, type: EditorBlockType): void {
  const kind = PROMPT_ON_INSERT[type];
  if (kind === undefined) return;
  const state = editor.state;
  const block = blocksIn(caretContainer(state))[currentIndex(state)];
  if (!block || block.node.type.name !== type) return;
  let rect: DOMRect;
  try {
    const coords = editor.view.coordsAtPos(block.pos);
    rect = new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
  } catch {
    return;
  }
  const detail: BlockEditDetail = {
    pos: block.pos,
    kind,
    value: kind === "media" ? type : "",
    nodeType: type,
    rect,
  };
  editor.view.dom.dispatchEvent(
    new CustomEvent<BlockEditDetail>(BLOCK_EDIT_EVENT, { detail, bubbles: true }),
  );
}

/** Remove the "/query" text and run the chosen item. */
export function applySlashItem(editor: Editor, item: SlashItem): void {
  const state = editor.state;
  const slash = getSlashState(state);
  const tr = state.tr;
  if (slash.active) {
    tr.delete(slash.from, Math.max(slash.from, state.selection.head));
  }
  tr.setMeta(slashKey, { close: true });
  editor.view.dispatch(tr);

  if (item.action === "inline_equation") {
    insertInlineEquation(editor);
    return;
  }
  const type = item.blockType;
  if (type === null) return;

  if (type === "column_list") {
    insertColumnLayout(2)(editor.state, editor.view.dispatch);
    editor.view.focus();
    return;
  }

  const next = editor.state;
  setBlockType(currentIndex(next), type, initialAttrs(type))(next, editor.view.dispatch);
  editor.view.focus();
  promptFor(editor, type);
}

/** Drop an empty inline equation at the caret and open its editor. */
export function insertInlineEquation(editor: Editor): void {
  const type = editor.state.schema.nodes[EQUATION_SPAN];
  if (!type) return;
  const at = editor.state.selection.from;
  editor.view.dispatch(editor.state.tr.replaceSelectionWith(type.create({ expression: "" }), false));
  editor.view.focus();

  let rect: DOMRect;
  try {
    const coords = editor.view.coordsAtPos(Math.min(at, editor.state.doc.content.size));
    rect = new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top);
  } catch {
    return;
  }
  const detail: BlockEditDetail = {
    pos: at,
    kind: "equation",
    value: "",
    nodeType: EQUATION_SPAN,
    rect,
  };
  editor.view.dom.dispatchEvent(
    new CustomEvent<BlockEditDetail>(BLOCK_EDIT_EVENT, { detail, bubbles: true }),
  );
}

function closeMeta(tr: Transaction): boolean {
  const meta = tr.getMeta(slashKey) as { close?: boolean } | undefined;
  return meta?.close === true;
}

export const KumiSlashMenu = Extension.create({
  name: "kumiSlashMenu",
  // Ahead of the block keymap so Enter/Arrow keys drive the menu when it is open.
  priority: 200,

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<SlashState>({
        key: slashKey,

        state: {
          init: () => CLOSED,
          apply(tr, previous, _oldState, newState) {
            if (closeMeta(tr)) return CLOSED;
            const meta = tr.getMeta(slashKey) as { index?: number } | undefined;

            if (previous.active) {
              const from = tr.mapping.map(previous.from, -1);
              const head = newState.selection.head;
              if (!newState.selection.empty || head <= from) return CLOSED;
              const trigger = newState.doc.textBetween(from, from + 1, "\n", "\n");
              if (trigger !== "/") return CLOSED;
              const query = newState.doc.textBetween(from + 1, head, "\n", "\n");
              if (query.includes("\n") || query.length > 32) return CLOSED;
              const matches = filterSlashItems(query);
              if (matches.length === 0) return CLOSED;
              const index = Math.min(meta?.index ?? previous.index, matches.length - 1);
              return { active: true, from, query, index: Math.max(0, index) };
            }

            if (!tr.docChanged || !newState.selection.empty) return CLOSED;
            const head = newState.selection.head;
            const resolved = newState.doc.resolve(head);
            if (resolved.parent.type.spec.code === true) return CLOSED;
            if (newState.doc.textBetween(Math.max(0, head - 1), head, "\n", "\n") !== "/") {
              return CLOSED;
            }
            const before = newState.doc.textBetween(Math.max(0, head - 2), head - 1, "\n", "\n");
            const atStart = resolved.parentOffset <= 1;
            if (!atStart && !/\s/.test(before)) return CLOSED;
            return { active: true, from: head - 1, query: "", index: 0 };
          },
        },

        props: {
          handleKeyDown: (view, event) => {
            const slash = getSlashState(view.state);
            if (!slash.active) return false;
            const matches = filterSlashItems(slash.query);
            if (matches.length === 0) return false;

            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(slashKey, { close: true }));
              return true;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const index = (slash.index + delta + matches.length) % matches.length;
              view.dispatch(view.state.tr.setMeta(slashKey, { index }));
              return true;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const item = matches[slash.index] ?? matches[0];
              if (!item) return false;
              applySlashItem(editor, item);
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});
