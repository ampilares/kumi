/**
 * Workspace storage: a folder containing `kumi.db` and an `assets/` directory.
 *
 * The whole workspace is portable by copying the folder (build plan, "Data
 * model"). This module owns connection setup, statement typing and schema
 * migrations only; all behaviour lives in the command layer.
 *
 * The driver is Node's built-in `node:sqlite` (`DatabaseSync`), which is the
 * only SQLite binding that works unchanged in both plain Node (CLI, vitest) and
 * Electron — a native module would have to be built twice, once per ABI. Node
 * prints an `ExperimentalWarning` for `node:sqlite`; that is expected.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { KumiError } from "./errors";

export type Db = DatabaseSync;

/**
 * A bound parameter: either a positional value or — as the first argument — an
 * object of named parameters (`@name` placeholders, bound bare).
 */
export type BindValue = SQLInputValue | Record<string, SQLInputValue>;

/** A prepared statement with the row shape its query produces. */
export interface Stmt<R> {
  all(...params: BindValue[]): R[];
  get(...params: BindValue[]): R | undefined;
  run(...params: BindValue[]): void;
}

/**
 * Prepare `sql` once and return it typed as producing `R`.
 *
 * `node:sqlite` types rows as `Record<string, SQLOutputValue>`; the row
 * interfaces in the command layer describe the same columns with their real
 * types, so this is the single trusted cast at the storage boundary.
 */
export function statement<R>(db: Db, sql: string): Stmt<R> {
  const prepared = db.prepare(sql);
  // A named-parameter object is legal as the first argument; the public
  // overloads split the two cases, the implementation does not.
  const bind = (params: BindValue[]): SQLInputValue[] => params as SQLInputValue[];
  return {
    all: (...params) => prepared.all(...bind(params)) as unknown as R[],
    get: (...params) =>
      prepared.get(...bind(params)) as unknown as R | undefined,
    run: (...params) => {
      prepared.run(...bind(params));
    },
  };
}

let savepointCounter = 0;

/**
 * Run `fn` inside a transaction, committing on return and rolling back on
 * throw. Re-entrant: a nested call uses a savepoint so an inner failure never
 * commits or aborts the outer transaction on its own.
 */
export function withTransaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) {
    const name = `kumi_sp_${++savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Ordered migration list. Migrations are append-only: never edit an applied
 * migration, add a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE assets (
  id            TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  path          TEXT NOT NULL,          -- relative to <workspace>/assets
  created_at    INTEGER NOT NULL
);
CREATE INDEX assets_content_hash ON assets(content_hash);

CREATE TABLE pages (
  id              TEXT PRIMARY KEY,
  parent_id       TEXT REFERENCES pages(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT '',
  icon            TEXT,
  cover_asset_id  TEXT REFERENCES assets(id) ON DELETE SET NULL,
  locked          INTEGER NOT NULL DEFAULT 0,
  full_width      INTEGER NOT NULL DEFAULT 0,
  small_text      INTEGER NOT NULL DEFAULT 0,
  rank            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER,
  -- Id of the page whose trashPage() call trashed this row; restorePage(root)
  -- restores exactly the rows carrying that root id.
  trash_batch_id  TEXT
);
CREATE INDEX pages_parent_rank ON pages(parent_id, rank);
CREATE INDEX pages_deleted_at ON pages(deleted_at);
CREATE INDEX pages_trash_batch ON pages(trash_batch_id);

CREATE TABLE blocks (
  id               TEXT PRIMARY KEY,
  page_id          TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  parent_block_id  TEXT REFERENCES blocks(id) ON DELETE CASCADE,
  rank             TEXT NOT NULL,
  type             TEXT NOT NULL,
  payload          TEXT NOT NULL,       -- JSON BlockPayload
  version          INTEGER NOT NULL DEFAULT 1,
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX blocks_page_parent_rank ON blocks(page_id, parent_block_id, rank);
CREATE INDEX blocks_parent ON blocks(parent_block_id);

CREATE TABLE links (
  source_block_id  TEXT NOT NULL REFERENCES blocks(id) ON DELETE CASCADE,
  source_page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  target_page_id   TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  PRIMARY KEY (source_block_id, target_page_id)
);
CREATE INDEX links_target ON links(target_page_id);

CREATE TABLE revisions (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,           -- 'page' | 'block'
  entity_id    TEXT NOT NULL,
  page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  version      INTEGER NOT NULL,
  patch        TEXT NOT NULL,           -- JSON
  created_at   INTEGER NOT NULL
);
CREATE INDEX revisions_entity ON revisions(entity_id, version);
CREATE INDEX revisions_page ON revisions(page_id, created_at);

-- Client-generated op ids already applied, so retried batches are idempotent.
CREATE TABLE applied_ops (
  op_id       TEXT PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);

-- Single-user preferences and workspace metadata, JSON-encoded values.
CREATE TABLE user_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
CREATE TABLE workspace_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- One row per page: title plus the plain text of its blocks. Kept in sync by
-- the command layer inside the same transaction as the mutation (JSON payloads
-- make triggers impractical). The rowid mirrors pages.rowid so a page's row can
-- be replaced without scanning the index.
CREATE VIRTUAL TABLE search_index USING fts5(
  page_id UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
`,
  },
  {
    version: 2,
    name: "databases",
    sql: `
-- One database (data source) owned by a page. A page can own several inline
-- databases; a full-page database is the same thing with one data source.
CREATE TABLE data_sources (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX data_sources_page ON data_sources(page_id);

-- Property ids are stable across renames and retypes (spec requirement).
CREATE TABLE properties (
  id              TEXT PRIMARY KEY,
  data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  config          TEXT NOT NULL,         -- JSON PropertyConfig
  rank            TEXT NOT NULL
);
CREATE INDEX properties_ds_rank ON properties(data_source_id, rank);

-- Marks a page as a row of a data source. Rows are real pages; this table is
-- what makes them rows, and what hides them from the sidebar tree.
CREATE TABLE ds_rows (
  page_id         TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  rank            TEXT NOT NULL
);
CREATE INDEX ds_rows_ds_rank ON ds_rows(data_source_id, rank);

-- Sparse typed cells. The title property is never stored here: a row's title
-- value is the page title itself.
CREATE TABLE property_values (
  page_id      TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  value        TEXT NOT NULL,            -- JSON PropertyValue
  PRIMARY KEY (page_id, property_id)
);
CREATE INDEX property_values_property ON property_values(property_id);

CREATE TABLE views (
  id              TEXT PRIMARY KEY,
  data_source_id  TEXT NOT NULL REFERENCES data_sources(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  type            TEXT NOT NULL,
  config          TEXT NOT NULL,         -- JSON ViewConfig
  rank            TEXT NOT NULL,
  locked          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX views_ds_rank ON views(data_source_id, rank);
`,
  },
  {
    version: 3,
    name: "history_and_templates",
    sql: `
-- Page history. One row per captured state of one page; \`state\` is the JSON
-- { title, icon, blocks: Block[] } that restoreSnapshot writes back verbatim.
-- Snapshots are page-local: restoring one never touches another page, and they
-- cascade away with the page itself.
CREATE TABLE page_snapshots (
  id          TEXT PRIMARY KEY,
  page_id     TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  cause       TEXT NOT NULL,           -- 'auto' | 'manual' | 'restore'
  state       TEXT NOT NULL,           -- JSON { title, icon, blocks }
  created_at  INTEGER NOT NULL
);
-- Newest-first listing and the auto-snapshot age probe are the only reads.
CREATE INDEX page_snapshots_page_created ON page_snapshots(page_id, created_at DESC);

-- Reusable page subtrees. \`state\` is a self-contained TemplateState (see
-- template.ts): every page, block, data source, property, view, row and cell of
-- the subtree, with the ids it had when it was saved. Instantiating remaps all
-- of them. Assets are referenced by id only — they live in the shared store.
CREATE TABLE templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT,
  state       TEXT NOT NULL,           -- JSON TemplateState
  created_at  INTEGER NOT NULL
);
CREATE INDEX templates_created ON templates(created_at DESC);
`,
  },
  {
    version: 4,
    name: "import_jobs",
    sql: `
-- One row per Notion import, keyed by the hash of the source archive/folder.
-- The UNIQUE hash is what makes a re-import an update: the same export always
-- finds its own job row, whose \`report\` names the root page the previous run
-- created (trashed before the new one is written).
CREATE TABLE import_jobs (
  id           TEXT PRIMARY KEY,
  source_path  TEXT NOT NULL,
  source_hash  TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL,           -- 'committed' | 'failed'
  report       TEXT,                    -- JSON ImportReport
  created_at   INTEGER NOT NULL
);
CREATE INDEX import_jobs_created ON import_jobs(created_at DESC);
`,
  },
];

function applyMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  INTEGER NOT NULL
  );`);

  const applied = new Set(
    statement<{ version: number }>(db, "SELECT version FROM migrations")
      .all()
      .map((row) => row.version),
  );
  const record = statement<never>(
    db,
    "INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length === 0) return;

  withTransaction(db, () => {
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, Date.now());
    }
  });
}

function seedWorkspaceMeta(db: Db, workspacePath: string): void {
  const insert = statement<never>(
    db,
    "INSERT OR IGNORE INTO workspace_meta (key, value) VALUES (?, ?)",
  );
  const defaultName = path.basename(path.resolve(workspacePath)) || "Kumi";
  insert.run("name", JSON.stringify(defaultName));
  insert.run("icon", JSON.stringify(null));
}

/** Absolute path of the workspace folder holding an open connection. */
export function workspacePathOf(db: Db): string {
  const location = db.location();
  if (location === null || location === "") {
    throw new KumiError(
      "invalid",
      "this connection has no workspace folder (in-memory database)",
    );
  }
  return path.dirname(path.resolve(location));
}

/** Absolute path of the workspace's `assets/` directory. */
export function assetsDirOf(db: Db): string {
  return path.join(workspacePathOf(db), "assets");
}

/**
 * Open (creating if absent) the workspace folder at `workspacePath` and return
 * a migrated connection. Creates `<workspacePath>/assets/` when missing.
 */
export function openWorkspaceDb(workspacePath: string): Db {
  const dir = path.resolve(workspacePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });

  const db = new DatabaseSync(path.join(dir, "kumi.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  applyMigrations(db);
  seedWorkspaceMeta(db, dir);
  return db;
}
