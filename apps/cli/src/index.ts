#!/usr/bin/env node
/**
 * kumi — headless CLI over @kumi/core.
 *
 * The agent-native interface to a Kumi workspace: every command emits
 * structured JSON with --json, uses stable exit codes (0 ok, 1 error,
 * 2 usage), and operates on the same SQLite workspace as the desktop app.
 */
// Silence only node:sqlite's ExperimentalWarning: it fires on every CLI call
// and pollutes stderr that agents parse. Must run before @kumi/core loads
// (CommonJS emit preserves statement order, so this precedes the requires).
const defaultEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  (defaultEmitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import { Command } from "commander";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type {
  Block,
  BlockOp,
  BlockType,
  FilterGroup,
  KumiCommands,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  RichText,
  RollupAggregation,
  SortSpec,
  ViewType,
} from "@kumi/core";
import { KumiError, openWorkspace, rankBetween } from "@kumi/core";

interface Ctx {
  commands: KumiCommands;
  close: () => void;
  json: boolean;
}

let ctx: Ctx | null = null;

function defaultWorkspacePath(): string {
  return process.env.KUMI_WORKSPACE ?? path.join(os.homedir(), "Kumi");
}

function getCtx(program: Command): Ctx {
  if (!ctx) {
    const opts = program.opts<{ workspace: string; json: boolean }>();
    const ws = openWorkspace(opts.workspace);
    ctx = { commands: ws.commands, close: ws.close, json: opts.json };
  }
  return ctx;
}

function ok(c: Ctx, data: unknown, human?: (d: never) => string): void {
  if (c.json) {
    process.stdout.write(JSON.stringify({ ok: true, data }, null, 2) + "\n");
  } else if (human) {
    process.stdout.write(human(data as never) + "\n");
  } else if (data !== undefined && data !== null) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
  } else {
    process.stdout.write("ok\n");
  }
}

function fail(json: boolean, err: unknown): never {
  const code = err instanceof KumiError ? err.code : "internal";
  const message = err instanceof Error ? err.message : String(err);
  if (json) {
    process.stderr.write(JSON.stringify({ ok: false, error: { code, message } }) + "\n");
  } else {
    process.stderr.write(`error (${code}): ${message}\n`);
  }
  process.exit(1);
}

function plainText(rt: RichText | undefined): string {
  if (!rt) return "";
  return rt
    .map((s) => (s.type === "text" ? s.text : s.type === "equation" ? s.expression : ""))
    .join("");
}

function toRichText(text: string): RichText {
  return text.length === 0 ? [] : [{ type: "text", text }];
}

function pageLine(p: { id: string; icon: string | null; title: string }): string {
  return `${p.icon ? p.icon + " " : ""}${p.title || "Untitled"}  [${p.id}]`;
}

/** Rank for appending after the current last sibling. */
function appendRank(blocks: Block[], parentBlockId: string | null): string {
  const siblings = blocks
    .filter((b) => b.parentBlockId === parentBlockId && !b.archived)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const last = siblings[siblings.length - 1];
  return rankBetween(last ? last.rank : null, null);
}

function main(): void {
  const program = new Command();
  program
    .name("kumi")
    .description("Agent-native CLI for a Kumi workspace (local Notion-style app)")
    .option("-w, --workspace <path>", "workspace folder", defaultWorkspacePath())
    .option("--json", "structured JSON output", false)
    .configureOutput({ writeErr: (s) => process.stderr.write(s) })
    .exitOverride();

  // ---- workspace ----------------------------------------------------------
  const wsCmd = program.command("workspace").description("workspace info & settings");
  wsCmd
    .command("info")
    .description("show workspace path, name, icon")
    .action(() => {
      const c = getCtx(program);
      const info = c.commands.getWorkspaceInfo();
      ok(c, info, (d: { name: string; path: string; icon: string | null }) =>
        `${d.icon ? d.icon + " " : ""}${d.name}\n${d.path}`
      );
    });
  wsCmd
    .command("rename <name>")
    .description("rename the workspace")
    .action((name: string) => {
      const c = getCtx(program);
      c.commands.renameWorkspace(name);
      ok(c, { name });
    });

  // ---- pages --------------------------------------------------------------
  const page = program.command("page").description("create, inspect, and organize pages");

  page
    .command("create")
    .description("create a page")
    .option("-t, --title <title>", "page title", "")
    .option("-p, --parent <pageId>", "parent page id (omit for root)")
    .option("-i, --icon <emoji>", "page icon")
    .action((opts: { title: string; parent?: string; icon?: string }) => {
      const c = getCtx(program);
      const p = c.commands.createPage({
        title: opts.title,
        parentId: opts.parent ?? null,
        icon: opts.icon ?? null,
      });
      ok(c, p, pageLine);
    });

  page
    .command("show <pageId>")
    .description("page metadata")
    .action((id: string) => {
      const c = getCtx(program);
      const p = c.commands.getPage(id);
      if (!p) throw new KumiError("not_found", `no page ${id}`);
      ok(c, p, pageLine);
    });

  page
    .command("list [parentId]")
    .description("list root pages, or children of a page")
    .action((parentId?: string) => {
      const c = getCtx(program);
      const nodes = parentId ? c.commands.listChildren(parentId) : c.commands.listRootPages();
      ok(c, nodes, (ns: { page: { id: string; icon: string | null; title: string }; hasChildren: boolean }[]) =>
        ns.length === 0
          ? "(empty)"
          : ns.map((n) => `${n.hasChildren ? "▸ " : "  "}${pageLine(n.page)}`).join("\n")
      );
    });

  page
    .command("rename <pageId> <title>")
    .description("set page title")
    .action((id: string, title: string) => {
      const c = getCtx(program);
      ok(c, c.commands.updatePage(id, { title }), pageLine);
    });

  page
    .command("move <pageId>")
    .description("move a page")
    .option("-p, --parent <pageId>", "new parent (omit for root)")
    .option("--after <pageId>", "position after this sibling")
    .action((id: string, opts: { parent?: string; after?: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.movePage(id, opts.parent ?? null, opts.after ?? null), pageLine);
    });

  page
    .command("duplicate <pageId>")
    .description("deep-copy a page and its subtree")
    .action((id: string) => {
      const c = getCtx(program);
      ok(c, c.commands.duplicatePage(id), pageLine);
    });

  page
    .command("trash <pageId>")
    .description("move a page (and subtree) to trash")
    .action((id: string) => {
      const c = getCtx(program);
      c.commands.trashPage(id);
      ok(c, { trashed: id });
    });

  page
    .command("restore <pageId>")
    .description("restore a page from trash")
    .action((id: string) => {
      const c = getCtx(program);
      c.commands.restorePage(id);
      ok(c, { restored: id });
    });

  page
    .command("delete <pageId>")
    .description("permanently delete a trashed page")
    .option("--force", "confirm permanent deletion", false)
    .action((id: string, opts: { force: boolean }) => {
      const c = getCtx(program);
      if (!opts.force) {
        throw new KumiError("invalid", "permanent deletion requires --force");
      }
      c.commands.deletePagePermanently(id);
      ok(c, { deleted: id });
    });

  page
    .command("breadcrumb <pageId>")
    .description("ancestry from root to the page")
    .action((id: string) => {
      const c = getCtx(program);
      const crumbs = c.commands.getBreadcrumb(id);
      ok(c, crumbs, (cs: { title: string }[]) => cs.map((x) => x.title || "Untitled").join(" / "));
    });

  program
    .command("trash")
    .description("list trashed pages")
    .action(() => {
      const c = getCtx(program);
      ok(c, c.commands.listTrash(), (ps: { id: string; icon: string | null; title: string }[]) =>
        ps.length === 0 ? "(trash is empty)" : ps.map(pageLine).join("\n")
      );
    });

  // ---- blocks -------------------------------------------------------------
  const block = program.command("block").description("read and edit page content");

  block
    .command("list <pageId>")
    .description("ordered blocks of a page")
    .action((pageId: string) => {
      const c = getCtx(program);
      const blocks = c.commands.getBlocks(pageId);
      ok(c, blocks, (bs: Block[]) =>
        bs.length === 0
          ? "(no blocks)"
          : bs
              .map((b) => {
                const text = plainText(b.payload.richText);
                return `${b.type.padEnd(20)} ${text.slice(0, 80)}  [${b.id}]`;
              })
              .join("\n")
      );
    });

  block
    .command("append <pageId> <text>")
    .description("append a block to a page")
    .option("-t, --type <type>", "block type", "paragraph")
    .option("--parent <blockId>", "parent block id (for nesting)")
    .action((pageId: string, text: string, opts: { type: string; parent?: string }) => {
      const c = getCtx(program);
      const blocks = c.commands.getBlocks(pageId);
      const parentBlockId = opts.parent ?? null;
      const op: BlockOp = {
        opId: crypto.randomUUID(),
        kind: "insert",
        block: {
          id: crypto.randomUUID(),
          pageId,
          parentBlockId,
          rank: appendRank(blocks, parentBlockId),
          type: opts.type as BlockType,
          payload: { richText: toRichText(text) },
        },
      };
      const res = c.commands.applyBlockOps([op]);
      if (res.rejected.length > 0) {
        throw new KumiError(res.rejected[0]!.reason, res.rejected[0]!.message);
      }
      ok(c, { blockId: op.kind === "insert" ? op.block.id : undefined });
    });

  block
    .command("edit <blockId> <text>")
    .description("replace a block's text")
    .action((blockId: string, text: string) => {
      const c = getCtx(program);
      const found = findBlock(c.commands, blockId);
      const op: BlockOp = {
        opId: crypto.randomUUID(),
        kind: "update",
        blockId,
        baseVersion: found.version,
        patch: { payload: { ...found.payload, richText: toRichText(text) } },
      };
      const res = c.commands.applyBlockOps([op]);
      if (res.rejected.length > 0) {
        throw new KumiError(res.rejected[0]!.reason, res.rejected[0]!.message);
      }
      ok(c, { blockId });
    });

  block
    .command("delete <blockId>")
    .description("delete a block")
    .action((blockId: string) => {
      const c = getCtx(program);
      findBlock(c.commands, blockId); // not_found check
      const res = c.commands.applyBlockOps([
        { opId: crypto.randomUUID(), kind: "delete", blockId },
      ]);
      if (res.rejected.length > 0) {
        throw new KumiError(res.rejected[0]!.reason, res.rejected[0]!.message);
      }
      ok(c, { deleted: blockId });
    });

  block
    .command("ops")
    .description("apply a raw BlockOp[] batch read from stdin (JSON)")
    .action(async () => {
      const c = getCtx(program);
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      const ops = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BlockOp[];
      ok(c, c.commands.applyBlockOps(ops));
    });

  block
    .command("show <blockId>")
    .description("one block with its full payload")
    .action((blockId: string) => {
      const c = getCtx(program);
      ok(c, findBlock(c.commands, blockId));
    });

  // ---- assets -------------------------------------------------------------
  const asset = program.command("asset").description("workspace asset store");
  asset
    .command("import <file>")
    .description("copy a file into the asset store (deduplicated by content)")
    .option("--name <filename>", "override the filename used for extension/MIME")
    .action((file: string, opts: { name?: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.importAsset(path.resolve(file), opts.name));
    });
  asset
    .command("show <assetId>")
    .description("asset metadata")
    .action((id: string) => {
      const c = getCtx(program);
      const a = c.commands.getAsset(id);
      if (!a) throw new KumiError("not_found", `no asset ${id}`);
      ok(c, a);
    });
  asset
    .command("path <assetId>")
    .description("absolute path of an asset's file")
    .action((id: string) => {
      const c = getCtx(program);
      const abs = c.commands.assetAbsolutePath(id);
      ok(c, { path: abs }, (d: { path: string }) => d.path);
    });

  // ---- backlinks ----------------------------------------------------------
  program
    .command("backlinks <pageId>")
    .description("pages whose content links to or mentions this page")
    .action((pageId: string) => {
      const c = getCtx(program);
      const links = c.commands.getBacklinks(pageId);
      ok(c, links, (ls: { sourcePageTitle: string; sourcePageIcon: string | null; sourcePageId: string; sourceBlockId: string }[]) =>
        ls.length === 0
          ? "(no backlinks)"
          : ls
              .map(
                (l) =>
                  `${l.sourcePageIcon ? l.sourcePageIcon + " " : ""}${l.sourcePageTitle || "Untitled"}  [${l.sourcePageId}] block ${l.sourceBlockId}`
              )
              .join("\n")
      );
    });

  // ---- search -------------------------------------------------------------
  program
    .command("search <query>")
    .description("full-text search across the workspace")
    .option("--title-only", "match titles only", false)
    .option("-n, --limit <n>", "max results", "20")
    .action((query: string, opts: { titleOnly: boolean; limit: string }) => {
      const c = getCtx(program);
      const results = c.commands.search(query, {
        titleOnly: opts.titleOnly,
        limit: Number.parseInt(opts.limit, 10),
      });
      ok(c, results, (rs: { title: string; snippet: string; breadcrumb: string[]; pageId: string }[]) =>
        rs.length === 0
          ? "(no results)"
          : rs
              .map(
                (r) =>
                  `${r.title || "Untitled"}  — ${r.breadcrumb.join(" / ") || "root"}  [${r.pageId}]\n    ${r.snippet.replace(/<\/?b>/g, "")}`
              )
              .join("\n")
      );
    });

  // ---- databases ----------------------------------------------------------
  const db = program.command("db").description("data sources (databases)");

  db.command("create <ownerPageId>")
    .description("create a database on a page (with Name property + Table view)")
    .option("-t, --title <title>", "database title", "")
    .action((ownerPageId: string, opts: { title: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.createDataSource(ownerPageId, opts.title));
    });

  db.command("show <dataSourceId>")
    .description("schema, properties, and views")
    .action((id: string) => {
      const c = getCtx(program);
      const ds = c.commands.getDataSource(id);
      if (!ds) throw new KumiError("not_found", `no data source ${id}`);
      ok(c, ds);
    });

  db.command("list [ownerPageId]")
    .description("data sources owned by a page, or every data source in the workspace")
    .action((ownerPageId?: string) => {
      const c = getCtx(program);
      if (ownerPageId) {
        ok(c, c.commands.listDataSources(ownerPageId));
        return;
      }
      // Workspace-wide walk (no core command enumerates all data sources yet).
      const all: { ownerPageId: string; ownerTitle: string; dataSource: unknown }[] = [];
      const stack = c.commands.listRootPages().map((n) => n.page);
      while (stack.length > 0) {
        const page = stack.pop()!;
        for (const ds of c.commands.listDataSources(page.id)) {
          all.push({ ownerPageId: page.id, ownerTitle: page.title, dataSource: ds });
        }
        for (const child of c.commands.listChildren(page.id)) stack.push(child.page);
      }
      ok(c, all);
    });

  db.command("rename <dataSourceId> <title>")
    .action((id: string, title: string) => {
      const c = getCtx(program);
      ok(c, c.commands.renameDataSource(id, title));
    });

  db.command("delete <dataSourceId>")
    .description("delete schema+views; rows go to trash")
    .option("--force", "confirm deletion", false)
    .action((id: string, opts: { force: boolean }) => {
      const c = getCtx(program);
      if (!opts.force) throw new KumiError("invalid", "database deletion requires --force");
      c.commands.deleteDataSource(id);
      ok(c, { deleted: id });
    });

  db.command("query <dataSourceId>")
    .description("filtered/sorted rows")
    .option("--filter <json>", "FilterGroup JSON")
    .option("--sort <spec>", "comma list of propertyId:asc|desc")
    .option("-n, --limit <n>", "max rows", "100")
    .option("--offset <n>", "skip rows", "0")
    .action((id: string, opts: { filter?: string; sort?: string; limit: string; offset: string }) => {
      const c = getCtx(program);
      const sorts: SortSpec[] = (opts.sort ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((spec) => {
          const [propertyId, direction] = spec.split(":");
          if (!propertyId || (direction !== "asc" && direction !== "desc")) {
            throw new KumiError("invalid", `bad sort spec "${spec}" (want propertyId:asc|desc)`);
          }
          return { propertyId, direction };
        });
      ok(
        c,
        c.commands.queryDataSource(id, {
          filter: opts.filter ? (JSON.parse(opts.filter) as FilterGroup) : undefined,
          sorts,
          limit: Number.parseInt(opts.limit, 10),
          offset: Number.parseInt(opts.offset, 10),
        }),
      );
    });

  const prop = program.command("prop").description("database properties");
  prop
    .command("add <dataSourceId> <name>")
    .requiredOption("-t, --type <type>", "property type")
    .option("--options <names>", "comma-separated select options")
    .option("--target <dsId>", "relation: target data source")
    .option("--paired-name <name>", "relation: also create the reverse relation on the target")
    .option("--through <relPropId>", "rollup: relation property on this data source")
    .option("--of <propId>", "rollup: target property to aggregate (omit for count)")
    .option("--agg <aggregation>", "rollup: count|count_values|sum|avg|min|max|show_originals")
    .option("--config <json>", "raw PropertyConfig JSON")
    .action(
      (
        dsId: string,
        name: string,
        opts: {
          type: string;
          options?: string;
          target?: string;
          pairedName?: string;
          through?: string;
          of?: string;
          agg?: string;
          config?: string;
        },
      ) => {
        const c = getCtx(program);
        let config: PropertyConfig | undefined = opts.config
          ? (JSON.parse(opts.config) as PropertyConfig)
          : undefined;
        if (opts.options) {
          // Core auto-fills option id/color when the fields are absent.
          const named = opts.options.split(",").map((n) => ({ name: n.trim() }));
          config = { ...(config ?? {}), options: named as PropertyConfig["options"] };
        }
        if (opts.type === "relation") {
          if (!opts.target) throw new KumiError("invalid", "relation needs --target <dataSourceId>");
          config = {
            ...(config ?? {}),
            relation: { dataSourceId: opts.target, pairedPropertyId: null },
            ...(opts.pairedName ? { createPaired: { name: opts.pairedName } } : {}),
          };
        }
        if (opts.type === "rollup") {
          if (!opts.through || !opts.agg) {
            throw new KumiError("invalid", "rollup needs --through <relationPropertyId> and --agg <aggregation>");
          }
          config = {
            ...(config ?? {}),
            rollup: {
              relationPropertyId: opts.through,
              targetPropertyId: opts.of ?? null,
              aggregation: opts.agg as RollupAggregation,
            },
          };
        }
        ok(c, c.commands.addProperty(dsId, { name, type: opts.type as PropertyType, config }));
      },
    );
  prop
    .command("update <propertyId>")
    .option("--name <name>")
    .option("-t, --type <type>")
    .option("--config <json>")
    .action((id: string, opts: { name?: string; type?: string; config?: string }) => {
      const c = getCtx(program);
      ok(
        c,
        c.commands.updateProperty(id, {
          name: opts.name,
          type: opts.type as PropertyType | undefined,
          config: opts.config ? (JSON.parse(opts.config) as PropertyConfig) : undefined,
        }),
      );
    });
  prop.command("rm <propertyId>").action((id: string) => {
    const c = getCtx(program);
    c.commands.removeProperty(id);
    ok(c, { removed: id });
  });

  const row = program.command("row").description("database rows (rows are pages)");
  row
    .command("add <dataSourceId>")
    .option("--values <json>", "Record<propertyId, PropertyValue> JSON")
    .action((dsId: string, opts: { values?: string }) => {
      const c = getCtx(program);
      const values = opts.values
        ? (JSON.parse(opts.values) as Record<string, PropertyValue>)
        : undefined;
      ok(c, c.commands.createRow(dsId, values));
    });
  row.command("show <pageId>").action((pageId: string) => {
    const c = getCtx(program);
    const r = c.commands.getRow(pageId);
    if (!r) throw new KumiError("not_found", `no row ${pageId}`);
    ok(c, r);
  });
  row
    .command("set <pageId> <valuesJson>")
    .description("write property values (null clears)")
    .action((pageId: string, valuesJson: string) => {
      const c = getCtx(program);
      ok(
        c,
        c.commands.setPropertyValues(
          pageId,
          JSON.parse(valuesJson) as Record<string, PropertyValue | null>,
        ),
      );
    });

  row
    .command("link <rowPageId> <propertyId>")
    .description("add/remove entries of a relation value")
    .option("--add <targetRowId>", "append a related row")
    .option("--remove <targetRowId>", "remove a related row")
    .action((rowPageId: string, propertyId: string, opts: { add?: string; remove?: string }) => {
      const c = getCtx(program);
      if (!opts.add && !opts.remove) {
        throw new KumiError("invalid", "pass --add and/or --remove");
      }
      const current = c.commands.getRow(rowPageId);
      if (!current) throw new KumiError("not_found", `no row ${rowPageId}`);
      const existing = current.values[propertyId];
      let pageIds = existing?.type === "relation" ? [...existing.pageIds] : [];
      if (opts.add && !pageIds.includes(opts.add)) pageIds.push(opts.add);
      if (opts.remove) pageIds = pageIds.filter((id) => id !== opts.remove);
      ok(
        c,
        c.commands.setPropertyValues(rowPageId, {
          [propertyId]: { type: "relation", pageIds },
        }),
      );
    });

  const view = program.command("view").description("saved database views");
  view
    .command("add <dataSourceId> <name>")
    .option("-t, --type <type>", "view type", "table")
    .action((dsId: string, name: string, opts: { type: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.createView(dsId, { name, type: opts.type as ViewType }));
    });
  view
    .command("update <viewId>")
    .option("--name <name>")
    .option("--config <json>", "partial ViewConfig JSON")
    .action((id: string, opts: { name?: string; config?: string }) => {
      const c = getCtx(program);
      ok(
        c,
        c.commands.updateView(id, {
          name: opts.name,
          config: opts.config ? (JSON.parse(opts.config) as Record<string, unknown>) : undefined,
        }),
      );
    });
  view.command("rm <viewId>").action((id: string) => {
    const c = getCtx(program);
    c.commands.deleteView(id);
    ok(c, { deleted: id });
  });

  // ---- history ------------------------------------------------------------
  const history = program.command("history").description("page version history");
  history
    .command("list <pageId>")
    .description("snapshots, newest first")
    .action((pageId: string) => {
      const c = getCtx(program);
      ok(c, c.commands.listSnapshots(pageId), (ss: { id: string; cause: string; createdAt: number }[]) =>
        ss.length === 0
          ? "(no history)"
          : ss
              .map((s) => `${new Date(s.createdAt).toISOString()}  ${s.cause.padEnd(7)}  [${s.id}]`)
              .join("\n")
      );
    });
  history
    .command("save <pageId>")
    .description("capture a manual snapshot now")
    .action((pageId: string) => {
      const c = getCtx(program);
      ok(c, c.commands.snapshotPage(pageId, "manual"));
    });
  history
    .command("show <snapshotId>")
    .description("full snapshot content")
    .action((id: string) => {
      const c = getCtx(program);
      ok(c, c.commands.getSnapshot(id));
    });
  history
    .command("restore <snapshotId>")
    .description("restore a snapshot (current state is snapshotted first)")
    .action((id: string) => {
      const c = getCtx(program);
      c.commands.restoreSnapshot(id);
      ok(c, { restored: id });
    });

  // ---- templates ----------------------------------------------------------
  const template = program.command("template").description("page templates");
  template
    .command("save <pageId>")
    .option("--name <name>", "template name (defaults to page title)")
    .action((pageId: string, opts: { name?: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.saveAsTemplate(pageId, opts.name));
    });
  template.command("list").action(() => {
    const c = getCtx(program);
    ok(c, c.commands.listTemplates(), (ts: { id: string; icon: string | null; name: string }[]) =>
      ts.length === 0 ? "(no templates)" : ts.map((t) => `${t.icon ? t.icon + " " : ""}${t.name}  [${t.id}]`).join("\n")
    );
  });
  template
    .command("use <templateId>")
    .description("instantiate as a new page")
    .option("-p, --parent <pageId>", "parent page (omit for root)")
    .action((id: string, opts: { parent?: string }) => {
      const c = getCtx(program);
      ok(c, c.commands.instantiateTemplate(id, opts.parent ?? null), pageLine);
    });
  template.command("rm <templateId>").action((id: string) => {
    const c = getCtx(program);
    c.commands.deleteTemplate(id);
    ok(c, { deleted: id });
  });

  // ---- export -------------------------------------------------------------
  const exp = program.command("export").description("export content");
  exp
    .command("md <pageId> <dir>")
    .description("page (and descendants) as Markdown + CSV + assets")
    .option("--no-recursive", "only this page, no descendants")
    .action((pageId: string, dir: string, opts: { recursive: boolean }) => {
      const c = getCtx(program);
      const res = c.commands.exportPageMarkdown(pageId, path.resolve(dir), {
        recursive: opts.recursive,
      });
      ok(c, res, (r: { files: string[] }) => `${r.files.length} files written\n${r.files.join("\n")}`);
    });
  exp
    .command("workspace <dir>")
    .description("full-fidelity JSON export of the whole workspace")
    .action((dir: string) => {
      const c = getCtx(program);
      const res = c.commands.exportWorkspaceJson(path.resolve(dir));
      ok(c, res, (r: { files: string[] }) => `${r.files.length} files written`);
    });

  // ---- notion import --------------------------------------------------------
  const imp = program.command("import").description("import a Notion export (Markdown & CSV)");
  imp
    .command("plan <path>")
    .description("dry run: what an import would create, with warnings and losses")
    .action((source: string) => {
      const c = getCtx(program);
      const plan = c.commands.planNotionImport(path.resolve(source));
      ok(c, plan, (p: {
        pages: number; dataSources: number; rows: number; assets: number;
        warnings: string[]; unsupported: { kind: string; detail: string; count: number }[];
      }) =>
        [
          `${p.pages} pages · ${p.dataSources} databases · ${p.rows} rows · ${p.assets} assets`,
          ...(p.warnings.length ? ["warnings:", ...p.warnings.map((w) => `  - ${w}`)] : []),
          ...(p.unsupported.length
            ? ["unsupported:", ...p.unsupported.map((u) => `  - ${u.kind} ×${u.count}: ${u.detail}`)]
            : []),
        ].join("\n")
      );
    });
  imp
    .command("run <path>")
    .description("import under a new root page (re-running the same export replaces it)")
    .action((source: string) => {
      const c = getCtx(program);
      const report = c.commands.runNotionImport(path.resolve(source), {
        onProgress: (p) => {
          if (!c.json) process.stderr.write(`${p.stage} ${p.done}/${p.total}\n`);
        },
      });
      ok(c, report, (r: {
        rootPageId: string | null;
        counts: { pages: number; blocks: number; dataSources: number; rows: number; assets: number };
        losses: unknown[]; warnings: string[];
      }) =>
        [
          `imported under root ${r.rootPageId}`,
          `${r.counts.pages} pages · ${r.counts.blocks} blocks · ${r.counts.dataSources} databases · ${r.counts.rows} rows · ${r.counts.assets} assets`,
          `${r.losses.length} loss item(s), ${r.warnings.length} warning(s) — use --json for details`,
        ].join("\n")
      );
    });
  imp
    .command("jobs")
    .description("past imports, newest first")
    .action(() => {
      const c = getCtx(program);
      ok(c, c.commands.listImportJobs(), (js: { id: string; sourcePath: string; status: string; createdAt: number }[]) =>
        js.length === 0
          ? "(no imports yet)"
          : js
              .map((j) => `${new Date(j.createdAt).toISOString()}  ${j.status.padEnd(9)}  ${j.sourcePath}  [${j.id}]`)
              .join("\n")
      );
    });

  // ---- favorites / recents ------------------------------------------------
  const fav = program.command("fav").description("favorites");
  fav
    .command("list")
    .description("list favorite pages")
    .action(() => {
      const c = getCtx(program);
      const state = c.commands.getUserState();
      const pages = state.favorites
        .map((id) => c.commands.getPage(id))
        .filter((p): p is NonNullable<typeof p> => p !== null);
      ok(c, pages, (ps: { id: string; icon: string | null; title: string }[]) =>
        ps.length === 0 ? "(no favorites)" : ps.map(pageLine).join("\n")
      );
    });
  fav
    .command("add <pageId>")
    .description("add a page to favorites")
    .action((id: string) => {
      const c = getCtx(program);
      ok(c, c.commands.setFavorite(id, true));
    });
  fav
    .command("remove <pageId>")
    .description("remove a page from favorites")
    .action((id: string) => {
      const c = getCtx(program);
      ok(c, c.commands.setFavorite(id, false));
    });

  program
    .command("recents")
    .description("recently visited pages")
    .action(() => {
      const c = getCtx(program);
      const state = c.commands.getUserState();
      const pages = state.recents
        .map((id) => c.commands.getPage(id))
        .filter((p): p is NonNullable<typeof p> => p !== null);
      ok(c, pages, (ps: { id: string; icon: string | null; title: string }[]) =>
        ps.length === 0 ? "(no recents)" : ps.map(pageLine).join("\n")
      );
    });

  // -------------------------------------------------------------------------
  const jsonFlag = process.argv.includes("--json");
  program
    .parseAsync(process.argv)
    .then(() => {
      ctx?.close();
    })
    .catch((err: unknown) => {
      ctx?.close();
      // commander's own exit (help/version/usage) — respect its code
      if (err && typeof err === "object" && "exitCode" in err && "code" in err) {
        const e = err as { exitCode: number; code: string };
        if (e.code.startsWith("commander.")) {
          process.exit(e.code === "commander.help" || e.code === "commander.version" ? 0 : 2);
        }
      }
      fail(jsonFlag, err);
    });
}

function findBlock(commands: KumiCommands, blockId: string): Block {
  const block = commands.getBlock(blockId);
  if (!block) throw new KumiError("not_found", `no block ${blockId}`);
  return block;
}

main();
