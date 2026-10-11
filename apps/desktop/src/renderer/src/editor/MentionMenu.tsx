/**
 * The "@" / "[[" page-mention panel.
 *
 * Mirrors SlashMenu's shape, but the rows come from `commands.search(…,
 * { titleOnly: true })`, so this component owns the query and reports the row
 * count back into the plugin — that is what lets the arrow keys in
 * editor/mention.ts wrap around a list they cannot see.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { SearchResult } from "@kumi/core";
import { commands } from "../ipc";
import { cx, displayTitle } from "../utils";
import {
  MENTION_ACCEPT_EVENT,
  applyMention,
  getMentionState,
  mentionKey,
  type MentionState,
} from "./mention";

const PANEL_WIDTH = 300;
const PANEL_MAX_HEIGHT = 300;
const LIMIT = 12;

export function MentionMenu({ editor }: { editor: Editor | null }): JSX.Element | null {
  const [mention, setMention] = useState<MentionState | null>(null);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<SearchResult[]>([]);
  resultsRef.current = results;

  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      const next = getMentionState(editor.state);
      setMention(next.active ? next : null);
    };
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);

  const query = mention?.query ?? null;

  useEffect(() => {
    if (query === null) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const run = async (): Promise<void> => {
      const trimmed = query.trim();
      const found = trimmed === "" ? [] : await commands.search(trimmed, { limit: LIMIT, titleOnly: true });
      // With no query Notion offers recently-visited pages.
      const rows = trimmed === "" ? await recentPages() : found;
      if (!cancelled) setResults(rows);
    };
    void run().catch(() => {
      if (!cancelled) setResults([]);
    });
    return () => {
      cancelled = true;
    };
  }, [query]);

  // Keep the plugin's row count in sync so ArrowUp/Down wrap correctly.
  useEffect(() => {
    if (!editor || !mention) return;
    if (mention.count === results.length) return;
    editor.view.dispatch(editor.state.tr.setMeta(mentionKey, { count: results.length }));
  }, [editor, mention, results.length]);

  useLayoutEffect(() => {
    if (!editor || !mention) return;
    const coords = editor.view.coordsAtPos(Math.min(mention.from, editor.state.doc.content.size));
    const left = Math.min(Math.max(8, coords.left), window.innerWidth - PANEL_WIDTH - 8);
    const below = coords.bottom + 6;
    const top =
      below + PANEL_MAX_HEIGHT > window.innerHeight - 8
        ? Math.max(8, coords.top - PANEL_MAX_HEIGHT - 6)
        : below;
    setPos({ top, left });
  }, [editor, mention]);

  useLayoutEffect(() => {
    listRef.current?.querySelector(".slash__item.is-active")?.scrollIntoView({ block: "nearest" });
  }, [mention?.index]);

  // Enter/Tab are handled by the plugin, which cannot see the rows.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onAccept = (): void => {
      const state = getMentionState(editor.state);
      if (!state.active) return;
      const rows = resultsRef.current;
      const row = rows[state.index] ?? rows[0];
      if (!row) return;
      applyMention(editor, { id: row.pageId, title: row.title, icon: row.icon });
    };
    dom.addEventListener(MENTION_ACCEPT_EVENT, onAccept);
    return () => dom.removeEventListener(MENTION_ACCEPT_EVENT, onAccept);
  }, [editor]);

  if (!editor || !mention) return null;

  return createPortal(
    <div
      className="popover slash slash--mention"
      role="listbox"
      aria-label="Link to page"
      style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH, maxHeight: PANEL_MAX_HEIGHT }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="menu__label">{mention.query.trim() === "" ? "Recent pages" : "Link to page"}</div>
      <div className="slash__list" ref={listRef}>
        {results.length === 0 ? (
          <div className="empty-hint">No pages found</div>
        ) : (
          results.map((row, index) => (
            <button
              key={row.pageId}
              type="button"
              role="option"
              aria-selected={index === mention.index}
              className={cx("slash__item", index === mention.index && "is-active")}
              onMouseEnter={() => editor.view.dispatch(editor.state.tr.setMeta(mentionKey, { index }))}
              onClick={() =>
                applyMention(editor, { id: row.pageId, title: row.title, icon: row.icon })
              }
            >
              <span className="slash__glyph slash__glyph--sm" aria-hidden="true">
                {row.icon ?? "📄"}
              </span>
              <span className="slash__text">
                <span className="slash__label">{displayTitle(row.title)}</span>
                {row.breadcrumb.length > 0 ? (
                  <span className="slash__hint">{row.breadcrumb.join(" / ")}</span>
                ) : null}
              </span>
            </button>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Recently visited pages, shaped like search results so one list renders both. */
async function recentPages(): Promise<SearchResult[]> {
  const state = await commands.getUserState();
  const ids = state.recents.slice(0, LIMIT);
  const pages = await Promise.all(ids.map((id) => commands.getPage(id)));
  return pages
    .filter((page): page is NonNullable<typeof page> => page !== null && page.deletedAt === null)
    .map((page) => ({
      pageId: page.id,
      title: page.title,
      icon: page.icon,
      snippet: "",
      breadcrumb: [],
      updatedAt: page.updatedAt,
    }));
}
