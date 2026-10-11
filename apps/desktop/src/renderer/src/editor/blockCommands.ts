/**
 * Block-level editing primitives shared by the keymap, the slash menu, the
 * gutter menu and drag-reorder. Written as plain ProseMirror commands so each
 * one can be probed (`dispatch === undefined`) before it runs.
 *
 * SCOPE — every command operates on a *container*: the document, or one column
 * of a column layout. Commands driven by the caret default to `"caret"`, which
 * makes typing inside a column behave exactly like typing on the page. Commands
 * driven by chrome that only exists for top-level blocks (the hover gutter, the
 * block menu, drag-reorder) pass `"doc"` explicitly, because their block index
 * was measured against the document's own children.
 */

import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { TextSelection } from "@tiptap/pm/state";
import {
  blocksIn,
  caretContainer,
  containerAt,
  docContainer,
  findBlockPos,
  indexInContainer,
  nextSibling,
  previousSibling,
  rangeOf,
  subtreeRange,
  type Container,
  type TopBlock,
} from "./doc";

export type Cmd = (state: EditorState, dispatch?: (tr: Transaction) => void) => boolean;

/** Which flat run of blocks a command's indices refer to. */
export type Scope = "caret" | "doc";

export function scopeContainer(state: EditorState, scope: Scope = "caret"): Container {
  return scope === "doc" ? docContainer(state.doc) : caretContainer(state);
}

/** Attributes that survive a turn-into: identity and outline position. */
function carried(node: PmNode): Record<string, unknown> {
  return { blockId: node.attrs["blockId"], depth: node.attrs["depth"] };
}

/** Index of the block the caret is in, within its own container. */
export function currentIndex(state: EditorState, scope: Scope = "caret"): number {
  const container = scopeContainer(state, scope);
  return indexInContainer(container, state.selection.from);
}

function caretAt(tr: Transaction, pos: number, bias: 1 | -1 = 1): Transaction {
  const clamped = Math.min(Math.max(pos, 0), tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(clamped), bias));
}

/* --------------------------------------------------------------- turn into */

function typeInContainer(
  container: Container,
  index: number,
  typeName: string,
  extraAttrs: Record<string, unknown>,
): Cmd {
  return (state, dispatch) => {
    const blocks = blocksIn(container);
    const block = blocks[index];
    const type = state.schema.nodes[typeName];
    if (!block || !type) return false;
    if (block.node.type.name === typeName && Object.keys(extraAttrs).length === 0) return false;
    if (!dispatch) return true;

    const attrs = { ...carried(block.node), ...extraAttrs };
    const tr = state.tr;
    if (type.isAtom || !block.node.isTextblock || !type.isTextblock) {
      tr.replaceWith(block.pos, block.pos + block.node.nodeSize, type.create(attrs));
      caretAt(tr, block.pos);
    } else {
      tr.setNodeMarkup(block.pos, type, attrs);
      if (typeName === "code") tr.removeMark(block.pos + 1, block.pos + block.node.nodeSize - 1);
    }
    dispatch(tr.scrollIntoView());
    return true;
  };
}

export function setBlockType(
  index: number,
  typeName: string,
  extraAttrs: Record<string, unknown> = {},
  scope: Scope = "caret",
): Cmd {
  return (state, dispatch) =>
    typeInContainer(scopeContainer(state, scope), index, typeName, extraAttrs)(state, dispatch);
}

/** Turn-into for the block under the caret. */
export function turnInto(typeName: string, extraAttrs?: Record<string, unknown>): Cmd {
  return (state, dispatch) => setBlockType(currentIndex(state), typeName, extraAttrs)(state, dispatch);
}

/* -------------------------------------------------------------- indentation */

export function shiftDepth(delta: number): Cmd {
  return (state, dispatch) => shiftDepthAt(currentIndex(state), delta)(state, dispatch);
}

export function shiftDepthAt(index: number, delta: number, scope: Scope = "caret"): Cmd {
  return (state, dispatch) => {
    const blocks = blocksIn(scopeContainer(state, scope));
    const block = blocks[index];
    if (!block) return false;
    const previous = blocks[index - 1];
    const ceiling = previous ? previous.depth + 1 : 0;
    const target = block.depth + delta;
    if (target < 0 || target > ceiling) return false;
    if (!dispatch) return true;

    const [start, end] = subtreeRange(blocks, index);
    const tr = state.tr;
    for (let i = start; i <= end; i += 1) {
      const item = blocks[i];
      if (!item) continue;
      tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, depth: item.depth + delta });
    }
    dispatch(tr);
    return true;
  };
}

/* ---------------------------------------------------------------- reordering */

function relocate(
  state: EditorState,
  container: Container,
  blocks: TopBlock[],
  start: number,
  end: number,
  beforeIndex: number,
  depthDelta: number,
): Transaction {
  const moving = rangeOf(blocks, start, end);
  const insertAt = beforeIndex >= blocks.length ? container.end : (blocks[beforeIndex]?.pos ?? container.start);
  const offset = Math.max(0, state.selection.from - moving.from);

  const nodes: PmNode[] = [];
  state.doc.slice(moving.from, moving.to).content.forEach((node) => {
    nodes.push(
      depthDelta === 0
        ? node
        : node.type.create(
            { ...node.attrs, depth: Math.max(0, Number(node.attrs["depth"] ?? 0) + depthDelta) },
            node.content,
            node.marks,
          ),
    );
  });

  const tr = state.tr;
  tr.delete(moving.from, moving.to);
  const mapped = tr.mapping.map(insertAt, -1);
  tr.insert(mapped, Fragment.fromArray(nodes));
  return caretAt(tr, mapped + offset).scrollIntoView();
}

/** Move the caret's block (with its subtree) one sibling up or down. */
export function moveBlock(direction: -1 | 1): Cmd {
  return (state, dispatch) => {
    const container = caretContainer(state);
    const blocks = blocksIn(container);
    const index = currentIndex(state);
    if (!blocks[index]) return false;
    const [start, end] = subtreeRange(blocks, index);

    let beforeIndex: number;
    if (direction === -1) {
      const sibling = previousSibling(blocks, index);
      if (sibling < 0) return false;
      beforeIndex = sibling;
    } else {
      const sibling = nextSibling(blocks, index);
      if (sibling < 0) return false;
      const [, siblingEnd] = subtreeRange(blocks, sibling);
      beforeIndex = siblingEnd + 1;
    }
    if (!dispatch) return true;
    dispatch(relocate(state, container, blocks, start, end, beforeIndex, 0));
    return true;
  };
}

/**
 * Drag-and-drop reorder: move the subtree at `sourceIndex` so it lands before
 * block `targetIndex` (or last when `targetIndex >= childCount`), re-basing its
 * depth onto `targetDepth`.
 */
export function moveSubtree(
  sourceIndex: number,
  targetIndex: number,
  targetDepth: number,
  scope: Scope = "doc",
): Cmd {
  return (state, dispatch) => {
    const container = scopeContainer(state, scope);
    const blocks = blocksIn(container);
    const source = blocks[sourceIndex];
    if (!source) return false;
    const [start, end] = subtreeRange(blocks, sourceIndex);
    if (targetIndex >= start && targetIndex <= end + 1) return false;
    if (!dispatch) return true;
    dispatch(relocate(state, container, blocks, start, end, targetIndex, targetDepth - source.depth));
    return true;
  };
}

/**
 * Move a subtree from anywhere in the document to a position inside `target`
 * (a column, or the document). Used by drag-and-drop across column boundaries.
 */
export function moveSubtreeInto(
  sourcePos: number,
  targetContainerPos: number | null,
  targetIndex: number,
): Cmd {
  return (state, dispatch) => {
    const sourceContainer = containerOfPos(state, sourcePos);
    const sourceBlocks = blocksIn(sourceContainer);
    const sourceIndex = sourceBlocks.findIndex((b) => b.pos === sourcePos);
    if (sourceIndex < 0) return false;

    const target =
      targetContainerPos === null
        ? docContainer(state.doc)
        : containerFromNodePos(state, targetContainerPos);
    if (!target) return false;

    const [start, end] = subtreeRange(sourceBlocks, sourceIndex);
    const moving = rangeOf(sourceBlocks, start, end);
    const targetBlocks = blocksIn(target);
    const insertAt =
      targetIndex >= targetBlocks.length ? target.end : (targetBlocks[targetIndex]?.pos ?? target.start);
    // Moving a run into itself is a no-op the mapping cannot express.
    if (insertAt > moving.from && insertAt < moving.to) return false;
    if (!dispatch) return true;

    const baseDepth = sourceBlocks[sourceIndex]?.depth ?? 0;
    const nodes: PmNode[] = [];
    state.doc.slice(moving.from, moving.to).content.forEach((node) => {
      nodes.push(
        node.type.create(
          { ...node.attrs, depth: Math.max(0, Number(node.attrs["depth"] ?? 0) - baseDepth) },
          node.content,
          node.marks,
        ),
      );
    });

    const tr = state.tr;
    tr.delete(moving.from, moving.to);
    const mapped = tr.mapping.map(insertAt, -1);
    tr.insert(mapped, Fragment.fromArray(nodes));
    dispatch(caretAt(tr, mapped + 1).scrollIntoView());
    return true;
  };
}

/** `pos` addresses a node, so bias inside it before resolving its container. */
function containerOfPos(state: EditorState, pos: number): Container {
  return containerAt(state.doc, Math.min(pos + 1, state.doc.content.size));
}

export function containerFromNodePos(state: EditorState, pos: number): Container | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  return { node, start: pos + 1, end: pos + node.nodeSize - 1, pos };
}

/* ------------------------------------------------------------ insert/delete */

export function insertParagraphAfter(index: number, scope: Scope = "doc"): Cmd {
  return (state, dispatch) => {
    const container = scopeContainer(state, scope);
    const blocks = blocksIn(container);
    const block = blocks[index];
    const type = state.schema.nodes["paragraph"];
    if (!block || !type) return false;
    if (!dispatch) return true;
    const [, end] = subtreeRange(blocks, index);
    const last = blocks[end];
    const at = last ? last.pos + last.node.nodeSize : container.end;
    const tr = state.tr.insert(at, type.create({ blockId: null, depth: block.depth }));
    dispatch(caretAt(tr, at + 1).scrollIntoView());
    return true;
  };
}

function deleteInContainer(container: Container, from: number, to: number): Cmd {
  return (state, dispatch) => {
    const blocks = blocksIn(container);
    if (!blocks[from] || !blocks[to]) return false;
    const [, subtreeEnd] = subtreeRange(blocks, to);
    const last = Math.max(to, subtreeEnd);
    if (!dispatch) return true;

    const range = rangeOf(blocks, from, last);
    const tr = state.tr.delete(range.from, range.to);
    // The document may never be empty; a column may (it then dissolves).
    if (container.pos === null && tr.doc.childCount === 0) {
      const paragraph = state.schema.nodes["paragraph"];
      if (paragraph) tr.insert(0, paragraph.create({ blockId: null, depth: 0 }));
    }
    dispatch(caretAt(tr, range.from, -1).scrollIntoView());
    return true;
  };
}

export function deleteBlockRange(from: number, to: number, scope: Scope = "doc"): Cmd {
  return (state, dispatch) =>
    deleteInContainer(scopeContainer(state, scope), from, to)(state, dispatch);
}

function duplicateInContainer(container: Container, from: number, to: number): Cmd {
  return (state, dispatch) => {
    const blocks = blocksIn(container);
    if (!blocks[from] || !blocks[to]) return false;
    const [, subtreeEnd] = subtreeRange(blocks, to);
    const last = Math.max(to, subtreeEnd);
    if (!dispatch) return true;

    const range = rangeOf(blocks, from, last);
    const copies: PmNode[] = [];
    state.doc.slice(range.from, range.to).content.forEach((node) => {
      // A null id makes the structure plugin mint a fresh one.
      copies.push(withFreshIds(node));
    });
    const tr = state.tr.insert(range.to, Fragment.fromArray(copies));
    dispatch(caretAt(tr, range.to + 1).scrollIntoView());
    return true;
  };
}

export function duplicateBlockRange(from: number, to: number, scope: Scope = "doc"): Cmd {
  return (state, dispatch) =>
    duplicateInContainer(scopeContainer(state, scope), from, to)(state, dispatch);
}

/** Clear `blockId` on a node and every descendant block (columns included). */
function withFreshIds(node: PmNode): PmNode {
  if (node.isText) return node;
  const hasBlockId = Object.prototype.hasOwnProperty.call(node.attrs, "blockId");
  const children: PmNode[] = [];
  let changed = false;
  node.content.forEach((child) => {
    const next = child.isBlock ? withFreshIds(child) : child;
    if (next !== child) changed = true;
    children.push(next);
  });
  if (!hasBlockId && !changed) return node;
  return node.type.create(
    hasBlockId ? { ...node.attrs, blockId: null } : node.attrs,
    changed ? Fragment.fromArray(children) : node.content,
    node.marks,
  );
}

/* ------------------------------------------------------- by-block-id façade */

/**
 * The hover gutter and the block menu address blocks by id rather than by
 * index, because the block under the pointer may live inside a column — where
 * "index 3" means something different from "index 3" on the page. Resolving the
 * id gives the command the right container without the chrome having to know
 * anything about column layouts.
 */
function locate(
  state: EditorState,
  blockId: string,
): { container: Container; index: number } | null {
  const pos = findBlockPos(state.doc, blockId);
  if (pos === null) return null;
  const container = containerOfPos(state, pos);
  const index = blocksIn(container).findIndex((block) => block.pos === pos);
  return index < 0 ? null : { container, index };
}

export function insertParagraphAfterBlock(blockId: string): Cmd {
  return (state, dispatch) => {
    const found = locate(state, blockId);
    if (!found) return false;
    const { container, index } = found;
    const blocks = blocksIn(container);
    const block = blocks[index];
    const type = state.schema.nodes["paragraph"];
    if (!block || !type) return false;
    if (!dispatch) return true;
    const [, end] = subtreeRange(blocks, index);
    const last = blocks[end];
    const at = last ? last.pos + last.node.nodeSize : container.end;
    const tr = state.tr.insert(at, type.create({ blockId: null, depth: block.depth }));
    dispatch(caretAt(tr, at + 1).scrollIntoView());
    return true;
  };
}

export function deleteBlock(blockId: string): Cmd {
  return (state, dispatch) => {
    const found = locate(state, blockId);
    if (!found) return false;
    return deleteInContainer(found.container, found.index, found.index)(state, dispatch);
  };
}

export function duplicateBlock(blockId: string): Cmd {
  return (state, dispatch) => {
    const found = locate(state, blockId);
    if (!found) return false;
    return duplicateInContainer(found.container, found.index, found.index)(state, dispatch);
  };
}

export function turnBlockInto(
  blockId: string,
  typeName: string,
  extraAttrs: Record<string, unknown> = {},
): Cmd {
  return (state, dispatch) => {
    const found = locate(state, blockId);
    if (!found) return false;
    return typeInContainer(found.container, found.index, typeName, extraAttrs)(state, dispatch);
  };
}

/* -------------------------------------------------------------- attr toggles */

export function setBlockAttrs(pos: number, attrs: Record<string, unknown>): Cmd {
  return (state, dispatch) => {
    const node = state.doc.nodeAt(pos);
    if (!node) return false;
    if (!dispatch) return true;
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    tr.setMeta("addToHistory", true);
    dispatch(tr);
    return true;
  };
}

/* -------------------------------------------------------------- split/merge */

/** Split the caret's block, giving the new half `typeName` and `attrs`. */
export function splitBlockAs(typeName: string, attrs: Record<string, unknown> = {}): Cmd {
  return (state, dispatch) => {
    const type = state.schema.nodes[typeName];
    const container = caretContainer(state);
    const blocks = blocksIn(container);
    const block = blocks[currentIndex(state)];
    if (!type || !block || !block.node.isTextblock) return false;
    if (!dispatch) return true;

    const { from, to } = state.selection;
    const contentEnd = block.pos + block.node.nodeSize - 1;
    const tail = state.doc.slice(to, contentEnd);
    const tr = state.tr;
    tr.delete(from, contentEnd);
    const boundary = tr.mapping.map(contentEnd + 1);
    tr.insert(boundary, type.create({ blockId: null, depth: block.depth, ...attrs }, tail.content));
    dispatch(caretAt(tr, boundary + 1).scrollIntoView());
    return true;
  };
}

/** Append the caret's block into the previous one and remove it. */
export function mergeWithPrevious(): Cmd {
  return (state, dispatch) => {
    const blocks = blocksIn(caretContainer(state));
    const index = currentIndex(state);
    const block = blocks[index];
    const previous = blocks[index - 1];
    if (!block || !previous || !block.node.isTextblock) return false;

    if (!previous.node.isTextblock) {
      // Previous block is an atom (divider, media, equation): Backspace removes it.
      if (!dispatch) return true;
      dispatch(state.tr.delete(previous.pos, previous.pos + previous.node.nodeSize).scrollIntoView());
      return true;
    }
    if (previous.node.type.spec.code === true) return false;
    if (!dispatch) return true;

    const joinAt = previous.pos + previous.node.nodeSize - 1;
    const tr = state.tr.delete(joinAt, block.pos + 1);
    tr.setSelection(TextSelection.create(tr.doc, joinAt));
    dispatch(tr.scrollIntoView());
    return true;
  };
}
