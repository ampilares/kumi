import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KumiError,
  rankBetween,
  type BlockPayload,
  type BlockType,
  type Id,
  type KumiCommands,
  type PropertyDef,
  type SelectOption,
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

let opCounter = 0;
const opId = (): string => `exp-op-${++opCounter}`;

function ws(): TestWorkspace {
  return tempWorkspace();
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

/** Append blocks to a page in the order given, under `parentBlockId`. */
function append(
  c: KumiCommands,
  pageId: Id,
  blocks: {
    id: Id;
    type: BlockType;
    payload: BlockPayload;
    parentBlockId?: Id | null;
  }[],
): void {
  const ranks = new Map<string, string>();
  const result = c.applyBlockOps(
    blocks.map((block) => {
      const key = block.parentBlockId ?? "";
      const rank = rankBetween(ranks.get(key) ?? null, null);
      ranks.set(key, rank);
      return {
        opId: opId(),
        kind: "insert" as const,
        block: {
          id: block.id,
          pageId,
          parentBlockId: block.parentBlockId ?? null,
          rank,
          type: block.type,
          payload: block.payload,
        },
      };
    }),
  );
  expect(result.rejected).toEqual([]);
}

/** Remove the scaffold paragraph so a golden file is exactly what we wrote. */
function clearPage(c: KumiCommands, pageId: Id): void {
  const ops = c
    .getBlocks(pageId)
    .map((block) => ({ opId: opId(), kind: "delete" as const, blockId: block.id }));
  if (ops.length > 0) c.applyBlockOps(ops);
}

function text(value: string): BlockPayload {
  return { richText: [{ type: "text", text: value }] };
}

function read(dir: string, ...segments: string[]): string {
  return fs.readFileSync(path.join(dir, ...segments), "utf8");
}

function relFiles(dir: string, files: string[]): string[] {
  return files.map((file) => path.relative(dir, file).split(path.sep).join("/")).sort();
}

function propNamed(props: PropertyDef[], name: string): PropertyDef {
  const prop = props.find((p) => p.name === name);
  if (prop === undefined) throw new Error(`no property named ${name}`);
  return prop;
}

function sourceFile(name: string, content: string): string {
  const dir = scratch("src");
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe("exportPageMarkdown: block mapping", () => {
  it("renders every block type as GitHub-flavoured Markdown", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const target = c.createPage({ title: "Target" });
    const page = c.createPage({ title: "Everything" });
    clearPage(c, page.id);

    append(c, page.id, [
      { id: "e-h1", type: "heading1", payload: text("Title") },
      { id: "e-h2", type: "heading2", payload: text("Section") },
      { id: "e-h3", type: "heading3", payload: text("Sub") },
      {
        id: "e-p",
        type: "paragraph",
        payload: {
          richText: [
            { type: "text", text: "plain " },
            { type: "text", text: "bold", annotations: { bold: true } },
            { type: "text", text: " " },
            { type: "text", text: "italic", annotations: { italic: true } },
            { type: "text", text: " " },
            { type: "text", text: "gone", annotations: { strikethrough: true } },
            { type: "text", text: " " },
            { type: "text", text: "code()", annotations: { code: true } },
            { type: "text", text: " " },
            { type: "text", text: "site", href: "https://example.com" },
            { type: "text", text: " " },
            { type: "text", text: "here", href: `kumi://page/${target.id}` },
            { type: "text", text: " " },
            { type: "mention", mention: { kind: "page", pageId: target.id } },
            { type: "text", text: " " },
            { type: "equation", expression: "a^2" },
          ],
        },
      },
      { id: "e-b1", type: "bulleted_list_item", payload: text("one") },
      { id: "e-b1a", type: "bulleted_list_item", payload: text("nested"), parentBlockId: "e-b1" },
      { id: "e-b2", type: "bulleted_list_item", payload: text("two") },
      { id: "e-n1", type: "numbered_list_item", payload: text("first") },
      { id: "e-n2", type: "numbered_list_item", payload: text("second") },
      { id: "e-t1", type: "to_do", payload: { ...text("done"), checked: true } },
      { id: "e-t2", type: "to_do", payload: { ...text("todo"), checked: false } },
      { id: "e-q", type: "quote", payload: text("quoted") },
      { id: "e-c", type: "callout", payload: { ...text("watch out"), icon: "⚠️" } },
      { id: "e-d", type: "divider", payload: {} },
      {
        id: "e-code",
        type: "code",
        payload: { ...text("print('hi')"), language: "python" },
      },
      { id: "e-eq", type: "equation", payload: { expression: "E = mc^2" } },
      {
        id: "e-bm",
        type: "bookmark",
        payload: { ...text("Example"), url: "https://example.com/a" },
      },
      { id: "e-em", type: "embed", payload: { url: "https://example.com/embed" } },
      { id: "e-lp", type: "linked_page", payload: { pageId: target.id } },
      { id: "e-cl", type: "column_list", payload: {} },
      { id: "e-col1", type: "column", payload: { widthRatio: 0.5 }, parentBlockId: "e-cl" },
      { id: "e-col2", type: "column", payload: { widthRatio: 0.5 }, parentBlockId: "e-cl" },
      { id: "e-tbl", type: "table", payload: { hasColumnHeader: true } },
      { id: "e-toc", type: "table_of_contents", payload: {} },
    ]);
    append(c, page.id, [
      { id: "e-cp1", type: "paragraph", payload: text("left"), parentBlockId: "e-col1" },
      { id: "e-cp2", type: "paragraph", payload: text("right"), parentBlockId: "e-col2" },
    ]);
    append(c, page.id, [
      {
        id: "e-tr1",
        type: "table_row",
        parentBlockId: "e-tbl",
        payload: {
          cells: [
            [{ type: "text", text: "Name" }],
            [{ type: "text", text: "Qty" }],
          ],
        },
      },
      {
        id: "e-tr2",
        type: "table_row",
        parentBlockId: "e-tbl",
        payload: {
          cells: [
            [{ type: "text", text: "Bolt | M6" }],
            [{ type: "text", text: "12" }],
          ],
        },
      },
    ]);

    const dir = scratch("md");
    const result = c.exportPageMarkdown(page.id, dir);
    expect(relFiles(dir, result.files)).toEqual(["Everything.md"]);
    expect(read(dir, "Everything.md")).toBe(
      [
        "# Everything",
        "",
        "# Title",
        "",
        "## Section",
        "",
        "### Sub",
        "",
        `plain **bold** *italic* ~~gone~~ \`code()\` [site](https://example.com) [here](kumi://page/${target.id}) [@Target](kumi://page/${target.id}) $a^2$`,
        "",
        "- one",
        "  - nested",
        "- two",
        "",
        "1. first",
        "2. second",
        "",
        "- [x] done",
        "- [ ] todo",
        "",
        "> quoted",
        "",
        "> ⚠️ watch out",
        "",
        "---",
        "",
        "```python",
        "print('hi')",
        "```",
        "",
        "$$",
        "E = mc^2",
        "$$",
        "",
        "[Example](https://example.com/a)",
        "",
        "https://example.com/embed",
        "",
        `[Target](kumi://page/${target.id})`,
        "",
        "left",
        "",
        "right",
        "",
        "| Name | Qty |",
        "| --- | --- |",
        "| Bolt \\| M6 | 12 |",
        "",
      ].join("\n"),
    );
  });

  it("escapes Markdown punctuation in plain text", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Punctuation" });
    clearPage(c, page.id);
    append(c, page.id, [
      { id: "e-esc", type: "paragraph", payload: text("a *star* and [a bracket]") },
    ]);

    const dir = scratch("md");
    c.exportPageMarkdown(page.id, dir);
    expect(read(dir, "Punctuation.md")).toContain(
      "a \\*star\\* and \\[a bracket\\]",
    );
  });
});

describe("exportPageMarkdown: files and links", () => {
  it("mirrors the page tree into folders when recursive", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ title: "Child", parentId: root.id });
    c.createPage({ title: "Grandchild", parentId: child.id });

    const dir = scratch("md");
    const result = c.exportPageMarkdown(root.id, dir, { recursive: true });
    expect(relFiles(dir, result.files)).toEqual([
      "Root.md",
      "Root/Child.md",
      "Root/Child/Grandchild.md",
    ]);
  });

  it("exports only the page itself by default", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const root = c.createPage({ title: "Root" });
    c.createPage({ title: "Child", parentId: root.id });

    const dir = scratch("md");
    expect(relFiles(dir, c.exportPageMarkdown(root.id, dir).files)).toEqual([
      "Root.md",
    ]);
  });

  it("rewrites kumi:// links and mentions to relative .md paths", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ title: "Child", parentId: root.id });
    const outside = c.createPage({ title: "Outside" });
    clearPage(c, root.id);
    clearPage(c, child.id);

    append(c, root.id, [
      {
        id: "e-l1",
        type: "paragraph",
        payload: {
          richText: [
            { type: "text", text: "down", href: `kumi://page/${child.id}` },
            { type: "text", text: " " },
            { type: "text", text: "away", href: `kumi://page/${outside.id}` },
          ],
        },
      },
      { id: "e-l2", type: "child_page", payload: { pageId: child.id } },
    ]);
    append(c, child.id, [
      {
        id: "e-l3",
        type: "paragraph",
        payload: {
          richText: [{ type: "mention", mention: { kind: "page", pageId: root.id } }],
        },
      },
    ]);

    const dir = scratch("md");
    c.exportPageMarkdown(root.id, dir, { recursive: true });

    const rootMd = read(dir, "Root.md");
    expect(rootMd).toContain("[down](Root/Child.md)");
    expect(rootMd).toContain(`[away](kumi://page/${outside.id})`);
    expect(rootMd).toContain("[Child](Root/Child.md)");
    // …and back up from the nested file.
    expect(read(dir, "Root", "Child.md")).toContain("[@Root](../Root.md)");
  });

  it("copies referenced assets into dir/assets and links them relatively", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const image = c.importAsset(sourceFile("shot.png", "pixels"), "shot.png");
    const doc = c.importAsset(sourceFile("report.pdf", "%PDF-1.4"), "report.pdf");

    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ title: "Child", parentId: root.id });
    clearPage(c, root.id);
    clearPage(c, child.id);
    append(c, root.id, [
      {
        id: "e-img",
        type: "image",
        payload: { assetId: image.id, caption: [{ type: "text", text: "A shot" }] },
      },
      { id: "e-file", type: "file", payload: { assetId: doc.id } },
    ]);
    append(c, child.id, [
      { id: "e-img2", type: "image", payload: { assetId: image.id } },
    ]);

    const dir = scratch("md");
    const result = c.exportPageMarkdown(root.id, dir, { recursive: true });

    expect(relFiles(dir, result.files)).toEqual(
      ["Root.md", "Root/Child.md", `assets/${doc.path}`, `assets/${image.path}`].sort(),
    );
    expect(read(dir, "assets", image.path)).toBe("pixels");
    expect(read(dir, "Root.md")).toContain(`![A shot](assets/${image.path})`);
    expect(read(dir, "Root.md")).toContain(`[${doc.path}](assets/${doc.path})`);
    // A nested page reaches the shared assets folder with "../".
    expect(read(dir, "Root", "Child.md")).toContain(`![](../assets/${image.path})`);
  });

  it("sanitises and de-duplicates filenames", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const root = c.createPage({ title: 'Q1/Q2: "plans" <draft>' });
    c.createPage({ title: "Notes", parentId: root.id });
    c.createPage({ title: "Notes", parentId: root.id });
    c.createPage({ title: "   ", parentId: root.id });
    c.createPage({ title: "con", parentId: root.id });

    const dir = scratch("md");
    const result = c.exportPageMarkdown(root.id, dir, { recursive: true });
    expect(relFiles(dir, result.files)).toEqual([
      "Q1 Q2 plans draft.md",
      "Q1 Q2 plans draft/Notes (2).md",
      "Q1 Q2 plans draft/Notes.md",
      "Q1 Q2 plans draft/Untitled.md",
      "Q1 Q2 plans draft/con_.md",
    ]);
  });

  it("refuses a trashed page and an unknown page", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Gone" });
    c.trashPage(page.id);
    const dir = scratch("md");
    expect(codeOf(() => c.exportPageMarkdown(page.id, dir))).toBe("invalid");
    expect(codeOf(() => c.exportPageMarkdown("nope", dir))).toBe("not_found");
  });
});

describe("exportPageMarkdown: databases as CSV", () => {
  it("writes one CSV per owned data source and links it from the Markdown", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const page = c.createPage({ title: "Project" });
    clearPage(c, page.id);

    const tasks = c.createDataSource(page.id, "Tasks").dataSource;
    const people = c.createDataSource(page.id, "People").dataSource;
    const taskProps = () => c.getDataSource(tasks.id)?.properties ?? [];
    const peopleProps = () => c.getDataSource(people.id)?.properties ?? [];

    const status = c.addProperty(tasks.id, {
      name: "Status",
      type: "select",
      config: { options: [{ name: "Done", color: "green" } as SelectOption] },
    });
    const estimate = c.addProperty(tasks.id, { name: "Estimate", type: "number" });
    const owner = c.addProperty(tasks.id, {
      name: "Owner",
      type: "relation",
      config: {
        relation: { dataSourceId: people.id, pairedPropertyId: null },
        createPaired: { name: "Tasks" },
      },
    });
    const total = c.addProperty(people.id, {
      name: "Total",
      type: "rollup",
      config: {
        rollup: {
          relationPropertyId: propNamed(peopleProps(), "Tasks").id,
          targetPropertyId: estimate.id,
          aggregation: "sum",
        },
      },
    });

    const alice = c.createRow(people.id, {
      [propNamed(peopleProps(), "Name").id]: {
        type: "title",
        richText: [{ type: "text", text: "Alice" }],
      },
    });
    c.createRow(tasks.id, {
      [propNamed(taskProps(), "Name").id]: {
        type: "title",
        richText: [{ type: "text", text: "Ship, quickly" }],
      },
      [status.id]: {
        type: "select",
        optionId: (propNamed(taskProps(), "Status").config.options ?? [])[0]?.id ?? "",
      },
      [estimate.id]: { type: "number", number: 3 },
      [owner.id]: { type: "relation", pageIds: [alice.page.id] },
    });

    append(c, page.id, [
      { id: "e-db", type: "child_database", payload: { dataSourceId: tasks.id } },
    ]);

    const dir = scratch("md");
    const result = c.exportPageMarkdown(page.id, dir);
    expect(relFiles(dir, result.files)).toEqual([
      "Project.People.csv",
      "Project.Tasks.csv",
      "Project.md",
    ]);

    expect(read(dir, "Project.Tasks.csv")).toBe(
      ["Name,Status,Estimate,Owner", '"Ship, quickly",Done,3,Alice', ""].join("\n"),
    );
    expect(read(dir, "Project.People.csv")).toBe(
      ["Name,Tasks,Total", "Alice,\"Ship, quickly\",3", ""].join("\n"),
    );
    expect(read(dir, "Project.md")).toContain("[Tasks](Project.Tasks.csv)");
    expect(total.id).not.toBe("");
  });
});

describe("exportWorkspaceJson", () => {
  interface Envelope {
    formatVersion: number;
    exportedAt: number;
    workspace: { name: string; icon: string | null };
    pages: { id: string; deletedAt: number | null; trashBatchId: string | null }[];
    blocks: { id: string }[];
    dataSources: { id: string }[];
    properties: { id: string }[];
    propertyValues: { pageId: string }[];
    dsRows: { pageId: string }[];
    views: { id: string }[];
    links: { sourceBlockId: string }[];
    assets: { id: string; path: string; contentHash: string }[];
    userState: { favorites: string[]; theme: string };
  }

  function populate(c: KumiCommands): { trashedId: Id; assetPath: string } {
    const asset = c.importAsset(sourceFile("logo.png", "bytes"), "logo.png");
    const page = c.createPage({ title: "Home", icon: "🏠" });
    append(c, page.id, [
      { id: "e-w1", type: "paragraph", payload: text("hello") },
      { id: "e-w2", type: "image", payload: { assetId: asset.id } },
    ]);
    const ds = c.createDataSource(page.id, "Log").dataSource;
    c.addProperty(ds.id, { name: "Count", type: "number" });
    c.createRow(ds.id);
    c.createView(ds.id, { name: "Board", type: "board" });
    c.setFavorite(page.id, true);
    c.setTheme("dark");

    const trashed = c.createPage({ title: "Old" });
    c.trashPage(trashed.id);
    return { trashedId: trashed.id, assetPath: asset.path };
  }

  it("dumps every table with counts that match the database", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const { trashedId, assetPath } = populate(c);

    const dir = scratch("json");
    const result = c.exportWorkspaceJson(dir);
    expect(relFiles(dir, result.files)).toEqual([
      `assets/${assetPath}`,
      "kumi-workspace.json",
    ]);

    const envelope = JSON.parse(read(dir, "kumi-workspace.json")) as Envelope;
    expect(envelope.formatVersion).toBe(1);
    expect(envelope.workspace.name).toBe(c.getWorkspaceInfo().name);
    expect(envelope.userState.theme).toBe("dark");
    expect(envelope.userState.favorites).toHaveLength(1);

    const home = envelope.pages.find((p) => p.id !== trashedId && p.deletedAt === null);
    expect(home).toBeTruthy();
    // Trashed pages travel with the export, deletion marker and all.
    const trashed = envelope.pages.find((p) => p.id === trashedId);
    expect(trashed?.deletedAt).not.toBeNull();
    expect(trashed?.trashBatchId).toBe(trashedId);

    expect(envelope.blocks.map((b) => b.id)).toContain("e-w1");
    expect(envelope.dataSources).toHaveLength(1);
    expect(envelope.properties).toHaveLength(2);
    expect(envelope.views).toHaveLength(2);
    expect(envelope.dsRows).toHaveLength(1);
    expect(envelope.assets).toHaveLength(1);
    expect(envelope.assets[0]?.path).toBe(assetPath);
    expect(read(dir, "assets", assetPath)).toBe("bytes");
  });

  it("is deterministic apart from exportedAt", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    populate(c);

    const first = scratch("json");
    const second = scratch("json");
    c.exportWorkspaceJson(first);
    c.exportWorkspaceJson(second);

    const strip = (json: string): string =>
      json.replace(/"exportedAt": \d+/, '"exportedAt": 0');
    expect(strip(read(first, "kumi-workspace.json"))).toBe(
      strip(read(second, "kumi-workspace.json")),
    );
  });

  it("carries the links index and property values", () => {
    const w = ws();
    const c: KumiCommands = w.commands;
    const target = c.createPage({ title: "Target" });
    const source = c.createPage({ title: "Source" });
    append(c, source.id, [
      {
        id: "e-j1",
        type: "paragraph",
        payload: {
          richText: [{ type: "text", text: "go", href: `kumi://page/${target.id}` }],
        },
      },
    ]);
    const ds = c.createDataSource(target.id, "D").dataSource;
    const count = c.addProperty(ds.id, { name: "Count", type: "number" });
    const row = c.createRow(ds.id, { [count.id]: { type: "number", number: 7 } });

    const dir = scratch("json");
    c.exportWorkspaceJson(dir);
    const envelope = JSON.parse(read(dir, "kumi-workspace.json")) as Envelope;

    expect(envelope.links.map((l) => l.sourceBlockId)).toContain("e-j1");
    expect(envelope.propertyValues.map((v) => v.pageId)).toContain(row.page.id);
  });
});
