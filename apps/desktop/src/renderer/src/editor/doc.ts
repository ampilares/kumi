/**
 * Positional helpers for the flat block document.
 *
 * Every block is a direct child of `doc`, so "the block the caret is in" is
 * always `doc.child(i)` for some `i` — these helpers keep that arithmetic in
 * one place instead of scattering `$from.depth` juggling across commands.
 */

import type { Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import { LIST_TYPES } from "../lib/blockTypes";
import { COLUMN, COLUMN_LIST } from "../lib/blockSync";

export interface TopBlock {
  index: number;
  /** Document position of the node itself (before its first child). */
  pos: number;
  node: PmNode;
  depth: number;
}

/**
 * A flat run of block nodes: either the whole document, or the content of one
 * column. Every block command operates on a container rather than on `doc`
 * directly, which is what lets the same Enter/Tab/drag code work unchanged
 * inside a column layout.
 */
export interface Container {
  node: PmNode;
  /** Position of the container's first child. */
  start: number;
  /** Position just after the container's last child. */
  end: number;
  /** Position of the container node itself; null for the document. */
  pos: number | null;
}

export function docContainer(doc: PmNode): Container {
  return { node: doc, start: 0, end: doc.content.size, pos: null };
}

/** The innermost column containing `pos`, or the document. */
export function containerAt(doc: PmNode, pos: number): Container {
  const clamped = Math.min(Math.max(pos, 0), doc.content.size);
  const resolved = doc.resolve(clamped);
  for (let level = resolved.depth; level >= 1; level -= 1) {
    const node = resolved.node(level);
    if (node.type.name !== COLUMN) continue;
    const before = resolved.before(level);
    return { node, start: before + 1, end: before + node.nodeSize - 1, pos: before };
  }
  return docContainer(doc);
}

/** The container the caret currently sits in. */
export function caretContainer(state: EditorState): Container {
  return containerAt(state.doc, state.selection.from);
}

export function blocksIn(container: Container): TopBlock[] {
  const out: TopBlock[] = [];
  container.node.forEach((node, offset, index) => {
    out.push({ index, pos: container.start + offset, node, depth: depthOf(node) });
  });
  return out;
}

/** The document's own top-level blocks — column layouts count as one block. */
export function topBlocks(doc: PmNode): TopBlock[] {
  return blocksIn(docContainer(doc));
}

/** Every column of a `column_list`, with the position of each column node. */
export function columnsOf(listPos: number, list: PmNode): Array<{ pos: number; node: PmNode }> {
  const out: Array<{ pos: number; node: PmNode }> = [];
  list.forEach((node, offset) => {
    if (node.type.name === COLUMN) out.push({ pos: listPos + 1 + offset, node });
  });
  return out;
}

/** A block anywhere in the document, with the container it belongs to. */
export interface LocatedBlock extends TopBlock {
  /** Position of the enclosing `column` node, or null when at page level. */
  containerPos: number | null;
}

/**
 * Every block the user can hover, drag or drop onto — the page's own children
 * plus the contents of every column — in document order.
 */
export function allBlocks(doc: PmNode): LocatedBlock[] {
  const out: LocatedBlock[] = [];
  const walk = (container: Container): void => {
    for (const block of blocksIn(container)) {
      out.push({ ...block, containerPos: container.pos });
      if (block.node.type.name !== COLUMN_LIST) continue;
      for (const column of columnsOf(block.pos, block.node)) {
        walk({
          node: column.node,
          start: column.pos + 1,
          end: column.pos + column.node.nodeSize - 1,
          pos: column.pos,
        });
      }
    }
  };
  walk(docContainer(doc));
  return out;
}

/** Position of the block node carrying `blockId`, or null when it is gone. */
export function findBlockPos(doc: PmNode, blockId: string): number | null {
  let found: number | null = null;
  doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.attrs["blockId"] === blockId) {
      found = pos;
      return false;
    }
    return true;
  });
  return found;
}

export function depthOf(node: PmNode): number {
  const value = node.attrs["depth"];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export function blockIdOf(node: PmNode): string | null {
  const value = node.attrs["blockId"];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Index of the top-level block containing `pos`. */
export function blockIndexAt(doc: PmNode, pos: number): number {
  const clamped = Math.min(Math.max(pos, 0), doc.content.size);
  const index = doc.resolve(clamped).index(0);
  return Math.min(index, Math.max(0, doc.childCount - 1));
}

/** Index of `pos` within its container (the document, or its column). */
export function indexInContainer(container: Container, pos: number): number {
  const count = container.node.childCount;
  if (count === 0) return 0;
  let index = 0;
  container.node.forEach((_node, offset, nodeIndex) => {
    if (pos >= container.start + offset) index = nodeIndex;
  });
  return Math.min(index, count - 1);
}

/** The block the selection head sits in, or `null` for an empty document. */
export function currentBlock(state: EditorState): TopBlock | null {
  const container = caretContainer(state);
  const blocks = blocksIn(container);
  const index = indexInContainer(container, state.selection.from);
  return blocks[Math.min(index, blocks.length - 1)] ?? null;
}

/** Inclusive index range of `index` and every block nested beneath it. */
export function subtreeRange(blocks: TopBlock[], index: number): [number, number] {
  const start = blocks[index];
  if (!start) return [index, index];
  let end = index;
  for (let i = index + 1; i < blocks.length; i += 1) {
    const next = blocks[i];
    if (!next || next.depth <= start.depth) break;
    end = i;
  }
  return [index, end];
}

/** Document range covering blocks `from`..`to` inclusive. */
export function rangeOf(blocks: TopBlock[], from: number, to: number): { from: number; to: number } {
  const first = blocks[from];
  const last = blocks[to];
  if (!first || !last) return { from: 0, to: 0 };
  return { from: first.pos, to: last.pos + last.node.nodeSize };
}

/** Index of the previous sibling at the same depth, or -1. */
export function previousSibling(blocks: TopBlock[], index: number): number {
  const self = blocks[index];
  if (!self) return -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = blocks[i];
    if (!candidate) continue;
    if (candidate.depth < self.depth) return -1;
    if (candidate.depth === self.depth) return i;
  }
  return -1;
}

/** Index of the next sibling at the same depth, or -1. */
export function nextSibling(blocks: TopBlock[], index: number): number {
  const self = blocks[index];
  if (!self) return -1;
  for (let i = index + 1; i < blocks.length; i += 1) {
    const candidate = blocks[i];
    if (!candidate) continue;
    if (candidate.depth < self.depth) return -1;
    if (candidate.depth === self.depth) return i;
  }
  return -1;
}

export function isListLike(node: PmNode): boolean {
  return LIST_TYPES.has(node.type.name);
}

/** True when the node holds no text (atoms count as non-empty). */
export function isEmptyBlock(node: PmNode): boolean {
  return node.isTextblock && node.content.size === 0;
}

/** Put the caret at the end of block `index`, if it can hold one. */
export function selectBlockText(tr: Transaction, index: number, side: "start" | "end"): Transaction {
  const blocks = topBlocks(tr.doc);
  const target = blocks[index];
  if (!target) return tr;
  if (!target.node.isTextblock) {
    return tr.setSelection(TextSelection.near(tr.doc.resolve(target.pos), 1));
  }
  const pos = side === "start" ? target.pos + 1 : target.pos + target.node.nodeSize - 1;
  return tr.setSelection(TextSelection.create(tr.doc, pos));
}
