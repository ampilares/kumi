import { afterAll, describe, expect, it } from "vitest";
import {
  KumiError,
  rankBetween,
  relationConfigOf,
  rollupConfigOf,
  type BlockPayload,
  type BlockType,
  type DataSource,
  type Id,
  type KumiCommands,
  type Page,
  type PropertyDef,
  type SelectOption,
} from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

let opCounter = 0;
const opId = (): string => `tpl-op-${++opCounter}`;

function ws(): KumiCommands {
  return tempWorkspace().commands;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

function insertBlock(
  c: KumiCommands,
  pageId: Id,
  id: Id,
  type: BlockType,
  payload: BlockPayload,
): void {
  const result = c.applyBlockOps([
    {
      opId: opId(),
      kind: "insert",
      block: {
        id,
        pageId,
        parentBlockId: null,
        rank: rankBetween(null, null),
        type,
        payload,
      },
    },
  ]);
  expect(result.rejected).toEqual([]);
}

function childNamed(c: KumiCommands, parentId: Id, title: string): Page {
  const node = c.listChildren(parentId).find((n) => n.page.title === title);
  if (node === undefined) throw new Error(`no child titled ${title}`);
  return node.page;
}

function propNamed(props: PropertyDef[], name: string): PropertyDef {
  const prop = props.find((p) => p.name === name);
  if (prop === undefined) throw new Error(`no property named ${name}`);
  return prop;
}

function onlyDataSource(c: KumiCommands, pageId: Id): DataSource {
  const list = c.listDataSources(pageId);
  const first = list[0];
  if (first === undefined) throw new Error(`no data source on ${pageId}`);
  return first;
}

describe("saveAsTemplate / listTemplates / deleteTemplate", () => {
  it("defaults the name to the page title and copies its icon", () => {
    const c = ws();
    const page = c.createPage({ title: "Weekly Review", icon: "🗓️" });

    const meta = c.saveAsTemplate(page.id);
    expect(meta.name).toBe("Weekly Review");
    expect(meta.icon).toBe("🗓️");
    expect(c.listTemplates().map((t) => t.id)).toEqual([meta.id]);
  });

  it("accepts an explicit name and falls back to Untitled", () => {
    const c = ws();
    const named = c.createPage({ title: "Whatever" });
    expect(c.saveAsTemplate(named.id, "  Meeting notes ").name).toBe("Meeting notes");

    const blank = c.createPage({ title: "" });
    expect(c.saveAsTemplate(blank.id).name).toBe("Untitled");
  });

  it("lists newest first and hard-deletes", () => {
    const c = ws();
    const page = c.createPage({ title: "T" });
    const first = c.saveAsTemplate(page.id, "one");
    const second = c.saveAsTemplate(page.id, "two");

    expect(c.listTemplates().map((t) => t.name)).toEqual(["two", "one"]);
    c.deleteTemplate(first.id);
    expect(c.listTemplates().map((t) => t.id)).toEqual([second.id]);
    expect(codeOf(() => c.deleteTemplate(first.id))).toBe("not_found");
  });

  it("refuses a trashed page and an unknown page", () => {
    const c = ws();
    const page = c.createPage({ title: "Gone" });
    c.trashPage(page.id);
    expect(codeOf(() => c.saveAsTemplate(page.id))).toBe("invalid");
    expect(codeOf(() => c.saveAsTemplate("nope"))).toBe("not_found");
  });
});

describe("instantiateTemplate: pages and blocks", () => {
  it("rebuilds the subtree with all-fresh ids", () => {
    const c = ws();
    const root = c.createPage({ title: "Root", icon: "📁" });
    const child = c.createPage({ title: "Child", parentId: root.id });
    c.createPage({ title: "Grandchild", parentId: child.id });
    insertBlock(c, root.id, "tpl-b1", "paragraph", {
      richText: [{ type: "text", text: "body" }],
    });

    const meta = c.saveAsTemplate(root.id);
    const copy = c.instantiateTemplate(meta.id);

    expect(copy.id).not.toBe(root.id);
    expect(copy.title).toBe("Root");
    expect(copy.icon).toBe("📁");
    expect(copy.parentId).toBeNull();

    const copiedChild = childNamed(c, copy.id, "Child");
    expect(copiedChild.id).not.toBe(child.id);
    expect(childNamed(c, copiedChild.id, "Grandchild")).toBeTruthy();

    const ids = c.getBlocks(copy.id).map((b) => b.id);
    expect(ids).not.toContain("tpl-b1");
    expect(c.getBlock("tpl-b1")?.pageId).toBe(root.id);
  });

  it("places the copy under parentId, appended last", () => {
    const c = ws();
    const root = c.createPage({ title: "Source" });
    const host = c.createPage({ title: "Host" });
    c.createPage({ title: "Existing", parentId: host.id });

    const meta = c.saveAsTemplate(root.id);
    const copy = c.instantiateTemplate(meta.id, host.id);

    expect(copy.parentId).toBe(host.id);
    expect(c.listChildren(host.id).map((n) => n.page.title)).toEqual([
      "Existing",
      "Source",
    ]);
  });

  it("treats null and undefined parents as the workspace root", () => {
    const c = ws();
    const root = c.createPage({ title: "R" });
    const meta = c.saveAsTemplate(root.id);

    expect(c.instantiateTemplate(meta.id, null).parentId).toBeNull();
    expect(c.instantiateTemplate(meta.id).parentId).toBeNull();
  });

  it("re-points child_page payloads and internal links at the copies", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    const child = c.createPage({ title: "Child", parentId: root.id });
    const outside = c.createPage({ title: "Outside" });

    insertBlock(c, root.id, "tpl-cp", "child_page", { pageId: child.id });
    insertBlock(c, root.id, "tpl-in", "paragraph", {
      richText: [{ type: "text", text: "in", href: `kumi://page/${child.id}` }],
    });
    insertBlock(c, root.id, "tpl-out", "paragraph", {
      richText: [{ type: "text", text: "out", href: `kumi://page/${outside.id}` }],
    });
    insertBlock(c, root.id, "tpl-men", "paragraph", {
      richText: [{ type: "mention", mention: { kind: "page", pageId: child.id } }],
    });

    const meta = c.saveAsTemplate(root.id);
    const copy = c.instantiateTemplate(meta.id);
    const copiedChild = childNamed(c, copy.id, "Child");
    const blocks = c.getBlocks(copy.id);

    const childPage = blocks.find((b) => b.type === "child_page");
    expect(childPage?.payload.pageId).toBe(copiedChild.id);

    const hrefs = blocks.flatMap((b) =>
      (b.payload.richText ?? []).flatMap((span) =>
        span.type === "text" && span.href !== undefined ? [span.href] : [],
      ),
    );
    expect(hrefs).toContain(`kumi://page/${copiedChild.id}`);
    // A link out of the template still names the page it always named.
    expect(hrefs).toContain(`kumi://page/${outside.id}`);

    const mentions = blocks.flatMap((b) =>
      (b.payload.richText ?? []).flatMap((span) =>
        span.type === "mention" && span.mention.kind === "page"
          ? [span.mention.pageId]
          : [],
      ),
    );
    expect(mentions).toEqual([copiedChild.id]);
    // The copies' links are indexed, so backlinks work immediately.
    expect(c.getBacklinks(copiedChild.id).length).toBeGreaterThan(0);
  });

  it("indexes the copies for search", () => {
    const c = ws();
    const root = c.createPage({ title: "Recipe" });
    insertBlock(c, root.id, "tpl-s1", "paragraph", {
      richText: [{ type: "text", text: "marjoram" }],
    });
    const meta = c.saveAsTemplate(root.id);
    const copy = c.instantiateTemplate(meta.id);

    expect(c.search("marjoram").map((r) => r.pageId).sort()).toEqual(
      [root.id, copy.id].sort(),
    );
  });

  it("rejects an unknown template and a trashed parent", () => {
    const c = ws();
    const root = c.createPage({ title: "R" });
    const meta = c.saveAsTemplate(root.id);
    const host = c.createPage({ title: "Host" });
    c.trashPage(host.id);

    expect(codeOf(() => c.instantiateTemplate("nope"))).toBe("not_found");
    expect(codeOf(() => c.instantiateTemplate(meta.id, host.id))).toBe("invalid");
  });

  it("skips trashed descendants", () => {
    const c = ws();
    const root = c.createPage({ title: "Root" });
    c.createPage({ title: "Kept", parentId: root.id });
    const dropped = c.createPage({ title: "Dropped", parentId: root.id });
    c.trashPage(dropped.id);

    const copy = c.instantiateTemplate(c.saveAsTemplate(root.id).id);
    expect(c.listChildren(copy.id).map((n) => n.page.title)).toEqual(["Kept"]);
  });
});

describe("instantiateTemplate: databases", () => {
  /**
   * Root
   *  ├─ Tasks   — data source "Tasks"   (Status select, Owner relation → People)
   *  └─ People  — data source "People"  (paired "Tasks" reverse relation)
   * Outside     — data source "Vendors" (a relation target NOT in the template)
   */
  function fixture(c: KumiCommands) {
    const root = c.createPage({ title: "Root" });
    const tasksPage = c.createPage({ title: "Tasks", parentId: root.id });
    const peoplePage = c.createPage({ title: "People", parentId: root.id });
    const outsidePage = c.createPage({ title: "Outside" });

    const tasks = c.createDataSource(tasksPage.id, "Tasks").dataSource;
    const people = c.createDataSource(peoplePage.id, "People").dataSource;
    const vendors = c.createDataSource(outsidePage.id, "Vendors").dataSource;

    const status = c.addProperty(tasks.id, {
      name: "Status",
      type: "select",
      // Option ids are minted by normalizeConfig; that is what this test wants.
      config: {
        options: [
          { name: "Todo", color: "gray" } as SelectOption,
          { name: "Done", color: "green" } as SelectOption,
        ],
      },
    });
    const owner = c.addProperty(tasks.id, {
      name: "Owner",
      type: "relation",
      config: {
        relation: { dataSourceId: people.id, pairedPropertyId: null },
        createPaired: { name: "Assigned" },
      },
    });
    const supplier = c.addProperty(tasks.id, {
      name: "Supplier",
      type: "relation",
      config: { relation: { dataSourceId: vendors.id, pairedPropertyId: null } },
    });
    const peopleCount = c.addProperty(people.id, {
      name: "Task count",
      type: "rollup",
      config: {
        rollup: {
          relationPropertyId: propNamed(
            c.getDataSource(people.id)?.properties ?? [],
            "Assigned",
          ).id,
          targetPropertyId: null,
          aggregation: "count",
        },
      },
    });

    const titleOfPeople = propNamed(c.getDataSource(people.id)?.properties ?? [], "Name");
    const alice = c.createRow(people.id, {
      [titleOfPeople.id]: { type: "title", richText: [{ type: "text", text: "Alice" }] },
    });
    const acme = c.createRow(vendors.id);
    const titleOfTasks = propNamed(c.getDataSource(tasks.id)?.properties ?? [], "Name");
    const todo = c.getDataSource(tasks.id)?.properties ?? [];
    const statusOptions = propNamed(todo, "Status").config.options ?? [];
    const task = c.createRow(tasks.id, {
      [titleOfTasks.id]: { type: "title", richText: [{ type: "text", text: "Ship it" }] },
      [status.id]: { type: "select", optionId: statusOptions[1]?.id ?? "" },
      [owner.id]: { type: "relation", pageIds: [alice.page.id] },
      [supplier.id]: { type: "relation", pageIds: [acme.page.id] },
    });

    return {
      root,
      tasksPage,
      peoplePage,
      tasks,
      people,
      vendors,
      status,
      owner,
      supplier,
      peopleCount,
      alice,
      acme,
      task,
      doneOptionId: statusOptions[1]?.id ?? "",
    };
  }

  it("copies schema, views, rows and cells with fresh ids", () => {
    const c = ws();
    const f = fixture(c);
    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);

    const copiedTasks = onlyDataSource(c, childNamed(c, copy.id, "Tasks").id);
    expect(copiedTasks.id).not.toBe(f.tasks.id);
    expect(copiedTasks.title).toBe("Tasks");

    const schema = c.getDataSource(copiedTasks.id);
    expect(schema?.properties.map((p) => p.name)).toEqual([
      "Name",
      "Status",
      "Owner",
      "Supplier",
    ]);
    expect(schema?.properties.map((p) => p.id)).not.toContain(f.status.id);
    expect(schema?.views).toHaveLength(1);
    expect(schema?.views[0]?.name).toBe("Table");

    const rows = c.queryDataSource(copiedTasks.id).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.page.id).not.toBe(f.task.page.id);
    expect(rows[0]?.page.title).toBe("Ship it");
    // The original database is untouched.
    expect(c.queryDataSource(f.tasks.id).rows).toHaveLength(1);
  });

  it("remaps select option ids consistently between schema and cells", () => {
    const c = ws();
    const f = fixture(c);
    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);

    const copiedTasks = onlyDataSource(c, childNamed(c, copy.id, "Tasks").id);
    const status = propNamed(c.getDataSource(copiedTasks.id)?.properties ?? [], "Status");
    const options = status.config.options ?? [];
    expect(options.map((o) => o.name)).toEqual(["Todo", "Done"]);
    expect(options.map((o) => o.id)).not.toContain(f.doneOptionId);

    const value = c.queryDataSource(copiedTasks.id).rows[0]?.values[status.id];
    expect(value?.type).toBe("select");
    expect(value?.type === "select" ? value.optionId : "").toBe(options[1]?.id);
  });

  it("keeps a paired relation paired between the copies", () => {
    const c = ws();
    const f = fixture(c);
    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);

    const copiedTasks = onlyDataSource(c, childNamed(c, copy.id, "Tasks").id);
    const copiedPeople = onlyDataSource(c, childNamed(c, copy.id, "People").id);
    const owner = propNamed(c.getDataSource(copiedTasks.id)?.properties ?? [], "Owner");
    const assigned = propNamed(
      c.getDataSource(copiedPeople.id)?.properties ?? [],
      "Assigned",
    );

    const ownerConfig = relationConfigOf(owner.config);
    expect(ownerConfig?.dataSourceId).toBe(copiedPeople.id);
    expect(ownerConfig?.pairedPropertyId).toBe(assigned.id);
    const assignedConfig = relationConfigOf(assigned.config);
    expect(assignedConfig?.dataSourceId).toBe(copiedTasks.id);
    expect(assignedConfig?.pairedPropertyId).toBe(owner.id);

    // The copied cell points at the copied row, not the original.
    const copiedTask = c.queryDataSource(copiedTasks.id).rows[0];
    const copiedAlice = c.queryDataSource(copiedPeople.id).rows[0];
    const ownerValue = copiedTask?.values[owner.id];
    expect(ownerValue?.type === "relation" ? ownerValue.pageIds : []).toEqual([
      copiedAlice?.page.id,
    ]);
    const assignedValue = copiedAlice?.values[assigned.id];
    expect(assignedValue?.type === "relation" ? assignedValue.pageIds : []).toEqual([
      copiedTask?.page.id,
    ]);

    // …and the pairing still works when the copy is edited.
    const second = c.createRow(copiedPeople.id);
    c.setPropertyValues(copiedTask?.page.id ?? "", {
      [owner.id]: { type: "relation", pageIds: [second.page.id] },
    });
    const back = c.getRow(second.page.id)?.values[assigned.id];
    expect(back?.type === "relation" ? back.pageIds : []).toEqual([
      copiedTask?.page.id,
    ]);
    // The original database never moved.
    const originalBack = c.getRow(f.alice.page.id);
    expect(originalBack).toBeTruthy();
  });

  it("keeps a relation that points outside the template pointing there", () => {
    const c = ws();
    const f = fixture(c);
    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);

    const copiedTasks = onlyDataSource(c, childNamed(c, copy.id, "Tasks").id);
    const supplier = propNamed(
      c.getDataSource(copiedTasks.id)?.properties ?? [],
      "Supplier",
    );
    const config = relationConfigOf(supplier.config);
    expect(config?.dataSourceId).toBe(f.vendors.id);
    // The far side points at the ORIGINAL data source, so the copy is one-way.
    expect(config?.pairedPropertyId).toBeNull();

    const value = c.queryDataSource(copiedTasks.id).rows[0]?.values[supplier.id];
    expect(value?.type === "relation" ? value.pageIds : []).toEqual([f.acme.page.id]);
  });

  it("remaps a rollup onto the copied relation and computes over the copies", () => {
    const c = ws();
    const f = fixture(c);
    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);

    const copiedPeople = onlyDataSource(c, childNamed(c, copy.id, "People").id);
    const props = c.getDataSource(copiedPeople.id)?.properties ?? [];
    const rollup = propNamed(props, "Task count");
    const assigned = propNamed(props, "Assigned");

    const config = rollupConfigOf(rollup.config);
    expect(config?.relationPropertyId).toBe(assigned.id);
    expect(config?.relationPropertyId).not.toBe(f.peopleCount.id);

    const value = c.queryDataSource(copiedPeople.id).rows[0]?.values[rollup.id];
    expect(value?.type === "rollup" ? value.number : null).toBe(1);
  });

  it("produces independent copies on every instantiation", () => {
    const c = ws();
    const f = fixture(c);
    const meta = c.saveAsTemplate(f.root.id);

    const first = c.instantiateTemplate(meta.id);
    const second = c.instantiateTemplate(meta.id);
    expect(first.id).not.toBe(second.id);

    const firstTasks = onlyDataSource(c, childNamed(c, first.id, "Tasks").id);
    const secondTasks = onlyDataSource(c, childNamed(c, second.id, "Tasks").id);
    expect(firstTasks.id).not.toBe(secondTasks.id);

    const firstRow = c.queryDataSource(firstTasks.id).rows[0];
    const secondRow = c.queryDataSource(secondTasks.id).rows[0];
    expect(firstRow?.page.id).not.toBe(secondRow?.page.id);

    c.createRow(firstTasks.id);
    expect(c.queryDataSource(firstTasks.id).total).toBe(2);
    expect(c.queryDataSource(secondTasks.id).total).toBe(1);
    expect(c.queryDataSource(f.tasks.id).total).toBe(1);
  });

  it("re-points a child_database block at the copied data source and view", () => {
    const c = ws();
    const f = fixture(c);
    const view = c.getDataSource(f.tasks.id)?.views[0];
    insertBlock(c, f.tasksPage.id, "tpl-db", "child_database", {
      dataSourceId: f.tasks.id,
      activeViewId: view?.id,
    });

    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);
    const copiedTasksPage = childNamed(c, copy.id, "Tasks");
    const copiedTasks = onlyDataSource(c, copiedTasksPage.id);
    const block = c
      .getBlocks(copiedTasksPage.id)
      .find((b) => b.type === "child_database");

    expect(block?.payload.dataSourceId).toBe(copiedTasks.id);
    expect(block?.payload.activeViewId).toBe(
      c.getDataSource(copiedTasks.id)?.views[0]?.id,
    );
  });

  it("remaps view sorts, grouping and filters onto the copied schema", () => {
    const c = ws();
    const f = fixture(c);
    const view = c.getDataSource(f.tasks.id)?.views[0];
    c.updateView(view?.id ?? "", {
      config: {
        sorts: [{ propertyId: f.status.id, direction: "asc" }],
        groupByPropertyId: f.status.id,
        visibleProperties: [f.status.id],
        propertyWidths: { [f.status.id]: 220 },
        filter: {
          kind: "group",
          op: "and",
          children: [
            { kind: "condition", propertyId: f.status.id, op: "equals", value: f.doneOptionId },
          ],
        },
      },
    });

    const copy = c.instantiateTemplate(c.saveAsTemplate(f.root.id).id);
    const copiedTasks = onlyDataSource(c, childNamed(c, copy.id, "Tasks").id);
    const schema = c.getDataSource(copiedTasks.id);
    const status = propNamed(schema?.properties ?? [], "Status");
    const config = schema?.views[0]?.config;

    expect(config?.sorts[0]?.propertyId).toBe(status.id);
    expect(config?.groupByPropertyId).toBe(status.id);
    expect(config?.visibleProperties).toEqual([status.id]);
    expect(config?.propertyWidths[status.id]).toBe(220);
    const condition = config?.filter?.children[0];
    expect(condition?.kind === "condition" ? condition.propertyId : "").toBe(status.id);
    expect(condition?.kind === "condition" ? condition.value : "").toBe(
      (status.config.options ?? [])[1]?.id,
    );
    // The filter still matches the copied row it was written for.
    expect(c.queryDataSource(copiedTasks.id, { filter: config?.filter }).total).toBe(1);
  });
});
