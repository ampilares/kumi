# Notion UI/UX reconnaissance — AMP / SMB Automations

Read-only browser pass on 19 Aug 2026 using the signed-in AMP workspace. No pages, blocks, database rows, permissions, settings, exports, downloads, invites, or uploads were changed. Browser viewport was 1280×720 CSS pixels at devicePixelRatio 2; screenshots are PNGs at that viewport.

## Executive implementation notes

- Notion is a two-pane shell: a persistent ~270 px left navigation rail and a flexible main canvas (~1010 px at this viewport). The shell uses a warm off-white/white surface, light gray separators, rounded controls, restrained shadows, and a system sans stack (`ui-sans-serif`, `-apple-system`, Segoe UI, Helvetica). Primary heading is approximately 40 px/48 px, dark charcoal (`rgb(44,44,43)`).
- The sidebar is hierarchical and stateful: workspace switcher, Home/Chat/Meetings/Inbox tabs, Search, Favorites, Recents, Teamspaces, Shared, Private, Notion apps, Library, My Tasks, Marketplace, Help, Trash, and a bottom New button. Page tree items expose open/add-child/more actions on focus/hover. The workspace switcher includes account/workspace list, upgrade, settings, people, add account, logout, and suggested workspaces.
- The page header is a 44 px top banner with breadcrumbs, page icon/title, Share, Copy link, Favorite, and Actions. Main page content supports icon, cover, comment affordance, editable title, arbitrary blocks, inline databases, and a floating Notion AI button.
- Rich editor blocks observed include linked pages, headings, checkboxes/to-dos, inline database, page icon, cover, comments, and empty insertion textboxes. Existing content is rendered as blocks with inline editing affordances; block handles appear on hover/focus.
- Inline databases expose a compact toolbar: add view, collection actions, Filter, Sort, Automations, AI Autofill, Search, open as full page, Settings, New, and more add options. Rows/cards have page titles, property chips, checkboxes, and New page affordances.
- Database view types available from the add-view grid: Table, Board, Gallery, List, Chart, Dashboard, Timeline, Feed, Map, Calendar, Form, and New data source. Existing pages demonstrated synchronized Board and Table views over the same dataset.
- View settings include view name/icon, Layout, Property visibility, Filter, Sort, Group, Conditional color, Copy link, data-source settings, Edit properties, Automations, AI Autofill, More settings, Manage data sources, and Lock database. Property visibility provides search, Hide all, drag ordering, and per-property visibility toggles.
- Filtering opens a property picker (SMB Pain Point, Category, Potential Solution in the inspected database) plus Add advanced filter. Sorting opens the same property picker. Keep these as non-destructive view-local configuration objects.
- Page Actions is a searchable command palette. Observed commands: style presets (Default/Serif/Mono), Copy page contents, Duplicate, Move to, Move to Trash, Present, Small text, Full width, Customize page, Lock page, Use with AI, Suggest edits, Translate, Undo, Import, Export, Turn into wiki, Updates & analytics, Version history, notifications, Connections, Open in Mac app. It also shows word count and last-edited metadata.
- Sharing dialog has Share/Publish tabs, email/group invite field, current member + permission control, General access (Only people invited in this workspace), Copy link, and a learn-about-sharing link. A clone should model permission inheritance and page-level roles, but keep risky changes behind explicit confirmation.
- Workspace Settings & members includes account/preferences/notifications/mail & calendar, workspace General/People/Import, feature tabs (Notion AI, Connections, Notion MCP, Public pages, Emoji, Developer), Teamspaces, Billing, and plans. General includes workspace name/icon, custom landing page, sidebar app toggles, whole-workspace Export, page-view analytics, workspace ID, and danger-zone deletion. Preferences includes theme, high contrast, input behavior, language/number/date formats, week start, timezone, desktop link behavior, open-on-start, cookie settings, view history, and profile discoverability.
- Migration UI is explicit and broad: Settings → Import offers ZIP (up to 5GB), CSV, PDF, text/Markdown, HTML, Word/DOCX, EPUB, and third-party imports for Asana, Confluence, Trello, Workflowy, Evernote, Jira, Monday.com, Quip, and Google Docs; it also has Discover/Completed tabs. General settings separately exposes whole-workspace Export. A clone should provide a durable, resumable export/import pipeline with block and database schema preservation, attachments, IDs, links, permissions, and an import-job history.
- Global Search is a modal with a query/ask combobox, highlight pane and filters (Title only, Created by, In), plus Filter and Search settings. It shows results grouped by date, with page icon/title, breadcrumb, author, edited date, and matching snippet; opening a result can show an inline side preview. Search results are live and can be queried without leaving the current page.

## Screenshots

All screenshots are in this folder and use descriptive names. The 12 most representative captures for the clone spec are marked ★.

- ★ `01-smb-automations-initial.png` — SMB Automations page, sidebar, breadcrumbs, title, inline table database, toolbar, row/property chips.
- ★ `02-share-permissions.png` — Share dialog with Share/Publish tabs, invite field, member role, general access, Copy link.
- ★ `03-page-actions-menu.png` — Actions command palette including Import/Export and page-level commands.
- ★ `04-settings-import-migration.png` — Settings → Import migration hub, supported file formats, third-party sources, Discover/Completed tabs.
- ★ `05-settings-general-export.png` — Workspace General settings with name/icon, custom landing page, whole-workspace Export, analytics and danger zone.
- `06-settings-preferences.png` — Appearance, input, language/time, desktop, privacy preferences.
- ★ `07-global-search.png` — Global search modal, query field, filters, recent results, preview pane.
- `08-global-search-results.png` — Search results after `automation` query with breadcrumbs, snippets, dates, and preview context.
- `09-database-controls-menu.png` — Collection/view actions menu: copy link, duplicate, view database, edit title/icon/layout, hide title.
- ★ `10-database-view-types.png` — Add a new view grid (Table, Board, Gallery, List, Chart, Dashboard, Timeline, Feed, Map, Calendar, Form, New data source).
- `11-database-filter-state.png` — Toolbar hover/state reference for table database controls (kept as a visual state capture).
- ★ `12-database-filter-menu.png` — Filter property picker and Add advanced filter.
- `13-database-sort-menu.png` — Sort property picker.
- ★ `14-database-view-settings.png` — View settings sheet with layout, visibility, grouping, source, automation, locking controls.
- `15-property-visibility.png` — Property visibility panel with search, Hide all, ordering and toggles.
- ★ `16-rich-page-editor.png` — Rich page editor with linked pages, heading, to-dos, inline database and board view.
- `17-table-database-view.png` — Table view with Name/Category/Difficulty/Impact/Status properties and multiple rows.
- ★ `18-board-database-view.png` — Board view grouped by status and date with colored property chips and New page cards.
- `19-sidebar-collapsed.png` — Workspace switcher popover opened from AMP workspace header (filename retained; visual is the switcher, not a collapsed rail).
- `20-workspace-switcher.png` — Dedicated capture of account/workspace switcher with Settings, People, Add account, workspace list, suggested joins, and Log out.
- `21-board-editor-clean.png` — Clean board editor after dismissing workspace switcher.

## Suggested clone acceptance criteria

1. Preserve a stable workspace/page tree and URL-addressable page IDs; support Favorites, Recents, private/shared/teamspace scopes, breadcrumbs, page icons, covers, comments, and full-page vs inline database rendering.
2. Implement block-level editor semantics (rich text, headings, lists, to-dos, links/mentions, media, nested pages, slash insertion, drag/reorder, undo/version history, page locking) with keyboard and pointer parity.
3. Implement a typed database model: title, text, select/status, multi-select, number, date, person, relation, rollup/formula, checkbox, URL/files; rows are pages and properties are schema. Support table/board/gallery/list/calendar/timeline/chart/dashboard/feed/map/form views.
4. Treat filters, sorts, groups, conditional colors, visible-property order, layouts, and locked views as per-view state. Support multiple views sharing a data source and opening a database as a full page.
5. Provide search over titles, body blocks, properties, and breadcrumbs with filters, snippets, date grouping, and an optional side preview; keyboard shortcut and no-navigation modal behavior are important.
6. Add sharing/publication flows with inherited permissions, invited-member roles, link access, copy-link, and Publish; separate read-only inspection from mutations.
7. Build migration as first-class functionality: export a complete workspace plus attachments; import ZIP/CSV/PDF/Markdown/HTML/DOCX/EPUB and third-party providers; job progress, retries, completed history, ID/link remapping, and loss reports are essential for leaving Notion.
8. Match the visual rhythm: ~270 px rail, 44 px top banner, 40 px page title, 8–12 px corner radii, low-contrast separators, subtle shadows, neutral background, blue primary New controls, colored status/property chips, and generous whitespace.

## Safety and scope note

The pass intentionally stopped short of clicking Export, choosing a file, changing permissions, toggling settings, creating/duplicating/moving/trashing pages, adding database views, or editing content. Menus and settings panes were opened only to read their visible controls.
