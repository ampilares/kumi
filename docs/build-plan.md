# Kumi — Build Plan

A local-only, **Electron + SQLite** desktop app that works exactly like Notion — same layouts, interactions, and keyboard feel — so the AMP Notion workspace can be transferred over with no change in day-to-day user experience. The app is **agent-native** via [CLI-Anything](https://github.com/HKUDS/CLI-Anything): every capability the UI has is also available as a structured, JSON-emitting CLI that AI agents can drive deterministically.

Fidelity source of truth: [docs/specs.pdf](specs.pdf) — the Kumi specification captured from the real AMP Notion workspace (20 annotated screenshots + requirements). Where the spec describes multi-user/cloud concerns, this plan scopes them out; where it describes UX, data model, and migration fidelity, this plan adopts it.

## Scope

**In scope**
- Full Notion-fidelity shell, editor, and databases (details in "UI fidelity reference" below, built to the spec's screenshots)
- Editor P0 blocks (spec §4): paragraph, headings 1–3, bulleted/numbered lists, to-do, toggle, quote, callout, divider, code, equation (KaTeX), bookmark, table of contents, image/file/video/audio, embed/link preview, child page, linked page, columns, simple table, synced block; inline mentions (pages/dates), links, full annotation set (bold/italic/underline/strike/code/color)
- Slash menu, markdown shortcuts, drag handles, multi-block selection, duplicate/delete/turn-into/color, formatting toolbar, undo/redo, find-in-page, copy block link
- Databases (spec §5): rows-are-pages; typed properties incl. **relations, rollups, and a formula subset**; table, board, list, gallery, calendar, timeline views; nested AND/OR filter trees, sorts, grouping, conditional color, property visibility; inline + full-page; center/side peek + full-page row open modes
- Global search + preview panel, Ctrl+P quick switcher, command palette
- Favorites, recents, trash with restore, page history with restore-as-new-version, templates, page lock
- Export to Markdown/CSV/PDF and a round-trippable native JSON export
- **Agent-native layer**: headless `kumi` CLI over the same core, wrapped by a CLI-Anything harness (SKILL.md, `--json`, REPL)
- **One-time Notion import** (Markdown+CSV and HTML export archives) — built **after** the app itself is done
- Light/dark themes matching Notion's look

**Out of scope (by decision)**
- Cloud sync, accounts, multi-user collaboration, sharing/publishing, realtime — all data lives on the local machine, single user
- Comments/inbox (single-user; revisit later), automations execution (imported as inert definitions only), AI features
- Auto-updates; unsigned installers accepted for personal use

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron** | What Notion itself uses; best-tested platform for heavy editor apps; Win/Mac/Linux from one codebase |
| Build tooling | **electron-vite + TypeScript**, pnpm monorepo | Fast dev loop; monorepo enables the shared headless core |
| UI | **React 18** | Ecosystem fit for editor + database views |
| Editor engine | **TipTap (ProseMirror), custom block node views** | Only realistic base for Notion-grade editing. Kumi owns the persisted block schema — ProseMirror JSON is never the storage format |
| Storage | **SQLite via better-sqlite3** (WAL mode) | Single portable file; transactional; FTS5 full-text search built in |
| Core logic | **`@kumi/core` package** — all commands, queries, schema, migrations | One code path used by Electron main **and** the headless CLI; this is what makes agent-native possible |
| IPC | Typed contract (electron-trpc or hand-rolled) over the same core command set | Renderer never touches the DB; UI ops ≡ CLI ops |
| Agent layer | **`kumi` CLI (Node)** + **CLI-Anything harness** (Python Click wrapper, SKILL.md, REPL, tests) | Deterministic agent control without GUI automation |
| State | Zustand + TanStack Query | Document-centric, optimistic updates |
| Drag & drop | dnd-kit | Blocks, tree, board cards, column widths |
| Math | KaTeX | Same renderer Notion uses |
| PDF export | Electron `webContents.printToPDF` | No extra dependency |
| Packaging | electron-builder + GitHub Actions matrix | NSIS `.exe`, `.dmg`, `.AppImage`/`.deb` |

> BlockNote was considered and rejected again: it fights pixel-fidelity, column layouts, and custom block behaviors. "Exactly like Notion" requires our own block layer on TipTap.

## Data model (spec §8, adapted to SQLite)

Everything is a block; pages are blocks; rows are pages — mirroring Notion's actual architecture so imported data maps 1:1 and every row opens as a real page (spec Figs. 4, 6).

```
pages        id, parent_id, title, icon, cover, state, lock, sort_rank,
             created/updated/deleted_at            -- deleted_at powers trash
blocks       id, page_id, parent_block_id, rank TEXT (fractional), type,
             payload JSON (rich-text spans + typed props), version, archived,
             created/updated_at
data_sources id, page_id, title, schema_version
properties   id, data_source_id, name, type, config JSON, rank
             -- stable IDs survive rename (spec requirement)
prop_values  page_id, property_id, value JSON      -- sparse; typed indexes on shadow cols
views        id, data_source_id, type ('table'|'board'|'list'|'gallery'|'calendar'|'timeline'),
             query JSON (filter tree, sorts, group), layout JSON (visible props,
             widths, conditional color, open mode), lock
assets       id, content_hash, mime, size, path    -- dedup by hash; files in workspace assets/
links        source_block_id, target_page_id       -- backlinks index
revisions    entity_id, actor, version, patch JSON, created_at   -- history + restore
templates    id, name, source_page_id
blocks_fts   FTS5 virtual table synced by triggers (titles, block text, property text)
import_jobs  id, source_hash, status, checkpoints JSON, mappings JSON   -- Phase 7
```

Invariants adopted from the spec:
- **Structured block tree + rich-text spans, never stored HTML.**
- **Fractional ranks** so reordering is O(1) and stable.
- **Views are non-destructive projections** — editing a row mutates the shared data source; editing a view mutates only that view. Property option IDs are stable.
- Property types: title, text, number(format), select/status, multi-select, date (start/end/tz), files, checkbox, URL, email, phone, **relation (bidirectional mirror, deferred resolution on import), rollup (count/sum/avg/min/max/show-originals), formula (translated Notion subset)**, created/edited metadata, unique ID. Person-type is stored but maps to the single local user.
- Restore from history creates a **new** version; later history is never destroyed (spec Fig. 6).
- The whole workspace = one folder: `kumi.db` + `assets/` — portable by copying.

## Architecture

```
┌─ @kumi/core (TypeScript, headless) ─────────────────────────┐
│ SQLite (better-sqlite3, WAL) · migrations · FTS5            │
│ Command layer: pages, blocks (batch ops w/ client op IDs),  │
│ data sources, properties, views, query engine (filter tree, │
│ sort, group, rollup/formula eval), search, history, trash,  │
│ templates, assets, export (MD/CSV/JSON), import pipeline    │
└──────┬──────────────────────────────┬───────────────────────┘
       │ typed IPC                    │ direct require
┌─ Electron main ─┐            ┌─ kumi CLI (Node) ────────────┐
│ windows, menus, │            │ every core command as a      │
│ printToPDF,     │            │ subcommand · --json output   │
│ file dialogs    │            │ · exit codes · stdin batch   │
└──────┬──────────┘            └──────┬───────────────────────┘
┌─ Renderer ──────┴─────────┐  ┌──────┴───────────────────────┐
│ Shell: sidebar, topbar    │  │ CLI-Anything harness (Python │
│ Editor: TipTap custom     │  │ Click): cli-anything-kumi,   │
│ nodes · DB views · search │  │ REPL mode, SKILL.md, tests   │
│ overlay · quick switcher  │  └──────────────────────────────┘
└───────────────────────────┘
```

- **Single-writer discipline**: SQLite WAL + busy timeout lets the CLI and the app coexist; the CLI detects a running app instance (lockfile + local socket) and routes writes through it so the UI updates live; otherwise it opens the DB directly. Either way it's the same `@kumi/core` code.
- **Everything is a command**: the renderer and the CLI call the identical command layer, so agent parity with the UI is guaranteed by construction, not by re-implementation.

## Agent-native design (CLI-Anything)

CLI-Anything's pipeline (analyze → design → implement → test → document → publish) generates a Click-based harness from a codebase. We make Kumi an ideal target from day one:

1. **`kumi` CLI ships with the app** (Phase 1 onward), exposing the full command layer:
   `kumi page create|move|list|show`, `kumi block append|edit|move|delete`, `kumi db create|schema|query --filter '<json>' --sort ...`, `kumi row add|set|open`, `kumi view create|configure`, `kumi search "<q>"`, `kumi history list|restore`, `kumi export ...` — every command with `--json`, stable exit codes, and batch input via stdin (mirrors the spec's `operations/batch` contract with client op IDs, so agent edits are atomic and idempotent).
2. **Run the CLI-Anything generator** (`/cli-anything ./kumi`) in Phase 6 to produce the harness package: dual-mode (subcommands + stateful REPL for long agent sessions), auto-generated **SKILL.md** for agent discovery, and a subprocess-level test suite. Iterate coverage with `/cli-anything:refine`.
3. **Authentic integration principle** (CLI-Anything's "zero compromise"): harness commands hit the real SQLite workspace through `@kumi/core` — no simulation layer; tests fail rather than degrade if the backend is missing.
4. Result: Claude Code (or any agent platform CLI-Anything supports) can create pages, restructure databases, run filtered queries, and bulk-edit content in Kumi headlessly — while a human sees the same workspace live in the Electron UI.

## UI fidelity reference (from the spec's screenshots — build to these)

The 20 figures in specs.pdf are captures of the real AMP Notion workspace and are the pixel/behavior reference. Ship a Kumi identity (name/icon), not Notion's branding.

**Shell (Figs. 1–3):**
- Left rail ~**270 px** (resizable 220–360 px), warm-white `#FBFAF8`; content surface `#FFFFFF`; primary text ≈ `#2C2C2B`, secondary ≈ `#6B6A66`.
- Rail order: workspace name + icon with collapse chevron « ; **Home pill + icon row** (updates, templates, inbox, search); **Favorites**; **Recents**; page trees; pinned **New** button at rail bottom.
- Tree rows: emoji/icon + name; hover reveals `+` (add child) and `…` with tooltip "Delete, duplicate, and more…" (Fig. 3); chevron appears on hover; selected row gets a soft gray pill. Expansion + scroll state persist across restarts; search/navigation never destroys them.
- Top bar ~**44 px**, sticky: breadcrumbs with ellipsis collapse (`Projects / … / Partner / Consultant / SMB Automations`); right cluster: lock-glyph privacy label, link-copy, star favorite (gold when active), `…` overflow.
- Page header: large icon above ~40/48 px title; hover-only "Add cover"; content max width 720 px + full-width toggle.

**Editor (Figs. 5, 16):**
- Low-chrome canvas: colored inline text (red section headings in the reference), to-dos with strikethrough on completion, linked child pages with icons, inline databases mid-page.
- Hover gutter per block: `+` and `⠿` drag handle (visible left of GOALS heading in Fig. 9).
- Page `…` palette (Fig. 16): search field on top; font tiles (Default/Serif/Mono "Ag"); Copy link / Copy page contents / Duplicate / Move to / Move to Trash; toggles Small text, Full width; Customize page; Lock page; Undo. Commands grouped by intent, shortcuts right-aligned, destructive actions separated.

**Databases (Figs. 1, 7–10, 19):**
- Inline database block: gray title, view tabs ("Board View | Table | +"), compact right toolbar: filter, sort, ⚡, search, expand, view-settings sliders icon, and the **blue split "New ▾" button**.
- Table: property-type glyphs in headers (`Aa` title, ⊙ select, ≡ text), `+` add column, `+ New page` footer row.
- **Add-view menu (Fig. 7)**: icon grid — Table, Board, Gallery, List, Calendar, Timeline ship; Chart, Dashboard, Feed, Map, Form are placeholders that must not require data-model changes later.
- **View settings inspector (Fig. 8)**: right-anchored layered panel — view name, Layout, Property visibility (count), Filter, Sort, Group, Conditional color, Copy link to view; "Data source settings": Source, Edit properties, More; Manage data sources; **Lock database**. Inline controls stay compact; deep config lives here so the page stays spatially stable.
- **Board (Fig. 9)**: grouped columns with colored chips + counts ("Not Started 5 / In Progress 3 / Completed 0"), collapsible subgroups ("▾ This Year (2026) 3"), cards with title + colored property pills (`Impact: High`, `Difficulty: Hard`), per-column `+ New page`, horizontal overflow.
- **Filter menu (Fig. 19)**: anchored dropdown — "Filter by…" search, typed property list with glyphs, "+ Add advanced filter" for nested AND/OR. No context switch.
- Full-page database (Fig. 10) is the same component as inline with different chrome — schema, records, view tabs, and toolbar are shared, never duplicated.

**Row peek + history (Figs. 4, 6):**
- Row click opens a **center peek modal** over the originating table, breadcrumbs preserved behind; side peek and full page are alternate open modes; back/forward restores exact prior view + scroll.
- **Version history (Fig. 6)**: right panel in the peek — dated revisions with author ("November 4, 2025 — Allen"), lock icons on snapshots, live preview of the selected revision including red "Deleted content" strips, blue **Restore** button.

**Search (Fig. 11) + quick switcher:**
- Modal over current context: search input, filter chip row (`Aa Title only`, `Created by ▾`, `In ▾`, `+ Filter`), **date-grouped results** ("Today", "Yesterday") with icon/title/gray breadcrumb, **right-side preview panel** of the highlighted result — preview without navigating. Ranking blends title match, phrase, recency, and interaction; show why a result matched. Ctrl+P quick switcher: fuzzy titles, recents first.

**Settings (Figs. 18, 20) & import hub (Fig. 17):**
- Settings modal with persistent left nav (Account/Preferences/Notifications · Workspace: General/**Import**). General: workspace name (65-char cap), icon, landing page; deletion isolated in a danger zone. Preferences: theme system/light/dark, high contrast, input options, language & time.
- Import hub inside settings: drag-drop zone ("ZIP, CSV, text, markdown, or HTML — ZIP max 5 GB"), Discover/Completed job tabs, per-source cards. (Built in Phase 7.)

**Updates panel (Fig. 14):** right-side panel listing edits — actor, "You edited …", date + breadcrumb, diff chips (old struck through, new highlighted), jump-to-version. Single-user version: local edit activity feed per page.

**System tokens & behavior (spec §10):** radii 8–12 px (menus 10–12, controls 6–8); 1 px low-contrast dividers; blue primary for New/confirm/focus; red isolated for destructive; 120–180 ms transitions honoring reduced-motion; menus anchor to triggers; modals trap focus, Escape closes; hover-only actions also keyboard-reachable; skeleton loading; empty states with one clear action. Semantic tokens from day one so dark mode is a token swap. Target WCAG 2.2 AA.

## Phases

Each phase ends with something runnable. The editor phases remain the heart of the project; migration comes **after** the app is complete, per decision.

### Phase 0 — Foundation (small)
- pnpm monorepo: `packages/core`, `apps/desktop`, `apps/cli`; electron-vite + React + TS; ESLint/Prettier
- electron-builder + GitHub Actions matrix from day one (packaging problems are cheapest early)
- Empty shell with Notion-accurate chrome: rail/topbar dimensions and design tokens from spec §10, light/dark

### Phase 1 — Core package & page tree (small-medium)
- `@kumi/core`: SQLite schema + migrations, command layer, typed IPC into Electron
- **First cut of the `kumi` CLI** (thin wrapper over core — grows with every subsequent phase; keeping it current is a per-phase exit criterion)
- Sidebar per Figs. 1–3: favorites/recents/trees, hover `+`/`…` actions, drag-reorder, persisted expansion/scroll; page icons + covers; create/rename/move/delete (to trash)

### Phase 2 — Core editor (large — the heart)
- TipTap wired to block storage: batched ops with client op IDs, debounced persistence, per-block diffing; optimistic UI where **focus never jumps on reconciliation** (spec §4)
- Blocks: paragraph, h1–3, lists, to-do, toggle, quote, code (highlight + language picker)
- Slash menu, markdown shortcuts, drag handle + drop indicator, multi-block selection (click-drag + shift-arrows), copy/paste of blocks
- Keyboard parity: Enter/Backspace semantics, Tab indent, Ctrl+Shift+arrows move blocks; undo/redo; local keystroke feedback **< 50 ms p95** (spec §12)

### Phase 3 — Advanced editor (medium-large)
- Columns via `column_list`/`column` containers: drag-right-to-create, draggable divider widths
- Callout, quote, divider, simple table, KaTeX equation block + inline math, TOC, synced blocks
- Media: image/file/video/audio into `assets/` (hash-dedup) with resize handles; PDF preview; bookmark cards; YouTube embeds; link previews
- `@`-mention menu (pages/dates), page links, `links` backlink index + backlinks panel
- Page `…` action palette per Fig. 16 (fonts, small text, full width, lock page)

### Phase 4 — Databases I: model + table (medium-large)
- Data source / property / view model; schema editor (Fig. 8 "Edit properties"); inline and full-page databases (Figs. 1, 10)
- Table view: typed cells for all scalar properties, column resize/reorder/hide, `+ New page` row
- Row open as center peek / side peek / full page (Fig. 4); filter trees + sorts per view (Fig. 19); multiple named views with tabs

### Phase 5 — Databases II: views, relations, formulas (medium-large)
- Board per Fig. 9 (grouping, subgroups, totals, drag between columns), list, gallery, calendar (month grid), timeline
- Conditional color, grouping rules, view settings inspector complete (Fig. 8), view + database lock
- **Relations** (paired reverse), **rollups** (count/sum/avg/min/max/show-originals), **formula subset** with dependency-graph recomputation — correct after create/update/delete (spec test DB-02)

### Phase 6 — Search, history, polish & agent harness (medium)
- FTS5 search overlay per Fig. 11 (filter chips, date groups, preview panel, match explanation); Ctrl+P quick switcher; command palette
- Page history: snapshots + op log, history panel per Fig. 6, restore-as-new-version; trash restore/permanent-delete; templates; favorites
- Export: page/subtree to Markdown (zip) + PDF; database to CSV; **full-workspace native JSON export that round-trips**
- **CLI completeness audit, then generate the CLI-Anything harness** (`/cli-anything`), REPL + SKILL.md + subprocess tests; refine with `/cli-anything:refine`; publish harness alongside the app
- Fidelity pass: side-by-side audit against real Notion + the spec screenshots (hover states, spacing, transitions)

### Phase 7 — Notion import & export hardening (medium-large) — *after the app is built*
One-time migration of the AMP workspace, built as an inspectable pipeline (spec §7), not a script:
- Import hub UI in settings per Fig. 17 (drag-drop, job history)
- Staged pipeline: **Ingest** (hash archive, sandboxed unzip — traversal/zip-bomb/size limits) → **Parse** (Notion Markdown+CSV and HTML exports → normalized records) → **Plan** (show counts, type mappings, unsupported items; confirm before commit) → **Allocate** (pre-assign IDs; source-ID/path/URL map) → **Write** (transactional, checkpointed) → **Resolve** (parent edges, internal links, relations, mentions, rollup/formula deps — deferred refs retried once all IDs exist) → **Assets** (hash-dedup copy, reference rewrite) → **Verify** (source vs destination counts/links/samples) → **Report** (summary + downloadable machine-readable **loss report**)
- Idempotent: mapping table keyed by source identity — retry updates, never duplicates; import into a hidden staging scope, atomic commit, job-scoped rollback; **never silently coerce** — preserve originals and list every coercion
- Formula translation report: what mapped, what's preserved verbatim as inert
- Acceptance (spec §14): MIG-01 nested export matches inventory · MIG-02 interrupt/resume 5 GB ZIP without duplicates · MIG-03 unknown block/property preserved + reported · EXP-01 export→import round-trip into a clean workspace · DB-02 relation/rollup/formula chain correct after import
- Also importable: generic Markdown/HTML/DOCX, CSV/TSV/XLSX with type confirmation

### Phase 8 — Release (small)
- electron-builder targets: NSIS `.exe`, `.dmg`, `.AppImage`/`.deb`; tag → CI matrix → GitHub Release
- App icon set (Kumi identity), README with install + CLI/agent usage, harness published to CLI-Hub if desired

## Performance & quality targets (from spec §12, scaled to local)

Keystroke feedback p95 < 50 ms · page usable < 2 s warm with long block trees streamed and scroll position retained · database query p95 < 800 ms on 100k-row sources · search p95 < 700 ms, edits indexed ≤ 5 s · design-scale test: 100k pages / 1 m blocks / 100k rows / 5 GB import archive · full keyboard operation with visible focus (spec UX-01/A11Y-01) · restore never destroys later history (REC-01).

## Risks & honest caveats

1. **The editor is ~50% of the project.** Notion's feel (selection, drag, keyboard semantics) is the hard part; Phases 2–3 exceed everything else combined and need iterative polish against the screenshots.
2. **Import fidelity is a project of its own** — that's why it's Phase 7 with the spec's full pipeline. Notion's own docs admit its export is lossy; the loss report and verify stage are what make the one-time migration trustworthy.
3. **Relations/rollups/formulas touch everything** (schema editor, cells, filters, import resolution). Sequenced into Phase 5 deliberately; the formula *subset* decision bounds the blast radius.
4. **CLI/UI drift** is the main agent-native risk. Mitigation is architectural: one `@kumi/core` command layer, CLI as a thin wrapper, harness tests run in CI, and "CLI updated" is an exit criterion of every phase.
5. **Concurrent CLI + app writes**: WAL + busy timeout handles it, but the socket-routing path (CLI → running app) must land early in Phase 6 so agents don't fight the UI for the write lock.
6. **Unsigned installers** warn on install (SmartScreen / right-click-Open on macOS). Fine for personal use; certs can be added later.
7. **"Exactly like Notion" has a long tail.** The Phase 6 fidelity pass, checked against the spec's screenshots, is where "close enough" gets decided. Ship Kumi's own name/icon — patterns, not trademarks.

## Suggested first milestone

Phases 0–2: an installable app where you can create nested pages and write in a Notion-feel block editor — with `kumi page`/`kumi block` CLI commands already working against the same workspace file. That proves the two riskiest bets (editor fidelity and the shared headless core that agent-nativeness depends on) before investing in databases or migration.
