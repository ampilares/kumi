/**
 * End-to-end tests for the built `kumi` CLI: each case spawns the real binary
 * (dist/index.js) against a temp workspace, exactly as an agent would.
 */
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { rankBetween } from "@kumi/core";

const cliRoot = path.resolve(__dirname, "..");
const entry = path.join(cliRoot, "dist", "index.js");

let workspace: string;

function kumi(args: string[], opts: { expectFail?: boolean } = {}): {
  stdout: string;
  status: number;
} {
  try {
    const stdout = execFileSync(process.execPath, [entry, ...args], {
      env: { ...process.env, KUMI_WORKSPACE: workspace },
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    if (!opts.expectFail) {
      throw new Error(`kumi ${args.join(" ")} failed: ${e.stderr ?? ""}`);
    }
    return { stdout: (e.stderr ?? "") + (e.stdout ?? ""), status: e.status ?? 1 };
  }
}

function kumiJson<T = Record<string, unknown>>(args: string[]): T {
  const { stdout } = kumi(["--json", ...args]);
  const parsed = JSON.parse(stdout) as { ok: boolean; data: T };
  expect(parsed.ok).toBe(true);
  return parsed.data;
}

beforeAll(() => {
  if (!fs.existsSync(entry)) {
    execSync("npx tsc -p tsconfig.json", { cwd: cliRoot, stdio: "inherit" });
  }
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-cli-test-"));
});

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("kumi CLI end-to-end", () => {
  let pageId: string;
  let childId: string;

  it("creates a workspace and reports info", () => {
    const info = kumiJson<{ path: string; name: string }>(["workspace", "info"]);
    expect(path.resolve(info.path)).toBe(path.resolve(workspace));
    expect(fs.existsSync(path.join(workspace, "kumi.db"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "assets"))).toBe(true);
  });

  it("creates and nests pages", () => {
    pageId = kumiJson<{ id: string }>(["page", "create", "-t", "Projects", "-i", "📁"]).id;
    childId = kumiJson<{ id: string }>(["page", "create", "-t", "SMB Automations", "-p", pageId]).id;
    const roots = kumiJson<{ page: { id: string }; hasChildren: boolean }[]>(["page", "list"]);
    expect(roots.map((r) => r.page.id)).toContain(pageId);
    expect(roots.find((r) => r.page.id === pageId)?.hasChildren).toBe(true);
  });

  it("appends and edits blocks", () => {
    const { blockId } = kumiJson<{ blockId: string }>([
      "block", "append", childId, "Answer the same questions with FAQ docs",
    ]);
    kumiJson(["block", "append", childId, "Follow up on SOPs", "-t", "to_do"]);
    kumiJson(["block", "edit", blockId, "Answer repeated questions with FAQ docs"]);
    const blocks = kumiJson<{ type: string; payload: { richText?: { text?: string }[] } }[]>([
      "block", "list", childId,
    ]);
    const texts = blocks.map((b) => b.payload.richText?.[0]?.text ?? "");
    expect(texts).toContain("Answer repeated questions with FAQ docs");
    expect(blocks.some((b) => b.type === "to_do")).toBe(true);
  });

  it("searches with breadcrumbs", () => {
    const results = kumiJson<{ pageId: string; breadcrumb: string[] }[]>(["search", "FAQ"]);
    expect(results.some((r) => r.pageId === childId)).toBe(true);
    expect(results.find((r) => r.pageId === childId)?.breadcrumb).toEqual(["Projects"]);
  });

  it("round-trips trash and restore", () => {
    kumiJson(["page", "trash", childId]);
    const trashed = kumiJson<{ id: string }[]>(["trash"]);
    expect(trashed.map((p) => p.id)).toContain(childId);
    kumiJson(["page", "restore", childId]);
    expect(kumiJson<{ id: string }[]>(["trash"])).toHaveLength(0);
  });

  it("requires --force for permanent deletion and honors it", () => {
    kumiJson(["page", "trash", childId]);
    const refused = kumi(["--json", "page", "delete", childId], { expectFail: true });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain("--force");
    kumiJson(["page", "delete", childId, "--force"]);
    expect(kumiJson<unknown[]>(["trash"])).toHaveLength(0);
  });

  it("shows a single block and 404s unknown blocks", () => {
    const home = kumiJson<{ id: string }>(["page", "create", "-t", "Block home"]).id;
    const { blockId } = kumiJson<{ blockId: string }>(["block", "append", home, "target text"]);
    const block = kumiJson<{ id: string; type: string }>(["block", "show", blockId]);
    expect(block.id).toBe(blockId);
    const missing = kumi(["--json", "block", "show", "00000000-0000-4000-8000-000000000001"], {
      expectFail: true,
    });
    expect(missing.status).toBe(1);
  });

  it("imports assets with content dedup and resolves their path", () => {
    const file = path.join(workspace, "sample.txt");
    fs.writeFileSync(file, "kumi asset content");
    const first = kumiJson<{ id: string; mime: string; size: number }>(["asset", "import", file]);
    expect(first.mime).toBe("text/plain");
    expect(first.size).toBe(18);
    const again = kumiJson<{ id: string }>(["asset", "import", file]);
    expect(again.id).toBe(first.id); // dedup by content hash
    const where = kumiJson<{ path: string }>(["asset", "path", first.id]);
    expect(fs.readFileSync(where.path, "utf8")).toBe("kumi asset content");
  });

  it("reports backlinks created through block content", () => {
    const target = kumiJson<{ id: string }>(["page", "create", "-t", "Linked target"]).id;
    const source = kumiJson<{ id: string }>(["page", "create", "-t", "Linking source"]).id;
    const op = {
      opId: "11111111-1111-4111-8111-111111111111",
      kind: "insert",
      block: {
        id: "22222222-2222-4222-8222-222222222222",
        pageId: source,
        parentBlockId: null,
        rank: rankBetween(null, null),
        type: "paragraph",
        payload: {
          richText: [{ type: "text", text: "see also", href: `kumi://page/${target}` }],
        },
      },
    };
    execFileSync(process.execPath, [entry, "--json", "block", "ops"], {
      env: { ...process.env, KUMI_WORKSPACE: workspace },
      input: JSON.stringify([op]),
      encoding: "utf8",
    });
    const links = kumiJson<{ sourcePageId: string; sourcePageTitle: string }[]>([
      "backlinks", target,
    ]);
    expect(links).toHaveLength(1);
    expect(links[0]?.sourcePageId).toBe(source);
    expect(links[0]?.sourcePageTitle).toBe("Linking source");
  });

  it("drives a database end-to-end: schema, rows, query, views", () => {
    const owner = kumiJson<{ id: string }>(["page", "create", "-t", "SMB Automations"]).id;
    const created = kumiJson<{
      dataSource: { id: string };
      properties: { id: string; type: string }[];
      views: { id: string }[];
    }>(["db", "create", owner, "-t", "Pain points"]);
    const dsId = created.dataSource.id;
    const titleProp = created.properties.find((p) => p.type === "title")!;
    expect(created.views).toHaveLength(1);

    const category = kumiJson<{ id: string; config: { options: { id: string; name: string }[] } }>([
      "prop", "add", dsId, "Category", "-t", "select", "--options", "Customer Service,Marketing",
    ]);
    const effort = kumiJson<{ id: string }>(["prop", "add", dsId, "Effort", "-t", "number"]);
    const csOption = category.config.options.find((o) => o.name === "Customer Service")!;

    const row1 = kumiJson<{ page: { id: string } }>([
      "row", "add", dsId, "--values",
      JSON.stringify({
        [titleProp.id]: { type: "title", richText: [{ type: "text", text: "Answering same questions" }] },
        [category.id]: { type: "select", optionId: csOption.id },
        [effort.id]: { type: "number", number: 3 },
      }),
    ]);
    kumiJson(["row", "add", dsId, "--values", JSON.stringify({
      [effort.id]: { type: "number", number: 8 },
    })]);

    // title mirror: the row page's title is the title property
    const rowPage = kumiJson<{ title: string }>(["page", "show", row1.page.id]);
    expect(rowPage.title).toBe("Answering same questions");

    // rows stay out of the page tree
    const children = kumiJson<unknown[]>(["page", "list", owner]);
    expect(children).toHaveLength(0);

    // filtered + sorted query
    const filtered = kumiJson<{ rows: { page: { id: string } }[]; total: number }>([
      "db", "query", dsId,
      "--filter", JSON.stringify({
        kind: "group", op: "and",
        children: [{ kind: "condition", propertyId: effort.id, op: "gte", value: 5 }],
      }),
      "--sort", `${effort.id}:desc`,
    ]);
    expect(filtered.total).toBe(1);
    expect(filtered.rows[0]?.page.id).not.toBe(row1.page.id);

    // invalid value variant is rejected loudly
    const bad = kumi(["--json", "row", "set", row1.page.id, JSON.stringify({
      [effort.id]: { type: "checkbox", checked: true },
    })], { expectFail: true });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout.trim().split("\n").pop()!).error.code).toBe("invalid");

    // views: add + refuse deleting the last remaining one after removal
    const extra = kumiJson<{ id: string }>(["view", "add", dsId, "Board later", "-t", "table"]);
    kumiJson(["view", "rm", extra.id]);
    const lastView = created.views[0]!.id;
    const refuse = kumi(["--json", "view", "rm", lastView], { expectFail: true });
    expect(refuse.status).toBe(1);
  });

  it("wires relations and rollups through the CLI", () => {
    const owner = kumiJson<{ id: string }>(["page", "create", "-t", "CRM"]).id;
    const clients = kumiJson<{ dataSource: { id: string } }>(["db", "create", owner, "-t", "Clients"]);
    const deals = kumiJson<{ dataSource: { id: string }; properties: { id: string }[] }>([
      "db", "create", owner, "-t", "Deals",
    ]);
    const amount = kumiJson<{ id: string }>(["prop", "add", deals.dataSource.id, "Amount", "-t", "number"]);

    // paired relation Clients→Deals
    const rel = kumiJson<{ id: string; config: { relation: { pairedPropertyId: string | null } } }>([
      "prop", "add", clients.dataSource.id, "Deals", "-t", "relation",
      "--target", deals.dataSource.id, "--paired-name", "Client",
    ]);
    expect(rel.config.relation.pairedPropertyId).toBeTruthy();

    // rollup: sum of related deal amounts
    const rollup = kumiJson<{ id: string }>([
      "prop", "add", clients.dataSource.id, "Total", "-t", "rollup",
      "--through", rel.id, "--of", amount.id, "--agg", "sum",
    ]);

    const client = kumiJson<{ page: { id: string } }>(["row", "add", clients.dataSource.id]);
    const deal1 = kumiJson<{ page: { id: string } }>(["row", "add", deals.dataSource.id, "--values",
      JSON.stringify({ [amount.id]: { type: "number", number: 1200 } })]);
    const deal2 = kumiJson<{ page: { id: string } }>(["row", "add", deals.dataSource.id, "--values",
      JSON.stringify({ [amount.id]: { type: "number", number: 800 } })]);

    kumiJson(["row", "link", client.page.id, rel.id, "--add", deal1.page.id]);
    kumiJson(["row", "link", client.page.id, rel.id, "--add", deal2.page.id]);

    const rowNow = kumiJson<{ values: Record<string, { type: string; number?: number; pageIds?: string[] }> }>([
      "row", "show", client.page.id,
    ]);
    expect(rowNow.values[rel.id]?.pageIds).toHaveLength(2);
    expect(rowNow.values[rollup.id]?.number).toBe(2000);

    // paired sync: the deal shows its client
    const dealRow = kumiJson<{ values: Record<string, { pageIds?: string[] }> }>([
      "row", "show", deal1.page.id,
    ]);
    const paired = rel.config.relation.pairedPropertyId!;
    expect(dealRow.values[paired]?.pageIds).toEqual([client.page.id]);

    // unlink updates the rollup
    kumiJson(["row", "link", client.page.id, rel.id, "--remove", deal2.page.id]);
    const after = kumiJson<{ values: Record<string, { number?: number }> }>(["row", "show", client.page.id]);
    expect(after.values[rollup.id]?.number).toBe(1200);

    // workspace-wide db list sees both databases
    const all = kumiJson<{ dataSource: { id: string } }[]>(["db", "list"]);
    const ids = all.map((e) => e.dataSource.id);
    expect(ids).toContain(clients.dataSource.id);
    expect(ids).toContain(deals.dataSource.id);
  });

  it("captures, restores, and exports through history/template/export commands", () => {
    const page = kumiJson<{ id: string }>(["page", "create", "-t", "Playbook", "-i", "📘"]).id;
    kumiJson(["block", "append", page, "Version one content"]);
    kumiJson(["history", "save", page]);

    const b2 = kumiJson<{ blockId: string }>(["block", "append", page, "Version two content"]);
    expect(b2.blockId).toBeTruthy();

    const snaps = kumiJson<{ id: string; cause: string }[]>(["history", "list", page]);
    const manual = snaps.find((s) => s.cause === "manual")!;
    kumiJson(["history", "restore", manual.id]);

    const blocks = kumiJson<{ payload: { richText?: { text?: string }[] } }[]>(["block", "list", page]);
    const texts = blocks.map((b) => b.payload.richText?.[0]?.text ?? "");
    expect(texts).toContain("Version one content");
    expect(texts).not.toContain("Version two content");
    // the pre-restore state was snapshotted, so nothing is lost
    const after = kumiJson<{ cause: string }[]>(["history", "list", page]);
    expect(after.some((s) => s.cause === "restore")).toBe(true);

    // template round trip
    const tpl = kumiJson<{ id: string; name: string }>(["template", "save", page, "--name", "Playbook Tpl"]);
    const inst = kumiJson<{ id: string; title: string }>(["template", "use", tpl.id]);
    expect(inst.id).not.toBe(page);
    const instBlocks = kumiJson<unknown[]>(["block", "list", inst.id]);
    expect(instBlocks.length).toBeGreaterThan(0);

    // markdown export
    const outDir = path.join(workspace, "export-out");
    const res = kumiJson<{ files: string[] }>(["export", "md", page, outDir]);
    expect(res.files.some((f) => f.endsWith(".md"))).toBe(true);
    const md = fs.readFileSync(res.files.find((f) => f.endsWith(".md"))!, "utf8");
    expect(md).toContain("Version one content");

    // workspace JSON export
    const wsDir = path.join(workspace, "ws-out");
    const ws = kumiJson<{ files: string[] }>(["export", "workspace", wsDir]);
    const envelope = JSON.parse(
      fs.readFileSync(ws.files.find((f) => f.endsWith("kumi-workspace.json"))!, "utf8"),
    ) as { formatVersion: number; pages: unknown[] };
    expect(envelope.formatVersion).toBe(1);
    expect(envelope.pages.length).toBeGreaterThan(0);
  });

  it("plans and runs a Notion export import", () => {
    // Minimal synthetic Notion Markdown+CSV export
    const src = path.join(workspace, "notion-export");
    const hexA = "a".repeat(32);
    const hexDb = "b".repeat(32);
    fs.mkdirSync(path.join(src, `Projects ${hexA}`), { recursive: true });
    fs.writeFileSync(
      path.join(src, `Projects ${hexA}.md`),
      "# Projects\n\nWelcome to the migrated workspace.\n\n- [ ] First task\n",
    );
    fs.writeFileSync(
      path.join(src, `Projects ${hexA}`, `Pain Points ${hexDb}.csv`),
      "Name,Category,Effort\nAnswering same questions,Customer Service,3\nManual invoicing,Admin,8\n",
    );

    const plan = kumiJson<{ pages: number; dataSources: number; rows: number }>([
      "import", "plan", src,
    ]);
    expect(plan.pages).toBeGreaterThanOrEqual(1);
    expect(plan.dataSources).toBe(1);
    expect(plan.rows).toBe(2);

    const report = kumiJson<{
      rootPageId: string;
      counts: { pages: number; rows: number; dataSources: number };
    }>(["import", "run", src]);
    expect(report.rootPageId).toBeTruthy();
    expect(report.counts.dataSources).toBe(1);
    expect(report.counts.rows).toBe(2);

    // imported content is really there and searchable
    const hits = kumiJson<{ title: string }[]>(["search", "migrated workspace"]);
    expect(hits.length).toBeGreaterThan(0);

    // re-run replaces, never duplicates
    const again = kumiJson<{ rootPageId: string }>(["import", "run", src]);
    expect(again.rootPageId).not.toBe(report.rootPageId);
    const jobs = kumiJson<{ status: string }[]>(["import", "jobs"]);
    expect(jobs.filter((j) => j.status === "committed")).toHaveLength(1);
  });

  it("fails with a structured error for unknown pages", () => {
    const res = kumi(["--json", "page", "show", "00000000-0000-4000-8000-000000000000"], {
      expectFail: true,
    });
    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout.trim().split("\n").pop()!) as {
      ok: boolean;
      error: { code: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("not_found");
  });

  it("keeps stderr free of experimental warnings", () => {
    const stderr = (() => {
      try {
        execFileSync(process.execPath, [entry, "page", "list"], {
          env: { ...process.env, KUMI_WORKSPACE: workspace },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return "";
      } catch {
        return "spawn failed";
      }
    })();
    expect(stderr).not.toContain("ExperimentalWarning");
  });
});
