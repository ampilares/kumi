<p align="center">
  <img src="apps/desktop/build/icon.png" width="96" alt="Kumi">
</p>

# Kumi

A **local-only, Notion-style workspace** for your desktop — nested pages, a block
editor, and full databases (table, board, list, gallery, calendar, timeline) —
with no account, no cloud, and no sync. Everything lives in one folder on your
machine.

Kumi is also **agent-native**: every capability the UI has is available headlessly
through the `kumi` CLI, so an AI agent can create pages, restructure databases,
run filtered queries, and bulk-edit content against the same workspace file you
have open in the app.

- Editor: paragraphs, headings, lists, to-dos, toggles, quotes, callouts, code,
  KaTeX equations, columns, simple tables, media, embeds, synced blocks, slash
  menu, markdown shortcuts, drag handles.
- Databases: typed properties including relations, rollups, and a formula
  subset; nested AND/OR filter trees, sorts, grouping, conditional color; rows
  are real pages that open as peek or full page.
- Search (FTS5) with preview panel, quick switcher, page history with restore,
  trash, templates, favorites, light/dark themes.
- Export to Markdown/CSV/PDF plus a round-trippable JSON workspace export, and a
  one-time Notion import pipeline.

Plan and scope: [`docs/build-plan.md`](docs/build-plan.md). Fidelity spec:
`docs/specs.pdf`.

---

## Install

Grab the installer for your platform from the
[Releases](../../releases) page:

| Platform | Artifact |
|---|---|
| Windows (x64) | `kumi-<version>-win-x64-setup.exe` |
| macOS (Apple Silicon / Intel) | `kumi-<version>-mac-arm64.dmg` / `kumi-<version>-mac-x64.dmg` |
| Linux (x64) | `kumi-<version>-linux-x64.AppImage` / `kumi-<version>-linux-x64.deb` |

The Windows installer is a per-user install (no admin rights) and lets you
choose the install directory.

> **Unsigned builds.** Kumi is built without a code-signing certificate, so the
> first launch shows a warning. On Windows, SmartScreen says "Windows protected
> your PC" — click **More info → Run anyway**. On macOS, right-click the app and
> choose **Open**, then confirm. Both are one-time.

## Your workspace, and how to back it up

Kumi keeps everything in a single folder — by default:

```
Windows   %USERPROFILE%\Kumi
macOS     ~/Kumi
Linux     ~/Kumi
```

It contains `kumi.db` (SQLite, WAL mode) and `assets/` (images and files, stored
by content hash).

- **Backup / move machines:** quit Kumi, then copy the whole folder. That is the
  entire backup — there is nothing else to export or restore.
- **Portable snapshot:** `kumi export workspace <dir>` writes a full-fidelity
  JSON export that imports back into a clean workspace.
- **Point tools at another workspace:** set `KUMI_WORKSPACE=/path/to/folder` for
  the CLI and harness.

## Import from Notion

Export your Notion workspace (**Settings → Import & Export → Export content**,
format *Markdown & CSV*, "Include subpages" on), then either:

- **In the app:** Settings → **Import**, drop the `.zip` (or the unzipped
  folder). You get a plan first — pages, databases, rows, and assets that will be
  created, plus anything unsupported — and confirm before anything is written.
- **From the CLI:**

  ```bash
  kumi import plan ./notion-export.zip    # dry run: counts, warnings, losses
  kumi import run  ./notion-export.zip    # writes under a new root page
  ```

The import is idempotent: re-running the same export updates the previous import
instead of duplicating it, and every coercion or unsupported item is listed in
the loss report rather than being silently dropped.

## CLI and agents

The `kumi` CLI wraps the same `@kumi/core` command layer the app uses, so CLI
operations and UI operations are identical by construction. Every command takes
`--json` for structured output and `-w/--workspace` to target a folder.

```bash
pnpm --filter @kumi/cli build
node apps/cli/dist/index.js --help

node apps/cli/dist/index.js page create -t "Engineering" -i "🛠"
node apps/cli/dist/index.js --json search "invoice"
node apps/cli/dist/index.js --json db query <dataSourceId> --filter '<json>'
node apps/cli/dist/index.js export md <pageId> ./out
```

For agent use there is a CLI-Anything harness (Python Click wrapper with a
stateful REPL and a generated skill description):
**[`tools/kumi-harness/SKILL.md`](tools/kumi-harness/SKILL.md)** — the full
command list, workspace concepts, and agent recipes. Install and setup live in
[`tools/kumi-harness/README.md`](tools/kumi-harness/README.md).

The app and the CLI can run at the same time: SQLite WAL plus a busy timeout
lets them share the workspace.

## Development

Requires Node ≥ 22 (24 recommended) and pnpm (the version is pinned by the
`packageManager` field).

```bash
pnpm install          # native build scripts are allowlisted in package.json
pnpm dev              # run the desktop app with hot reload
pnpm typecheck        # all packages
pnpm test             # all packages
pnpm build            # all packages
```

Layout:

| Path | What |
|---|---|
| `packages/core` | `@kumi/core` — SQLite schema, migrations, and **all** business logic |
| `apps/desktop` | Electron main/preload + React renderer (electron-vite) |
| `apps/cli` | the `kumi` CLI, a thin wrapper over core |
| `tools/kumi-harness` | Python CLI-Anything harness for agents |

Storage uses Node's built-in `node:sqlite` (also built into Electron) and the
pure-JS `adm-zip` — there are **no native modules**, so there is nothing to
rebuild after installing.

## Packaging a release

```bash
pnpm dist          # current platform
pnpm dist:win      # Windows NSIS installer
```

Artifacts land in `apps/desktop/dist/`. Configuration is
[`apps/desktop/electron-builder.yml`](apps/desktop/electron-builder.yml); the
app icon is generated from `apps/desktop/build/icon.svg` by
`python apps/desktop/build/make-icons.py`.

Pushing a `v*` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds on Windows, macOS, and Linux, gates on `pnpm -r build/typecheck/test`,
and attaches the installers to a GitHub Release.

## License

Personal project; no license granted yet. Kumi implements Notion-*style*
patterns with its own name, icon, and code — it is not affiliated with Notion.
