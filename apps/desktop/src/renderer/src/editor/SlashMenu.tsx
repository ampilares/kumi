/**
 * The "/" command panel: a Notion-style anchored list with an icon tile, a
 * label and a one-line hint per row, grouped into Basic / Media / Advanced.
 * All state lives in the ProseMirror plugin (editor/slash.ts) — this component
 * only renders it.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import {
  SLASH_GROUP_LABEL,
  applySlashItem,
  filterSlashItems,
  getSlashState,
  slashKey,
  type SlashGroup,
  type SlashItem,
  type SlashState,
} from "./slash";
import { cx } from "../utils";

const PANEL_WIDTH = 320;
const PANEL_MAX_HEIGHT = 344;

export function SlashMenu({ editor }: { editor: Editor | null }): JSX.Element | null {
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      const next = getSlashState(editor.state);
      setSlash(next.active ? next : null);
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor || !slash) return;
    const coords = editor.view.coordsAtPos(Math.min(slash.from, editor.state.doc.content.size));
    const left = Math.min(Math.max(8, coords.left), window.innerWidth - PANEL_WIDTH - 8);
    const below = coords.bottom + 6;
    const top =
      below + PANEL_MAX_HEIGHT > window.innerHeight - 8
        ? Math.max(8, coords.top - PANEL_MAX_HEIGHT - 6)
        : below;
    setPos({ top, left });
  }, [editor, slash]);

  useLayoutEffect(() => {
    listRef.current?.querySelector(".slash__item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [slash?.index]);

  if (!editor || !slash) return null;
  const items = filterSlashItems(slash.query);
  if (items.length === 0) return null;

  // Rows keep their overall order so the highlighted index stays meaningful;
  // a header is emitted the first time each group appears.
  const seen = new Set<SlashGroup>();
  const rows: Array<{ item: SlashItem; index: number; header: string | null }> = items.map(
    (item, index) => {
      const header = seen.has(item.group) ? null : SLASH_GROUP_LABEL[item.group];
      seen.add(item.group);
      return { item, index, header };
    },
  );

  return createPortal(
    <div
      className="popover slash"
      role="listbox"
      aria-label="Insert block"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="slash__list" ref={listRef}>
        {rows.map(({ item, index, header }) => (
          <div key={item.key}>
            {header === null ? null : <div className="menu__label">{header}</div>}
            <button
              type="button"
              role="option"
              aria-selected={index === slash.index}
              className={cx("slash__item", index === slash.index && "is-active")}
              onMouseEnter={() => editor.view.dispatch(editor.state.tr.setMeta(slashKey, { index }))}
              onClick={() => applySlashItem(editor, item)}
            >
              <span className="slash__glyph" aria-hidden="true">
                {item.glyph}
              </span>
              <span className="slash__text">
                <span className="slash__label">{item.label}</span>
                <span className="slash__hint">{item.hint}</span>
              </span>
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
