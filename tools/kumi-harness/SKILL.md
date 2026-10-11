---
name: kumi
description: Control a local Kumi workspace from the command line — pages, blocks, databases, search, history, and export — via the cli-anything-kumi harness over the real Kumi CLI.
commands:
  - name: doctor
    description: Report backend path, node version, workspace path, and database reachability.
    example: cli-anything-kumi doctor
  - name: workspace info
    description: Show the workspace path, name, and icon.
    example: cli-anything-kumi workspace info
  - name: workspace rename
    description: Rename the workspace.
    example: cli-anything-kumi workspace rename "Team Brain"
  - name: page create
    description: Create a page, optionally under a parent, with a title and icon.
    example: cli-anything-kumi --json page create -t "Engineering" -i "🛠"
  - name: page show
    description: Show a page's metadata.
    example: cli-anything-kumi page show <pageId>
  - name: page list
    description: List root pages, or the children of a page.
    example: cli-anything-kumi page list <parentPageId>
  - name: page rename
    description: Set a page's title.
    example: cli-anything-kumi page rename <pageId> "New Title"
  - name: page move
    description: Move a page to a new parent and/or position.
    example: cli-anything-kumi page move <pageId> -p <newParentId> --after <siblingId>
  - name: page duplicate
    description: Deep-copy a page and its subtree.
    example: cli-anything-kumi page duplicate <pageId>
  - name: page trash
    description: Move a page (and its subtree) to the trash.
    example: cli-anything-kumi page trash <pageId>
  - name: page restore
    description: Restore a page from the trash.
    example: cli-anything-kumi page restore <pageId>
  - name: page delete
    description: Permanently delete a trashed page (requires --force).
    example: cli-anything-kumi page delete <pageId> --force
  - name: page breadcrumb
    description: Show the ancestry from root to a page.
    example: cli-anything-kumi page breadcrumb <pageId>
  - name: trash
    description: List trashed pages.
    example: cli-anything-kumi trash
  - name: block list
    description: List a page's blocks in document order.
    example: cli-anything-kumi block list <pageId>
  - name: block show
    description: Show one block with its full payload.
    example: cli-anything-kumi --json block show <blockId>
  - name: block append
    description: Append a block of text to a page.
    example: cli-anything-kumi block append <pageId> "Team charter and rituals." -t paragraph
  - name: block edit
    description: Replace a block's text.
    example: cli-anything-kumi block edit <blockId> "Revised text"
  - name: block delete
    description: Delete a block.
    example: cli-anything-kumi block delete <blockId>
  - name: block ops
    description: Apply a raw BlockOp[] batch read from stdin (or --file).
    example: cli-anything-kumi block ops --file ops.json
  - name: asset import
    description: Copy a file into the asset store (deduplicated by content).
    example: cli-anything-kumi --json asset import ./diagram.png
  - name: asset show
    description: Show an asset's metadata.
    example: cli-anything-kumi --json asset show <assetId>
  - name: asset path
    description: Print the absolute path of an asset's file.
    example: cli-anything-kumi asset path <assetId>
  - name: backlinks
    description: List pages whose content links to or mentions this page.
    example: cli-anything-kumi backlinks <pageId>
  - name: search
    description: Full-text search across the workspace.
    example: cli-anything-kumi search "charter" -n 10
  - name: db create
    description: Create a database on a page (with a Name property and Table view).
    example: cli-anything-kumi --json db create <ownerPageId> -t "Tasks"
  - name: db show
    description: Show a database's schema, properties, and views.
    example: cli-anything-kumi --json db show <dataSourceId>
  - name: db list
    description: List a page's databases, or every database in the workspace.
    example: cli-anything-kumi --json db list
  - name: db rename
    description: Rename a database.
    example: cli-anything-kumi db rename <dataSourceId> "Backlog"
  - name: db delete
    description: Delete a database's schema and views; its rows go to the trash.
    example: cli-anything-kumi db delete <dataSourceId> --force
  - name: db query
    description: Query rows with an optional FilterGroup JSON, sort, limit, and offset.
    example: cli-anything-kumi db query <dataSourceId> --sort "<propId>:desc" -n 20
  - name: prop add
    description: Add a property (column) to a database, including select, relation, and rollup.
    example: cli-anything-kumi --json prop add <dataSourceId> Status -t select --options "Todo,Doing,Done"
  - name: prop update
    description: Update a property's name, type, or config.
    example: cli-anything-kumi prop update <propertyId> --name "State"
  - name: prop rm
    description: Remove a property from a database.
    example: cli-anything-kumi prop rm <propertyId>
  - name: row add
    description: Add a row to a database, optionally with initial property values.
    example: cli-anything-kumi --json row add <dataSourceId> --values '{"<titlePropId>":{"type":"title","richText":[{"type":"text","text":"Ship the CLI"}]}}'
  - name: row show
    description: Show a row — its page plus all property values.
    example: cli-anything-kumi --json row show <rowPageId>
  - name: row set
    description: Write property values on a row (null clears a value).
    example: cli-anything-kumi row set <rowPageId> '{"<numberPropId>":{"type":"number","number":5}}'
  - name: row link
    description: Add or remove entries of a relation property's value.
    example: cli-anything-kumi row link <rowPageId> <relationPropId> --add <targetRowPageId>
  - name: view add
    description: Add a saved view to a database.
    example: cli-anything-kumi view add <dataSourceId> "By status" -t board
  - name: view update
    description: Update a view's name or config.
    example: cli-anything-kumi view update <viewId> --name "All tasks"
  - name: view rm
    description: Delete a saved view.
    example: cli-anything-kumi view rm <viewId>
  - name: history list
    description: List a page's snapshots, newest first.
    example: cli-anything-kumi history list <pageId>
  - name: history save
    description: Capture a manual snapshot of a page now.
    example: cli-anything-kumi history save <pageId>
  - name: history show
    description: Show a snapshot's full content.
    example: cli-anything-kumi --json history show <snapshotId>
  - name: history restore
    description: Restore a snapshot (the current state is snapshotted first).
    example: cli-anything-kumi history restore <snapshotId>
  - name: template save
    description: Save a page as a reusable template.
    example: cli-anything-kumi template save <pageId> --name "Meeting notes"
  - name: template list
    description: List saved templates.
    example: cli-anything-kumi template list
  - name: template use
    description: Instantiate a template as a new page.
    example: cli-anything-kumi template use <templateId> -p <parentPageId>
  - name: template rm
    description: Delete a template.
    example: cli-anything-kumi template rm <templateId>
  - name: export md
    description: Export a page (and descendants) as Markdown + CSV + assets.
    example: cli-anything-kumi export md <pageId> ./out
  - name: export workspace
    description: Export the whole workspace as full-fidelity JSON.
    example: cli-anything-kumi export workspace ./backup
  - name: fav add
    description: Add a page to favorites.
    example: cli-anything-kumi fav add <pageId>
  - name: fav remove
    description: Remove a page from favorites.
    example: cli-anything-kumi fav remove <pageId>
  - name: fav list
    description: List favorite pages.
    example: cli-anything-kumi fav list
  - name: recents
    description: List recently visited pages.
    example: cli-anything-kumi recents
  - name: repl
    description: Start a stateful REPL that holds the current workspace.
    example: cli-anything-kumi repl
---

# Kumi

`cli-anything-kumi` is an agent harness over Kumi's own Node CLI. It drives the
real application: the same SQLite workspace the desktop app opens, no
simulation and no fallback. If the backend is not built or `node` is missing,
every command fails loudly.

## Setup

```bash
# 1. Build the backend (from the repo root)
pnpm --filter @kumi/cli build

# 2. Install the harness
pip install -e tools/kumi-harness

# 3. Verify
cli-anything-kumi doctor
```

`doctor` prints the backend entry point, the node version, the workspace path,
and whether the database is reachable. It exits 1 if anything is wrong.

### Choosing a workspace

Every command accepts `-w/--workspace <path>`. Without it the harness uses
`$KUMI_WORKSPACE`, falling back to `~/Kumi`. The workspace folder is created on
first use.

```bash
export KUMI_WORKSPACE=/path/to/workspace
cli-anything-kumi workspace info
```

Backend discovery: `KUMI_CLI_PATH` overrides the entry point outright,
otherwise `KUMI_REPO` (or walking up from the installed package) locates
`<repo>/apps/cli/dist/index.js`.

## Workspace concepts

- **Pages** form a tree. Every page has a UUID `id`, a title, an optional emoji
  icon, and a parent (`null` for a root page). Ids are what every other command
  takes — capture them from `--json` output.
- **Blocks** are a page's content, ordered within the page and optionally
  nested under a parent block. `block append` writes plain text; `block ops`
  applies raw `BlockOp[]` JSON for anything richer.
- **Databases** (data sources) live on an owner page. Creating one yields a
  `Name` title property and a `Table` view.
- **Rows are pages.** `row add` returns `{page, values}`; the row's page id is
  a normal page id, so `page show`, `block append`, and `export md` all work on
  it. Rows are created as children of the database's owner page.
- **Relations and rollups.** A `relation` property points at another database
  (`--target`); `--paired-name` also creates the reverse relation on the target
  and returns its id in `config.relation.pairedPropertyId`. A `rollup` property
  aggregates across a relation: `--through <relationPropertyId> --of
  <targetPropertyId> --agg sum`.
- **History** stores per-page snapshots. Kumi takes automatic ones as content
  changes (`cause: "auto"`); `history save` adds a `manual` one. Restoring
  snapshots the current state first, so a restore is itself undoable.
- **Export** writes Markdown per page plus one CSV per database, and copies
  referenced assets. `export workspace` writes full-fidelity JSON.
- **Output.** The default rendering is a short human summary. Add `--json`
  (before the subcommand) to get the raw payload — the backend's `data` field,
  already unwrapped from its `{ok, data}` envelope. Errors go to stderr as
  `error (<code>): <message>` with exit 1; usage errors exit 2.

## Common recipes

### Create a page tree

```bash
ROOT=$(cli-anything-kumi --json page create -t "Engineering" -i "🛠" | jq -r .id)
cli-anything-kumi page create -t "Sprint 12" -p "$ROOT"
cli-anything-kumi block append "$ROOT" "Team charter and rituals." -t paragraph
cli-anything-kumi page list "$ROOT"
cli-anything-kumi search "charter"
```

### Build a database and query it with a filter

```bash
cli-anything-kumi --json db create "$ROOT" -t "Tasks" > db.json
DS=$(jq -r .dataSource.id db.json)
NAME=$(jq -r '.properties[0].id' db.json)          # the Name (title) property

cli-anything-kumi --json prop add "$DS" Status -t select \
  --options "Todo,Doing,Done" > status.json
STATUS=$(jq -r .id status.json)
DONE=$(jq -r '.config.options[] | select(.name=="Done") | .id' status.json)
HOURS=$(cli-anything-kumi --json prop add "$DS" Hours -t number | jq -r .id)

cli-anything-kumi --json row add "$DS" --values "{
  \"$NAME\":   {\"type\":\"title\",\"richText\":[{\"type\":\"text\",\"text\":\"Ship the CLI\"}]},
  \"$STATUS\": {\"type\":\"select\",\"optionId\":\"$DONE\"},
  \"$HOURS\":  {\"type\":\"number\",\"number\":5}
}"

cli-anything-kumi db query "$DS" --filter "{
  \"kind\":\"group\",\"op\":\"and\",
  \"children\":[{\"kind\":\"condition\",\"propertyId\":\"$STATUS\",
                 \"op\":\"equals\",\"value\":\"$DONE\"}]
}"
```

Filter JSON is a `FilterGroup`: `{kind:"group", op:"and"|"or", children:[...]}`
where each child is either another group or
`{kind:"condition", propertyId, op, value}`. Operators: `equals`, `not_equals`,
`contains`, `not_contains`, `starts_with`, `ends_with`, `is_empty`,
`is_not_empty`, `gt`, `gte`, `lt`, `lte`, `before`, `after`, `on_or_before`,
`on_or_after`. Operand shapes: strings for text types, numbers for `number`,
booleans for `checkbox`, an **option id** for `select`/`multi_select`, an ISO
date string for `date`, and a related row's **page id** for `relation`. A bad
operator or operand throws `invalid` — it never silently matches nothing.

Sorting uses `--sort "<propId>:asc,<otherPropId>:desc"`; pagination uses
`-n/--limit` (max 500) and `--offset`.

### Wire a paired relation and a rollup

```bash
cli-anything-kumi --json db create "$ROOT" -t "Projects" > proj.json
PROJ=$(jq -r .dataSource.id proj.json)
PNAME=$(jq -r '.properties[0].id' proj.json)

# Relation on Tasks -> Projects, plus the reverse "Tasks" relation on Projects
cli-anything-kumi --json prop add "$DS" Project -t relation \
  --target "$PROJ" --paired-name "Tasks" > rel.json
REL=$(jq -r .id rel.json)
PAIRED=$(jq -r .config.relation.pairedPropertyId rel.json)

# Sum the Tasks' Hours onto each Project through the reverse relation
cli-anything-kumi prop add "$PROJ" "Total Hours" -t rollup \
  --through "$PAIRED" --of "$HOURS" --agg sum

PROW=$(cli-anything-kumi --json row add "$PROJ" --values \
  "{\"$PNAME\":{\"type\":\"title\",\"richText\":[{\"type\":\"text\",\"text\":\"Apollo\"}]}}" \
  | jq -r .page.id)
cli-anything-kumi row link "$TASK_ROW" "$REL" --add "$PROW"
cli-anything-kumi --json row show "$PROW"   # Total Hours -> {"type":"rollup","aggregation":"sum","number":5}
```

Aggregations: `count`, `count_values`, `sum`, `avg`, `min`, `max`,
`show_originals`. Omit `--of` for `count`.

### Snapshot and restore

```bash
SNAP=$(cli-anything-kumi --json history save "$ROOT" | jq -r .id)
cli-anything-kumi page rename "$ROOT" "Engineering (draft)"
cli-anything-kumi history restore "$SNAP"       # title is back to "Engineering"
cli-anything-kumi history list "$ROOT"
```

### Export

```bash
cli-anything-kumi export md "$ROOT" ./out              # page + descendants
cli-anything-kumi export md "$ROOT" ./out --no-recursive
cli-anything-kumi export workspace ./backup            # full-fidelity JSON
```

Relative export directories resolve against the current working directory.

## REPL

`cli-anything-kumi repl` opens a stateful loop that holds one workspace. The
commands are identical, minus the program name — the REPL invokes the same
Click group, so the two can never drift.

```
$ cli-anything-kumi repl
kumi> use /path/to/workspace
workspace: /path/to/workspace
kumi> page create -t "From REPL"
From REPL  [eb995b6d-22d2-4a58-a5c3-7094ea352e21]
kumi> page list
  From REPL  [eb995b6d-22d2-4a58-a5c3-7094ea352e21]
kumi> page show nope
error (not_found): no page nope
kumi> exit
```

`help` lists the commands, `use <path>` switches workspace, and `exit` or EOF
quits. Errors print `error (<code>): <message>` and the loop continues.
