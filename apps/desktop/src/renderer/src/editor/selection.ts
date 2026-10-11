/**
 * Notion-style multi-block selection.
 *
 * A text selection that crosses a block boundary is promoted to a *block*
 * selection: every covered block gets the blue overlay, the native text
 * highlight is suppressed, and the arrow keys, Backspace and Ctrl+D operate on
 * whole blocks. Escape from a caret selects the block it sits in.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { blockIndexAt, rangeOf, subtreeRange, topBlocks } from "./doc";
import { deleteBlockRange, duplicateBlockRange } from "./blockCommands";
import { TextSelection } from "@tiptap/pm/state";

export interface BlockSelection {
  anchor: number;
  head: number;
}

export const blockSelectionKey = new PluginKey<BlockSelection | null>("kumiBlockSelection");

export function getBlockSelection(state: EditorState): BlockSelection | null {
  return blockSelectionKey.getState(state) ?? null;
}

export function selectedRange(selection: BlockSelection): [number, number] {
  return selection.anchor <= selection.head
    ? [selection.anchor, selection.head]
    : [selection.head, selection.anchor];
}

export const KumiBlockSelection = Extension.create({
  name: "kumiBlockSelection",
  priority: 190,

  addProseMirrorPlugins() {
    return [
      new Plugin<BlockSelection | null>({
        key: blockSelectionKey,

        state: {
          init: () => null,
          apply(tr, previous, _oldState, newState) {
            const meta = tr.getMeta(blockSelectionKey) as
              | BlockSelection
              | null
              | undefined;
            if (meta !== undefined) return meta;
            if (tr.docChanged) return null;
            if (!tr.selectionSet) return previous;

            // A drag across blocks becomes a block selection automatically.
            const { from, to } = newState.selection;
            const first = blockIndexAt(newState.doc, from);
            const last = blockIndexAt(newState.doc, to);
            if (from !== to && first !== last) return { anchor: first, head: last };
            return null;
          },
        },

        props: {
          attributes(state): Record<string, string> {
            return getBlockSelection(state) ? { class: "is-block-selecting" } : {};
          },

          decorations(state) {
            const selection = getBlockSelection(state);
            if (!selection) return null;
            const blocks = topBlocks(state.doc);
            const [from, to] = selectedRange(selection);
            const decorations: Decoration[] = [];
            for (let i = from; i <= to; i += 1) {
              const block = blocks[i];
              if (!block) continue;
              decorations.push(
                Decoration.node(block.pos, block.pos + block.node.nodeSize, {
                  class: "is-selected",
                }),
              );
            }
            return DecorationSet.create(state.doc, decorations);
          },

          handleKeyDown: (view, event) => {
            const state = view.state;
            const selection = getBlockSelection(state);
            const blocks = topBlocks(state.doc);

            if (selection === null) {
              if (event.key === "Escape" && state.selection.empty) {
                const index = blockIndexAt(state.doc, state.selection.from);
                view.dispatch(
                  state.tr.setMeta(blockSelectionKey, { anchor: index, head: index }),
                );
                return true;
              }
              return false;
            }

            const [from, to] = selectedRange(selection);

            if (event.key === "Escape") {
              view.dispatch(state.tr.setMeta(blockSelectionKey, null));
              return true;
            }

            if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const head = Math.min(Math.max(selection.head + delta, 0), blocks.length - 1);
              const next = event.shiftKey
                ? { anchor: selection.anchor, head }
                : { anchor: head, head };
              view.dispatch(state.tr.setMeta(blockSelectionKey, next));
              return true;
            }

            if (event.key === "Backspace" || event.key === "Delete") {
              deleteBlockRange(from, to)(state, view.dispatch);
              return true;
            }

            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") {
              duplicateBlockRange(from, to)(state, view.dispatch);
              return true;
            }

            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
              view.dispatch(
                state.tr.setMeta(blockSelectionKey, {
                  anchor: 0,
                  head: Math.max(0, blocks.length - 1),
                }),
              );
              return true;
            }

            if (event.key === "Enter") {
              const last = blocks[to];
              if (last) {
                const tr = state.tr.setMeta(blockSelectionKey, null);
                const caret = Math.min(
                  last.pos + last.node.nodeSize - 1,
                  tr.doc.content.size,
                );
                tr.setSelection(TextSelection.near(tr.doc.resolve(caret), -1));
                view.dispatch(tr.scrollIntoView());
              }
              return true;
            }

            // Any other bare keystroke drops back to text editing.
            if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
              const range = rangeOf(blocks, from, subtreeRange(blocks, to)[1]);
              const tr = state.tr.setMeta(blockSelectionKey, null);
              tr.setSelection(TextSelection.near(tr.doc.resolve(range.to - 1), -1));
              view.dispatch(tr);
              return false;
            }
            return false;
          },
        },
      }),
    ];
  },
});
