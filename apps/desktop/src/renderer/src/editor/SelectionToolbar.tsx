/**
 * Notion's floating formatting toolbar.
 *
 * Appears over any non-empty text selection and disappears the moment the
 * selection collapses, a whole block gets selected, or the page is locked. It
 * is a *mirror* of the document's marks, never a second source of truth: the
 * active states come from `activeMarks`, so Ctrl+B and the toolbar's B button
 * can never disagree.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { SearchResult } from "@kumi/core";
import { commands } from "../ipc";
import { cx, displayTitle } from "../utils";
import { CODE_MARK } from "../lib/richText";
import { getBlockSelection } from "./selection";
import { getSlashState, insertInlineEquation } from "./slash";
import { getMentionState } from "./mention";
import {
  BACKGROUND_COLORS,
  TEXT_COLORS,
  activeMarks,
  applyColor,
  applyLink,
  clearLink,
  colorLabel,
  normalizeUrl,
  pageHref,
  parsePageHref,
  type MarkSnapshot,
} from "./marks";

const TOOLBAR_WIDTH = 380;
const TOOLBAR_HEIGHT = 34;
const GAP = 8;

interface Placement {
  top: number;
  left: number;
}

type Panel = "none" | "link" | "color";

interface Button {
  key: keyof Pick<MarkSnapshot, "bold" | "italic" | "underline" | "strike" | "code">;
  mark: string;
  label: string;
  hint: string;
  glyph: string;
}

const BUTTONS: readonly Button[] = [
  { key: "bold", mark: "bold", label: "Bold", hint: "Ctrl+B", glyph: "B" },
  { key: "italic", mark: "italic", label: "Italic", hint: "Ctrl+I", glyph: "i" },
  { key: "underline", mark: "underline", label: "Underline", hint: "Ctrl+U", glyph: "U" },
  { key: "strike", mark: "strike", label: "Strikethrough", hint: "Ctrl+Shift+S", glyph: "S" },
  { key: "code", mark: CODE_MARK, label: "Code", hint: "Ctrl+E", glyph: "</>" },
];

export function SelectionToolbar({ editor }: { editor: Editor | null }): JSX.Element | null {
  const [marks, setMarks] = useState<MarkSnapshot | null>(null);
  const [place, setPlace] = useState<Placement | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editor) return;
    const sync = (): void => {
      const state = editor.state;
      const visible =
        editor.isEditable &&
        // A NodeSelection (clicking an inline database, image, …) also spans a
        // range, but there is no text under it to format — only a real text
        // selection should raise the bar.
        state.selection instanceof TextSelection &&
        !state.selection.empty &&
        state.selection.from !== state.selection.to &&
        getBlockSelection(state) === null &&
        !getSlashState(state).active &&
        !getMentionState(state).active;
      setMarks(visible ? activeMarks(state) : null);
      if (!visible) setPanel("none");
    };
    sync();
    editor.on("transaction", sync);
    editor.on("focus", sync);
    return () => {
      editor.off("transaction", sync);
      editor.off("focus", sync);
    };
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor || !marks) {
      setPlace(null);
      return;
    }
    const { from, to } = editor.state.selection;
    let start: { top: number; left: number; bottom: number };
    let end: { top: number; left: number; bottom: number };
    try {
      start = editor.view.coordsAtPos(from);
      end = editor.view.coordsAtPos(to);
    } catch {
      return;
    }
    const centre = (start.left + end.left) / 2;
    const left = Math.min(
      Math.max(GAP, centre - TOOLBAR_WIDTH / 2),
      window.innerWidth - TOOLBAR_WIDTH - GAP,
    );
    const above = Math.min(start.top, end.top) - TOOLBAR_HEIGHT - GAP;
    const top = above < GAP ? Math.max(start.bottom, end.bottom) + GAP : above;
    setPlace({ top, left });
  }, [editor, marks]);

  if (!editor || !marks || !place) return null;

  const toggle = (mark: string): void => {
    editor.chain().focus().toggleMark(mark).run();
  };

  return createPortal(
    <div
      ref={ref}
      className="fmtbar"
      role="toolbar"
      aria-label="Text formatting"
      style={{ top: place.top, left: place.left }}
      // Never let the toolbar steal the selection it is describing.
      onMouseDown={(event) => {
        if ((event.target as HTMLElement).closest("input") === null) event.preventDefault();
      }}
    >
      {BUTTONS.map((button) => (
        <button
          key={button.key}
          type="button"
          className={cx(
            "fmtbar__btn",
            `fmtbar__btn--${button.key}`,
            marks[button.key] && "is-active",
          )}
          title={`${button.label} — ${button.hint}`}
          aria-label={button.label}
          aria-pressed={marks[button.key]}
          onClick={() => toggle(button.mark)}
        >
          {button.glyph}
        </button>
      ))}

      <span className="fmtbar__sep" role="separator" />

      <button
        type="button"
        className={cx("fmtbar__btn", marks.link !== null && "is-active")}
        title="Link — Ctrl+K"
        aria-label="Link"
        aria-pressed={marks.link !== null}
        onClick={() => setPanel((open) => (open === "link" ? "none" : "link"))}
      >
        🔗
      </button>

      <button
        type="button"
        className="fmtbar__btn fmtbar__btn--color"
        title="Colour"
        aria-label="Text colour"
        aria-expanded={panel === "color"}
        onClick={() => setPanel((open) => (open === "color" ? "none" : "color"))}
      >
        <span className={cx("fmtbar__a", `kt-${marks.color}`)}>A</span>
        <span className="fmtbar__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      <button
        type="button"
        className="fmtbar__btn"
        title="Inline equation — Ctrl+Shift+E"
        aria-label="Inline equation"
        onClick={() => {
          setPanel("none");
          insertInlineEquation(editor);
        }}
      >
        𝑥
      </button>

      {panel === "link" ? (
        <LinkPanel
          editor={editor}
          current={marks.link}
          onClose={() => setPanel("none")}
        />
      ) : null}
      {panel === "color" ? (
        <ColorPanel
          active={marks.color}
          onPick={(color) => {
            applyColor(editor, color);
            setPanel("none");
          }}
        />
      ) : null}
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------- link panel */

function LinkPanel({
  editor,
  current,
  onClose,
}: {
  editor: Editor;
  current: string | null;
  onClose(): void;
}): JSX.Element {
  const [value, setValue] = useState(current ?? "");
  const [results, setResults] = useState<SearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const query = value.trim();
    if (query === "" || /^[a-z]+:\/\//i.test(query) || query.includes(".")) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void commands
      .search(query, { limit: 5, titleOnly: true })
      .then((rows) => {
        if (!cancelled) setResults(rows);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  const commit = (): void => {
    const href = normalizeUrl(value);
    if (href === null) {
      onClose();
      return;
    }
    applyLink(editor, href);
    onClose();
  };

  return (
    <div className="popover fmtbar__panel" role="dialog" aria-label="Link">
      <input
        ref={inputRef}
        className="field"
        placeholder="Paste a link or search pages…"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            const first = results[0];
            if (first && normalizeUrl(value) === null) {
              applyLink(editor, pageHref(first.pageId));
              onClose();
              return;
            }
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          event.stopPropagation();
        }}
      />
      {results.length > 0 ? (
        <div className="fmtbar__results">
          <div className="menu__label">Link to page</div>
          {results.map((row) => (
            <button
              key={row.pageId}
              type="button"
              className="menuitem"
              onClick={() => {
                applyLink(editor, pageHref(row.pageId));
                onClose();
              }}
            >
              <span className="row__icon">{row.icon ?? "📄"}</span>
              <span className="menuitem__label">{displayTitle(row.title)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {current !== null ? (
        <>
          <div className="menu__sep" role="separator" />
          <button
            type="button"
            className="menuitem menuitem--danger"
            onClick={() => {
              clearLink(editor);
              onClose();
            }}
          >
            <span className="menuitem__label">Remove link</span>
            <span className="menuitem__hint">
              {parsePageHref(current) !== null ? "page" : "external"}
            </span>
          </button>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ colour panel */

function ColorPanel({
  active,
  onPick,
}: {
  active: string;
  onPick(color: string): void;
}): JSX.Element {
  return (
    <div className="popover fmtbar__panel fmtbar__panel--color" role="menu" aria-label="Colour">
      <div className="menu__label">Text colour</div>
      {TEXT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={active === color}
          className={cx("menuitem", active === color && "is-active")}
          onClick={() => onPick(color)}
        >
          <span className={cx("colorchip", `kt-${color}`)} aria-hidden="true">
            A
          </span>
          <span className="menuitem__label">{colorLabel(color)}</span>
        </button>
      ))}
      <div className="menu__sep" role="separator" />
      <div className="menu__label">Background</div>
      {BACKGROUND_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="menuitemradio"
          aria-checked={active === color}
          className={cx("menuitem", active === color && "is-active")}
          onClick={() => onPick(color)}
        >
          <span className={cx("colorchip", `kt-${color}`)} aria-hidden="true">
            A
          </span>
          <span className="menuitem__label">{colorLabel(color)}</span>
        </button>
      ))}
    </div>
  );
}
