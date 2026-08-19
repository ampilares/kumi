# Secondary read-only Notion verification — SMB Automations

Second pass performed in the logged-in AMP workspace on 19 Aug 2026. It deliberately exercised only navigation and non-mutating UI surfaces. No page, database row, block, comment, view, setting, permission, publish state, import/export job, attachment, invite, or download was changed. The page was left on its original URL with transient panels dismissed.

## Confirmed behavior

- The sidebar exposes `Favorites`, `Recents`, `Teamspaces`, `Shared`, `Private`, and `Notion apps` as expandable sections. Their content is represented as accessible trees; a hovered page exposes discrete **Open**, **Add a page inside**, and **Delete, duplicate, and more…** affordances. A clone should provide hover/touch-safe equivalents and prevent destructive operations from being the primary target.
- The current page has breadcrumbs, a page icon/title header, sharing/actions controls, editable page areas, and an inline table database. Each database title row is a page-like entity and can be opened without changing the underlying table schema.
- The embedded database's **Open as full page** link opens the same data source as a dedicated page. The full-page presentation has its own icon/cover/description slots, a title, a view tab strip (Table selected here), and the same data toolbar/rows. This establishes a stable shared data-source/view model rather than duplicating data on open.
- Clicking a database row opened a transient page/side-peek surface over the original page. The accessible surface exposes an active blank block editor, and Escape dismissed it. The precise narrow-vs-wide breakpoint behavior was not varied in this pass.
- **Add comment** reveals an inline composer with the author avatar, `Add a comment…` field, attachment and mention controls, and disabled Send until content exists. No text was entered. This supports comments as separate objects that can contain files and page/person/date mentions.
- The page Actions palette explicitly exposes keyboard labels for Copy link (`⌘⌥L`), Duplicate (`⌘D`), Move to (`⌘⇧P`), and Present (`⌘⌥P`), alongside Import, Export, Updates & analytics, Version history, page locking and width/text switches. The clone should implement command discoverability and show shortcuts in context menus.
- **Version history** is a modal titled `Page History`, listing dated revisions and authors. It includes a `Restore` action, so the clone needs immutable versions plus a separate, confirmable restoration path (not an in-place overwrite by default).
- **Updates & analytics** opens a right complementary panel with Updates/Analytics tabs. The Updates feed contains actor, action, linked page, date, breadcrumb context, and a `View version for this update` action; the panel is independently closable and resizable.
- Share's **Publish** tab is separate from invite/general-access sharing. It explains that publishing makes the page accessible by link and exposes contributor names, then presents an explicit `Publish` button. The button was not pressed. The clone should require a deliberate mutation and provide a clear public-data disclosure before publishing.

## Screenshots

All are 1280×720 PNGs in this folder.

1. `01-sidebar-tree-affordances.png` — baseline sidebar hierarchy, page header, and inline table.
2. `02-sidebar-tree-hover-actions.png` — Recents item hover reveals Open, nested-page, and more actions.
3. `03-database-row-side-peek.png` — database row open surface over the page.
4. `04-full-page-database-table-view.png` — the same database opened as a full page, with Table as its selected view.
5. `05-inline-comment-composer.png` — page-level comment composer with attachment/mention actions and disabled send state.
6. `06-page-version-history.png` — revision list, authors/dates, Learn more, and Restore action.
7. `07-page-updates-activity-panel.png` — independently closable activity/analytics side panel and update feed.
8. `08-publish-to-web-dialog.png` — Publish tab's explicit public-web disclosure and Publish action.

## High-confidence acceptance criteria

1. Page navigation preserves a hierarchical, scoped sidebar tree; hover/focus affords Open, add-child, and more actions, with accessible names and keyboard operation.
2. A database row is a page object. It can open as a transient side-peek and a data source can open as a full page without copying its records, schemas, or view definitions.
3. Full-page and inline database surfaces share records and views; full-page adds page chrome and a view tab strip while retaining filtering/sorting/search/settings/New controls.
4. Comments have an inline composer with mention and attachment entry points; the send action stays disabled until valid content is present and never creates a comment merely by opening the composer.
5. Page actions are command-palette based, keyboard discoverable, and group read-only actions separately from destructive or state-changing ones.
6. Version history records authors and timestamps and treats restore as an explicit state-changing action. Activity shows linked entities and supplies a direct jump from an update to its relevant version.
7. Publishing is a distinct surface from private sharing, clearly discloses public visibility and contributor-name exposure, and only changes state after the user explicitly publishes.

## Gaps / deliberately untested

- I did not open a revision, invoke Restore, send a comment, attach/mention anything, publish, adjust general access, copy a link, configure analytics, alter an existing view, or create a view/row/page.
- No export/download or import/upload dialog was progressed beyond the earlier pass's safe menu/settings inspection.
- The exact responsive threshold and whether every row opens as a side-peek versus a full modal/page were not tested; the clone should make this configurable and verify it with its own responsive tests.
