# Notion Clone — Build Plan

A pixel-close, local-only Notion clone packaged as a desktop app for Windows, macOS, and Linux.

## Scope (as agreed)

**In scope**
- Nested pages with sidebar tree, and a full block editor: text, headings, bulleted/numbered/toggle lists, to-dos, code blocks, callouts, quotes, dividers, simple tables, KaTeX math
- Slash-command menu, drag handles with reordering, markdown input shortcuts (`# `, `- `, `[] `, etc.)
- Multi-column page layouts (drag a block beside another)
- Page links, @-mentions, and a backlinks panel
- Media: image/file/video upload, PDF preview, web bookmarks, YouTube embeds
- Databases: table, board (kanban), calendar, list, and gallery views
- Property types: text, number, select, multi-select, date, checkbox, URL, plus **relations and rollups**; per-view filters and sorts
- Full-text search and a Ctrl+P quick switcher
- Templates, favorites, trash with restore, page history, export to Markdown and PDF
- Light and dark themes matching Notion's look

**Out of scope (by decision)**
- Cloud sync, accounts, multi-user collaboration — all data lives on the local machine
- Notion import
- Formula properties (relations/rollups yes, formula language no)
- Auto-updates — new versions are installed manually

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** | What Notion itself uses; best-tested platform for heavy editor apps; one codebase → Win/Mac/Linux installers |
| Build tooling | **electron-vite + TypeScript** | Fast dev loop, modern defaults |
| UI | **React 18** | Ecosystem fit for the editor and database views |
| Editor engine | **TipTap (ProseMirror) with custom block node views** | ProseMirror is the only realistic base for a Notion-grade editor. TipTap wraps it nicely; each Notion block becomes a custom node with its own React node view, which is what makes pixel-fidelity and per-block drag handles achievable |
| Storage | **SQLite via better-sqlite3** (main process) | Single local file, transactional, fast; FTS5 gives full-text search for free |
| IPC | Typed contract via **electron-trpc** (or a hand-rolled typed IPC layer) | Renderer never touches the DB directly; keeps the security model clean |
| State | **Zustand** + TanStack Query for async data | Lightweight, fits document-centric apps |
| Drag & drop | **dnd-kit** | Block reordering, board cards, column resizing |
| Math | **KaTeX** | Same renderer Notion uses |
| PDF export | Electron `webContents.printToPDF` | No extra dependency |
| Packaging | **electron-builder** + GitHub Actions matrix | NSIS `.exe`, `.dmg`, `.AppImage`/`.deb` from one config |

> Note on shortcuts considered: BlockNote (a prebuilt Notion-style TipTap editor) would get ~70% of the editor quickly, but it fights you on pixel-fidelity, column layouts, and custom block behaviors. Since "exact clone" is the goal, we build our own block layer on TipTap directly.

## Data model

Everything is a **block**, mirroring Notion's actual architecture:

```
blocks
  id            TEXT PK (uuid)
  parent_id     TEXT     -- parent block or page; NULL for workspace roots
  type          TEXT     -- 'page' | 'paragraph' | 'heading1' | 'toggle' | 'column_list' | 'column' | ...
  content       TEXT     -- JSON: rich text runs, props (checked, language, icon, cover, ...)
  order_key     TEXT     -- fractional index for O(1) reordering
  created_at / updated_at / deleted_at   -- deleted_at powers trash

collections           -- a database
  id, page_id, schema TEXT (JSON: property definitions incl. relation/rollup config)

collection_rows       -- each row is also a page (so rows open as full pages)
  page_id, collection_id, properties TEXT (JSON keyed by property id)

collection_views
  id, collection_id, type ('table'|'board'|'calendar'|'list'|'gallery'),
  config TEXT (JSON: filters, sorts, group-by, visible properties, column widths)

links                 -- backlinks index: (source_block_id, target_page_id)
page_history          -- periodic snapshots: (page_id, snapshot TEXT, created_at)
blocks_fts            -- FTS5 virtual table synced by triggers
```

- **Pages are blocks** (`type='page'`), so nesting, moving, trash, and history all use one code path.
- **Rows are pages**, so a board card opens into a real editable page — exactly Notion's behavior.
- Relations store arrays of target page ids in the row's properties JSON; rollups are computed at read time in the main process.

## Architecture

```
┌─ Main process ────────────────────────────┐
│ SQLite (better-sqlite3) · FTS5 search     │
│ File storage (media copied into app dir)  │
│ Export (MD serializer, printToPDF)        │
└──────────────┬────────────────────────────┘
               │ typed IPC (electron-trpc)
┌─ Renderer ───┴────────────────────────────┐
│ App shell: sidebar tree, topbar, tabs     │
│ Editor: TipTap doc per page, custom nodes │
│ Database views: table/board/calendar/...  │
│ Quick switcher, search overlay, settings  │
└───────────────────────────────────────────┘
```

Media files are copied into a per-workspace `assets/` folder next to the SQLite file, so the whole workspace is one portable folder.

## Phases

Each phase ends with something you can run. Estimates assume steady part-time build sessions and are deliberately rough.

### Phase 0 — Foundation (small)
- Scaffold electron-vite + React + TS, ESLint/Prettier, folder structure
- **Set up electron-builder + GitHub Actions from day one** so installers for all three OSes exist before features do (packaging problems are much cheaper to find early)
- Empty app shell: window chrome, Notion-style sidebar/main split, light/dark theme tokens copied from Notion's actual CSS variables

### Phase 1 — Data layer & page tree (small-medium)
- SQLite schema + migrations, typed IPC layer
- Create/rename/delete/move pages; collapsible nested sidebar tree with drag-to-reorder
- Page icons and cover images; workspace persists across restarts

### Phase 2 — Core editor (large — the heart of the project)
- TipTap document wired to block storage (debounced persistence, per-block diffing)
- Blocks: paragraph, headings 1–3, bulleted/numbered/toggle lists, to-do, code (with syntax highlight + language picker)
- Slash menu, markdown shortcuts, drag handle with drop indicator, block selection (click-drag + shift-arrows), copy/paste of blocks
- Keyboard behavior parity: Enter/Backspace semantics, Tab to indent, Ctrl+Shift+arrows to move blocks

### Phase 3 — Advanced editor (medium-large)
- Column layouts via `column_list`/`column` container blocks with drag-right-to-create and draggable divider widths
- Callout, quote, divider, in-page table, KaTeX equation block + inline math
- Images/files/video upload with resize handles; PDF preview; bookmark cards (fetch title/favicon); YouTube embeds
- `@`-mention menu, page links, `links` index maintenance, backlinks panel at page bottom

### Phase 4 — Databases I: tables (medium-large)
- Collection schema editor; create inline or full-page databases
- Table view: typed cells for text/number/select/multi-select/date/checkbox/URL, column resize/reorder/hide, row open as page
- Filters and sorts per view; multiple named views per database

### Phase 5 — Databases II: views + relations (medium-large)
- Board view grouped by select property with drag between columns
- List and gallery views; calendar view (month grid) on a date property
- Relation properties (with the paired reverse relation) and rollup properties (count/sum/avg/min/max/show-originals)

### Phase 6 — Search & quick switcher (small-medium)
- FTS5-backed search overlay with result highlighting
- Ctrl+P quick switcher: fuzzy page-title match, recent pages first

### Phase 7 — Extras & polish (medium)
- Favorites section; trash with restore/permanent-delete; page templates (save page as template, instantiate)
- Page history: periodic snapshots + restore
- Export page/subtree to Markdown (zip) and PDF
- Fidelity pass: hover states, transitions, spacing audit against real Notion side-by-side

### Phase 8 — Release (small)
- electron-builder targets: NSIS `.exe` (Win), `.dmg` (Mac), `.AppImage` + `.deb` (Linux)
- GitHub Actions release workflow: tag → build matrix → attach installers to a GitHub Release
- App icon set, installer branding, README install instructions

## Risks & honest caveats

1. **The editor is 50% of the project.** Notion's editing feel (selection, drag, keyboard semantics) is the hard part; Phase 2–3 will take longer than everything else combined and will need iterative polish.
2. **Unsigned installers warn on install.** Without a paid code-signing cert (~US$100+/yr for Windows, US$99/yr Apple Developer for Mac notarization), Windows shows a SmartScreen warning and macOS requires right-click → Open. Fine for personal use; certs can be added later.
3. **Mac builds require CI or a Mac.** The GitHub Actions matrix handles building, but real testing on macOS needs access to a Mac at least occasionally.
4. **"Exact" has a long tail.** Core layout and behavior can get very close; the last few percent (e.g. Notion's exact drag animations) has diminishing returns. The Phase 7 fidelity pass is where we decide what's close enough.
5. **Relations/rollups touch everything** — schema editor, cells, filters, and reads. Scoped into Phase 5 deliberately so the simpler database core lands first.

## Suggested first milestone

Phases 0–2: an installable app where you can create nested pages and write in a Notion-feel block editor. That proves the riskiest part (the editor) before investing in databases.
