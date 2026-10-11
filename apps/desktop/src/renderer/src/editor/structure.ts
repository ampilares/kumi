/**
 * Structural invariants of the block document.
 *
 * 1. Every block node carries a unique, stable `blockId` — stamped the instant
 *    the node appears (split, paste, slash menu) so the persistence diff never
 *    has to write ids back into the document and never inserts a block twice.
 * 2. `depth` is clamped so a block is at most one level deeper than the block
 *    above it, and the first block of each run is always at depth 0. A column's
 *    content is its own run, so indentation restarts inside a column.
 * 3. A column that loses its last block disappears; a layout left with a single
 *    column collapses back into ordinary page blocks (editor/columns.ts).
 * 4. Derived presentation that must not live in storage — numbered-list
 *    ordinals and toggle collapse — is applied as decorations.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { COLUMN_LIST } from "../lib/blockSync";
import { blockIdOf, blocksIn, columnsOf, depthOf, docContainer, type Container } from "./doc";
import { dissolveColumns } from "./columns";

export const structureKey = new PluginKey("kumiStructure");

function freshId(): string {
  return crypto.randomUUID();
}

interface Fix {
  pos: number;
  attrs: Record<string, unknown>;
}

/** Walk one flat run, stamping ids and clamping depths; recurse into columns. */
function repairRun(container: Container, seen: Set<string>, fixes: Fix[]): void {
  let previousDepth = -1;

  for (const block of blocksIn(container)) {
    const attrs: Record<string, unknown> = {};
    const id = blockIdOf(block.node);
    let finalId = id;
    if (id === null || seen.has(id)) {
      finalId = freshId();
      attrs["blockId"] = finalId;
    }
    seen.add(finalId ?? "");

    const wanted = depthOf(block.node);
    const depth = previousDepth < 0 ? 0 : Math.min(wanted, previousDepth + 1);
    if (depth !== block.node.attrs["depth"]) attrs["depth"] = depth;
    previousDepth = depth;

    if (Object.keys(attrs).length > 0) {
      fixes.push({ pos: block.pos, attrs: { ...block.node.attrs, ...attrs } });
    }

    if (block.node.type.name !== COLUMN_LIST) continue;
    for (const column of columnsOf(block.pos, block.node)) {
      const columnId = blockIdOf(column.node);
      if (columnId === null || seen.has(columnId)) {
        const fresh = freshId();
        seen.add(fresh);
        fixes.push({ pos: column.pos, attrs: { ...column.node.attrs, blockId: fresh } });
      } else {
        seen.add(columnId);
      }
      repairRun(
        { node: column.node, start: column.pos + 1, end: column.pos + column.node.nodeSize - 1, pos: column.pos },
        seen,
        fixes,
      );
    }
  }
}

/** Ordinals + toggle collapse for one flat run. */
function decorateRun(container: Container, decorations: Decoration[]): void {
  const counters = new Map<number, number>();
  /** Depth of the shallowest collapsed toggle currently hiding blocks. */
  let hiddenBelow: number | null = null;

  for (const block of blocksIn(container)) {
    const { depth, node, pos } = block;
    for (const key of [...counters.keys()]) {
      if (key > depth) counters.set(key, 0);
    }

    if (hiddenBelow !== null && depth <= hiddenBelow) hiddenBelow = null;
    const hidden = hiddenBelow !== null;

    const attrs: Record<string, string> = {};
    if (node.type.name === "numbered_list_item") {
      const next = (counters.get(depth) ?? 0) + 1;
      counters.set(depth, next);
      attrs["data-ordinal"] = String(next);
    } else {
      counters.set(depth, 0);
    }
    if (hidden) attrs["class"] = "is-hidden";

    if (Object.keys(attrs).length > 0) {
      decorations.push(Decoration.node(pos, pos + node.nodeSize, attrs));
    }

    if (node.type.name === COLUMN_LIST) {
      for (const column of columnsOf(pos, node)) {
        decorateRun(
          {
            node: column.node,
            start: column.pos + 1,
            end: column.pos + column.node.nodeSize - 1,
            pos: column.pos,
          },
          decorations,
        );
      }
      continue;
    }

    if (!hidden && node.type.name === "toggle" && node.attrs["collapsed"] === true) {
      hiddenBelow = depth;
    }
  }
}

/** True when any column in the document is empty, or a layout has <2 columns. */
function needsDissolve(doc: PmNode): boolean {
  let broken = false;
  doc.forEach((node, offset) => {
    if (broken || node.type.name !== COLUMN_LIST) return;
    const columns = columnsOf(offset, node);
    if (columns.length < 2) broken = true;
    else if (columns.some((column) => column.node.childCount === 0)) broken = true;
  });
  return broken;
}

export const KumiStructure = Extension.create({
  name: "kumiStructure",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: structureKey,

        appendTransaction: (_transactions, _oldState, newState) => {
          if (needsDissolve(newState.doc)) {
            const tr = dissolveColumns(newState);
            // Run one repair per tick; the next appendTransaction pass stamps
            // ids on whatever the dissolution lifted.
            if (tr) return tr;
          }

          const fixes: Fix[] = [];
          repairRun(docContainer(newState.doc), new Set<string>(), fixes);
          if (fixes.length === 0) return null;

          const tr = newState.tr;
          for (const fix of fixes) tr.setNodeMarkup(fix.pos, undefined, fix.attrs);
          // Structural repair is not a user edit: it must not land in undo.
          tr.setMeta("addToHistory", false);
          tr.setMeta("kumiStructure", true);
          return tr;
        },

        props: {
          decorations(state) {
            const decorations: Decoration[] = [];
            decorateRun(docContainer(state.doc), decorations);
            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
