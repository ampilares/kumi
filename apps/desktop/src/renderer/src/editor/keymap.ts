/**
 * Notion keyboard semantics.
 *
 * Enter        split; continue a list; an empty list item outdents, then
 *              becomes a paragraph. Inside a toggle it creates a nested child.
 * Shift+Enter  soft line break inside the same block (stored as "\n").
 * Backspace    at block start: outdent → turn into paragraph → merge upwards;
 *              on the first empty block it hands focus back to the page title.
 * Tab          indent / outdent list items, to-dos and any other block.
 * Ctrl+Shift+↑ move the block (with its subtree) among its siblings.
 * Ctrl+A       select the block's text first, the whole page second.
 */

import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { LIST_TYPES } from "../lib/blockTypes";
import {
  currentIndex,
  deleteBlockRange,
  insertParagraphAfter,
  mergeWithPrevious,
  moveBlock,
  shiftDepth,
  splitBlockAs,
  turnInto,
  type Cmd,
} from "./blockCommands";
import { blocksIn, caretContainer } from "./doc";
import { insertInlineEquation } from "./slash";

export interface KumiKeymapOptions {
  /** Called when Backspace at the very start of the document should leave it. */
  onLeaveTop?: () => void;
}

const SPLIT_TO_PARAGRAPH = new Set(["heading1", "heading2", "heading3", "quote", "callout"]);

export const KumiKeymap = Extension.create<KumiKeymapOptions>({
  name: "kumiKeymap",

  addOptions() {
    return {};
  },

  addKeyboardShortcuts() {
    const run = (cmd: Cmd): boolean => cmd(this.editor.state, this.editor.view.dispatch);

    const atBlockStart = (): boolean => {
      const { $from, empty } = this.editor.state.selection;
      return empty && $from.parentOffset === 0;
    };

    return {
      Enter: () => {
        const state = this.editor.state;
        const blocks = blocksIn(caretContainer(state));
        const index = currentIndex(state);
        const block = blocks[index];
        if (!block) return false;
        const name = block.node.type.name;

        if (name === "code") {
          this.editor.view.dispatch(state.tr.insertText("\n").scrollIntoView());
          return true;
        }

        const empty = block.node.isTextblock && block.node.content.size === 0;
        if (empty && name !== "paragraph") {
          if (block.depth > 0 && run(shiftDepth(-1))) return true;
          return run(turnInto("paragraph"));
        }
        if (empty && name === "paragraph" && block.depth > 0) {
          return run(shiftDepth(-1));
        }

        if (LIST_TYPES.has(name)) {
          return run(splitBlockAs(name, name === "to_do" ? { checked: false } : {}));
        }
        if (name === "toggle") {
          // Enter inside a toggle starts its first child, matching Notion.
          return run(splitBlockAs("paragraph", { depth: block.depth + 1 }));
        }
        const atEnd = state.selection.from === block.pos + block.node.nodeSize - 1;
        if (SPLIT_TO_PARAGRAPH.has(name) && atEnd) return run(splitBlockAs("paragraph"));
        return run(splitBlockAs(name));
      },

      "Shift-Enter": () => {
        const state = this.editor.state;
        if (!state.selection.empty) return false;
        this.editor.view.dispatch(state.tr.insertText("\n").scrollIntoView());
        return true;
      },

      "Mod-Enter": () => run(insertParagraphAfter(currentIndex(this.editor.state), "caret")),

      Backspace: () => {
        const state = this.editor.state;
        if (!state.selection.empty || !atBlockStart()) return false;
        const container = caretContainer(state);
        const blocks = blocksIn(container);
        const index = currentIndex(state);
        const block = blocks[index];
        if (!block) return false;
        const name = block.node.type.name;

        if (block.depth > 0) return run(shiftDepth(-1));
        if (name !== "paragraph") {
          return run(turnInto("paragraph"));
        }
        if (index === 0) {
          // Inside a column the first block has nowhere above it to merge into.
          // Removing the column's last (empty) block is what dissolves it.
          if (container.pos !== null) {
            if (blocks.length === 1 && block.node.content.size === 0) {
              return run(deleteBlockRange(0, 0, "caret"));
            }
            return true;
          }
          this.options.onLeaveTop?.();
          return true;
        }
        return run(mergeWithPrevious());
      },

      Tab: () => {
        run(shiftDepth(1));
        return true; // never let Tab move focus out of the editor
      },

      "Shift-Tab": () => {
        run(shiftDepth(-1));
        return true;
      },

      // Notion's inline-math shortcut.
      "Mod-Shift-e": () => {
        insertInlineEquation(this.editor);
        return true;
      },

      "Mod-Shift-ArrowUp": () => run(moveBlock(-1)),
      "Mod-Shift-ArrowDown": () => run(moveBlock(1)),

      "Mod-a": () => {
        const state = this.editor.state;
        const blocks = blocksIn(caretContainer(state));
        const block = blocks[currentIndex(state)];
        if (!block || !block.node.isTextblock) return false;
        const from = block.pos + 1;
        const to = block.pos + block.node.nodeSize - 1;
        const { from: selFrom, to: selTo } = state.selection;
        if (selFrom === from && selTo === to) return false; // fall through to select-all
        this.editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
        return true;
      },
    };
  },
});
