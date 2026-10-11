import AdmZip from "adm-zip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createCommands,
  ingestNotionExport,
  openWorkspaceDb,
  runImportPipeline,
  type Block,
  type ImportProgress,
  type KumiCommands,
  type PropertyDef,
} from "../src";
import { cleanupWorkspaces, tempWorkspace, type TestWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kumi-${prefix}-`));
  scratchDirs.push(dir);
  return dir;
}

/** Write a `rel path → content` map as a real directory tree. */
function exportDir(files: Record<string, string | Buffer>): string {
  const root = scratch("notion-src");
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

/** The same map as a `.zip`, the way Notion actually hands it over. */
function exportZip(files: Record<string, string | Buffer>, name = "export.zip"): string {
  const zip = new AdmZip();
  for (const [rel, content] of Object.entries(files)) {
    zip.addFile(rel, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  const target = path.join(scratch("notion-zip"), name);
  zip.writeZip(target);
  return target;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "none";
  }
  return "none";
}

// A realistic export: nested pages, an inline database with both CSVs and a
// row page, a local image, an external image and a dangling link.
const HOME = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d";
const PROJECTS = "2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e";
const TASKS = "3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f";
const SHIP = "4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90";
const NOTES = "5e6f7a8b9c0d1e2f3a4b5c6d7e8f9012";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000",
  "hex",
);

const TASKS_ALL_CSV =
  "Name,Status,Due,Done,Cost,Tags,Link\n" +
  'Ship it,Done,2026-08-19,Yes,10,"a, b",https://a.test\n' +
  'Write docs,Open,"August 20, 2026",No,2.5,b,https://b.test\n' +
  "Review,Done,2026-09-01,Yes,1200,a,https://c.test\n";

const TASKS_VIEW_CSV = "Name,Status,Due,Done,Cost,Tags,Link\nShip it,Done,2026-08-19,Yes,10,a,https://a.test\n";

function fixture(): Record<string, string | Buffer> {
  return {
    [`Getting Started ${HOME}.md`]:
      `# Getting Started\n\n` +
      `Welcome. See [Projects](Projects%20${PROJECTS}.md) and [Ghost](Ghost%20ffffffffffffffffffffffffffffffff.md).\n\n` +
      `![logo](Getting%20Started%20${HOME}/logo.png)\n\n` +
      `![remote](https://example.com/remote.png)\n\n` +
      `> 💡 A callout survives\n\n` +
      "- [x] shipped\n- [ ] pending\n",
    [`Getting Started ${HOME}/logo.png`]: PNG,
    [`Projects ${PROJECTS}.md`]: `# Projects\n\nEverything we are building.\n`,
    [`Projects ${PROJECTS}/Tasks ${TASKS}.csv`]: TASKS_VIEW_CSV,
    [`Projects ${PROJECTS}/Tasks ${TASKS}_all.csv`]: TASKS_ALL_CSV,
    [`Projects ${PROJECTS}/Tasks ${TASKS}/Ship it ${SHIP}.md`]:
      "# Ship it\n\nStatus: Done\nCost: 10\n\nThe row page keeps its own content.\n",
    [`Projects ${PROJECTS}/Notes ${NOTES}.md`]: `# Notes\n\nA child of Projects.\n`,
  };
}

function ws(): TestWorkspace {
  return tempWorkspace();
}

function pageByTitle(commands: KumiCommands, title: string): { id: string } {
  const found = commands.search(title, { titleOnly: true, limit: 10 })[0];
  if (found === undefined) throw new Error(`no page titled ${title}`);
  return { id: found.pageId };
}

function rootChildren(commands: KumiCommands, rootId: string): string[] {
  return commands.listChildren(rootId).map((node) => node.page.title);
}

function blocksOf(commands: KumiCommands, pageId: string): Block[] {
  return commands.getBlocks(pageId);
}

function plainOf(block: Block | undefined): string {
  const spans = block?.payload.richText;
  if (!Array.isArray(spans)) return "";
  return spans.map((span) => (span.type === "text" ? span.text : "")).join("");
}

describe("planNotionImport", () => {
  it("reports what the export holds without writing anything", () => {
    const { commands } = ws();
    const before = commands.listRootPages().length;
    const plan = commands.planNotionImport(exportDir(fixture()));

    expect(plan.pages).toBe(3); // Getting Started, Projects, Notes
    expect(plan.dataSources).toBe(1);
    expect(plan.rows).toBe(3);
    expect(plan.assets).toBe(1);
    expect(commands.listRootPages()).toHaveLength(before);
    expect(commands.listImportJobs()).toHaveLength(0);
  });

  it("aggregates unsupported constructs by kind", () => {
    const { commands } = ws();
    const plan = commands.planNotionImport(exportDir(fixture()));
    const kinds = plan.unsupported.map((entry) => entry.kind);
    expect(kinds).toContain("external_image");
    expect(kinds).toContain("unresolved_link");
  });

  it("warns that relation columns are indistinguishable from text", () => {
    const { commands } = ws();
    const plan = commands.planNotionImport(exportDir(fixture()));
    expect(plan.warnings.join("\n")).toContain("relation");
  });

  it("rejects a source that is neither a zip nor a directory", () => {
    const { commands } = ws();
    const file = path.join(scratch("notion-plain"), "notes.txt");
    fs.writeFileSync(file, "hello");
    expect(codeOf(() => commands.planNotionImport(file))).toBe("invalid");
    expect(codeOf(() => commands.planNotionImport(path.join(file, "nope")))).toBe("invalid");
  });
});

describe("runNotionImport: structure", () => {
  it("imports the tree under one dated root page", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir(fixture()));
    expect(report.rootPageId).not.toBeNull();

    const root = commands.getPage(report.rootPageId ?? "");
    expect(root?.title).toMatch(/^Imported from Notion \d{4}-\d{2}-\d{2}$/);
    expect(root?.parentId).toBeNull();

    const children = rootChildren(commands, root?.id ?? "");
    expect(children.sort()).toEqual(["Getting Started", "Projects"]);
  });

  it("nests child pages under their folder's page", () => {
    const { commands } = ws();
    commands.runNotionImport(exportDir(fixture()));
    const projects = pageByTitle(commands, "Projects");
    expect(rootChildren(commands, projects.id)).toContain("Notes");
  });

  it("writes the page's blocks, replacing the empty scaffold", () => {
    const { commands } = ws();
    commands.runNotionImport(exportDir(fixture()));
    const home = pageByTitle(commands, "Getting Started");
    const blocks = blocksOf(commands, home.id);
    const types = blocks.map((block) => block.type);
    expect(types).toContain("callout");
    expect(types).toContain("to_do");
    expect(types).toContain("image");
    expect(types).toContain("bookmark");
    expect(blocks.filter((block) => block.type === "to_do")[0]?.payload.checked).toBe(true);
  });

  it("counts what it created", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir(fixture()));
    expect(report.counts).toMatchObject({ pages: 3, dataSources: 1, rows: 3, assets: 1 });
    expect(report.counts.blocks).toBeGreaterThan(5);
  });

  it("keeps the plan's counts and the report's counts in step", () => {
    const { commands } = ws();
    const dir = exportDir(fixture());
    const plan = commands.planNotionImport(dir);
    const report = commands.runNotionImport(dir);
    expect(report.counts.pages).toBe(plan.pages);
    expect(report.counts.dataSources).toBe(plan.dataSources);
    expect(report.counts.rows).toBe(plan.rows);
    expect(report.counts.assets).toBe(plan.assets);
    expect(report.sourceHash).toBe(plan.sourceHash);
  });
});

describe("runNotionImport: links and assets", () => {
  it("resolves an internal link to kumi://page/<id> and indexes the backlink", () => {
    const { commands } = ws();
    commands.runNotionImport(exportDir(fixture()));
    const home = pageByTitle(commands, "Getting Started");
    const projects = pageByTitle(commands, "Projects");
    const spans = blocksOf(commands, home.id)
      .flatMap((block) => (Array.isArray(block.payload.richText) ? block.payload.richText : []))
      .filter((span) => span.type === "text" && typeof span.href === "string");
    expect(spans.some((span) => span.type === "text" && span.href === `kumi://page/${projects.id}`)).toBe(
      true,
    );
    expect(commands.getBacklinks(projects.id).some((link) => link.sourcePageId === home.id)).toBe(true);
  });

  it("keeps a dangling link as plain text and reports unresolved_link", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir(fixture()));
    const home = pageByTitle(commands, "Getting Started");
    const ghost = blocksOf(commands, home.id)
      .flatMap((block) => (Array.isArray(block.payload.richText) ? block.payload.richText : []))
      .find((span) => span.type === "text" && span.text === "Ghost");
    expect(ghost).toBeDefined();
    expect(ghost && "href" in ghost ? ghost.href : undefined).toBeUndefined();
    expect(report.losses.some((loss) => loss.kind === "unresolved_link")).toBe(true);
  });

  it("imports a referenced local image and points the block at the asset", () => {
    const { commands } = ws();
    commands.runNotionImport(exportDir(fixture()));
    const home = pageByTitle(commands, "Getting Started");
    const image = blocksOf(commands, home.id).find((block) => block.type === "image");
    const assetId = image?.payload.assetId;
    expect(typeof assetId).toBe("string");
    const asset = commands.getAsset(String(assetId));
    expect(asset?.mime).toBe("image/png");
    expect(fs.existsSync(commands.assetAbsolutePath(String(assetId)))).toBe(true);
  });

  it("turns an external image into a bookmark plus an external_image loss", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir(fixture()));
    const home = pageByTitle(commands, "Getting Started");
    const bookmark = blocksOf(commands, home.id).find((block) => block.type === "bookmark");
    expect(bookmark?.payload.url).toBe("https://example.com/remote.png");
    const loss = report.losses.find((entry) => entry.kind === "external_image");
    expect(loss?.sourceRef).toContain("Getting Started");
  });

  it("reports a reference to a file the export does not contain", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(
      exportDir({ [`Solo ${HOME}.md`]: "# Solo\n\n![gone](missing.png)\n" }),
    );
    const loss = report.losses.find((entry) => entry.kind === "missing_asset");
    expect(loss).toBeDefined();
    expect(loss?.sourceRef).toContain("missing.png");
  });

  it("stores one asset for a file referenced twice", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(
      exportDir({
        [`A ${HOME}.md`]: `# A\n\n![x](A%20${HOME}/pic.png)\n`,
        [`A ${HOME}/pic.png`]: PNG,
        [`B ${PROJECTS}.md`]: `# B\n\n![x](A%20${HOME}/pic.png)\n`,
      }),
    );
    expect(report.counts.assets).toBe(1);
  });

  it("imports a linked file as an asset and points the link at it", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(
      exportDir({
        [`Doc ${HOME}.md`]: `# Doc\n\nSee [the report](Doc%20${HOME}/report.pdf).\n`,
        [`Doc ${HOME}/report.pdf`]: Buffer.from("%PDF-1.4\n"),
      }),
    );
    expect(report.losses.some((loss) => loss.kind === "file_link")).toBe(true);
    const doc = pageByTitle(commands, "Doc");
    const spans = blocksOf(commands, doc.id).flatMap((block) =>
      Array.isArray(block.payload.richText) ? block.payload.richText : [],
    );
    const link = spans.find((span) => span.type === "text" && typeof span.href === "string");
    expect(link && "href" in link ? String(link.href) : "").toMatch(/^kumi:\/\/asset\//);
  });

  it("resolves URL-encoded unicode filenames", () => {
    const { commands } = ws();
    commands.runNotionImport(
      exportDir({
        [`Start ${HOME}.md`]: `# Start\n\n[日本語](%E6%97%A5%E6%9C%AC%E8%AA%9E%20${PROJECTS}.md)\n`,
        [`日本語 ${PROJECTS}.md`]: "# 日本語 🎉\n\nこんにちは\n",
      }),
    );
    const target = pageByTitle(commands, "日本語");
    expect(commands.getBacklinks(target.id)).toHaveLength(1);
  });
});

describe("runNotionImport: databases", () => {
  function importFixture(): { commands: KumiCommands; properties: PropertyDef[]; dataSourceId: string } {
    const { commands } = ws();
    commands.runNotionImport(exportDir(fixture()));
    const projects = pageByTitle(commands, "Projects");
    const dataSource = commands.listDataSources(projects.id)[0];
    if (dataSource === undefined) throw new Error("no data source imported");
    const loaded = commands.getDataSource(dataSource.id);
    return {
      commands,
      properties: loaded?.properties ?? [],
      dataSourceId: dataSource.id,
    };
  }

  it("prefers the `_all` CSV over the visible-view CSV", () => {
    const { commands, dataSourceId } = importFixture();
    expect(commands.queryDataSource(dataSourceId).total).toBe(3);
  });

  it("infers the schema conservatively", () => {
    const { properties } = importFixture();
    const byName = new Map(properties.map((prop) => [prop.name, prop.type]));
    expect(byName.get("Name")).toBe("title");
    expect(byName.get("Status")).toBe("select");
    expect(byName.get("Due")).toBe("date");
    expect(byName.get("Done")).toBe("checkbox");
    expect(byName.get("Cost")).toBe("number");
    expect(byName.get("Tags")).toBe("multi_select");
    expect(byName.get("Link")).toBe("url");
  });

  it("writes typed cell values", () => {
    const { commands, properties, dataSourceId } = importFixture();
    const byName = new Map(properties.map((prop) => [prop.name, prop]));
    const rows = commands.queryDataSource(dataSourceId).rows;
    const ship = rows.find((row) => row.page.title === "Ship it");
    expect(ship).toBeDefined();
    expect(ship?.values[byName.get("Cost")?.id ?? ""]).toEqual({ type: "number", number: 10 });
    expect(ship?.values[byName.get("Done")?.id ?? ""]).toEqual({ type: "checkbox", checked: true });
    expect(ship?.values[byName.get("Due")?.id ?? ""]).toMatchObject({ start: "2026-08-19" });
    const tags = ship?.values[byName.get("Tags")?.id ?? ""];
    expect(tags?.type === "multi_select" ? tags.optionIds : []).toHaveLength(2);
  });

  it("gives each row a page and attaches the row page's own content", () => {
    const { commands, dataSourceId } = importFixture();
    const ship = commands
      .queryDataSource(dataSourceId)
      .rows.find((row) => row.page.title === "Ship it");
    const blocks = blocksOf(commands, ship?.page.id ?? "");
    expect(plainOf(blocks[0])).toBe("The row page keeps its own content.");
  });

  it("keeps a row page with no CSV row as its own row and reports it", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(
      exportDir({
        [`Tasks ${TASKS}.csv`]: "Name,Note\nOne,first\n",
        [`Tasks ${TASKS}/Stray ${SHIP}.md`]: "# Stray\n\nOrphan row content.\n",
      }),
    );
    expect(report.counts.rows).toBe(2);
    expect(report.losses.some((loss) => loss.kind === "row_page_unmatched")).toBe(true);
  });

  it("reads a quoted multiline cell into the row", () => {
    const { commands } = ws();
    commands.runNotionImport(
      exportDir({ [`Notes ${TASKS}.csv`]: 'Name,Body\nOne,"line1\nline2"\n' }),
    );
    const owner = commands.listRootPages()[0];
    const dataSource = commands.listDataSources(owner?.page.id ?? "")[0];
    const loaded = commands.getDataSource(dataSource?.id ?? "");
    const body = loaded?.properties.find((prop) => prop.name === "Body");
    const row = commands.queryDataSource(dataSource?.id ?? "").rows[0];
    const value = row?.values[body?.id ?? ""];
    expect(value?.type === "text" ? value.richText[0] : undefined).toMatchObject({
      text: "line1\nline2",
    });
  });

  it("downgrades a column to text when a value fails validation, verbatim", () => {
    const { commands } = ws();
    // Both values parse as dates by shape, but a compact `+0000` offset is not
    // an ISO datetime Kumi stores: the column falls back to text, verbatim.
    const report = commands.runNotionImport(
      exportDir({
        [`Dates ${TASKS}.csv`]: "Name,When\nA,2026-08-19T10:00:00+0000\nB,2026-03-01\n",
      }),
    );
    const owner = commands.listRootPages()[0];
    const dataSource = commands.listDataSources(owner?.page.id ?? "")[0];
    const loaded = commands.getDataSource(dataSource?.id ?? "");
    const when = loaded?.properties.find((prop) => prop.name === "When");
    expect(when?.type).toBe("text");

    const rows = commands.queryDataSource(dataSource?.id ?? "").rows;
    const first = rows.find((row) => row.page.title === "A");
    const value = first?.values[when?.id ?? ""];
    expect(value?.type === "text" ? value.richText[0] : undefined).toMatchObject({
      text: "2026-08-19T10:00:00+0000",
    });
    expect(report.warnings.join("\n")).toContain("preserved");
    expect(report.losses.some((loss) => loss.kind === "column_downgraded")).toBe(true);
  });
});

describe("ingest: zip handling", () => {
  it("imports from a .zip exactly as from a directory", () => {
    const files = fixture();
    const fromZip = ws().commands.runNotionImport(exportZip(files));
    const fromDir = ws().commands.runNotionImport(exportDir(files));
    expect(fromZip.counts).toEqual(fromDir.counts);
  });

  it("unwraps Notion's single Export-<uuid>/ wrapper folder", () => {
    const wrapped: Record<string, string | Buffer> = {};
    for (const [rel, content] of Object.entries(fixture())) {
      wrapped[`Export-8b1c/${rel}`] = content;
    }
    const { commands } = ws();
    const report = commands.runNotionImport(exportZip(wrapped));
    expect(report.counts.pages).toBe(3);
  });

  it("refuses an entry that escapes the extraction directory (zip slip)", () => {
    const zip = new AdmZip();
    zip.addFile("evil.txt", Buffer.from("pwned", "utf8"));
    zip.addFile(`Safe ${HOME}.md`, Buffer.from("# Safe\n", "utf8"));
    // adm-zip sanitizes names given to addFile, so the traversal is written
    // straight onto the entry — exactly what a hostile archive carries.
    const attack = zip.getEntries()[0];
    if (attack !== undefined) attack.entryName = "../../evil.txt";
    const target = path.join(scratch("notion-slip"), "slip.zip");
    zip.writeZip(target);

    const { commands } = ws();
    expect(codeOf(() => commands.planNotionImport(target))).toBe("invalid");
    expect(fs.existsSync(path.join(path.dirname(target), "..", "..", "evil.txt"))).toBe(false);
  });

  it("refuses an archive over the uncompressed size cap", () => {
    const target = exportZip({ [`Big ${HOME}.md`]: "x".repeat(4096) }, "big.zip");
    expect(codeOf(() => ingestNotionExport(target, { maxBytes: 1024 }))).toBe("invalid");
  });

  it("refuses an archive over the file-count cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i += 1) files[`P${i} ${HOME.slice(0, 31)}${i}.md`] = `# P${i}\n`;
    const target = exportZip(files, "many.zip");
    expect(codeOf(() => ingestNotionExport(target, { maxFiles: 3 }))).toBe("invalid");
  });

  it("refuses a directory over the caps too", () => {
    const dir = exportDir({ [`Big ${HOME}.md`]: "x".repeat(4096) });
    expect(codeOf(() => ingestNotionExport(dir, { maxBytes: 16 }))).toBe("invalid");
  });

  it("hashes a zip by its bytes and a directory by its listing", () => {
    const files = fixture();
    const zipA = exportZip(files, "a.zip");
    const zipB = exportZip(files, "b.zip");
    const a = ingestNotionExport(zipA);
    const b = ingestNotionExport(zipB);
    a.cleanup();
    b.cleanup();
    expect(a.sourceHash).toBe(b.sourceHash);

    const dir = exportDir(files);
    const first = ingestNotionExport(dir);
    const second = ingestNotionExport(dir);
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.sourceHash).not.toBe(a.sourceHash);
  });
});

describe("idempotency and job history", () => {
  it("re-running the same export trashes the old root instead of duplicating", () => {
    const { commands } = ws();
    const source = exportZip(fixture());
    const first = commands.runNotionImport(source);
    const second = commands.runNotionImport(source);

    expect(second.rootPageId).not.toBe(first.rootPageId);
    const roots = commands.listRootPages().map((node) => node.page.id);
    expect(roots).toContain(second.rootPageId);
    expect(roots).not.toContain(first.rootPageId);
    expect(commands.listTrash().map((page) => page.id)).toContain(first.rootPageId);
    expect(commands.getPage(first.rootPageId ?? "")?.deletedAt).not.toBeNull();

    // Nothing doubled: one live copy of every imported page.
    expect(commands.search("Getting Started", { titleOnly: true })).toHaveLength(1);
    expect(second.warnings.join("\n")).toContain("trash");
  });

  it("reuses the job row, keeping its id and createdAt", () => {
    const { commands } = ws();
    const source = exportZip(fixture());
    const first = commands.runNotionImport(source);
    const firstJob = commands.listImportJobs()[0];
    const second = commands.runNotionImport(source);
    const jobs = commands.listImportJobs();

    expect(jobs).toHaveLength(1);
    expect(second.jobId).toBe(first.jobId);
    expect(jobs[0]?.createdAt).toBe(firstJob?.createdAt);
    expect(jobs[0]?.report?.rootPageId).toBe(second.rootPageId);
    expect(jobs[0]?.status).toBe("committed");
  });

  it("keeps a separate job per distinct export, newest first", () => {
    const { commands } = ws();
    const one = commands.runNotionImport(exportZip(fixture(), "one.zip"));
    const two = commands.runNotionImport(
      exportZip({ [`Other ${PROJECTS}.md`]: "# Other\n" }, "two.zip"),
    );
    const jobs = commands.listImportJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.id).toBe(two.jobId);
    expect(jobs[1]?.id).toBe(one.jobId);
    expect(jobs[0]?.report?.counts.pages).toBe(1);
    expect(jobs[0]?.sourcePath.endsWith("two.zip")).toBe(true);
  });

  it("restores the previous import from the trash if asked", () => {
    const { commands } = ws();
    const source = exportZip(fixture());
    const first = commands.runNotionImport(source);
    commands.runNotionImport(source);
    commands.restorePage(first.rootPageId ?? "");
    expect(commands.getPage(first.rootPageId ?? "")?.deletedAt).toBeNull();
  });
});

describe("progress and verification", () => {
  it("reports every stage once, in pipeline order, with real counts", () => {
    const { commands } = ws();
    const seen: ImportProgress[] = [];
    commands.runNotionImport(exportDir(fixture()), {
      onProgress: (progress) => seen.push(progress),
    });
    const order = [...new Set(seen.map((entry) => entry.stage))];
    expect(order).toEqual(["ingest", "parse", "write", "resolve", "assets", "verify"]);

    const parse = seen.filter((entry) => entry.stage === "parse");
    expect(parse[parse.length - 1]?.done).toBe(parse[parse.length - 1]?.total);
    const write = seen.filter((entry) => entry.stage === "write");
    expect(write[write.length - 1]).toEqual({ stage: "write", done: 7, total: 7 });
    expect(seen[seen.length - 1]).toEqual({ stage: "verify", done: 1, total: 1 });
  });

  it("records a verify_mismatch when the written rows do not match the CSV", () => {
    const db = openWorkspaceDb(scratch("verify-ws"));
    const commands = createCommands(db);
    // A workspace that under-reports its rows is exactly the corruption the
    // verify stage exists to catch.
    const lying: KumiCommands = {
      ...commands,
      queryDataSource: (dataSourceId: string) => ({
        ...commands.queryDataSource(dataSourceId, { limit: 1 }),
        total: 0,
      }),
    };
    const report = runImportPipeline(db, lying, exportDir(fixture()));
    db.close();
    const mismatch = report.losses.find((loss) => loss.kind === "verify_mismatch");
    expect(mismatch?.detail).toContain("3 row(s)");
  });

  it("carries a source reference on every loss item", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir(fixture()));
    expect(report.losses.length).toBeGreaterThan(0);
    for (const loss of report.losses) {
      expect(loss.sourceRef).not.toBe("");
      expect(loss.kind).not.toBe("");
    }
  });

  it("imports an empty export without writing anything but the root", () => {
    const { commands } = ws();
    const report = commands.runNotionImport(exportDir({ "readme.txt": "nothing to see" }));
    expect(report.counts).toMatchObject({ pages: 0, dataSources: 0, rows: 0 });
    expect(commands.getPage(report.rootPageId ?? "")).not.toBeNull();
  });
});
