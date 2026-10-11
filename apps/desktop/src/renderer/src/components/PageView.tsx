import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Page } from "@kumi/core";
import { commands } from "../ipc";
import { useAutoGrow, useDebounced } from "../hooks";
import { renamePage, useOptimistic } from "../data";
import { cx } from "../utils";
import { EmojiPicker, Popover } from "./ui";
import { ImageIcon, PlusIcon } from "./icons";
import { BlockEditor, type BlockEditorHandle } from "../editor/BlockEditor";
import { Backlinks } from "./Backlinks";
import { primePage } from "../lib/pageCache";

/**
 * `presentation` is the one thing a row peek changes: the page loses its
 * cover/backlink chrome and gains a slot (`children`) between the title and the
 * body, which the peek fills with the row's property panel. Everything else —
 * title editing, icon picker, the block editor — is literally the same code, so
 * a row page is never a second-class page.
 */
export function PageView({
  page,
  presentation = "page",
  children,
}: {
  page: Page;
  presentation?: "page" | "peek";
  children?: ReactNode;
}): JSX.Element {
  const peek = presentation === "peek";
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const iconAnchor = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<BlockEditorHandle>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const [title, setTitle] = useState(page.title);

  // Re-sync when navigating to a different page (not on every refetch).
  useEffect(() => {
    setTitle(page.title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // A page load is the cheapest moment to refresh what mention chips display.
  useEffect(() => {
    primePage(page);
  }, [page]);

  useAutoGrow(titleRef, title);

  const commit = useDebounced((next: string) => {
    void renamePage(page.id, next);
  }, 350);

  const onTitleChange = (next: string): void => {
    setTitle(next);
    useOptimistic.getState().setTitle(page.id, next);
    commit(next);
  };

  const setIcon = (icon: string | null): void => {
    void commands.updatePage(page.id, { icon });
    setIconOpen(false);
  };

  return (
    <div
      className={cx(
        "page",
        page.fullWidth && "page--wide",
        page.smallText && "page--small",
        peek && "page--peek",
      )}
      ref={bodyRef}
    >
      <div className="page__affordances">
        {page.icon ? null : (
          <button type="button" className="affordance" onClick={() => setIconOpen(true)}>
            <PlusIcon width={13} height={13} />
            Add icon
          </button>
        )}
        <button
          type="button"
          className="affordance"
          title="Covers arrive with the asset pipeline in Phase 3"
          disabled
        >
          <ImageIcon width={13} height={13} />
          Add cover
        </button>
      </div>

      <button
        ref={iconAnchor}
        type="button"
        className="page__icon"
        style={{ display: page.icon ? "block" : "none" }}
        onClick={() => setIconOpen(true)}
        aria-label="Change page icon"
      >
        {page.icon}
      </button>

      <Popover
        open={iconOpen}
        anchorRef={page.icon ? iconAnchor : bodyRef}
        onClose={() => setIconOpen(false)}
        label="Page icon"
        width={286}
      >
        <EmojiPicker
          onPick={(emoji) => setIcon(emoji)}
          onRemove={page.icon ? () => setIcon(null) : undefined}
        />
      </Popover>

      <textarea
        ref={titleRef}
        className="page__title"
        rows={1}
        spellCheck
        placeholder="New page"
        value={title}
        readOnly={page.locked}
        onChange={(e) => onTitleChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || (e.key === "ArrowDown" && !e.shiftKey)) {
            e.preventDefault();
            editorRef.current?.focusStart();
          }
        }}
      />

      {children}

      <BlockEditor
        ref={editorRef}
        pageId={page.id}
        editable={!page.locked}
        onLeaveTop={() => titleRef.current?.focus()}
      />

      {peek ? null : <Backlinks pageId={page.id} />}
    </div>
  );
}
