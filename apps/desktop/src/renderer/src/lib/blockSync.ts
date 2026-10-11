/**
 * Block storage ⇄ ProseMirror document.
 *
 * SCHEMA DECISION — flat document, nesting carried by a `depth` attribute.
 * ----------------------------------------------------------------------
 * The TipTap document is a *flat* list of top-level block nodes. Nesting
 * (Kumi's `parentBlockId`) is expressed by an integer `depth` attribute plus
 * document order, exactly like an outline:
 *
 *     depth 0   Groceries              ← parentBlockId: null
 *     depth 1     Fruit                ← parentBlockId: <Groceries>
 *     depth 2       Apples             ← parentBlockId: <Fruit>
 *     depth 0   Notes                  ← parentBlockId: null
 *
 * `depth` is the single structural source of truth: a node's parent is the
 * nearest preceding node with a smaller depth. The nested alternative (a
 * container node per block, à la BlockNote) buys automatic subtree integrity at
 * the cost of every keyboard command having to walk container boundaries, and
 * makes ProseMirror positions two levels deeper than the visible text. Flat
 * keeps Enter/Backspace/Tab as one-node edits, keeps the diff a single linear
 * pass, and makes the drag handle's hit-testing trivial — at the cost of having
 * to move a block's descendants explicitly, which `editor/structure.ts` does.
 *
 * Node names are the Kumi `BlockType` strings verbatim, so type mapping is the
 * identity function. Block types the editor cannot render (table, synced_block,
 * …) become `unsupported_block` atoms that carry their payload verbatim, so
 * opening and editing such a page never destroys data written by the CLI or a
 * later phase.
 *
 * COLUMNS — the one structural exception (Phase 3)
 * ------------------------------------------------
 * `column_list` is a genuinely nested node: it contains `column` children, and
 * each column contains a *flat, depth-carrying* run of ordinary blocks exactly
 * like the document root. Storage still sees nothing special — the nesting is
 * expressed with the same `parentBlockId` mechanism:
 *
 *     column_list          parentBlockId: null
 *       column             parentBlockId: <column_list>
 *         paragraph        parentBlockId: <column>
 *           paragraph      parentBlockId: <the paragraph above>  (depth 1)
 *       column             parentBlockId: <column_list>
 *
 * Columns are the only container: the schema forbids a `column_list` inside a
 * `column`, so the recursion is exactly two levels deep.
 */

import type { Block, BlockOp, BlockPayload, BlockType, Id, RichText } from "@kumi/core";
import { UNSUPPORTED_NODE, isEditorBlockType } from "./blockTypes";
import { boolAttr, deepEqual, numAttr, strAttr, type PmDoc, type PmNode } from "./pmjson";
import { inlineToRichText, richTextToInline } from "./richText";
import { rankBetween } from "./rank";

/** Node name of the only nesting container in the schema. */
export const COLUMN_LIST = "column_list";
export const COLUMN = "column";

/**
 * Optional payload values become an explicit `null` attribute rather than a
 * missing one, so a block that never had the key round-trips to a payload that
 * still does not have it (an absent key and `[]`/`0` are different states).
 */
function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalRichText(value: unknown): RichText | null {
  return Array.isArray(value) ? (value as RichText) : null;
}

/** Write `key` when the attribute carries a value, remove it when it does not. */
function assign(payload: BlockPayload, key: string, value: unknown): void {
  if (value === null || value === undefined) delete payload[key];
  else payload[key] = value;
}

/* ------------------------------------------------------------------ blocks → doc */

interface Placed {
  block: Block;
  depth: number;
}

/**
 * Depth-first order (siblings by rank), with each block's outline depth.
 * Column containers get no special treatment here — this is the plain outline
 * view of a page, used by tests and by anything that only needs an ordering.
 */
export function orderBlocks(blocks: Block[]): Placed[] {
  const byParent = childIndex(blocks.filter((b) => !b.archived));

  const out: Placed[] = [];
  const seen = new Set<string>();
  const visit = (key: string, depth: number): void => {
    for (const block of byParent.get(key) ?? []) {
      if (seen.has(block.id)) continue; // cycle guard
      seen.add(block.id);
      out.push({ block, depth });
      visit(block.id, depth + 1);
    }
  };
  visit("", 0);
  return out;
}

function nodeFromBlock(block: Block, depth: number): PmNode {
  const attrs: Record<string, unknown> = { blockId: block.id, depth };
  const payload = block.payload;

  if (!isEditorBlockType(block.type)) {
    return {
      type: UNSUPPORTED_NODE,
      attrs: { ...attrs, kumiType: block.type, payload },
    };
  }

  switch (block.type) {
    case "divider":
      return { type: "divider", attrs };
    case "equation":
      return {
        type: "equation",
        attrs: { ...attrs, expression: typeof payload.expression === "string" ? payload.expression : "" },
      };
    case "image":
    case "file":
    case "video":
    case "audio":
      return {
        type: block.type,
        attrs: {
          ...attrs,
          assetId: optionalString(payload.assetId),
          caption: optionalRichText(payload.caption),
          width: optionalNumber(payload.width),
        },
      };
    case "bookmark":
      return {
        type: "bookmark",
        attrs: {
          ...attrs,
          url: optionalString(payload.url),
          title: optionalString(payload["title"]),
          description: optionalString(payload["description"]),
          favicon: optionalString(payload["favicon"]),
        },
      };
    case "embed":
      return { type: "embed", attrs: { ...attrs, url: optionalString(payload.url) } };
    case "child_database":
      // The block owns only the *reference*; schema, views and rows live in the
      // data source, which survives the block being deleted (Notion parity).
      return {
        type: "child_database",
        attrs: {
          ...attrs,
          dataSourceId: optionalString(payload.dataSourceId),
          activeViewId: optionalString(payload.activeViewId),
        },
      };
    case "child_page":
      // Reference only — the page itself lives in the tree and survives the
      // block being deleted.
      return {
        type: "child_page",
        attrs: { ...attrs, pageId: optionalString(payload.pageId) },
      };
    case "code": {
      const text = (payload.richText ?? [])
        .map((s) => (s.type === "text" ? s.text : s.type === "equation" ? s.expression : ""))
        .join("");
      const language = typeof payload.language === "string" ? payload.language : "plain text";
      const node: PmNode = { type: "code", attrs: { ...attrs, language } };
      if (text !== "") node.content = [{ type: "text", text }];
      return node;
    }
    case "to_do":
      attrs["checked"] = payload.checked === true;
      break;
    case "toggle":
      attrs["collapsed"] = payload["collapsed"] === true;
      break;
    case "callout":
      attrs["icon"] = typeof payload.icon === "string" && payload.icon !== "" ? payload.icon : "💡";
      break;
    default:
      break;
  }

  const content = richTextToInline(payload.richText);
  const node: PmNode = { type: block.type, attrs };
  if (content.length > 0) node.content = content;
  return node;
}

/** An empty page document: one empty paragraph, waiting for its first insert. */
export function emptyDoc(): PmDoc {
  return { type: "doc", content: [{ type: "paragraph", attrs: { blockId: null, depth: 0 } }] };
}

function emptyParagraph(): PmNode {
  return { type: "paragraph", attrs: { blockId: null, depth: 0 } };
}

/** Children bucketed by parent id, siblings in rank order. Orphans re-root. */
function childIndex(live: Block[]): Map<string, Block[]> {
  const known = new Set(live.map((b) => b.id));
  const byParent = new Map<string, Block[]>();
  for (const block of live) {
    const parent = block.parentBlockId;
    const key = parent !== null && known.has(parent) ? parent : "";
    const bucket = byParent.get(key);
    if (bucket === undefined) byParent.set(key, [block]);
    else bucket.push(block);
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1));
  }
  return byParent;
}

interface Walker {
  byParent: Map<string, Block[]>;
  seen: Set<string>;
}

/** A flat, depth-carrying run of blocks — the document root or one column. */
function flatRun(walker: Walker, parentKey: string, depth: number): PmNode[] {
  const out: PmNode[] = [];
  for (const block of walker.byParent.get(parentKey) ?? []) {
    if (walker.seen.has(block.id)) continue; // cycle guard
    walker.seen.add(block.id);
    if (block.type === COLUMN_LIST) {
      out.push(columnListNode(walker, block, depth));
      continue;
    }
    // A stray `column` outside a column_list has no meaning; render its
    // children in its place rather than dropping them.
    if (block.type === COLUMN) {
      out.push(...flatRun(walker, block.id, depth));
      continue;
    }
    out.push(nodeFromBlock(block, depth));
    out.push(...flatRun(walker, block.id, depth + 1));
  }
  return out;
}

function columnNode(walker: Walker, block: Block, extra: PmNode[]): PmNode {
  const inner = [...extra, ...flatRun(walker, block.id, 0)];
  return {
    type: COLUMN,
    attrs: { blockId: block.id, widthRatio: optionalNumber(block.payload.widthRatio) },
    content: inner.length > 0 ? inner : [emptyParagraph()],
  };
}

function columnListNode(walker: Walker, block: Block, depth: number): PmNode {
  const children = walker.byParent.get(block.id) ?? [];
  const columns = children.filter((b) => b.type === COLUMN && !walker.seen.has(b.id));
  for (const column of columns) walker.seen.add(column.id);

  // Anything that is not a column has been mis-parented (hand-written CLI data,
  // a partial write). Pull it into the first column instead of losing it; the
  // resulting move op repairs storage on the next save.
  const strays: PmNode[] = [];
  for (const child of children) {
    if (child.type === COLUMN || walker.seen.has(child.id)) continue;
    walker.seen.add(child.id);
    strays.push(nodeFromBlock(child, 0));
    strays.push(...flatRun(walker, child.id, 1));
  }

  const content = columns.map((column, index) =>
    columnNode(walker, column, index === 0 ? strays : []),
  );
  while (content.length < 2) {
    content.push({
      type: COLUMN,
      attrs: { blockId: null, widthRatio: null },
      content: content.length === 0 && strays.length > 0 ? strays : [emptyParagraph()],
    });
  }
  return { type: COLUMN_LIST, attrs: { blockId: block.id, depth }, content };
}

export function blocksToDoc(blocks: Block[]): PmDoc {
  const live = blocks.filter((b) => !b.archived);
  const walker: Walker = { byParent: childIndex(live), seen: new Set() };
  const content = flatRun(walker, "", 0);
  if (content.length === 0) return emptyDoc();
  return { type: "doc", content };
}

/* ------------------------------------------------------------------ doc → blocks */

function textOf(node: PmNode): string {
  return (node.content ?? []).map((child) => child.text ?? "").join("");
}

/**
 * Payload for a node, layered over the block's previous payload so unknown keys
 * written by the CLI or a future phase survive a round trip.
 */
export function payloadFromNode(node: PmNode, previous: BlockPayload | undefined): BlockPayload {
  const base: BlockPayload = { ...(previous ?? {}) };

  if (node.type === UNSUPPORTED_NODE) {
    const stored = node.attrs?.["payload"];
    return stored !== null && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as BlockPayload)
      : base;
  }

  switch (node.type) {
    case "divider":
      delete base.richText;
      return base;
    case "equation":
      delete base.richText;
      base.expression = strAttr(node, "expression", "") ?? "";
      return base;
    case "image":
    case "file":
    case "video":
    case "audio":
      delete base.richText;
      assign(base, "assetId", optionalString(node.attrs?.["assetId"]));
      assign(base, "caption", optionalRichText(node.attrs?.["caption"]));
      assign(base, "width", optionalNumber(node.attrs?.["width"]));
      return base;
    case "bookmark":
      delete base.richText;
      assign(base, "url", optionalString(node.attrs?.["url"]));
      assign(base, "title", optionalString(node.attrs?.["title"]));
      assign(base, "description", optionalString(node.attrs?.["description"]));
      assign(base, "favicon", optionalString(node.attrs?.["favicon"]));
      return base;
    case "embed":
      delete base.richText;
      assign(base, "url", optionalString(node.attrs?.["url"]));
      return base;
    case "child_database":
      delete base.richText;
      assign(base, "dataSourceId", optionalString(node.attrs?.["dataSourceId"]));
      assign(base, "activeViewId", optionalString(node.attrs?.["activeViewId"]));
      return base;
    case "child_page":
      delete base.richText;
      assign(base, "pageId", optionalString(node.attrs?.["pageId"]));
      return base;
    case COLUMN_LIST:
      delete base.richText;
      return base;
    case COLUMN:
      delete base.richText;
      assign(base, "widthRatio", optionalNumber(node.attrs?.["widthRatio"]));
      return base;
    case "code":
      base.language = strAttr(node, "language", "plain text") ?? "plain text";
      base.richText = textOf(node) === "" ? [] : [{ type: "text", text: textOf(node) }];
      return base;
    case "to_do":
      base.checked = boolAttr(node, "checked");
      break;
    case "toggle":
      base["collapsed"] = boolAttr(node, "collapsed");
      break;
    case "callout":
      base.icon = strAttr(node, "icon", "💡") ?? "💡";
      break;
    default:
      break;
  }
  base.richText = inlineToRichText(node.content);
  return base;
}

export function typeFromNode(node: PmNode): BlockType {
  if (node.type === UNSUPPORTED_NODE) {
    const stored = strAttr(node, "kumiType");
    return (stored ?? "paragraph") as BlockType;
  }
  return node.type as BlockType;
}

/* ------------------------------------------------------------------------ diff */

interface Entry {
  id: Id;
  isNew: boolean;
  depth: number;
  parentId: Id | null;
  type: BlockType;
  payload: BlockPayload;
  rank: string;
}

export interface DocToOpsOptions {
  /** Injectable id factory; defaults to `crypto.randomUUID()`. */
  newId?: () => string;
}

function makeId(options: DocToOpsOptions | undefined): string {
  return options?.newId ? options.newId() : crypto.randomUUID();
}

/**
 * Normalised outline depths: a node may sit at most one level deeper than the
 * node above it, and the first node is always at depth 0.
 */
export function normalizeDepths(nodes: PmNode[]): number[] {
  const depths: number[] = [];
  let previous = -1;
  for (const node of nodes) {
    const wanted = Math.max(0, Math.trunc(numAttr(node, "depth", 0)));
    const depth = previous < 0 ? 0 : Math.min(wanted, previous + 1);
    depths.push(depth);
    previous = depth;
  }
  return depths;
}

/**
 * Diff the live document against the last known server state.
 *
 * Emission order is insert → update → move → delete so that a block can be
 * inserted and immediately referenced as another block's parent within the same
 * batch, and so a parent is never archived before its children are re-parented.
 */
interface WalkContext {
  prevById: Map<string, Block>;
  usedIds: Set<string>;
  options: DocToOpsOptions | undefined;
  out: Entry[];
}

/**
 * A declared id is honoured even when the server has not seen it yet: the
 * structure plugin stamps ids the moment a node appears, and re-minting one
 * here would insert the same block twice on the next diff.
 */
function claimId(node: PmNode, context: WalkContext): Id {
  const declared = strAttr(node, "blockId");
  const id =
    declared !== null && declared !== "" && !context.usedIds.has(declared)
      ? declared
      : makeId(context.options);
  context.usedIds.add(id);
  return id;
}

function pushEntry(
  context: WalkContext,
  node: PmNode,
  id: Id,
  depth: number,
  parentId: Id | null,
): void {
  const previous = context.prevById.get(id);
  context.out.push({
    id,
    isNew: previous === undefined,
    depth,
    parentId,
    type: typeFromNode(node),
    payload: payloadFromNode(node, previous?.payload),
    rank: "",
  });
}

/**
 * Walk one flat run of block nodes — the document root, or a column's content —
 * resolving `depth` into `parentBlockId`. Recurses exactly one extra level for
 * `column_list` → `column` → the column's own flat run.
 */
function walkRun(nodes: PmNode[], parentId: Id | null, context: WalkContext): void {
  const blocks = nodes.filter((n) => n.type !== "text");
  const depths = normalizeDepths(blocks);
  const stack: Id[] = [];

  blocks.forEach((node, index) => {
    const depth = depths[index] ?? 0;
    stack.length = depth;
    const id = claimId(node, context);
    const nodeParent = depth === 0 ? parentId : (stack[depth - 1] ?? parentId);
    stack[depth] = id;
    pushEntry(context, node, id, depth, nodeParent);

    if (node.type !== COLUMN_LIST) return;
    for (const column of node.content ?? []) {
      if (column.type !== COLUMN) continue;
      const columnId = claimId(column, context);
      pushEntry(context, column, columnId, 0, id);
      walkRun(column.content ?? [], columnId, context);
    }
  });
}

export function docToOps(
  prevBlocks: Block[],
  doc: PmDoc,
  pageId: Id,
  options?: DocToOpsOptions,
): BlockOp[] {
  const prevById = new Map<string, Block>();
  for (const block of prevBlocks) if (!block.archived) prevById.set(block.id, block);

  const entries: Entry[] = [];
  walkRun(doc.content ?? [], null, { prevById, usedIds: new Set(), options, out: entries });

  assignRanks(entries, prevById);

  const inserts: BlockOp[] = [];
  const updates: BlockOp[] = [];
  const moves: BlockOp[] = [];

  for (const entry of entries) {
    const previous = prevById.get(entry.id);
    if (entry.isNew || previous === undefined) {
      inserts.push({
        opId: makeId(options),
        kind: "insert",
        block: {
          id: entry.id,
          pageId,
          parentBlockId: entry.parentId,
          rank: entry.rank,
          type: entry.type,
          payload: entry.payload,
        },
      });
      continue;
    }
    if (previous.type !== entry.type || !deepEqual(previous.payload, entry.payload)) {
      updates.push({
        opId: makeId(options),
        kind: "update",
        blockId: entry.id,
        baseVersion: previous.version,
        patch: { type: entry.type, payload: entry.payload },
      });
    }
    if (previous.parentBlockId !== entry.parentId || previous.rank !== entry.rank) {
      moves.push({
        opId: makeId(options),
        kind: "move",
        blockId: entry.id,
        parentBlockId: entry.parentId,
        rank: entry.rank,
      });
    }
  }

  const present = new Set(entries.map((e) => e.id));
  const gone = [...prevById.values()].filter((b) => !present.has(b.id));
  const goneIds = new Set(gone.map((b) => b.id));
  const deletes: BlockOp[] = gone
    // Core archives a block's whole subtree, so only the topmost vanished block
    // of each subtree needs an op; the rest would come back as `not_found`.
    .filter((b) => {
      let parent = b.parentBlockId;
      while (parent !== null) {
        if (goneIds.has(parent)) return false;
        parent = prevById.get(parent)?.parentBlockId ?? null;
      }
      return true;
    })
    .map((b) => ({ opId: makeId(options), kind: "delete", blockId: b.id }) as const);

  return [...inserts, ...updates, ...moves, ...deletes];
}

/**
 * Give every entry a rank, reusing the stored rank wherever document order
 * already agrees with it so a plain text edit never emits a move.
 */
function assignRanks(entries: Entry[], prevById: Map<string, Block>): void {
  const groups = new Map<string, Entry[]>();
  for (const entry of entries) {
    const key = entry.parentId ?? "";
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [entry]);
    else bucket.push(entry);
  }

  for (const group of groups.values()) {
    const keep: boolean[] = [];
    let lastKept: string | null = null;
    group.forEach((entry) => {
      const previous = prevById.get(entry.id);
      const stable =
        !entry.isNew &&
        previous !== undefined &&
        previous.parentBlockId === entry.parentId &&
        (lastKept === null || previous.rank > lastKept);
      keep.push(stable);
      if (stable && previous) lastKept = previous.rank;
    });

    let i = 0;
    while (i < group.length) {
      const entry = group[i];
      if (entry === undefined) break;
      if (keep[i] === true) {
        entry.rank = prevById.get(entry.id)?.rank ?? rankBetween(null, null);
        i += 1;
        continue;
      }
      let j = i;
      while (j < group.length && keep[j] !== true) j += 1;
      const previousEntry = i > 0 ? group[i - 1] : undefined;
      const nextEntry = j < group.length ? group[j] : undefined;
      let lower = previousEntry?.rank ?? null;
      const upper = nextEntry ? (prevById.get(nextEntry.id)?.rank ?? null) : null;
      for (let k = i; k < j; k += 1) {
        const target = group[k];
        if (target === undefined) continue;
        lower = rankBetween(lower, upper);
        target.rank = lower;
      }
      i = j;
    }
  }
}

/* -------------------------------------------------------------- local mirror */

/**
 * Predict the server state after `ops` apply. Core has no way to return the new
 * versions (see `BatchResult`), so the renderer mirrors its version arithmetic:
 * insert starts at 1, update and move each bump by one, delete archives the
 * whole subtree.
 */
export function applyOpsLocally(prev: Block[], ops: BlockOp[], at = Date.now()): Block[] {
  const byId = new Map<string, Block>();
  for (const block of prev) byId.set(block.id, { ...block, payload: { ...block.payload } });

  for (const op of ops) {
    switch (op.kind) {
      case "insert":
        byId.set(op.block.id, {
          id: op.block.id,
          pageId: op.block.pageId,
          parentBlockId: op.block.parentBlockId,
          rank: op.block.rank,
          type: op.block.type,
          payload: op.block.payload,
          version: 1,
          archived: false,
          createdAt: at,
          updatedAt: at,
        });
        break;
      case "update": {
        const block = byId.get(op.blockId);
        if (!block) break;
        byId.set(op.blockId, {
          ...block,
          type: op.patch.type ?? block.type,
          payload: op.patch.payload ?? block.payload,
          version: block.version + 1,
          updatedAt: at,
        });
        break;
      }
      case "move": {
        const block = byId.get(op.blockId);
        if (!block) break;
        byId.set(op.blockId, {
          ...block,
          parentBlockId: op.parentBlockId,
          rank: op.rank,
          version: block.version + 1,
          updatedAt: at,
        });
        break;
      }
      case "delete": {
        const doomed = new Set<string>([op.blockId]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const block of byId.values()) {
            if (block.parentBlockId !== null && doomed.has(block.parentBlockId) && !doomed.has(block.id)) {
              doomed.add(block.id);
              grew = true;
            }
          }
        }
        for (const id of doomed) byId.delete(id);
        break;
      }
    }
  }

  return [...byId.values()];
}
