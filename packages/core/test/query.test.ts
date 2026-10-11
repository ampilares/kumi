import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KumiError,
  createCommands,
  openWorkspaceDb,
  withTransaction,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterOperator,
  type Id,
  type KumiCommands,
  type PropertyDef,
  type PropertyValue,
  type QueryOptions,
  type RollupAggregation,
  type RowRecord,
  type SelectOption,
} from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

function firstOf<T>(items: readonly T[], what: string): T {
  const value = items[0];
  if (value === undefined) throw new Error(`expected at least one ${what}`);
  return value;
}

const text = (value: string): PropertyValue => ({
  type: "text",
  richText: [{ type: "text", text: value }],
});

const titleValue = (value: string): PropertyValue => ({
  type: "title",
  richText: [{ type: "text", text: value }],
});

interface Schema {
  c: KumiCommands;
  dataSourceId: Id;
  title: PropertyDef;
  note: PropertyDef;
  count: PropertyDef;
  status: PropertyDef;
  tags: PropertyDef;
  due: PropertyDef;
  done: PropertyDef;
  site: PropertyDef;
}

/** A data source with one property of every Phase 4 type. */
function schema(): Schema {
  const c = tempWorkspace().commands;
  const page = c.createPage({ title: "DB" });
  const created = c.createDataSource(page.id, "Everything");
  const dataSourceId = created.dataSource.id;
  return {
    c,
    dataSourceId,
    title: firstOf(created.properties, "property"),
    note: c.addProperty(dataSourceId, { name: "Note", type: "text" }),
    count: c.addProperty(dataSourceId, { name: "Count", type: "number" }),
    status: c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      config: {
        options: [
          option("todo", "Todo"),
          option("doing", "Doing"),
          option("done", "Done"),
        ],
      },
    }),
    tags: c.addProperty(dataSourceId, {
      name: "Tags",
      type: "multi_select",
      config: {
        options: [
          option("red", "Red"),
          option("blue", "Blue"),
        ],
      },
    }),
    due: c.addProperty(dataSourceId, { name: "Due", type: "date" }),
    done: c.addProperty(dataSourceId, { name: "Done", type: "checkbox" }),
    site: c.addProperty(dataSourceId, { name: "Site", type: "url" }),
  };
}

const condition = (
  propertyId: Id,
  op: FilterOperator,
  value?: unknown,
): FilterCondition => ({ kind: "condition", propertyId, op, value });

/** A view/query filter is always a group; `only` wraps a single condition. */
const only = (propertyId: Id, op: FilterOperator, value?: unknown): FilterGroup => ({
  kind: "group",
  op: "and",
  children: [condition(propertyId, op, value)],
});

const option = (id: Id, name: string, color = "default"): SelectOption => ({
  id,
  name,
  color,
});

function titlesOf(rows: RowRecord[]): string[] {
  return rows.map((row) => row.page.title);
}

function query(s: Schema, opts: QueryOptions): string[] {
  return titlesOf(s.c.queryDataSource(s.dataSourceId, opts).rows);
}

// ---------------------------------------------------------------------------

describe("filters", () => {
  function seeded(): Schema {
    const s = schema();
    s.c.createRow(s.dataSourceId, {
      [s.title.id]: titleValue("Alpha"),
      [s.note.id]: text("first note"),
      [s.count.id]: { type: "number", number: 1 },
      [s.status.id]: { type: "select", optionId: "todo" },
      [s.tags.id]: { type: "multi_select", optionIds: ["red"] },
      [s.due.id]: { type: "date", start: "2024-01-01" },
      [s.done.id]: { type: "checkbox", checked: true },
      [s.site.id]: { type: "url", value: "https://alpha.example.com" },
    });
    s.c.createRow(s.dataSourceId, {
      [s.title.id]: titleValue("Beta"),
      [s.note.id]: text("second NOTE"),
      [s.count.id]: { type: "number", number: 10 },
      [s.status.id]: { type: "select", optionId: "done" },
      [s.tags.id]: { type: "multi_select", optionIds: ["red", "blue"] },
      [s.due.id]: { type: "date", start: "2024-06-15T08:00:00Z" },
      [s.site.id]: { type: "url", value: "http://beta.test" },
    });
    s.c.createRow(s.dataSourceId, { [s.title.id]: titleValue("Gamma") });
    return s;
  }

  it("equals / not_equals on text and title", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.title.id, "equals", "alpha") })).toEqual([
      "Alpha",
    ]);
    expect(
      query(s, { filter: only(s.note.id, "not_equals", "first note") }),
    ).toEqual(["Beta", "Gamma"]);
  });

  it("equals on number, checkbox, select, multi_select and date", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.count.id, "equals", 10) })).toEqual([
      "Beta",
    ]);
    expect(query(s, { filter: only(s.done.id, "equals", true) })).toEqual([
      "Alpha",
    ]);
    expect(query(s, { filter: only(s.done.id, "equals", false) })).toEqual([
      "Beta",
      "Gamma",
    ]);
    expect(query(s, { filter: only(s.status.id, "equals", "done") })).toEqual([
      "Beta",
    ]);
    expect(
      query(s, { filter: only(s.tags.id, "equals", ["blue", "red"]) }),
    ).toEqual(["Beta"]);
    expect(query(s, { filter: only(s.tags.id, "equals", "red") })).toEqual([
      "Alpha",
    ]);
    expect(
      query(s, { filter: only(s.due.id, "equals", "2024-01-01") }),
    ).toEqual(["Alpha"]);
  });

  it("contains / not_contains on text, url and multi_select", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.note.id, "contains", "note") })).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(
      query(s, { filter: only(s.note.id, "not_contains", "first") }),
    ).toEqual(["Beta", "Gamma"]);
    expect(query(s, { filter: only(s.site.id, "contains", "beta") })).toEqual([
      "Beta",
    ]);
    expect(query(s, { filter: only(s.tags.id, "contains", "blue") })).toEqual([
      "Beta",
    ]);
    expect(
      query(s, { filter: only(s.tags.id, "not_contains", "blue") }),
    ).toEqual(["Alpha", "Gamma"]);
  });

  it("starts_with / ends_with are case-insensitive", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.title.id, "starts_with", "al") })).toEqual([
      "Alpha",
    ]);
    expect(query(s, { filter: only(s.title.id, "ends_with", "TA") })).toEqual([
      "Beta",
    ]);
    expect(
      query(s, { filter: only(s.site.id, "starts_with", "https://") }),
    ).toEqual(["Alpha"]);
  });

  it("is_empty / is_not_empty for every type", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.note.id, "is_empty") })).toEqual(["Gamma"]);
    expect(query(s, { filter: only(s.count.id, "is_not_empty") })).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(query(s, { filter: only(s.tags.id, "is_empty") })).toEqual(["Gamma"]);
    expect(query(s, { filter: only(s.due.id, "is_empty") })).toEqual(["Gamma"]);
    // An unchecked checkbox is empty.
    expect(query(s, { filter: only(s.done.id, "is_empty") })).toEqual([
      "Beta",
      "Gamma",
    ]);
    expect(query(s, { filter: only(s.title.id, "is_not_empty") })).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("numeric comparisons", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.count.id, "gt", 1) })).toEqual(["Beta"]);
    expect(query(s, { filter: only(s.count.id, "gte", 1) })).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(query(s, { filter: only(s.count.id, "lt", 10) })).toEqual(["Alpha"]);
    expect(query(s, { filter: only(s.count.id, "lte", 10) })).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("date comparisons compare the start instant", () => {
    const s = seeded();
    expect(query(s, { filter: only(s.due.id, "before", "2024-06-15") })).toEqual([
      "Alpha",
    ]);
    expect(query(s, { filter: only(s.due.id, "after", "2024-01-01") })).toEqual([
      "Beta",
    ]);
    expect(
      query(s, { filter: only(s.due.id, "on_or_after", "2024-01-01") }),
    ).toEqual(["Alpha", "Beta"]);
    expect(
      query(s, { filter: only(s.due.id, "on_or_before", "2024-01-01") }),
    ).toEqual(["Alpha"]);
  });

  it("evaluates nested and/or trees", () => {
    const s = seeded();
    const filter: FilterNode = {
      kind: "group",
      op: "and",
      children: [
        condition(s.title.id, "is_not_empty"),
        {
          kind: "group",
          op: "or",
          children: [
            condition(s.count.id, "gte", 10),
            condition(s.status.id, "equals", "todo"),
          ],
        },
      ],
    };
    expect(query(s, { filter })).toEqual(["Alpha", "Beta"]);

    const negated: FilterNode = {
      kind: "group",
      op: "and",
      children: [
        { kind: "group", op: "or", children: [condition(s.tags.id, "contains", "red")] },
        condition(s.done.id, "equals", false),
      ],
    };
    expect(query(s, { filter: negated })).toEqual(["Beta"]);
  });

  it("treats an empty group as the identity of its operator", () => {
    const s = seeded();
    expect(query(s, { filter: { kind: "group", op: "and", children: [] } })).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(query(s, { filter: { kind: "group", op: "or", children: [] } })).toEqual([]);
  });

  it("throws on unknown property ids, wrong operators and bad operands", () => {
    const s = seeded();
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only("nope", "equals", "x"),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only(s.count.id, "starts_with", "1"),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only(s.done.id, "gt", 1),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only(s.count.id, "equals", "10"),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only(s.due.id, "before", "15/06/2024"),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          filter: only(s.status.id, "equals", "ghost"),
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() => s.c.queryDataSource("unknown-data-source")),
    ).toBe("not_found");
  });
});

describe("sorts", () => {
  function ranked(): Schema {
    const s = schema();
    const rows: [string, number | null, string | null, string | null, boolean][] = [
      ["delta", 2, "doing", "2024-03-01", false],
      ["Alpha", null, null, null, true],
      ["charlie", 2, "todo", "2024-01-01", false],
      ["Bravo", 10, "done", "2024-02-01", true],
    ];
    for (const [name, count, status, due, done] of rows) {
      const values: Record<Id, PropertyValue> = {
        [s.title.id]: titleValue(name),
        [s.done.id]: { type: "checkbox", checked: done },
      };
      if (count !== null) values[s.count.id] = { type: "number", number: count };
      if (status !== null) values[s.status.id] = { type: "select", optionId: status };
      if (due !== null) values[s.due.id] = { type: "date", start: due };
      s.c.createRow(s.dataSourceId, values);
    }
    return s;
  }

  it("sorts text case-insensitively", () => {
    const s = ranked();
    expect(query(s, { sorts: [{ propertyId: s.title.id, direction: "asc" }] })).toEqual(
      ["Alpha", "Bravo", "charlie", "delta"],
    );
    expect(
      query(s, { sorts: [{ propertyId: s.title.id, direction: "desc" }] }),
    ).toEqual(["delta", "charlie", "Bravo", "Alpha"]);
  });

  it("sorts numbers numerically and dates chronologically", () => {
    const s = ranked();
    expect(query(s, { sorts: [{ propertyId: s.count.id, direction: "asc" }] })).toEqual(
      ["delta", "charlie", "Bravo", "Alpha"],
    );
    expect(query(s, { sorts: [{ propertyId: s.due.id, direction: "desc" }] })).toEqual([
      "delta",
      "Bravo",
      "charlie",
      "Alpha",
    ]);
  });

  it("sorts selects by option order, not by name", () => {
    const s = ranked();
    expect(
      query(s, { sorts: [{ propertyId: s.status.id, direction: "asc" }] }),
    ).toEqual(["charlie", "delta", "Bravo", "Alpha"]);
  });

  it("sorts checkbox false before true and has no missing state", () => {
    const s = ranked();
    expect(query(s, { sorts: [{ propertyId: s.done.id, direction: "asc" }] })).toEqual([
      "delta",
      "charlie",
      "Alpha",
      "Bravo",
    ]);
  });

  it("puts missing values last in both directions", () => {
    const s = ranked();
    const asc = query(s, { sorts: [{ propertyId: s.count.id, direction: "asc" }] });
    const desc = query(s, { sorts: [{ propertyId: s.count.id, direction: "desc" }] });
    expect(asc[asc.length - 1]).toBe("Alpha");
    expect(desc[desc.length - 1]).toBe("Alpha");
    expect(desc.slice(0, 3)).toEqual(["Bravo", "delta", "charlie"]);
  });

  it("is stable: ties keep row order, and extra keys break them", () => {
    const s = ranked();
    // delta and charlie both have Count 2 and keep their insertion order.
    expect(
      query(s, { sorts: [{ propertyId: s.count.id, direction: "asc" }] }).slice(0, 2),
    ).toEqual(["delta", "charlie"]);
    expect(
      query(s, {
        sorts: [
          { propertyId: s.count.id, direction: "asc" },
          { propertyId: s.title.id, direction: "asc" },
        ],
      }).slice(0, 2),
    ).toEqual(["charlie", "delta"]);
  });

  it("throws on an unknown sort property", () => {
    const s = ranked();
    expect(
      codeOf(() =>
        s.c.queryDataSource(s.dataSourceId, {
          sorts: [{ propertyId: "nope", direction: "asc" }],
        }),
      ),
    ).toBe("invalid");
  });
});

describe("pagination", () => {
  function many(count: number): Schema {
    const s = schema();
    for (let i = 0; i < count; i++) {
      s.c.createRow(s.dataSourceId, {
        [s.title.id]: titleValue(`Row ${String(i).padStart(3, "0")}`),
        [s.count.id]: { type: "number", number: i },
      });
    }
    return s;
  }

  it("reports the total ignoring limit and offset", () => {
    const s = many(25);
    const page = s.c.queryDataSource(s.dataSourceId, { limit: 5, offset: 10 });
    expect(page.total).toBe(25);
    expect(page.rows).toHaveLength(5);
    expect(titlesOf(page.rows)[0]).toBe("Row 010");
  });

  it("counts only matching rows in the total", () => {
    const s = many(25);
    const page = s.c.queryDataSource(s.dataSourceId, {
      filter: only(s.count.id, "gte", 20),
      limit: 2,
    });
    expect(page.total).toBe(5);
    expect(page.rows).toHaveLength(2);
  });

  it("clamps the limit to 1..500 and the offset to >= 0", () => {
    const s = many(3);
    expect(s.c.queryDataSource(s.dataSourceId, { limit: 0 }).rows).toHaveLength(1);
    expect(s.c.queryDataSource(s.dataSourceId, { limit: 9999 }).rows).toHaveLength(3);
    expect(s.c.queryDataSource(s.dataSourceId, { offset: -5 }).rows).toHaveLength(3);
    expect(s.c.queryDataSource(s.dataSourceId, { offset: 99 }).rows).toHaveLength(0);
  });

  it("defaults to 100 rows", () => {
    const s = many(120);
    const page = s.c.queryDataSource(s.dataSourceId);
    expect(page.rows).toHaveLength(100);
    expect(page.total).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// Relations and rollups
// ---------------------------------------------------------------------------

interface Related {
  c: KumiCommands;
  projects: Id;
  projectTitle: PropertyDef;
  taskTitle: PropertyDef;
  estimate: PropertyDef;
  due: PropertyDef;
  /** Projects → Tasks, one-way. */
  link: PropertyDef;
  total: PropertyDef;
  mean: PropertyDef;
  earliest: PropertyDef;
  originals: PropertyDef;
  task: Record<string, Id>;
}

/**
 * Three projects pointing at three tasks: Apollo → Design(3) + Build(5),
 * Borealis → Ship(1), Cygnus → nothing.
 */
function related(): Related {
  const c = tempWorkspace().commands;
  const home = c.createPage({ title: "Home" });
  const projectsDs = c.createDataSource(home.id, "Projects");
  const tasksDs = c.createDataSource(home.id, "Tasks");
  const projects = projectsDs.dataSource.id;
  const tasks = tasksDs.dataSource.id;

  const projectTitle = firstOf(projectsDs.properties, "property");
  const taskTitle = firstOf(tasksDs.properties, "property");
  const estimate = c.addProperty(tasks, { name: "Estimate", type: "number" });
  const due = c.addProperty(tasks, { name: "Due", type: "date" });
  const link = c.addProperty(projects, {
    name: "Tasks",
    type: "relation",
    config: { relation: { dataSourceId: tasks, pairedPropertyId: null } },
  });
  const rollup = (
    name: string,
    aggregation: RollupAggregation,
    targetPropertyId: Id | null,
  ): PropertyDef =>
    c.addProperty(projects, {
      name,
      type: "rollup",
      config: {
        rollup: { relationPropertyId: link.id, targetPropertyId, aggregation },
      },
    });
  const total = rollup("Total", "sum", estimate.id);
  const mean = rollup("Mean", "avg", estimate.id);
  const earliest = rollup("Earliest", "min", due.id);
  const originals = rollup("Estimates", "show_originals", estimate.id);

  const task = (name: string, points: number, dueDate: string): Id =>
    c.createRow(tasks, {
      [taskTitle.id]: titleValue(name),
      [estimate.id]: { type: "number", number: points },
      [due.id]: { type: "date", start: dueDate },
    }).page.id;
  const taskIds: Record<string, Id> = {
    design: task("Design", 3, "2024-03-01"),
    build: task("Build", 5, "2024-01-15"),
    ship: task("Ship", 1, "2024-08-20"),
  };

  const project = (name: string, pageIds: Id[]): void => {
    c.createRow(projects, {
      [projectTitle.id]: titleValue(name),
      [link.id]: { type: "relation", pageIds },
    });
  };
  project("Apollo", [taskIds.design ?? "", taskIds.build ?? ""]);
  project("Borealis", [taskIds.ship ?? ""]);
  project("Cygnus", []);

  return {
    c,
    projects,
    projectTitle,
    taskTitle,
    estimate,
    due,
    link,
    total,
    mean,
    earliest,
    originals,
    task: taskIds,
  };
}

function queryRelated(r: Related, opts: QueryOptions): string[] {
  return titlesOf(r.c.queryDataSource(r.projects, opts).rows);
}

describe("relation filters and sorts", () => {
  it("contains / not_contains take one related row page id", () => {
    const r = related();
    expect(
      queryRelated(r, { filter: only(r.link.id, "contains", r.task.build) }),
    ).toEqual(["Apollo"]);
    expect(
      queryRelated(r, { filter: only(r.link.id, "not_contains", r.task.build) }),
    ).toEqual(["Borealis", "Cygnus"]);
  });

  it("equals compares the set of related ids, order-independently", () => {
    const r = related();
    expect(
      queryRelated(r, {
        filter: only(r.link.id, "equals", [r.task.build, r.task.design]),
      }),
    ).toEqual(["Apollo"]);
    expect(
      queryRelated(r, { filter: only(r.link.id, "equals", r.task.ship) }),
    ).toEqual(["Borealis"]);
    expect(
      queryRelated(r, { filter: only(r.link.id, "not_equals", r.task.ship) }),
    ).toEqual(["Apollo", "Cygnus"]);
  });

  it("is_empty / is_not_empty follow the live related rows", () => {
    const r = related();
    expect(queryRelated(r, { filter: only(r.link.id, "is_empty") })).toEqual([
      "Cygnus",
    ]);
    expect(queryRelated(r, { filter: only(r.link.id, "is_not_empty") })).toEqual([
      "Apollo",
      "Borealis",
    ]);
    r.c.trashPage(r.task.ship ?? "");
    expect(queryRelated(r, { filter: only(r.link.id, "is_empty") })).toEqual([
      "Borealis",
      "Cygnus",
    ]);
  });

  it("rejects operators a relation cannot answer", () => {
    const r = related();
    for (const op of ["starts_with", "ends_with", "gt", "before"] as const) {
      expect(
        codeOf(() => queryRelated(r, { filter: only(r.link.id, op, "x") })),
      ).toBe("invalid");
    }
    expect(
      codeOf(() => queryRelated(r, { filter: only(r.link.id, "contains", 7) })),
    ).toBe("invalid");
  });

  it("cannot be sorted", () => {
    const r = related();
    expect(
      codeOf(() =>
        queryRelated(r, { sorts: [{ propertyId: r.link.id, direction: "asc" }] }),
      ),
    ).toBe("invalid");
  });
});

describe("rollup filters and sorts", () => {
  it("filters numeric aggregations numerically", () => {
    const r = related();
    expect(queryRelated(r, { filter: only(r.total.id, "equals", 8) })).toEqual([
      "Apollo",
    ]);
    expect(queryRelated(r, { filter: only(r.total.id, "gte", 1) })).toEqual([
      "Apollo",
      "Borealis",
    ]);
    expect(queryRelated(r, { filter: only(r.total.id, "lt", 8) })).toEqual([
      "Borealis",
      "Cygnus",
    ]);
    expect(queryRelated(r, { filter: only(r.total.id, "not_equals", 8) })).toEqual([
      "Borealis",
      "Cygnus",
    ]);
  });

  it("treats a null average as empty and a zero sum as a value", () => {
    const r = related();
    expect(queryRelated(r, { filter: only(r.mean.id, "is_empty") })).toEqual([
      "Cygnus",
    ]);
    expect(queryRelated(r, { filter: only(r.total.id, "is_empty") })).toEqual([]);
  });

  it("rejects every operator on date min/max and show_originals", () => {
    const r = related();
    expect(
      codeOf(() => queryRelated(r, { filter: only(r.earliest.id, "gt", 1) })),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        queryRelated(r, { filter: only(r.earliest.id, "after", "2024-01-01") }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() => queryRelated(r, { filter: only(r.originals.id, "is_empty") })),
    ).toBe("invalid");
    expect(
      codeOf(() => queryRelated(r, { filter: only(r.total.id, "contains", "8") })),
    ).toBe("invalid");
  });

  it("sorts numeric aggregations numerically", () => {
    const r = related();
    expect(
      queryRelated(r, { sorts: [{ propertyId: r.total.id, direction: "desc" }] }),
    ).toEqual(["Apollo", "Borealis", "Cygnus"]);
    // A null average sorts last in both directions.
    expect(
      queryRelated(r, { sorts: [{ propertyId: r.mean.id, direction: "asc" }] }),
    ).toEqual(["Borealis", "Apollo", "Cygnus"]);
  });

  it("sorts date min/max chronologically", () => {
    const r = related();
    expect(
      queryRelated(r, { sorts: [{ propertyId: r.earliest.id, direction: "asc" }] }),
    ).toEqual(["Apollo", "Borealis", "Cygnus"]);
    expect(
      queryRelated(r, { sorts: [{ propertyId: r.earliest.id, direction: "desc" }] }),
    ).toEqual(["Borealis", "Apollo", "Cygnus"]);
  });

  it("cannot sort by show_originals", () => {
    const r = related();
    expect(
      codeOf(() =>
        queryRelated(r, {
          sorts: [{ propertyId: r.originals.id, direction: "asc" }],
        }),
      ),
    ).toBe("invalid");
  });

  it("recomputes as related rows are trashed", () => {
    const r = related();
    r.c.trashPage(r.task.build ?? "");
    expect(queryRelated(r, { filter: only(r.total.id, "equals", 3) })).toEqual([
      "Apollo",
    ]);
  });
});

describe("query performance", () => {
  it("filters and sorts 5,000 rows x 4 properties in well under a second", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-perf-"));
    const db = openWorkspaceDb(dir);
    try {
      const c = createCommands(db);
      const page = c.createPage({ title: "Big" });
      const created = c.createDataSource(page.id, "Big");
      const dataSourceId = created.dataSource.id;
      const title = firstOf(created.properties, "property");
      const count = c.addProperty(dataSourceId, { name: "Count", type: "number" });
      const status = c.addProperty(dataSourceId, {
        name: "Status",
        type: "select",
        config: {
          options: [
            option("todo", "Todo"),
            option("done", "Done"),
          ],
        },
      });
      const due = c.addProperty(dataSourceId, { name: "Due", type: "date" });

      // One transaction for the whole seed; the measurement is the query.
      withTransaction(db, () => {
        for (let i = 0; i < 5000; i++) {
          c.createRow(dataSourceId, {
            [title.id]: titleValue(`Row ${i}`),
            [count.id]: { type: "number", number: i % 977 },
            [status.id]: { type: "select", optionId: i % 3 === 0 ? "done" : "todo" },
            [due.id]: {
              type: "date",
              start: `2024-${String((i % 12) + 1).padStart(2, "0")}-01`,
            },
          });
        }
      });

      const started = Date.now();
      const result = c.queryDataSource(dataSourceId, {
        filter: {
          kind: "group",
          op: "and",
          children: [
            condition(status.id, "equals", "todo"),
            condition(count.id, "gte", 100),
            {
              kind: "group",
              op: "or",
              children: [
                condition(title.id, "contains", "9"),
                condition(due.id, "after", "2024-06-01"),
              ],
            },
          ],
        },
        sorts: [
          { propertyId: count.id, direction: "desc" },
          { propertyId: title.id, direction: "asc" },
        ],
        limit: 50,
      });
      const elapsed = Date.now() - started;

      expect(result.total).toBeGreaterThan(500);
      expect(result.rows).toHaveLength(50);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filters and sorts a rollup over 2,000 related rows in under a second", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-perf-rollup-"));
    const db = openWorkspaceDb(dir);
    try {
      const c = createCommands(db);
      const home = c.createPage({ title: "Big" });
      const catalogDs = c.createDataSource(home.id, "Catalog");
      const ordersDs = c.createDataSource(home.id, "Orders");
      const catalog = catalogDs.dataSource.id;
      const orders = ordersDs.dataSource.id;
      const catalogTitle = firstOf(catalogDs.properties, "property");
      const orderTitle = firstOf(ordersDs.properties, "property");
      const price = c.addProperty(catalog, { name: "Price", type: "number" });
      const items = c.addProperty(orders, {
        name: "Items",
        type: "relation",
        config: { relation: { dataSourceId: catalog, pairedPropertyId: null } },
      });
      const total = c.addProperty(orders, {
        name: "Total",
        type: "rollup",
        config: {
          rollup: {
            relationPropertyId: items.id,
            targetPropertyId: price.id,
            aggregation: "sum",
          },
        },
      });

      // One transaction for the whole seed; the measurement is the query.
      const catalogIds: Id[] = [];
      withTransaction(db, () => {
        for (let i = 0; i < 100; i++) {
          catalogIds.push(
            c.createRow(catalog, {
              [catalogTitle.id]: titleValue(`Item ${i}`),
              [price.id]: { type: "number", number: i },
            }).page.id,
          );
        }
        for (let i = 0; i < 2000; i++) {
          const pick = [0, 1, 2].map(
            (offset) => catalogIds[(i * 7 + offset * 13) % 100] ?? "",
          );
          c.createRow(orders, {
            [orderTitle.id]: titleValue(`Order ${i}`),
            [items.id]: { type: "relation", pageIds: pick },
          });
        }
      });

      const started = Date.now();
      const result = c.queryDataSource(orders, {
        filter: only(total.id, "gte", 60),
        sorts: [
          { propertyId: total.id, direction: "desc" },
          { propertyId: orderTitle.id, direction: "asc" },
        ],
        limit: 50,
      });
      const elapsed = Date.now() - started;

      expect(result.total).toBeGreaterThan(100);
      expect(result.rows).toHaveLength(50);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
