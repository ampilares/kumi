import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { TemplateMeta, UserState } from "@kumi/core";
import { commands } from "../ipc";
import { RAIL, useUi } from "../store";
import {
  createPage,
  setExpanded,
  usePages,
  useRootPages,
  useTemplates,
  useWorkspaceInfo,
} from "../data";
import { cx, displayTitle } from "../utils";
import { sortTemplates } from "../lib/phase6";
import {
  ChevronRight,
  ChevronsLeft,
  DocIcon,
  HomeIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  TrashIcon,
} from "./icons";
import { ConfirmDialog, MenuLabel, MenuSeparator, Popover } from "./ui";
import { PageTree } from "./PageTree";
import { toastError, toastInfo } from "./Toasts";

/** How many recently-visited pages the rail lists (Fig. 1 shows ~11). */
const RECENTS_SHOWN = 10;

export function Sidebar({ userState }: { userState: UserState | undefined }): JSX.Element {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const width = useUi((s) => s.sidebarWidth);
  const setWidth = useUi((s) => s.setSidebarWidth);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openSearch = useUi((s) => s.openSearch);
  const openTrash = useUi((s) => s.openTrash);
  const showEmpty = useUi((s) => s.showEmpty);
  const view = useUi((s) => s.view);

  const roots = useRootPages();
  const favoriteIds = userState?.favorites ?? [];
  const favorites = usePages(favoriteIds);
  // Fig. 1's rail lists Recents under Favorites; core already tracks the ids.
  const recentIds = (userState?.recents ?? []).slice(0, RECENTS_SHOWN);
  const recents = usePages(recentIds);
  // A trashed page keeps its recents entry until it is purged; the rail must
  // not offer it as somewhere to go.
  const recentPages = (recents.data ?? []).filter((page) => page.deletedAt === null);

  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent): void => setWidth(e.clientX);
    const onUp = (): void => setDragging(false);
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp, { once: true });
    document.body.style.cursor = "col-resize";
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
  }, [dragging, setWidth]);

  if (collapsed) {
    return (
      <div className="floating-open">
        <button
          type="button"
          className="iconbtn"
          title="Open sidebar"
          aria-label="Open sidebar"
          onClick={() => toggleSidebar(false)}
        >
          <ChevronsLeft style={{ transform: "rotate(180deg)" }} />
        </button>
      </div>
    );
  }

  return (
    <nav
      className="rail"
      style={{ "--rail-width": `${width}px` } as CSSProperties}
      aria-label="Sidebar"
    >
      <div className="rail__header">
        <WorkspaceButton />
        <button
          type="button"
          className="iconbtn"
          title="Close sidebar"
          aria-label="Close sidebar"
          onClick={() => toggleSidebar(true)}
        >
          <ChevronsLeft />
        </button>
      </div>

      <div className="rail__scroll">
        {/* Figs. 1-3: Home is a pill, and the global actions sit beside it as a
            compact icon row rather than each taking a full-width row. */}
        <div className="railtop">
          <button
            type="button"
            className={cx("row", "railtop__home", view === "empty" && "is-selected")}
            onClick={showEmpty}
          >
            <span className="row__icon">
              <HomeIcon />
            </span>
            <span className="row__label">Home</span>
          </button>
          <SettingsRow />
          <button
            type="button"
            className="iconbtn"
            title="Search — Ctrl P"
            aria-label="Search"
            onClick={() => openSearch("search")}
          >
            <SearchIcon />
          </button>
        </div>

        {favoriteIds.length > 0 ? (
          <div className="section">
            <div className="section__title">Favorites</div>
            {(favorites.data ?? []).map((page) => (
              <FavoriteRow key={page.id} id={page.id} title={page.title} icon={page.icon} />
            ))}
          </div>
        ) : null}

        {recentPages.length > 0 ? (
          <div className="section">
            <div className="section__title">Recents</div>
            {recentPages.map((page) => (
              <FavoriteRow key={page.id} id={page.id} title={page.title} icon={page.icon} />
            ))}
          </div>
        ) : null}

        <div className="section">
          <div className="section__title">Private</div>
          {roots.loading && !roots.data ? (
            <div style={{ padding: "6px" }}>
              <div className="skeleton" style={{ width: 120, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: 90 }} />
            </div>
          ) : (roots.data ?? []).length === 0 ? (
            <div className="tree__empty" style={{ paddingLeft: 6 }}>
              No pages inside
            </div>
          ) : (
            <PageTree nodes={roots.data ?? []} favoriteIds={favoriteIds} />
          )}
        </div>

        <div className="section">
          <button
            type="button"
            className={cx("row", view === "trash" && "is-selected")}
            onClick={openTrash}
          >
            <span className="row__icon">
              <TrashIcon />
            </span>
            <span className="row__label">Trash</span>
          </button>
        </div>
      </div>

      <div className="rail__footer">
        <NewPageButton />
      </div>

      <div
        className={cx("rail__resizer", dragging && "is-active")}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => setWidth(RAIL.DEFAULT)}
      />
    </nav>
  );
}

/**
 * The rail's "New page" control, split like the database toolbar's New pill:
 * the wide half is the unchanged blank-page action, the ▾ half lists templates.
 * Keeping the plain click free of a menu matters — creating a page is the most
 * frequent action in the app and must stay one click.
 */
function NewPageButton(): JSX.Element {
  const caretAnchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TemplateMeta | null>(null);
  const templates = useTemplates(open);
  const view = useUi((s) => s.view);
  const currentPageId = useUi((s) => s.currentPageId);
  const openPage = useUi((s) => s.openPage);

  const list = sortTemplates(templates.data ?? []);
  /** Templates land under the open page when there is one, else at the root. */
  const parentId = view === "page" ? currentPageId : null;

  const instantiate = async (template: TemplateMeta): Promise<void> => {
    setOpen(false);
    try {
      const page = await commands.instantiateTemplate(template.id, parentId);
      if (parentId) await setExpanded(parentId, true);
      openPage(page.id);
      void commands.touchRecent(page.id);
    } catch (err) {
      toastError(err, "That template could not be used.");
    }
  };

  const remove = async (template: TemplateMeta): Promise<void> => {
    setConfirmDelete(null);
    try {
      await commands.deleteTemplate(template.id);
      toastInfo(`Deleted the “${template.name}” template.`);
    } catch (err) {
      toastError(err, "That template could not be deleted.");
    }
  };

  return (
    <>
      <div className="newsplit">
        <button
          type="button"
          className="newbtn newsplit__main"
          onClick={() => void createPage(null)}
        >
          <span className="row__icon">
            <PlusIcon />
          </span>
          <span className="row__label">New page</span>
          <span className="menuitem__hint">Ctrl N</span>
        </button>
        <button
          ref={caretAnchor}
          type="button"
          className="newbtn newsplit__caret"
          title="New from template"
          aria-label="New from template"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronRight style={{ transform: "rotate(90deg)" }} />
        </button>
      </div>

      <Popover
        open={open}
        anchorRef={caretAnchor}
        onClose={() => setOpen(false)}
        align="end"
        label="New from template"
        width={260}
      >
        <MenuLabel>New from template</MenuLabel>
        {templates.loading && !templates.data ? (
          <div className="menu__label">Loading…</div>
        ) : list.length === 0 ? (
          <div className="menu__label" style={{ lineHeight: 1.4 }}>
            No templates yet — use ⋯ → Save as template on any page.
          </div>
        ) : (
          list.map((template) => (
            <div key={template.id} className="templaterow">
              <button
                type="button"
                className="menuitem templaterow__main"
                onClick={() => void instantiate(template)}
              >
                <span className="row__icon">{template.icon ?? <DocIcon />}</span>
                <span className="menuitem__label">{template.name}</span>
              </button>
              <button
                type="button"
                className="iconbtn templaterow__delete"
                title={`Delete the ${template.name} template`}
                aria-label={`Delete the ${template.name} template`}
                onClick={() => setConfirmDelete(template)}
              >
                <TrashIcon width={13} height={13} />
              </button>
            </div>
          ))
        )}
      </Popover>

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Delete this template?"
        body={
          confirmDelete
            ? `“${confirmDelete.name}” will be removed. Pages already created from it are untouched.`
            : ""
        }
        confirmLabel="Delete template"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete);
        }}
      />
    </>
  );
}

function FavoriteRow({
  id,
  title,
  icon,
}: {
  id: string;
  title: string;
  icon: string | null;
}): JSX.Element {
  const openPage = useUi((s) => s.openPage);
  const selected = useUi((s) => s.currentPageId === id);
  return (
    <button
      type="button"
      className={cx("row", selected && "is-selected")}
      onClick={() => {
        openPage(id);
        void commands.touchRecent(id);
      }}
    >
      <span className="row__icon">{icon ?? <DocIcon />}</span>
      <span className="row__label">{displayTitle(title)}</span>
    </button>
  );
}

function WorkspaceButton(): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const info = useWorkspaceInfo();
  const name = info.data?.name ?? "Kumi";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="rail__ws"
        onClick={() => {
          setDraft(name);
          setOpen(true);
        }}
        title={info.data?.path ?? ""}
      >
        <span className="rail__ws-icon">{info.data?.icon ?? name.slice(0, 1).toUpperCase()}</span>
        <span className="rail__ws-name">{name}</span>
      </button>
      <Popover
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        label="Workspace"
        width={260}
      >
        <MenuLabel>Workspace name</MenuLabel>
        <div style={{ padding: "0 4px 4px" }}>
          <input
            className="field"
            autoFocus
            maxLength={65}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const next = draft.trim();
                if (next && next !== name) void commands.renameWorkspace(next);
                setOpen(false);
              }
            }}
          />
        </div>
        <MenuSeparator />
        <div className="menu__label" style={{ wordBreak: "break-all" }}>
          {info.data?.path ?? ""}
        </div>
      </Popover>
    </>
  );
}

/**
 * Opens the settings modal. Phase 7 replaced the old anchored popover: theme,
 * export and the import hub no longer fit in a 220 px menu, and the fidelity
 * reference puts all three behind one modal with a left nav.
 */
function SettingsRow(): JSX.Element {
  const openSettings = useUi((s) => s.openSettings);
  const active = useUi((s) => s.settingsOpen);

  return (
    <button
      type="button"
      className={cx("row", active && "is-selected")}
      onClick={() => openSettings()}
    >
      <span className="row__icon">
        <SettingsIcon />
      </span>
      <span className="row__label">Settings</span>
    </button>
  );
}
