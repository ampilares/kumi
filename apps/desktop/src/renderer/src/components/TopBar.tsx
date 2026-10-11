import { Fragment, useRef, useState } from "react";
import type { Page } from "@kumi/core";
import { commands } from "../ipc";
import { useUi } from "../store";
import { toggleFavorite, useBreadcrumb, useOptimistic } from "../data";
import { collapseCrumbs, cx, displayTitle } from "../utils";
import {
  ArchiveIcon,
  ChevronsLeft,
  CopyIcon,
  EllipsisIcon,
  ExportIcon,
  HistoryIcon,
  LinkIcon,
  LockIcon,
  StarIcon,
  TemplateIcon,
  TextSizeIcon,
  TrashIcon,
  WidthIcon,
} from "./icons";
import { ConfirmDialog, MenuItem, MenuLabel, MenuSeparator, NamePrompt, Popover, Toggle } from "./ui";
import { defaultTemplateName, normalizeTemplateName } from "../lib/phase6";
import { exportPageMarkdown, exportPagePdf } from "./exportActions";
import { toastError, toastInfo } from "./Toasts";

export function TopBar({
  page,
  favoriteIds,
}: {
  page: Page | null;
  favoriteIds: string[];
}): JSX.Element {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const openPage = useUi((s) => s.openPage);
  const showEmpty = useUi((s) => s.showEmpty);
  const openHistory = useUi((s) => s.openHistory);
  const crumbs = useBreadcrumb(page?.id ?? null);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The page menu has one nested level; `null` is the root list. */
  const [submenu, setSubmenu] = useState<"export" | null>(null);
  const [templateName, setTemplateName] = useState<string | null>(null);
  const favOverride = useOptimistic((s) => (page ? s.favorites[page.id] : undefined));

  const isFavorite = page ? (favOverride ?? favoriteIds.includes(page.id)) : false;
  const inTrash = page?.deletedAt != null;
  const items = collapseCrumbs(crumbs.data ?? [], 3);

  const closeMenu = (): void => {
    setMenuOpen(false);
    setSubmenu(null);
  };

  const patch = (next: Parameters<typeof commands.updatePage>[1]): void => {
    if (page) void commands.updatePage(page.id, next);
    closeMenu();
  };

  const saveTemplate = async (name: string): Promise<void> => {
    if (!page) return;
    const clean = normalizeTemplateName(name);
    if (!clean) return;
    try {
      await commands.saveAsTemplate(page.id, clean);
      toastInfo(`Saved “${clean}” as a template.`);
    } catch (err) {
      toastError(err, "That template could not be saved.");
    }
  };

  return (
    <header className="topbar">
      <div className="topbar__left">
        {collapsed ? (
          <button
            type="button"
            className="iconbtn"
            title="Open sidebar"
            aria-label="Open sidebar"
            onClick={() => toggleSidebar(false)}
          >
            <ChevronsLeft style={{ transform: "rotate(180deg)" }} />
          </button>
        ) : null}
        <nav className="crumbs" aria-label="Breadcrumb">
          {items.map((item, i) =>
            item === "ellipsis" ? (
              <Fragment key="ellipsis">
                <span className="crumb__sep">/</span>
                <span className="crumb" aria-hidden="true">
                  …
                </span>
              </Fragment>
            ) : (
              <Fragment key={item.id}>
                {i > 0 ? <span className="crumb__sep">/</span> : null}
                <button
                  type="button"
                  className={cx("crumb", item.id === page?.id && "is-current")}
                  onClick={() => openPage(item.id)}
                >
                  {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                  {displayTitle(item.title)}
                </button>
              </Fragment>
            ),
          )}
        </nav>
      </div>

      {page ? (
        <div className="topbar__right">
          {page.locked ? (
            <span className="topbar__badge">
              <LockIcon />
              Locked
            </span>
          ) : null}
          {/* Fig. 1's right cluster surfaces link-copy next to the star rather
              than burying it in the overflow menu. */}
          <button
            type="button"
            className="iconbtn"
            title="Copy link to page"
            aria-label="Copy link to page"
            onClick={() => {
              void navigator.clipboard?.writeText(`kumi://page/${page.id}`);
              toastInfo("Link copied");
            }}
          >
            <LinkIcon />
          </button>
          <button
            type="button"
            className={cx("iconbtn", isFavorite && "is-active")}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
            onClick={() => void toggleFavorite(page.id, !isFavorite)}
          >
            <StarIcon filled={isFavorite} />
          </button>
          <button
            ref={menuAnchor}
            type="button"
            className="iconbtn"
            title="Delete, duplicate, and more…"
            aria-label="Page menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <EllipsisIcon />
          </button>

          <Popover
            open={menuOpen}
            anchorRef={menuAnchor}
            onClose={closeMenu}
            align="end"
            label="Page menu"
            width={240}
          >
            {submenu === "export" ? (
              <>
                <MenuItem label="‹ Back" onSelect={() => setSubmenu(null)} />
                <MenuSeparator />
                <MenuLabel>Export</MenuLabel>
                <MenuItem
                  label="Markdown"
                  hint="folder"
                  onSelect={() => {
                    closeMenu();
                    void exportPageMarkdown(page.id);
                  }}
                />
                <MenuItem
                  label="PDF"
                  hint="file"
                  onSelect={() => {
                    closeMenu();
                    void exportPagePdf(page.id, page.title || "Untitled");
                  }}
                />
              </>
            ) : (
              <>
            <MenuItem
              icon={<TextSizeIcon />}
              label="Small text"
              onSelect={() => patch({ smallText: !page.smallText })}
              trailing={<Toggle on={page.smallText} />}
            />
            <MenuItem
              icon={<WidthIcon />}
              label="Full width"
              onSelect={() => patch({ fullWidth: !page.fullWidth })}
              trailing={<Toggle on={page.fullWidth} />}
            />
            <MenuItem
              icon={<LockIcon />}
              label="Lock page"
              onSelect={() => patch({ locked: !page.locked })}
              trailing={<Toggle on={page.locked} />}
            />
            <MenuSeparator />
            <MenuItem
              icon={<HistoryIcon />}
              label="Page history"
              onSelect={() => {
                closeMenu();
                openHistory(page.id);
              }}
            />
            <MenuItem
              icon={<TemplateIcon />}
              label="Save as template"
              onSelect={() => {
                closeMenu();
                setTemplateName(defaultTemplateName(page.title));
              }}
            />
            <MenuItem
              icon={<ExportIcon />}
              label="Export"
              hint="▸"
              onSelect={() => setSubmenu("export")}
            />
            <MenuSeparator />
            <MenuItem
              icon={<LinkIcon />}
              label="Copy link"
              onSelect={() => {
                void navigator.clipboard?.writeText(`kumi://page/${page.id}`);
                closeMenu();
              }}
            />
            <MenuItem
              icon={<CopyIcon />}
              label="Duplicate"
              onSelect={() => {
                void commands.duplicatePage(page.id);
                closeMenu();
              }}
            />
            <MenuSeparator />
            {inTrash ? (
              <>
                <MenuItem
                  icon={<ArchiveIcon />}
                  label="Restore"
                  onSelect={() => {
                    void commands.restorePage(page.id);
                    closeMenu();
                  }}
                />
                <MenuItem
                  icon={<TrashIcon />}
                  label="Delete permanently"
                  danger
                  onSelect={() => {
                    closeMenu();
                    setConfirmDelete(true);
                  }}
                />
              </>
            ) : (
              <MenuItem
                icon={<TrashIcon />}
                label="Move to Trash"
                danger
                onSelect={() => {
                  void commands.trashPage(page.id).then(() => showEmpty());
                  closeMenu();
                }}
              />
            )}
              </>
            )}
          </Popover>

          <NamePrompt
            open={templateName !== null}
            title="Save as template"
            initial={templateName ?? ""}
            confirmLabel="Save template"
            onCancel={() => setTemplateName(null)}
            onSubmit={(value) => {
              setTemplateName(null);
              void saveTemplate(value);
            }}
          />

          <ConfirmDialog
            open={confirmDelete}
            title="Delete page forever?"
            body="This page and everything inside it will be permanently deleted. This cannot be undone."
            confirmLabel="Delete forever"
            danger
            onCancel={() => setConfirmDelete(false)}
            onConfirm={() => {
              void commands.deletePagePermanently(page.id).then(() => showEmpty());
              setConfirmDelete(false);
            }}
          />
        </div>
      ) : null}
    </header>
  );
}
