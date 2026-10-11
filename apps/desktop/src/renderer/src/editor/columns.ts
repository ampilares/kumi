/**
 * Column layouts.
 *
 * A `column_list` is the one nested node in the schema (see lib/blockSync.ts).
 * This module owns the three things that make it feel like Notion's:
 *
 *   1. creating one — from the slash menu, or by dropping a block on the right
 *      edge of another block;
 *   2. resizing — the draggable divider writes `payload.widthRatio`;
 *   3. dissolving — a column that loses its last block disappears, and a layout
 *      left with a single column collapses back into ordinary page blocks.
 *
 * Dissolution is an invariant rather than a command: it runs in an
 * `appendTransaction` (see editor/structure.ts) so it holds no matter how the
 * column emptied — drag, Backspace, undo, or an external edit.
 */

import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { COLUMN, COLUMN_LIST } from "../lib/blockSync";
import { blocksIn, columnsOf, docContainer, subtreeRange, rangeOf, topBlocks } from "./doc";
import type { Cmd } from "./blockCommands";

/** A column holding nothing at all — the state that triggers dissolution. */
function isEmptyColumn(node: PmNode): boolean {
  return node.type.name === COLUMN && node.childCount === 0;
}

function makeColumn(state: EditorState, content: PmNode[], widthRatio: number | null): PmNode | null {
  const column = state.schema.nodes[COLUMN];
  const paragraph = state.schema.nodes["paragraph"];
  if (!column || !paragraph) return null;
  const inner =
    content.length > 0 ? content : [paragraph.create({ blockId: null, depth: 0 })];
  return column.create({ blockId: null, widthRatio }, Fragment.fromArray(inner));
}

/** Re-base a moved subtree so its shallowest block sits at depth 0. */
function rebase(nodes: PmNode[]): PmNode[] {
  let base = Number.POSITIVE_INFINITY;
  for (const node of nodes) base = Math.min(base, Number(node.attrs["depth"] ?? 0));
  if (!Number.isFinite(base) || base === 0) return nodes;
  return nodes.map((node) =>
    node.type.create(
      { ...node.attrs, depth: Math.max(0, Number(node.attrs["depth"] ?? 0) - base) },
      node.content,
      node.marks,
    ),
  );
}

function sliceNodes(state: EditorState, from: number, to: number): PmNode[] {
  const nodes: PmNode[] = [];
  state.doc.slice(from, to).content.forEach((node) => nodes.push(node));
  return nodes;
}

/**
 * Turn the block at `targetIndex` into a two-column layout, with the subtree at
 * `sourceIndex` in the column on `side`. Both indices address the document's
 * own children — this is the drop-on-the-right-edge gesture.
 */
export function createColumnsFromDrop(
  sourceIndex: number,
  targetIndex: number,
  side: "left" | "right",
): Cmd {
  return (state, dispatch) => {
    const list = state.schema.nodes[COLUMN_LIST];
    const blocks = topBlocks(state.doc);
    const source = blocks[sourceIndex];
    const target = blocks[targetIndex];
    if (!list || !source || !target || sourceIndex === targetIndex) return false;
    // A layout may not nest, and the target must not be inside what is moving.
    if (source.node.type.name === COLUMN_LIST || target.node.type.name === COLUMN_LIST) return false;
    const [sourceStart, sourceEnd] = subtreeRange(blocks, sourceIndex);
    if (targetIndex >= sourceStart && targetIndex <= sourceEnd) return false;
    if (!dispatch) return true;

    const [targetStart, targetEnd] = subtreeRange(blocks, targetIndex);
    const sourceRange = rangeOf(blocks, sourceStart, sourceEnd);
    const targetRange = rangeOf(blocks, targetStart, targetEnd);

    const sourceNodes = rebase(sliceNodes(state, sourceRange.from, sourceRange.to));
    const targetNodes = rebase(sliceNodes(state, targetRange.from, targetRange.to));

    const dropped = makeColumn(state, sourceNodes, null);
    const kept = makeColumn(state, targetNodes, null);
    if (!dropped || !kept) return false;

    const columns = side === "left" ? [dropped, kept] : [kept, dropped];
    const layout = list.create(
      { blockId: null, depth: target.depth },
      Fragment.fromArray(columns),
    );

    // Edit the later range first so the earlier one keeps its positions, and
    // never let the document be momentarily empty — ProseMirror would repair
    // that by inserting a paragraph we would then have to remove again.
    const tr = state.tr;
    if (sourceRange.from > targetRange.from) {
      tr.delete(sourceRange.from, sourceRange.to);
      tr.replaceWith(targetRange.from, targetRange.to, layout);
    } else {
      tr.replaceWith(targetRange.from, targetRange.to, layout);
      tr.delete(sourceRange.from, sourceRange.to);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Slash-menu "2 columns": replace the caret's block with an empty layout. */
export function insertColumnLayout(count = 2): Cmd {
  return (state, dispatch) => {
    const list = state.schema.nodes[COLUMN_LIST];
    const blocks = topBlocks(state.doc);
    const index = docBlockIndexAt(state);
    const block = blocks[index];
    if (!list || !block) return false;
    if (!dispatch) return true;

    const content = sliceNodes(
      state,
      block.pos,
      block.pos + block.node.nodeSize,
    );
    const columns: PmNode[] = [];
    for (let i = 0; i < count; i += 1) {
      const column = makeColumn(state, i === 0 ? content : [], null);
      if (column) columns.push(column);
    }
    if (columns.length < 2) return false;

    const layout = list.create({ blockId: null, depth: block.depth }, Fragment.fromArray(columns));
    const tr = state.tr.replaceWith(block.pos, block.pos + block.node.nodeSize, layout);
    // Caret into the first column's first block.
    const caret = Math.min(block.pos + 3, tr.doc.content.size);
    tr.setSelection(TextSelection.near(tr.doc.resolve(caret), 1));
    dispatch(tr.scrollIntoView());
    return true;
  };
}

/** Index of the document child containing the caret (never a column's index). */
function docBlockIndexAt(state: EditorState): number {
  const resolved = state.doc.resolve(Math.min(state.selection.from, state.doc.content.size));
  return Math.min(resolved.index(0), Math.max(0, state.doc.childCount - 1));
}

/** Write new width ratios for every column of the layout at `listPos`. */
export function setColumnRatios(listPos: number, ratios: number[]): Cmd {
  return (state, dispatch) => {
    const list = state.doc.nodeAt(listPos);
    if (!list || list.type.name !== COLUMN_LIST) return false;
    const columns = columnsOf(listPos, list);
    if (columns.length !== ratios.length) return false;
    if (!dispatch) return true;

    const tr = state.tr;
    columns.forEach((column, index) => {
      const ratio = ratios[index];
      if (ratio === undefined) return;
      tr.setNodeMarkup(column.pos, undefined, {
        ...column.node.attrs,
        widthRatio: Number(ratio.toFixed(4)),
      });
    });
    dispatch(tr);
    return true;
  };
}

/* ------------------------------------------------------------- dissolution */

/**
 * Remove empty columns, and unwrap a layout that no longer holds at least two.
 * Returns `null` when the document already satisfies the invariant.
 */
export function dissolveColumns(state: EditorState): Transaction | null {
  const blocks = blocksIn(docContainer(state.doc));
  // Deepest-last so earlier edits do not invalidate later positions.
  const fixes: Array<() => void> = [];
  let tr: Transaction | null = null;

  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (!block || block.node.type.name !== COLUMN_LIST) continue;
    const columns = columnsOf(block.pos, block.node);
    const populated = columns.filter((column) => !isEmptyColumn(column.node));
    if (populated.length === columns.length && columns.length >= 2) continue;

    tr ??= state.tr;
    const listFrom = block.pos;
    const listTo = block.pos + block.node.nodeSize;
    const depth = Number(block.node.attrs["depth"] ?? 0);

    if (populated.length >= 2) {
      // Drop just the empty columns; the layout survives.
      const kept = populated.map((column) =>
        column.node.type.create(column.node.attrs, column.node.content, column.node.marks),
      );
      const replacement = block.node.type.create(
        block.node.attrs,
        Fragment.fromArray(kept),
        block.node.marks,
      );
      const at = listFrom;
      fixes.push(() => tr?.replaceWith(at, listTo, replacement));
      continue;
    }

    // Fewer than two columns left: lift the survivor's blocks to this level.
    const survivor = populated[0];
    const lifted: PmNode[] = [];
    survivor?.node.content.forEach((child) => {
      lifted.push(
        child.type.create(
          { ...child.attrs, depth: depth + Number(child.attrs["depth"] ?? 0) },
          child.content,
          child.marks,
        ),
      );
    });
    const at = listFrom;
    fixes.push(() => {
      if (!tr) return;
      if (lifted.length === 0) {
        const paragraph = state.schema.nodes["paragraph"];
        if (state.doc.childCount <= 1 && paragraph) {
          tr.replaceWith(at, listTo, paragraph.create({ blockId: null, depth }));
        } else {
          tr.delete(at, listTo);
        }
        return;
      }
      tr.replaceWith(at, listTo, Fragment.fromArray(lifted));
    });
  }

  if (!tr) return null;
  for (const fix of fixes) fix();
  tr.setMeta("addToHistory", false);
  return tr;
}
