import { useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { PageTreeNode } from "@kumi/core";
import { commands } from "../ipc";
import { useUi } from "../store";
import {
  createPage,
  setExpanded,
  toggleFavorite,
  useChildren,
  useOptimistic,
} from "../data";
import { cx, displayTitle } from "../utils";
import { ChevronRight, DocIcon, EllipsisIcon, PlusIcon } from "./icons";
import { MenuItem, MenuSeparator, Popover } from "./ui";

const INDENT = 14;

export function PageTree({
  nodes,
  depth = 0,
  favoriteIds,
}: {
  nodes: PageTreeNode[];
  depth?: number;
  favoriteIds: string[];
}): JSX.Element {
  return (
    <div role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <TreeRow key={node.page.id} node={node} depth={depth} favoriteIds={favoriteIds} />
      ))}
    </div>
  );
}

/** Moves DOM focus to the next (or previous) rendered tree row. */
function focusNeighbour(from: HTMLElement, direction: 1 | -1): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-treerow="1"]'));
  const index = rows.indexOf(from);
  if (index === -1) return;
  const next = rows[index + direction] ?? rows[index - direction];
  next?.focus();
}

function TreeRow({
  node,
  depth,
  favoriteIds,
}: {
  node: PageTreeNode;
  depth: number;
  favoriteIds: string[];
}): JSX.Element {
  const page = node.page;
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");

  const expanded = useUi((s) => s.expanded[page.id] ?? false);
  const currentPageId = useUi((s) => s.currentPageId);
  const openPage = useUi((s) => s.openPage);
  const showEmpty = useUi((s) => s.showEmpty);
  const titleOverride = useOptimistic((s) => s.titles[page.id]);
  const favOverride = useOptimistic((s) => s.favorites[page.id]);

  const isFavorite = favOverride ?? favoriteIds.includes(page.id);
  const children = useChildren(page.id, expanded);
  const selected = currentPageId === page.id;
  const title = displayTitle(titleOverride ?? page.title);

  const open = (): void => {
    openPage(page.id);
    void commands.touchRecent(page.id);
  };

  const toggle = (e: MouseEvent): void => {
    e.stopPropagation();
    void setExpanded(page.id, !expanded);
  };

  const addChild = (e: MouseEvent): void => {
    e.stopPropagation();
    void createPage(page.id);
  };

  const trash = (): void => {
    const el = rowRef.current;
    void commands.trashPage(page.id).then(() => {
      if (currentPageId === page.id) showEmpty();
      if (el) focusNeighbour(el, 1);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    } else if (e.key === "Delete") {
      e.preventDefault();
      trash();
    } else if (e.key === "ArrowRight" && !expanded) {
      e.preventDefault();
      void setExpanded(page.id, true);
    } else if (e.key === "ArrowLeft" && expanded) {
      e.preventDefault();
      void setExpanded(page.id, false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rowRef.current) focusNeighbour(rowRef.current, e.key === "ArrowDown" ? 1 : -1);
    }
  };

  const commitRename = (): void => {
    setRenaming(false);
    const next = draft.trim();
    if (next && next !== page.title) {
      useOptimistic.getState().setTitle(page.id, next);
      void commands
        .updatePage(page.id, { title: next })
        .finally(() => useOptimistic.getState().clear(page.id));
    }
  };

  return (
    <>
      <div
        ref={rowRef}
        data-treerow="1"
        role="treeitem"
        aria-expanded={expanded}
        aria-selected={selected}
        aria-level={depth + 1}
        tabIndex={0}
        className={cx("row", selected && "is-selected")}
        style={{ paddingLeft: 6 + depth * INDENT }}
        onClick={open}
        onKeyDown={onKeyDown}
        title={title}
      >
        <button
          type="button"
          className={cx("disc", expanded && "is-open", !expanded && "is-hidden")}
          onClick={toggle}
          tabIndex={-1}
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ChevronRight />
        </button>
        <span className="row__icon">{page.icon ?? <DocIcon />}</span>
        <span className="row__label">{title}</span>
        {/* Fig. 3 orders the hovered affordances add-child then more-actions. */}
        <span className={cx("row__actions", menuOpen && "is-open")}>
          <button
            type="button"
            className="iconbtn iconbtn--sm"
            title="Add a page inside"
            aria-label="Add a page inside"
            onClick={addChild}
          >
            <PlusIcon />
          </button>
          <button
            ref={menuRef}
            type="button"
            className="iconbtn iconbtn--sm"
            title="Delete, duplicate, and more…"
            aria-label="Page options"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
          >
            <EllipsisIcon />
          </button>
        </span>
      </div>

      <Popover
        open={menuOpen}
        anchorRef={menuRef}
        onClose={() => setMenuOpen(false)}
        label="Page options"
        width={220}
      >
        {renaming ? (
          <div style={{ padding: 4 }}>
            <input
              className="field"
              autoFocus
              value={draft}
              placeholder="Page name"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitRename();
                  setMenuOpen(false);
                }
                if (e.key === "Escape") setRenaming(false);
              }}
              onBlur={commitRename}
            />
          </div>
        ) : (
          <>
            <MenuItem
              label={isFavorite ? "Remove from favorites" : "Add to favorites"}
              onSelect={() => {
                void toggleFavorite(page.id, !isFavorite);
                setMenuOpen(false);
              }}
            />
            <MenuItem
              label="Rename"
              onSelect={() => {
                setDraft(page.title);
                setRenaming(true);
              }}
            />
            <MenuItem
              label="Duplicate"
              onSelect={() => {
                void commands.duplicatePage(page.id);
                setMenuOpen(false);
              }}
            />
            <MenuItem
              label="Copy link"
              onSelect={() => {
                void navigator.clipboard?.writeText(`kumi://page/${page.id}`);
                setMenuOpen(false);
              }}
            />
            <MenuSeparator />
            <MenuItem
              label="Move to Trash"
              danger
              onSelect={() => {
                trash();
                setMenuOpen(false);
              }}
            />
          </>
        )}
      </Popover>

      {expanded ? (
        children.data && children.data.length > 0 ? (
          <PageTree nodes={children.data} depth={depth + 1} favoriteIds={favoriteIds} />
        ) : children.loading ? (
          <div className="tree__empty" style={{ paddingLeft: 6 + (depth + 1) * INDENT }}>
            <div className="skeleton" style={{ width: 90 }} />
          </div>
        ) : (
          <div className="tree__empty" style={{ paddingLeft: 6 + (depth + 1) * INDENT }}>
            No pages inside
          </div>
        )
      ) : null}
    </>
  );
}
