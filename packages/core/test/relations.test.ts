import { afterAll, describe, expect, it } from "vitest";
import {
  KumiError,
  type Id,
  type KumiCommands,
  type PropertyDef,
  type PropertyValue,
  type RollupAggregation,
  type RowRecord,
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

function propertyNamed(
  c: KumiCommands,
  dataSourceId: Id,
  name: string,
): PropertyDef {
  const found = c
    .getDataSource(dataSourceId)
    ?.properties.find((prop) => prop.name === name);
  if (found === undefined) throw new Error(`no property named ${name}`);
  return found;
}

const titleValue = (value: string): PropertyValue => ({
  type: "title",
  richText: [{ type: "text", text: value }],
});

const relation = (pageIds: Id[]): PropertyValue => ({
  type: "relation",
  pageIds,
});

function relationIds(row: RowRecord | null, prop: PropertyDef): Id[] {
  const value = row?.values[prop.id];
  return value !== undefined && value.type === "relation" ? value.pageIds : [];
}

function rollupOf(row: RowRecord | null, prop: PropertyDef): PropertyValue {
  const value = row?.values[prop.id];
  if (value === undefined) throw new Error("expected a rollup value");
  return value;
}

/**
 * Two databases wired the way the desktop app wires them: Projects holds a
 * paired relation "Tasks" whose reverse side on Tasks is called "Project".
 */
interface Pair {
  c: KumiCommands;
  projects: Id;
  tasks: Id;
  projectTitle: PropertyDef;
  taskTitle: PropertyDef;
  estimate: PropertyDef;
  due: PropertyDef;
  status: PropertyDef;
  /** Projects → Tasks. */
  projectTasks: PropertyDef;
  /** Tasks → Projects (the created reverse side). */
  taskProject: PropertyDef;
}

function pair(): Pair {
  const c = tempWorkspace().commands;
  const home = c.createPage({ title: "Home" });
  const projectsDs = c.createDataSource(home.id, "Projects");
  const tasksDs = c.createDataSource(home.id, "Tasks");
  const projects = projectsDs.dataSource.id;
  const tasks = tasksDs.dataSource.id;

  const estimate = c.addProperty(tasks, { name: "Estimate", type: "number" });
  const due = c.addProperty(tasks, { name: "Due", type: "date" });
  const status = c.addProperty(tasks, {
    name: "Status",
    type: "select",
    config: {
      options: [
        { id: "todo", name: "Todo", color: "gray" },
        { id: "done", name: "Done", color: "green" },
      ],
    },
  });

  const projectTasks = c.addProperty(projects, {
    name: "Tasks",
    type: "relation",
    config: {
      relation: { dataSourceId: tasks, pairedPropertyId: null },
      createPaired: { name: "Project" },
    },
  });

  return {
    c,
    projects,
    tasks,
    projectTitle: firstOf(projectsDs.properties, "property"),
    taskTitle: firstOf(tasksDs.properties, "property"),
    estimate,
    due,
    status,
    projectTasks,
    taskProject: propertyNamed(c, tasks, "Project"),
  };
}

/** A one-way Projects → Tasks relation, with no reverse side. */
function oneWay(): Pair & { oneWayProp: PropertyDef } {
  const p = pair();
  return {
    ...p,
    oneWayProp: p.c.addProperty(p.projects, {
      name: "Watching",
      type: "relation",
      config: { relation: { dataSourceId: p.tasks, pairedPropertyId: null } },
    }),
  };
}

interface Seeded extends Pair {
  p1: Id;
  p2: Id;
  t1: Id;
  t2: Id;
  t3: Id;
}

/** Two projects, three tasks; nothing related yet. */
function seeded(): Seeded {
  const p = pair();
  const project = (name: string): Id =>
    p.c.createRow(p.projects, { [p.projectTitle.id]: titleValue(name) }).page.id;
  const task = (name: string, estimate: number | null, dueDate: string): Id =>
    p.c.createRow(p.tasks, {
      [p.taskTitle.id]: titleValue(name),
      [p.estimate.id]: { type: "number", number: estimate },
      [p.due.id]: { type: "date", start: dueDate },
      [p.status.id]: { type: "select", optionId: "todo" },
    }).page.id;

  return {
    ...p,
    p1: project("Apollo"),
    p2: project("Borealis"),
    t1: task("Design", 3, "2024-03-01"),
    t2: task("Build", 5, "2024-01-15"),
    t3: task("Ship", null, "2024-08-20"),
  };
}

// ---------------------------------------------------------------------------

describe("relation properties: creation and pairing", () => {
  it("createPaired builds the reverse relation and wires both sides", () => {
    const p = pair();
    expect(p.projectTasks.config.relation).toEqual({
      dataSourceId: p.tasks,
      pairedPropertyId: p.taskProject.id,
    });
    expect(p.taskProject.type).toBe("relation");
    expect(p.taskProject.config.relation).toEqual({
      dataSourceId: p.projects,
      pairedPropertyId: p.projectTasks.id,
    });
  });

  it("does not store the createPaired instruction in the config", () => {
    const p = pair();
    expect(p.projectTasks.config.createPaired).toBeUndefined();
  });

  it("rejects createPaired together with an explicit pairedPropertyId", () => {
    const p = pair();
    expect(
      codeOf(() =>
        p.c.addProperty(p.projects, {
          name: "More tasks",
          type: "relation",
          config: {
            relation: { dataSourceId: p.tasks, pairedPropertyId: p.taskProject.id },
            createPaired: { name: "Nope" },
          },
        }),
      ),
    ).toBe("invalid");
  });

  it("rejects a malformed createPaired", () => {
    const p = pair();
    for (const createPaired of [{ name: "" }, { name: 7 }, "Project"]) {
      expect(
        codeOf(() =>
          p.c.addProperty(p.projects, {
            name: `Rel ${String(Math.random())}`,
            type: "relation",
            config: {
              relation: { dataSourceId: p.tasks, pairedPropertyId: null },
              createPaired,
            },
          }),
        ),
      ).toBe("invalid");
    }
  });

  it("requires config.relation with an existing data source", () => {
    const p = pair();
    expect(
      codeOf(() => p.c.addProperty(p.projects, { name: "Bad", type: "relation" })),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        p.c.addProperty(p.projects, {
          name: "Bad",
          type: "relation",
          config: { relation: { dataSourceId: "missing-ds", pairedPropertyId: null } },
        }),
      ),
    ).toBe("not_found");
  });

  it("adopts an existing unpaired reverse relation named as the partner", () => {
    const p = pair();
    const loose = p.c.addProperty(p.tasks, {
      name: "Owner",
      type: "relation",
      config: { relation: { dataSourceId: p.projects, pairedPropertyId: null } },
    });
    const adopted = p.c.addProperty(p.projects, {
      name: "Owned tasks",
      type: "relation",
      config: { relation: { dataSourceId: p.tasks, pairedPropertyId: loose.id } },
    });
    expect(adopted.config.relation).toEqual({
      dataSourceId: p.tasks,
      pairedPropertyId: loose.id,
    });
    expect(propertyNamed(p.c, p.tasks, "Owner").config.relation).toEqual({
      dataSourceId: p.projects,
      pairedPropertyId: adopted.id,
    });
  });

  it("rejects a partner that is already paired, not a relation, or points elsewhere", () => {
    const p = pair();
    const alreadyPaired = codeOf(() =>
      p.c.addProperty(p.projects, {
        name: "Second",
        type: "relation",
        config: {
          relation: { dataSourceId: p.tasks, pairedPropertyId: p.taskProject.id },
        },
      }),
    );
    const notARelation = codeOf(() =>
      p.c.addProperty(p.projects, {
        name: "Third",
        type: "relation",
        config: { relation: { dataSourceId: p.tasks, pairedPropertyId: p.estimate.id } },
      }),
    );
    const wrongDataSource = codeOf(() =>
      p.c.addProperty(p.projects, {
        name: "Fourth",
        type: "relation",
        config: {
          relation: { dataSourceId: p.projects, pairedPropertyId: p.taskProject.id },
        },
      }),
    );
    expect([alreadyPaired, notARelation, wrongDataSource]).toEqual([
      "invalid",
      "invalid",
      "invalid",
    ]);
  });
});

describe("relation values", () => {
  it("writes and reads related rows in order", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t2, s.t1]) });
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t2, s.t1]);
  });

  it("collapses duplicates onto their first mention", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, {
      [s.projectTasks.id]: relation([s.t2, s.t1, s.t2, s.t1]),
    });
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t2, s.t1]);
  });

  it("rejects unknown, foreign and trashed target rows", () => {
    const s = seeded();
    const unknown = codeOf(() =>
      s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation(["nope"]) }),
    );
    // p2 is a row of Projects, not of the configured target Tasks.
    const foreign = codeOf(() =>
      s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.p2]) }),
    );
    s.c.trashPage(s.t3);
    const trashed = codeOf(() =>
      s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t3]) }),
    );
    expect([unknown, foreign, trashed]).toEqual(["invalid", "invalid", "invalid"]);
  });

  it("rejects a value whose variant is not a relation", () => {
    const s = seeded();
    expect(
      codeOf(() =>
        s.c.setPropertyValues(s.p1, {
          [s.projectTasks.id]: { type: "number", number: 1 },
        }),
      ),
    ).toBe("invalid");
  });

  it("accepts relation values at createRow", () => {
    const s = seeded();
    const row = s.c.createRow(s.projects, {
      [s.projectTitle.id]: titleValue("Cygnus"),
      [s.projectTasks.id]: relation([s.t1]),
    });
    expect(relationIds(row, s.projectTasks)).toEqual([s.t1]);
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([row.page.id]);
  });
});

describe("paired synchronisation", () => {
  it("makes the far side point back", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([s.p1]);
    expect(relationIds(s.c.getRow(s.t2), s.taskProject)).toEqual([s.p1]);
    expect(relationIds(s.c.getRow(s.t3), s.taskProject)).toEqual([]);
  });

  it("syncs from the reverse side too", () => {
    const s = seeded();
    s.c.setPropertyValues(s.t3, { [s.taskProject.id]: relation([s.p2]) });
    expect(relationIds(s.c.getRow(s.p2), s.projectTasks)).toEqual([s.t3]);
  });

  it("removes the back-reference when an id is dropped", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t2]) });
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([]);
    expect(relationIds(s.c.getRow(s.t2), s.taskProject)).toEqual([s.p1]);
  });

  it("clearing with null empties both sides", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: null });
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([]);
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([]);
    expect(relationIds(s.c.getRow(s.t2), s.taskProject)).toEqual([]);
  });

  it("keeps a many-to-many invariant across several rows", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    s.c.setPropertyValues(s.p2, { [s.projectTasks.id]: relation([s.t2, s.t3]) });
    expect(relationIds(s.c.getRow(s.t2), s.taskProject)).toEqual([s.p1, s.p2]);
    s.c.setPropertyValues(s.t2, { [s.taskProject.id]: relation([s.p2]) });
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t1]);
    expect(relationIds(s.c.getRow(s.p2), s.projectTasks)).toEqual([s.t2, s.t3]);
  });

  it("leaves a one-way relation with no back-reference", () => {
    const w = oneWay();
    const p1 = w.c.createRow(w.projects, {
      [w.projectTitle.id]: titleValue("Apollo"),
    }).page.id;
    const t1 = w.c.createRow(w.tasks, { [w.taskTitle.id]: titleValue("Design") })
      .page.id;
    w.c.setPropertyValues(p1, { [w.oneWayProp.id]: relation([t1]) });
    expect(relationIds(w.c.getRow(p1), w.oneWayProp)).toEqual([t1]);
    expect(relationIds(w.c.getRow(t1), w.taskProject)).toEqual([]);
  });
});

describe("self relations", () => {
  function selfSetup(): {
    c: KumiCommands;
    ds: Id;
    title: PropertyDef;
    blocks: PropertyDef;
  } {
    const c = tempWorkspace().commands;
    const home = c.createPage({ title: "Home" });
    const created = c.createDataSource(home.id, "Tasks");
    const ds = created.dataSource.id;
    return {
      c,
      ds,
      title: firstOf(created.properties, "property"),
      blocks: c.addProperty(ds, {
        name: "Blocks",
        type: "relation",
        config: { relation: { dataSourceId: ds, pairedPropertyId: null } },
      }),
    };
  }

  it("allows a one-way self relation", () => {
    const s = selfSetup();
    const a = s.c.createRow(s.ds, { [s.title.id]: titleValue("A") }).page.id;
    const b = s.c.createRow(s.ds, { [s.title.id]: titleValue("B") }).page.id;
    s.c.setPropertyValues(a, { [s.blocks.id]: relation([b]) });
    expect(relationIds(s.c.getRow(a), s.blocks)).toEqual([b]);
    expect(relationIds(s.c.getRow(b), s.blocks)).toEqual([]);
  });

  it("pairs a self relation with a second property on the same data source", () => {
    const s = selfSetup();
    const blockedBy = s.c.addProperty(s.ds, {
      name: "Blocked by",
      type: "relation",
      config: { relation: { dataSourceId: s.ds, pairedPropertyId: s.blocks.id } },
    });
    expect(blockedBy.id).not.toBe(s.blocks.id);
    const a = s.c.createRow(s.ds, { [s.title.id]: titleValue("A") }).page.id;
    const b = s.c.createRow(s.ds, { [s.title.id]: titleValue("B") }).page.id;
    s.c.setPropertyValues(a, { [blockedBy.id]: relation([b]) });
    expect(relationIds(s.c.getRow(b), s.blocks)).toEqual([a]);
  });

  it("createPaired on a self relation creates a distinct second property", () => {
    const s = selfSetup();
    const parent = s.c.addProperty(s.ds, {
      name: "Parent",
      type: "relation",
      config: {
        relation: { dataSourceId: s.ds, pairedPropertyId: null },
        createPaired: { name: "Children" },
      },
    });
    const children = propertyNamed(s.c, s.ds, "Children");
    expect(children.id).not.toBe(parent.id);
    expect(parent.config.relation).toEqual({
      dataSourceId: s.ds,
      pairedPropertyId: children.id,
    });
    const a = s.c.createRow(s.ds, { [s.title.id]: titleValue("A") }).page.id;
    const b = s.c.createRow(s.ds, { [s.title.id]: titleValue("B") }).page.id;
    s.c.setPropertyValues(a, { [parent.id]: relation([b]) });
    expect(relationIds(s.c.getRow(b), children)).toEqual([a]);
  });
});

describe("trashed rows", () => {
  it("disappear from relation reads and come back on restore", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    s.c.trashPage(s.t1);
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t2]);
    s.c.restorePage(s.t1);
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t1, s.t2]);
  });

  it("hide the whole relation when every target is trashed", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    s.c.trashPage(s.t1);
    expect(s.c.getRow(s.p1)?.values[s.projectTasks.id]).toBeUndefined();
    s.c.restorePage(s.t1);
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t1]);
  });

  it("drop out of the reverse side too", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    s.c.trashPage(s.p1);
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([]);
    s.c.restorePage(s.p1);
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([s.p1]);
  });
});

// ---------------------------------------------------------------------------

interface Rolled extends Seeded {
  rollup(
    aggregation: RollupAggregation,
    targetPropertyId: Id | null,
    relationPropertyId?: Id,
  ): PropertyDef;
}

function rolled(): Rolled {
  const s = seeded();
  let n = 0;
  return {
    ...s,
    rollup(aggregation, targetPropertyId, relationPropertyId): PropertyDef {
      n += 1;
      return s.c.addProperty(s.projects, {
        name: `Rollup ${aggregation} ${String(n)}`,
        type: "rollup",
        config: {
          rollup: {
            relationPropertyId: relationPropertyId ?? s.projectTasks.id,
            targetPropertyId,
            aggregation,
          },
        },
      });
    },
  };
}

describe("rollup configuration", () => {
  it("accepts every legal aggregation/target combination", () => {
    const r = rolled();
    expect(r.rollup("count", null).type).toBe("rollup");
    expect(r.rollup("count_values", r.estimate.id).type).toBe("rollup");
    expect(r.rollup("sum", r.estimate.id).type).toBe("rollup");
    expect(r.rollup("avg", r.estimate.id).type).toBe("rollup");
    expect(r.rollup("min", r.estimate.id).type).toBe("rollup");
    expect(r.rollup("max", r.due.id).type).toBe("rollup");
    expect(r.rollup("show_originals", r.status.id).type).toBe("rollup");
    expect(r.rollup("count_values", r.taskTitle.id).type).toBe("rollup");
  });

  it("requires config.rollup with a known aggregation", () => {
    const r = rolled();
    expect(
      codeOf(() => r.c.addProperty(r.projects, { name: "R", type: "rollup" })),
    ).toBe("invalid");
    expect(
      codeOf(() => r.rollup("median" as RollupAggregation, r.estimate.id)),
    ).toBe("invalid");
  });

  it("requires the relation property to be a relation on the same data source", () => {
    const r = rolled();
    // A relation property that lives on the *related* data source.
    expect(codeOf(() => r.rollup("count", null, r.taskProject.id))).toBe("invalid");
    // Not a relation at all.
    expect(
      codeOf(() =>
        r.c.addProperty(r.projects, {
          name: "R",
          type: "rollup",
          config: {
            rollup: {
              relationPropertyId: r.projectTitle.id,
              targetPropertyId: null,
              aggregation: "count",
            },
          },
        }),
      ),
    ).toBe("invalid");
  });

  it("counts related rows and takes no target", () => {
    const r = rolled();
    expect(codeOf(() => r.rollup("count", r.estimate.id))).toBe("invalid");
  });

  it("requires a target for every other aggregation", () => {
    const r = rolled();
    const needsTarget: RollupAggregation[] = [
      "count_values",
      "sum",
      "avg",
      "min",
      "max",
      "show_originals",
    ];
    for (const aggregation of needsTarget) {
      expect(codeOf(() => r.rollup(aggregation, null))).toBe("invalid");
    }
  });

  it("restricts sum/avg to number targets and min/max to number or date", () => {
    const r = rolled();
    expect(codeOf(() => r.rollup("sum", r.due.id))).toBe("invalid");
    expect(codeOf(() => r.rollup("avg", r.status.id))).toBe("invalid");
    expect(codeOf(() => r.rollup("min", r.status.id))).toBe("invalid");
    expect(r.rollup("min", r.due.id).type).toBe("rollup");
  });

  it("requires the target to live on the related data source", () => {
    const r = rolled();
    expect(codeOf(() => r.rollup("count_values", r.projectTitle.id))).toBe(
      "invalid",
    );
  });

  it("refuses to chain: a rollup cannot aggregate a relation or another rollup", () => {
    const r = rolled();
    const inner = r.c.addProperty(r.tasks, {
      name: "Inner",
      type: "rollup",
      config: {
        rollup: {
          relationPropertyId: r.taskProject.id,
          targetPropertyId: null,
          aggregation: "count",
        },
      },
    });
    expect(codeOf(() => r.rollup("count_values", inner.id))).toBe("invalid");
    expect(codeOf(() => r.rollup("count_values", r.taskProject.id))).toBe(
      "invalid",
    );
  });
});

describe("rollup values", () => {
  function withTasks(): Rolled {
    const r = rolled();
    // Apollo: Design (3, 2024-03-01) and Build (5, 2024-01-15).
    r.c.setPropertyValues(r.p1, { [r.projectTasks.id]: relation([r.t1, r.t2]) });
    return r;
  }

  it("count counts related rows, including ones with no target value", () => {
    const r = withTasks();
    const count = r.rollup("count", null);
    r.c.setPropertyValues(r.p1, {
      [r.projectTasks.id]: relation([r.t1, r.t2, r.t3]),
    });
    expect(rollupOf(r.c.getRow(r.p1), count)).toEqual({
      type: "rollup",
      aggregation: "count",
      number: 3,
    });
  });

  it("count_values counts only non-empty target cells", () => {
    const r = withTasks();
    const countValues = r.rollup("count_values", r.estimate.id);
    r.c.setPropertyValues(r.p1, {
      [r.projectTasks.id]: relation([r.t1, r.t2, r.t3]),
    });
    expect(rollupOf(r.c.getRow(r.p1), countValues)).toEqual({
      type: "rollup",
      aggregation: "count_values",
      number: 2,
    });
  });

  it("sums numbers, and sums nothing to 0", () => {
    const r = withTasks();
    const sum = r.rollup("sum", r.estimate.id);
    expect(rollupOf(r.c.getRow(r.p1), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 8,
    });
    expect(rollupOf(r.c.getRow(r.p2), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 0,
    });
  });

  it("averages numbers, and averages nothing to null", () => {
    const r = withTasks();
    const avg = r.rollup("avg", r.estimate.id);
    expect(rollupOf(r.c.getRow(r.p1), avg)).toEqual({
      type: "rollup",
      aggregation: "avg",
      number: 4,
    });
    expect(rollupOf(r.c.getRow(r.p2), avg)).toEqual({
      type: "rollup",
      aggregation: "avg",
      number: null,
    });
  });

  it("min/max over numbers, null on an empty set", () => {
    const r = withTasks();
    const min = r.rollup("min", r.estimate.id);
    const max = r.rollup("max", r.estimate.id);
    expect(rollupOf(r.c.getRow(r.p1), min)).toEqual({
      type: "rollup",
      aggregation: "min",
      number: 3,
    });
    expect(rollupOf(r.c.getRow(r.p1), max)).toEqual({
      type: "rollup",
      aggregation: "max",
      number: 5,
    });
    expect(rollupOf(r.c.getRow(r.p2), min)).toEqual({
      type: "rollup",
      aggregation: "min",
      number: null,
    });
  });

  it("min/max over dates yield a date range, null on an empty set", () => {
    const r = withTasks();
    const min = r.rollup("min", r.due.id);
    const max = r.rollup("max", r.due.id);
    expect(rollupOf(r.c.getRow(r.p1), min)).toEqual({
      type: "rollup",
      aggregation: "min",
      date: { start: "2024-01-15", end: null },
    });
    expect(rollupOf(r.c.getRow(r.p1), max)).toEqual({
      type: "rollup",
      aggregation: "max",
      date: { start: "2024-03-01", end: null },
    });
    expect(rollupOf(r.c.getRow(r.p2), max)).toEqual({
      type: "rollup",
      aggregation: "max",
      date: null,
    });
  });

  it("show_originals keeps the relation order", () => {
    const r = rolled();
    const originals = r.rollup("show_originals", r.estimate.id);
    r.c.setPropertyValues(r.p1, { [r.projectTasks.id]: relation([r.t2, r.t1]) });
    expect(rollupOf(r.c.getRow(r.p1), originals)).toEqual({
      type: "rollup",
      aggregation: "show_originals",
      values: [
        { type: "number", number: 5 },
        { type: "number", number: 3 },
      ],
    });
    expect(rollupOf(r.c.getRow(r.p2), originals)).toEqual({
      type: "rollup",
      aggregation: "show_originals",
      values: [],
    });
  });

  it("rolls up titles of the related rows", () => {
    const r = withTasks();
    const originals = r.rollup("show_originals", r.taskTitle.id);
    expect(rollupOf(r.c.getRow(r.p1), originals)).toEqual({
      type: "rollup",
      aggregation: "show_originals",
      values: [
        { type: "title", richText: [{ type: "text", text: "Design" }] },
        { type: "title", richText: [{ type: "text", text: "Build" }] },
      ],
    });
  });

  it("counts only live related rows", () => {
    const r = withTasks();
    const sum = r.rollup("sum", r.estimate.id);
    const count = r.rollup("count", null);
    r.c.trashPage(r.t2);
    expect(rollupOf(r.c.getRow(r.p1), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 3,
    });
    expect(rollupOf(r.c.getRow(r.p1), count)).toEqual({
      type: "rollup",
      aggregation: "count",
      number: 1,
    });
    r.c.restorePage(r.t2);
    expect(rollupOf(r.c.getRow(r.p1), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 8,
    });
  });

  it("recomputes when the related cell changes — nothing is cached", () => {
    const r = withTasks();
    const sum = r.rollup("sum", r.estimate.id);
    r.c.setPropertyValues(r.t1, { [r.estimate.id]: { type: "number", number: 30 } });
    expect(rollupOf(r.c.getRow(r.p1), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 35,
    });
  });

  it("reads as empty when its relation property is removed", () => {
    const r = withTasks();
    const count = r.rollup("count", null);
    r.c.removeProperty(r.projectTasks.id);
    expect(rollupOf(r.c.getRow(r.p1), count)).toEqual({
      type: "rollup",
      aggregation: "count",
      number: 0,
    });
  });

  it("rejects writing a rollup value", () => {
    const r = withTasks();
    const sum = r.rollup("sum", r.estimate.id);
    expect(
      codeOf(() =>
        r.c.setPropertyValues(r.p1, {
          [sum.id]: { type: "rollup", aggregation: "sum", number: 99 },
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        r.c.setPropertyValues(r.p1, {
          [sum.id]: { type: "number", number: 99 },
        }),
      ),
    ).toBe("invalid");
    expect(codeOf(() => r.c.setPropertyValues(r.p1, { [sum.id]: null }))).toBe(
      "invalid",
    );
  });
});

describe("schema changes", () => {
  it("relation → text renders the related titles, other targets drop", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    const asText = s.c.updateProperty(s.projectTasks.id, { type: "text" });
    expect(asText.type).toBe("text");
    expect(s.c.getRow(s.p1)?.values[s.projectTasks.id]).toEqual({
      type: "text",
      richText: [{ type: "text", text: "Design, Build" }],
    });
    // …and the partner survives as a one-way relation, values intact.
    expect(propertyNamed(s.c, s.tasks, "Project").config.relation).toEqual({
      dataSourceId: s.projects,
      pairedPropertyId: null,
    });
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([s.p1]);
  });

  it("relation → number drops every cell", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    s.c.updateProperty(s.projectTasks.id, { type: "number" });
    expect(s.c.getRow(s.p1)?.values[s.projectTasks.id]).toBeUndefined();
  });

  it("anything → relation drops stored values and starts one-way", () => {
    const s = seeded();
    const note = s.c.addProperty(s.projects, { name: "Note", type: "text" });
    s.c.setPropertyValues(s.p1, {
      [note.id]: { type: "text", richText: [{ type: "text", text: "hi" }] },
    });
    const asRelation = s.c.updateProperty(note.id, {
      type: "relation",
      config: { relation: { dataSourceId: s.tasks, pairedPropertyId: null } },
    });
    expect(asRelation.config.relation).toEqual({
      dataSourceId: s.tasks,
      pairedPropertyId: null,
    });
    expect(s.c.getRow(s.p1)?.values[note.id]).toBeUndefined();
  });

  it("refuses to establish a pairing through updateProperty", () => {
    const s = seeded();
    const loose = s.c.addProperty(s.tasks, {
      name: "Owner",
      type: "relation",
      config: { relation: { dataSourceId: s.projects, pairedPropertyId: null } },
    });
    const note = s.c.addProperty(s.projects, { name: "Note", type: "text" });
    expect(
      codeOf(() =>
        s.c.updateProperty(note.id, {
          type: "relation",
          config: { relation: { dataSourceId: s.tasks, pairedPropertyId: loose.id } },
        }),
      ),
    ).toBe("invalid");
  });

  it("retargeting a relation drops its values and unpairs it", () => {
    const s = seeded();
    const others = s.c.createDataSource(
      s.c.createPage({ title: "Other" }).id,
      "Other",
    ).dataSource.id;
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    const retargeted = s.c.updateProperty(s.projectTasks.id, {
      config: { relation: { dataSourceId: others, pairedPropertyId: null } },
    });
    expect(retargeted.config.relation).toEqual({
      dataSourceId: others,
      pairedPropertyId: null,
    });
    expect(s.c.getRow(s.p1)?.values[s.projectTasks.id]).toBeUndefined();
    expect(propertyNamed(s.c, s.tasks, "Project").config.relation).toEqual({
      dataSourceId: s.projects,
      pairedPropertyId: null,
    });
  });

  it("unpairs when the config drops pairedPropertyId, keeping values", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    const unpaired = s.c.updateProperty(s.projectTasks.id, {
      config: { relation: { dataSourceId: s.tasks, pairedPropertyId: null } },
    });
    expect(unpaired.config.relation).toEqual({
      dataSourceId: s.tasks,
      pairedPropertyId: null,
    });
    expect(relationIds(s.c.getRow(s.p1), s.projectTasks)).toEqual([s.t1]);
    // Writes no longer touch the far side.
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t2]) });
    expect(relationIds(s.c.getRow(s.t1), s.taskProject)).toEqual([s.p1]);
  });

  it("a config patch replaces the whole config, so a relation must resend it", () => {
    const s = seeded();
    expect(
      codeOf(() => s.c.updateProperty(s.projectTasks.id, { config: {} })),
    ).toBe("invalid");
    // A rename leaves the config untouched.
    const renamed = s.c.updateProperty(s.projectTasks.id, { name: "Work items" });
    expect(renamed.config.relation).toEqual({
      dataSourceId: s.tasks,
      pairedPropertyId: s.taskProject.id,
    });
  });

  it("removing a paired relation leaves the partner one-way with its values", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) });
    s.c.removeProperty(s.projectTasks.id);
    const partner = propertyNamed(s.c, s.tasks, "Project");
    expect(partner.config.relation).toEqual({
      dataSourceId: s.projects,
      pairedPropertyId: null,
    });
    expect(relationIds(s.c.getRow(s.t1), partner)).toEqual([s.p1]);
  });

  it("rollup → number switches the definition and stores nothing", () => {
    const r = rolled();
    r.c.setPropertyValues(r.p1, { [r.projectTasks.id]: relation([r.t1]) });
    const sum = r.rollup("sum", r.estimate.id);
    const asNumber = r.c.updateProperty(sum.id, { type: "number", config: {} });
    expect(asNumber.type).toBe("number");
    expect(r.c.getRow(r.p1)?.values[sum.id]).toBeUndefined();
  });

  it("number → rollup drops the stored numbers", () => {
    const s = seeded();
    const spare = s.c.addProperty(s.projects, { name: "Spare", type: "number" });
    s.c.setPropertyValues(s.p1, { [spare.id]: { type: "number", number: 7 } });
    s.c.updateProperty(spare.id, {
      type: "rollup",
      config: {
        rollup: {
          relationPropertyId: s.projectTasks.id,
          targetPropertyId: null,
          aggregation: "count",
        },
      },
    });
    expect(s.c.getRow(s.p1)?.values[spare.id]).toEqual({
      type: "rollup",
      aggregation: "count",
      number: 0,
    });
  });
});

describe("deleteDataSource", () => {
  it("clears cross-data-source relation values and breaks the pairing", () => {
    const s = seeded();
    s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1, s.t2]) });
    s.c.deleteDataSource(s.tasks);

    const partner = propertyNamed(s.c, s.projects, "Tasks");
    expect(partner.config.relation).toEqual({
      dataSourceId: s.tasks,
      pairedPropertyId: null,
    });
    expect(s.c.getRow(s.p1)?.values[s.projectTasks.id]).toBeUndefined();
  });

  it("makes later writes to a dangling relation fail loudly", () => {
    const s = seeded();
    s.c.deleteDataSource(s.tasks);
    expect(
      codeOf(() =>
        s.c.setPropertyValues(s.p1, { [s.projectTasks.id]: relation([s.t1]) }),
      ),
    ).toBe("invalid");
  });

  it("leaves rollups over a deleted relation reading empty", () => {
    const r = rolled();
    r.c.setPropertyValues(r.p1, { [r.projectTasks.id]: relation([r.t1]) });
    const sum = r.rollup("sum", r.estimate.id);
    r.c.deleteDataSource(r.tasks);
    expect(rollupOf(r.c.getRow(r.p1), sum)).toEqual({
      type: "rollup",
      aggregation: "sum",
      number: 0,
    });
  });
});

describe("search", () => {
  it("indexes titles but never relation or rollup values", () => {
    const r = rolled();
    r.rollup("sum", r.estimate.id);
    r.c.setPropertyValues(r.p1, { [r.projectTasks.id]: relation([r.t1]) });
    // The related task is findable by its own title…
    expect(r.c.search("Design").map((hit) => hit.pageId)).toContain(r.t1);
    // …but the project that merely points at it is not.
    expect(r.c.search("Design").map((hit) => hit.pageId)).not.toContain(r.p1);
  });
});
