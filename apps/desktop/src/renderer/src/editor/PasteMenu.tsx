/**
 * Notion's paste menu: after a bare URL lands on an empty paragraph, offer to
 * upgrade it into a bookmark card or an embed. Dismiss leaves the plain link.
 */

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { getPasteMenuState, pasteMenuKey, type PasteMenuState } from "./pasteDrop";
import { setBlockType } from "./blockCommands";
import { blocksIn, docContainer } from "./doc";

const PANEL_WIDTH = 280;

export function PasteMenu({
  editor,
  onBookmark,
}: {
  editor: Editor | null;
  /** Applies the URL and fetches metadata (owned by BlockEditor). */
  onBookmark(pos: number, nodeType: string, url: string): Promise<void>;
}): JSX.Element | null {
  const [menu, setMenu] = useState<PasteMenuState | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      const next = getPasteMenuState(editor.state);
      setMenu(next.active ? next : null);
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor || !menu) return;
    try {
      const coords = editor.view.coordsAtPos(Math.min(menu.blockPos + 1, editor.state.doc.content.size));
      setPos({
        top: coords.bottom + 6,
        left: Math.min(Math.max(8, coords.left), window.innerWidth - PANEL_WIDTH - 8),
      });
    } catch {
      /* the block vanished; the next transaction closes the menu */
    }
  }, [editor, menu]);

  if (!editor || !menu) return null;

  const close = (): void => {
    editor.view.dispatch(editor.state.tr.setMeta(pasteMenuKey, { close: true }));
  };

  /** Index of the pasted-into block among the page's own children. */
  const docIndex = (): number => {
    const blocks = blocksIn(docContainer(editor.state.doc));
    return blocks.findIndex((block) => block.pos === menu.blockPos);
  };

  const convert = (type: "bookmark" | "embed"): void => {
    const index = docIndex();
    if (index < 0) {
      close();
      return;
    }
    const attrs =
      type === "bookmark"
        ? { url: menu.url, title: null, description: null, favicon: null }
        : { url: menu.url };
    setBlockType(index, type, attrs, "doc")(editor.state, editor.view.dispatch);
    close();
    if (type === "bookmark") {
      const blocks = blocksIn(docContainer(editor.state.doc));
      const block = blocks[index];
      if (block) void onBookmark(block.pos, "bookmark", menu.url);
    }
  };

  return createPortal(
    <div
      className="popover pastemenu"
      role="menu"
      aria-label="Paste as"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" className="menuitem" onClick={close}>
        <span className="row__icon">✕</span>
        <span className="menuitem__label">Dismiss</span>
      </button>
      <button type="button" role="menuitem" className="menuitem" onClick={() => convert("bookmark")}>
        <span className="row__icon">🔖</span>
        <span className="menuitem__label">Create bookmark</span>
      </button>
      <button type="button" role="menuitem" className="menuitem" onClick={() => convert("embed")}>
        <span className="row__icon">▶</span>
        <span className="menuitem__label">Embed</span>
      </button>
    </div>,
    document.body,
  );
}
