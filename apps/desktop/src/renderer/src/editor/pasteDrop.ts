/**
 * Paste and drop behaviour.
 *
 * Two Notion gestures live here:
 *
 *   • Pasting a bare URL. Over a selection it just becomes a link; onto an
 *     empty paragraph it drops the URL in as a link *and* offers the paste menu
 *     ("Dismiss / Create bookmark / Embed"), which is why the plugin has to
 *     carry state rather than being a pure `handlePaste`.
 *   • Dropping OS files. Chromium hands us `File` objects with no path, so the
 *     preload bridge translates them with `webUtils.getPathForFile`, the main
 *     process copies them into the workspace asset store, and the resulting
 *     media blocks are inserted at the drop position — not at the caret.
 */

import { Extension } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Asset } from "@kumi/core";
import { importAssets, pathForFile } from "../ipc";
import { looksLikeUrl } from "./marks";

/* ------------------------------------------------------------- paste menu */

export interface PasteMenuState {
  active: boolean;
  /** Position of the block that received the URL. */
  blockPos: number;
  url: string;
}

const CLOSED: PasteMenuState = { active: false, blockPos: 0, url: "" };

export const pasteMenuKey = new PluginKey<PasteMenuState>("kumiPasteMenu");

export function getPasteMenuState(state: EditorState): PasteMenuState {
  return pasteMenuKey.getState(state) ?? CLOSED;
}

/** Media node name for a MIME type, mirroring the block types Kumi stores. */
export function mediaTypeForMime(mime: string): "image" | "video" | "audio" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return "file";
}

function isEmptyParagraph(node: PmNode | null | undefined): boolean {
  return node?.type.name === "paragraph" && node.content.size === 0;
}

/* -------------------------------------------------------------- file drop */

function mediaNodes(view: EditorView, assets: Asset[], depth: number): PmNode[] {
  const nodes: PmNode[] = [];
  for (const asset of assets) {
    const type = view.state.schema.nodes[mediaTypeForMime(asset.mime)];
    if (!type) continue;
    nodes.push(type.create({ blockId: null, depth, assetId: asset.id, caption: null, width: null }));
  }
  return nodes;
}

/**
 * Insert the imported media where the drop landed. The document may have moved
 * on while the import ran, so the position is re-derived from the id of the
 * block that was under the cursor rather than from a stale offset.
 */
async function insertDroppedFiles(view: EditorView, files: File[], dropPos: number): Promise<void> {
  const paths = files.map((file) => pathForFile(file)).filter((path) => path !== "");
  if (paths.length === 0) return;

  const anchorBlock = blockAt(view.state, dropPos);
  const anchorId = anchorBlock?.node.attrs["blockId"];

  const assets = await importAssets(paths);
  if (assets.length === 0 || view.isDestroyed) return;

  const target = typeof anchorId === "string" ? findBlockById(view.state, anchorId) : null;
  const at = target ? target.pos + target.node.nodeSize : Math.min(dropPos, view.state.doc.content.size);
  const depth = target ? Number(target.node.attrs["depth"] ?? 0) : 0;

  const nodes = mediaNodes(view, assets, depth);
  if (nodes.length === 0) return;

  const tr = view.state.tr.insert(at, Fragment.fromArray(nodes));
  // Replace the placeholder paragraph the media was dropped onto.
  if (target && isEmptyParagraph(target.node)) {
    tr.delete(tr.mapping.map(target.pos), tr.mapping.map(target.pos + target.node.nodeSize));
  }
  view.dispatch(tr.scrollIntoView());
}

interface Located {
  pos: number;
  node: PmNode;
}

/** The nearest ancestor block node of `pos`, at any nesting level. */
function blockAt(state: EditorState, pos: number): Located | null {
  const clamped = Math.min(Math.max(pos, 0), state.doc.content.size);
  const resolved = state.doc.resolve(clamped);
  for (let level = resolved.depth; level >= 1; level -= 1) {
    const node = resolved.node(level);
    if (node.type.name === "column" || node.type.name === "column_list") continue;
    if (node.isBlock) return { pos: resolved.before(level), node };
  }
  const index = Math.min(resolved.index(0), Math.max(0, state.doc.childCount - 1));
  const node = state.doc.maybeChild(index);
  return node ? { pos: resolved.start(0) + offsetOfChild(state.doc, index), node } : null;
}

function offsetOfChild(doc: PmNode, index: number): number {
  let offset = 0;
  for (let i = 0; i < index; i += 1) offset += doc.child(i).nodeSize;
  return offset;
}

function findBlockById(state: EditorState, blockId: string): Located | null {
  let found: Located | null = null;
  state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.attrs["blockId"] === blockId) {
      found = { pos, node };
      return false;
    }
    return true;
  });
  return found;
}

/* ------------------------------------------------------------------ plugin */

export const KumiPasteDrop = Extension.create({
  name: "kumiPasteDrop",

  addProseMirrorPlugins() {
    return [
      new Plugin<PasteMenuState>({
        key: pasteMenuKey,

        state: {
          init: () => CLOSED,
          apply(tr, previous) {
            const meta = tr.getMeta(pasteMenuKey) as PasteMenuState | { close: true } | undefined;
            if (meta !== undefined) return "close" in meta ? CLOSED : meta;
            if (!previous.active) return previous;
            // Any further editing dismisses the offer, exactly like Notion.
            if (tr.docChanged) return CLOSED;
            return previous;
          },
        },

        props: {
          handlePaste: (view, event) => {
            if (!view.editable) return false;
            const text = event.clipboardData?.getData("text/plain") ?? "";
            if (!looksLikeUrl(text)) return false;
            const url = text.trim();
            const { state } = view;
            const link = state.schema.marks["link"];
            if (!link) return false;

            // Over a selection: turn the selected text into a link.
            if (!state.selection.empty) {
              view.dispatch(
                state.tr.addMark(state.selection.from, state.selection.to, link.create({ href: url })),
              );
              return true;
            }

            const block = blockAt(state, state.selection.from);
            const onEmptyParagraph = isEmptyParagraph(block?.node);
            const tr = state.tr.replaceSelectionWith(
              state.schema.text(url, [link.create({ href: url })]),
              false,
            );
            if (onEmptyParagraph && block) {
              tr.setMeta(pasteMenuKey, { active: true, blockPos: block.pos, url });
            }
            view.dispatch(tr.scrollIntoView());
            return true;
          },

          handleDrop: (view, event) => {
            if (!view.editable) return false;
            const dropEvent = event as DragEvent;
            const files = Array.from(dropEvent.dataTransfer?.files ?? []);
            if (files.length === 0) return false;
            dropEvent.preventDefault();
            const at = view.posAtCoords({ left: dropEvent.clientX, top: dropEvent.clientY });
            const pos = at?.pos ?? view.state.selection.from;
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))));
            void insertDroppedFiles(view, files, pos);
            return true;
          },
        },
      }),
    ];
  },
});
