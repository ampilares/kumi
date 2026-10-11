import { afterAll, describe, expect, it } from "vitest";
import {
  KumiError,
  type Id,
  type KumiCommands,
  type PropertyDef,
  type PropertyValue,
  type SelectOption,
  type View,
} from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

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

function first<T>(items: readonly T[], what: string): T {
  const value = items[0];
  if (value === undefined) throw new Error(`expected at least one ${what}`);
  return value;
}

interface Fixture {
  c: KumiCommands;
  ownerPageId: Id;
  dataSourceId: Id;
  title: PropertyDef;
  view: View;
}

function fixture(): Fixture {
  const c = ws();
  const page = c.createPage({ title: "Tasks" });
  const created = c.createDataSource(page.id, "Task tracker");
  return {
    c,
    ownerPageId: page.id,
    dataSourceId: created.dataSource.id,
    title: first(created.properties, "property"),
    view: first(created.views, "view"),
  };
}

const option = (id: Id, name: string, color = "default"): SelectOption => ({
  id,
  name,
  color,
});

const text = (value: string): PropertyValue => ({
  type: "text",
  richText: [{ type: "text", text: value }],
});

const titleValue = (value: string): PropertyValue => ({
  type: "title",
  richText: [{ type: "text", text: value }],
});

// ---------------------------------------------------------------------------

describe("createDataSource", () => {
  it("creates a Name title property and one default table view", () => {
    const { c, dataSourceId, title, view } = fixture();
    expect(title.name).toBe("Name");
    expect(title.type).toBe("title");
    expect(view.name).toBe("Table");
    expect(view.type).toBe("table");
    expect(view.locked).toBe(false);
    expect(view.config).toEqual({
      filter: null,
      sorts: [],
      visibleProperties: null,
      propertyWidths: {},
      openMode: "center_peek",
    });
    expect(c.getDataSource(dataSourceId)?.dataSource.title).toBe("Task tracker");
  });

  it("lists several data sources per owner page and rejects unknown ids", () => {
    const { c, ownerPageId, dataSourceId } = fixture();
    const second = c.createDataSource(ownerPageId, "Notes");
    expect(c.listDataSources(ownerPageId).map((d) => d.id)).toEqual([
      dataSourceId,
      second.dataSource.id,
    ]);
    expect(c.getDataSource("nope")).toBeNull();
    expect(codeOf(() => c.renameDataSource("nope", "x"))).toBe("not_found");
  });

  it("renames a data source", () => {
    const { c, dataSourceId } = fixture();
    expect(c.renameDataSource(dataSourceId, "  Renamed  ").title).toBe("Renamed");
  });

  it("refuses a data source on a trashed page", () => {
    const c = ws();
    const page = c.createPage({ title: "Gone" });
    c.trashPage(page.id);
    expect(codeOf(() => c.createDataSource(page.id))).toBe("invalid");
  });
});

describe("properties", () => {
  it("appends, prepends and inserts after a named property", () => {
    const { c, dataSourceId, title } = fixture();
    const status = c.addProperty(dataSourceId, { name: "Status", type: "text" });
    const firstProp = c.addProperty(dataSourceId, {
      name: "First",
      type: "text",
      afterPropertyId: null,
    });
    const middle = c.addProperty(dataSourceId, {
      name: "Middle",
      type: "text",
      afterPropertyId: title.id,
    });
    const order = c.getDataSource(dataSourceId)?.properties.map((p) => p.id) ?? [];
    expect(order).toEqual([firstProp.id, title.id, middle.id, status.id]);
  });

  it("reorders a property", () => {
    const { c, dataSourceId, title } = fixture();
    const a = c.addProperty(dataSourceId, { name: "A", type: "text" });
    const b = c.addProperty(dataSourceId, { name: "B", type: "number" });
    c.reorderProperty(b.id, title.id);
    expect(c.getDataSource(dataSourceId)?.properties.map((p) => p.name)).toEqual([
      "Name",
      "B",
      "A",
    ]);
    c.reorderProperty(a.id, null);
    expect(c.getDataSource(dataSourceId)?.properties.map((p) => p.name)).toEqual([
      "A",
      "Name",
      "B",
    ]);
  });

  it("keeps exactly one title property", () => {
    const { c, dataSourceId, title } = fixture();
    expect(
      codeOf(() => c.addProperty(dataSourceId, { name: "Other", type: "title" })),
    ).toBe("invalid");
    expect(codeOf(() => c.removeProperty(title.id))).toBe("invalid");
    expect(codeOf(() => c.updateProperty(title.id, { type: "text" }))).toBe(
      "invalid",
    );
    const plain = c.addProperty(dataSourceId, { name: "Plain", type: "text" });
    expect(codeOf(() => c.updateProperty(plain.id, { type: "title" }))).toBe(
      "invalid",
    );
  });

  it("rejects unknown types and empty names", () => {
    const { c, dataSourceId } = fixture();
    expect(
      codeOf(() =>
        c.addProperty(dataSourceId, {
          name: "X",
          type: "relation" as PropertyDef["type"],
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() => c.addProperty(dataSourceId, { name: "   ", type: "text" })),
    ).toBe("invalid");
  });

  it("normalises select options, generating ids and colors", () => {
    const { c, dataSourceId } = fixture();
    const prop = c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      // A JSON/CLI caller may send an option by name alone; the id and color
      // are filled in (the TS contract still asks for a complete option).
      config: {
        options: [{ name: "Todo" } as SelectOption, option("done", "Done")],
      },
    });
    const options = prop.config.options ?? [];
    expect(options).toHaveLength(2);
    expect(options[0]?.id).toMatch(/[0-9a-f-]{36}/);
    expect(options[0]?.color).toBe("default");
    expect(options[1]?.id).toBe("done");
    expect(
      codeOf(() =>
        c.addProperty(dataSourceId, {
          name: "Dup",
          type: "select",
          config: { options: [option("a", "A"), option("a", "B")] },
        }),
      ),
    ).toBe("invalid");
  });

  it("renames without touching stored values and removes with its cells", () => {
    const { c, dataSourceId } = fixture();
    const note = c.addProperty(dataSourceId, { name: "Note", type: "text" });
    const row = c.createRow(dataSourceId, { [note.id]: text("hello") });
    expect(c.updateProperty(note.id, { name: "Notes" }).name).toBe("Notes");
    expect(c.getRow(row.page.id)?.values[note.id]).toEqual(text("hello"));
    c.removeProperty(note.id);
    expect(c.getRow(row.page.id)?.values[note.id]).toBeUndefined();
    expect(codeOf(() => c.removeProperty(note.id))).toBe("not_found");
  });
});

describe("rows are pages", () => {
  it("creates a row page with no scaffold block, parented to the owner", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    const row = c.createRow(dataSourceId);
    expect(row.page.parentId).toBe(ownerPageId);
    expect(row.page.title).toBe("");
    expect(c.getBlocks(row.page.id)).toEqual([]);
    expect(c.getPage(row.page.id)?.id).toBe(row.page.id);
    expect(c.getBreadcrumb(row.page.id).map((p) => p.id)).toEqual([
      ownerPageId,
      row.page.id,
    ]);
  });

  it("hides rows from listChildren and listRootPages but not from getPage", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    const child = c.createPage({ parentId: ownerPageId, title: "Real child" });
    const row = c.createRow(dataSourceId, {});
    expect(c.listChildren(ownerPageId).map((n) => n.page.id)).toEqual([child.id]);
    expect(c.listRootPages().map((n) => n.page.id)).toEqual([ownerPageId]);
    expect(c.getPage(row.page.id)).not.toBeNull();
  });

  it("reports no children when a page owns only rows", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    c.createRow(dataSourceId);
    const root = c.listRootPages().find((n) => n.page.id === ownerPageId);
    expect(root?.hasChildren).toBe(false);
  });

  it("orders rows by rank with after semantics", () => {
    const { c, dataSourceId, title } = fixture();
    const a = c.createRow(dataSourceId, { [title.id]: titleValue("A") });
    const b = c.createRow(dataSourceId, { [title.id]: titleValue("B") });
    const zero = c.createRow(dataSourceId, { [title.id]: titleValue("Z") }, null);
    const mid = c.createRow(dataSourceId, { [title.id]: titleValue("M") }, a.page.id);
    expect(
      c.queryDataSource(dataSourceId).rows.map((r) => r.page.title),
    ).toEqual(["Z", "A", "M", "B"]);
    expect(b.page.id).not.toBe(mid.page.id);
    expect(codeOf(() => c.createRow(dataSourceId, {}, "nope"))).toBe("invalid");
    expect(zero.page.title).toBe("Z");
  });

  it("mirrors the title value and the page title in both directions", () => {
    const { c, dataSourceId, title } = fixture();
    const row = c.createRow(dataSourceId, { [title.id]: titleValue("Write docs") });
    expect(row.page.title).toBe("Write docs");
    expect(row.values[title.id]).toEqual(titleValue("Write docs"));

    c.updatePage(row.page.id, { title: "Write specs" });
    expect(c.getRow(row.page.id)?.values[title.id]).toEqual(titleValue("Write specs"));

    c.setPropertyValues(row.page.id, { [title.id]: titleValue("Ship it") });
    expect(c.getPage(row.page.id)?.title).toBe("Ship it");
    expect(c.search("Ship").map((r) => r.pageId)).toContain(row.page.id);

    c.setPropertyValues(row.page.id, { [title.id]: null });
    expect(c.getPage(row.page.id)?.title).toBe("");
    expect(c.getRow(row.page.id)?.values[title.id]).toEqual({
      type: "title",
      richText: [],
    });
  });

  it("clears a value with null and stores values verbatim", () => {
    const { c, dataSourceId } = fixture();
    const note = c.addProperty(dataSourceId, { name: "Note", type: "text" });
    const row = c.createRow(dataSourceId, {
      [note.id]: { type: "text", richText: [{ type: "text", text: "keep", annotations: { bold: true } }] },
    });
    expect(c.getRow(row.page.id)?.values[note.id]).toEqual({
      type: "text",
      richText: [{ type: "text", text: "keep", annotations: { bold: true } }],
    });
    c.setPropertyValues(row.page.id, { [note.id]: null });
    expect(c.getRow(row.page.id)?.values[note.id]).toBeUndefined();
  });

  it("returns null for pages that are not rows", () => {
    const { c, ownerPageId } = fixture();
    expect(c.getRow(ownerPageId)).toBeNull();
    expect(codeOf(() => c.setPropertyValues(ownerPageId, {}))).toBe("not_found");
  });
});

describe("value validation", () => {
  it("rejects a variant that does not match the property type", () => {
    const { c, dataSourceId } = fixture();
    const count = c.addProperty(dataSourceId, { name: "Count", type: "number" });
    expect(
      codeOf(() => c.createRow(dataSourceId, { [count.id]: text("nope") })),
    ).toBe("invalid");
  });

  it("rejects unknown select and multi_select options", () => {
    const { c, dataSourceId } = fixture();
    const status = c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      config: { options: [option("todo", "Todo")] },
    });
    const tags = c.addProperty(dataSourceId, {
      name: "Tags",
      type: "multi_select",
      config: { options: [option("red", "Red")] },
    });
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, {
          [status.id]: { type: "select", optionId: "ghost" },
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, {
          [tags.id]: { type: "multi_select", optionIds: ["red", "ghost"] },
        }),
      ),
    ).toBe("invalid");
    const row = c.createRow(dataSourceId, {
      [status.id]: { type: "select", optionId: "todo" },
      [tags.id]: { type: "multi_select", optionIds: ["red"] },
    });
    expect(row.values[status.id]).toEqual({ type: "select", optionId: "todo" });
  });

  it("rejects non-ISO dates and accepts both ISO shapes", () => {
    const { c, dataSourceId } = fixture();
    const due = c.addProperty(dataSourceId, { name: "Due", type: "date" });
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, { [due.id]: { type: "date", start: "13/02/2024" } }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, { [due.id]: { type: "date", start: "2024-13-45" } }),
      ),
    ).toBe("invalid");
    const day = c.createRow(dataSourceId, {
      [due.id]: { type: "date", start: "2024-02-13" },
    });
    const instant = c.createRow(dataSourceId, {
      [due.id]: { type: "date", start: "2024-02-13T09:30:00Z", end: null },
    });
    expect(day.values[due.id]).toEqual({ type: "date", start: "2024-02-13" });
    expect(instant.values[due.id]).toEqual({
      type: "date",
      start: "2024-02-13T09:30:00Z",
      end: null,
    });
  });

  it("rejects non-finite numbers and accepts null", () => {
    const { c, dataSourceId } = fixture();
    const count = c.addProperty(dataSourceId, { name: "Count", type: "number" });
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, {
          [count.id]: { type: "number", number: Number.POSITIVE_INFINITY },
        }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() =>
        c.createRow(dataSourceId, { [count.id]: { type: "number", number: NaN } }),
      ),
    ).toBe("invalid");
    const row = c.createRow(dataSourceId, {
      [count.id]: { type: "number", number: null },
    });
    expect(row.values[count.id]).toEqual({ type: "number", number: null });
  });

  it("rejects a property that belongs to another data source", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    const other = c.createDataSource(ownerPageId, "Other");
    const foreign = c.addProperty(other.dataSource.id, {
      name: "Foreign",
      type: "text",
    });
    expect(
      codeOf(() => c.createRow(dataSourceId, { [foreign.id]: text("x") })),
    ).toBe("invalid");
    const row = c.createRow(dataSourceId);
    expect(
      codeOf(() => c.setPropertyValues(row.page.id, { [foreign.id]: text("x") })),
    ).toBe("invalid");
    expect(
      codeOf(() => c.setPropertyValues(row.page.id, { unknown: text("x") })),
    ).toBe("invalid");
  });

  it("rolls back the whole write when one entry is invalid", () => {
    const { c, dataSourceId } = fixture();
    const note = c.addProperty(dataSourceId, { name: "Note", type: "text" });
    const count = c.addProperty(dataSourceId, { name: "Count", type: "number" });
    const row = c.createRow(dataSourceId);
    expect(
      codeOf(() =>
        c.setPropertyValues(row.page.id, {
          [note.id]: text("written"),
          [count.id]: text("wrong"),
        }),
      ),
    ).toBe("invalid");
    expect(c.getRow(row.page.id)?.values[note.id]).toBeUndefined();
  });
});

describe("trash integration", () => {
  it("excludes an individually trashed row and restores it", () => {
    const { c, dataSourceId, title } = fixture();
    const keep = c.createRow(dataSourceId, { [title.id]: titleValue("keep") });
    const gone = c.createRow(dataSourceId, { [title.id]: titleValue("gone") });
    c.trashPage(gone.page.id);
    expect(c.queryDataSource(dataSourceId).rows.map((r) => r.page.id)).toEqual([
      keep.page.id,
    ]);
    expect(c.queryDataSource(dataSourceId).total).toBe(1);
    c.restorePage(gone.page.id);
    expect(c.queryDataSource(dataSourceId).total).toBe(2);
  });

  it("hides every row while the owner page is in the trash", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    c.createRow(dataSourceId);
    c.createRow(dataSourceId);
    c.trashPage(ownerPageId);
    expect(c.queryDataSource(dataSourceId).total).toBe(0);
    c.restorePage(ownerPageId);
    expect(c.queryDataSource(dataSourceId).total).toBe(2);
  });

  it("keeps a trashed row out of the sidebar after restore", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    const row = c.createRow(dataSourceId);
    c.trashPage(row.page.id);
    c.restorePage(row.page.id);
    expect(c.listChildren(ownerPageId)).toEqual([]);
    expect(c.getRow(row.page.id)).not.toBeNull();
  });

  it("deleteDataSource trashes all rows as one batch and drops the schema", () => {
    const { c, dataSourceId, title, ownerPageId } = fixture();
    const note = c.addProperty(dataSourceId, { name: "Note", type: "text" });
    const a = c.createRow(dataSourceId, {
      [title.id]: titleValue("a"),
      [note.id]: text("n"),
    });
    const b = c.createRow(dataSourceId, { [title.id]: titleValue("b") });

    c.deleteDataSource(dataSourceId);

    expect(c.getDataSource(dataSourceId)).toBeNull();
    expect(c.listDataSources(ownerPageId)).toEqual([]);
    expect(c.getRow(a.page.id)).toBeNull();
    expect(c.getPage(a.page.id)?.deletedAt).not.toBeNull();
    expect(c.getPage(b.page.id)?.deletedAt).not.toBeNull();
    expect(codeOf(() => c.queryDataSource(dataSourceId))).toBe("not_found");

    // One batch, rooted at the first row: restoring it brings every row back.
    const trashRoots = c.listTrash().map((p) => p.id);
    expect(trashRoots).toEqual([a.page.id]);
    c.restorePage(a.page.id);
    expect(c.getPage(b.page.id)?.deletedAt).toBeNull();
    // With the data source gone the rows are ordinary child pages again.
    expect(c.listChildren(ownerPageId).map((n) => n.page.id).sort()).toEqual(
      [a.page.id, b.page.id].sort(),
    );
  });

  it("cascades the whole database when the owner page is deleted permanently", () => {
    const { c, dataSourceId, ownerPageId } = fixture();
    const row = c.createRow(dataSourceId);
    c.trashPage(ownerPageId);
    c.deletePagePermanently(ownerPageId);
    expect(c.getDataSource(dataSourceId)).toBeNull();
    expect(c.getPage(row.page.id)).toBeNull();
    expect(c.getRow(row.page.id)).toBeNull();
  });
});

describe("property type conversion", () => {
  const setup = (): {
    c: KumiCommands;
    dataSourceId: Id;
    rowOf: (values: Record<Id, PropertyValue>) => Id;
  } => {
    const { c, dataSourceId } = fixture();
    return {
      c,
      dataSourceId,
      rowOf: (values) => c.createRow(dataSourceId, values).page.id,
    };
  };

  it("text → number keeps a leading numeric and drops the rest", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, { name: "Amount", type: "text" });
    const numeric = rowOf({ [prop.id]: text("12.5 kg") });
    const prose = rowOf({ [prop.id]: text("about ten") });
    c.updateProperty(prop.id, { type: "number" });
    expect(c.getRow(numeric)?.values[prop.id]).toEqual({
      type: "number",
      number: 12.5,
    });
    expect(c.getRow(prose)?.values[prop.id]).toBeUndefined();
  });

  it("number → text renders the decimal", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, { name: "Amount", type: "number" });
    const row = rowOf({ [prop.id]: { type: "number", number: -3.25 } });
    c.updateProperty(prop.id, { type: "text" });
    expect(c.getRow(row)?.values[prop.id]).toEqual(text("-3.25"));
  });

  it("select ↔ multi_select wraps and keeps the first option", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      config: {
        options: [
          option("a", "A"),
          option("b", "B"),
        ],
      },
    });
    const row = rowOf({ [prop.id]: { type: "select", optionId: "b" } });
    c.updateProperty(prop.id, { type: "multi_select" });
    expect(c.getRow(row)?.values[prop.id]).toEqual({
      type: "multi_select",
      optionIds: ["b"],
    });
    c.setPropertyValues(row, {
      [prop.id]: { type: "multi_select", optionIds: ["b", "a"] },
    });
    c.updateProperty(prop.id, { type: "select" });
    expect(c.getRow(row)?.values[prop.id]).toEqual({ type: "select", optionId: "b" });
  });

  it("drops everything on the way to checkbox and away from it", () => {
    const { c, dataSourceId, rowOf } = setup();
    const flag = c.addProperty(dataSourceId, { name: "Flag", type: "text" });
    const row = rowOf({ [flag.id]: text("yes") });
    c.updateProperty(flag.id, { type: "checkbox" });
    expect(c.getRow(row)?.values[flag.id]).toBeUndefined();

    c.setPropertyValues(row, { [flag.id]: { type: "checkbox", checked: true } });
    c.updateProperty(flag.id, { type: "text" });
    expect(c.getRow(row)?.values[flag.id]).toBeUndefined();
  });

  it("interconverts text, url, email and phone keeping the string", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, { name: "Contact", type: "text" });
    const row = rowOf({ [prop.id]: text("ada@example.com") });
    c.updateProperty(prop.id, { type: "email" });
    expect(c.getRow(row)?.values[prop.id]).toEqual({
      type: "email",
      value: "ada@example.com",
    });
    c.updateProperty(prop.id, { type: "phone" });
    expect(c.getRow(row)?.values[prop.id]).toEqual({
      type: "phone",
      value: "ada@example.com",
    });
    c.updateProperty(prop.id, { type: "url" });
    c.updateProperty(prop.id, { type: "text" });
    expect(c.getRow(row)?.values[prop.id]).toEqual(text("ada@example.com"));
  });

  it("text → date keeps ISO strings and drops the rest", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, { name: "When", type: "text" });
    const iso = rowOf({ [prop.id]: text("2024-05-06") });
    const prose = rowOf({ [prop.id]: text("next tuesday") });
    c.updateProperty(prop.id, { type: "date" });
    expect(c.getRow(iso)?.values[prop.id]).toEqual({
      type: "date",
      start: "2024-05-06",
    });
    expect(c.getRow(prose)?.values[prop.id]).toBeUndefined();
    c.updateProperty(prop.id, { type: "text" });
    expect(c.getRow(iso)?.values[prop.id]).toEqual(text("2024-05-06"));
  });

  it("select → text renders the option name", () => {
    const { c, dataSourceId, rowOf } = setup();
    const prop = c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      config: { options: [option("done", "Done")] },
    });
    const row = rowOf({ [prop.id]: { type: "select", optionId: "done" } });
    c.updateProperty(prop.id, { type: "text" });
    expect(c.getRow(row)?.values[prop.id]).toEqual(text("Done"));
  });

  it("drops values naming an option removed from the config", () => {
    const { c, dataSourceId, rowOf } = setup();
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
    const tags = c.addProperty(dataSourceId, {
      name: "Tags",
      type: "multi_select",
      config: {
        options: [
          option("red", "Red"),
          option("blue", "Blue"),
        ],
      },
    });
    const row = rowOf({
      [status.id]: { type: "select", optionId: "done" },
      [tags.id]: { type: "multi_select", optionIds: ["red", "blue"] },
    });
    const kept = rowOf({ [status.id]: { type: "select", optionId: "todo" } });

    c.updateProperty(status.id, { config: { options: [option("todo", "Todo")] } });
    c.updateProperty(tags.id, { config: { options: [option("blue", "Blue")] } });

    expect(c.getRow(row)?.values[status.id]).toBeUndefined();
    expect(c.getRow(row)?.values[tags.id]).toEqual({
      type: "multi_select",
      optionIds: ["blue"],
    });
    expect(c.getRow(kept)?.values[status.id]).toEqual({
      type: "select",
      optionId: "todo",
    });
  });

  it("renaming an option keeps the stored value", () => {
    const { c, dataSourceId, rowOf } = setup();
    const status = c.addProperty(dataSourceId, {
      name: "Status",
      type: "select",
      config: { options: [option("todo", "Todo")] },
    });
    const row = rowOf({ [status.id]: { type: "select", optionId: "todo" } });
    c.updateProperty(status.id, {
      config: { options: [option("todo", "To do", "blue")] },
    });
    expect(c.getRow(row)?.values[status.id]).toEqual({
      type: "select",
      optionId: "todo",
    });
  });
});

describe("views", () => {
  it("creates views with defaults, validating the type", () => {
    const { c, dataSourceId, view } = fixture();
    const board = c.createView(dataSourceId, { name: "Board", type: "board" });
    expect(board.config.openMode).toBe("center_peek");
    expect(board.config.sorts).toEqual([]);
    expect(
      codeOf(() =>
        c.createView(dataSourceId, { name: "X", type: "kanban" as View["type"] }),
      ),
    ).toBe("invalid");
    expect(
      codeOf(() => c.createView(dataSourceId, { name: " ", type: "list" })),
    ).toBe("invalid");
    expect(c.getDataSource(dataSourceId)?.views.map((v) => v.id)).toEqual([
      view.id,
      board.id,
    ]);
  });

  it("merges a partial config patch", () => {
    const { c, view } = fixture();
    const updated = c.updateView(view.id, {
      config: { openMode: "full_page", propertyWidths: { a: 120 } },
    });
    expect(updated.config.openMode).toBe("full_page");
    expect(updated.config.propertyWidths).toEqual({ a: 120 });
    expect(updated.config.filter).toBeNull();
  });

  it("round-trips the calendar/board config keys", () => {
    const { c, dataSourceId, view } = fixture();
    const due = c.addProperty(dataSourceId, { name: "Due", type: "date" });
    const calendar = c.createView(dataSourceId, {
      name: "Calendar",
      type: "calendar",
      config: { datePropertyId: due.id, cardSize: "large" },
    });
    expect(calendar.config.datePropertyId).toBe(due.id);
    expect(calendar.config.cardSize).toBe("large");

    const updated = c.updateView(view.id, {
      config: { collapsedGroups: ["__none__", "todo"], cardSize: "small" },
    });
    expect(updated.config.collapsedGroups).toEqual(["__none__", "todo"]);
    // A later partial patch keeps the keys it does not mention.
    const again = c.updateView(view.id, { config: { openMode: "full_page" } });
    expect(again.config.collapsedGroups).toEqual(["__none__", "todo"]);
    expect(again.config.cardSize).toBe("small");
    expect(again.config.openMode).toBe("full_page");
  });

  it("refuses shape changes on a locked view but allows unlocking and renaming", () => {
    const { c, view } = fixture();
    c.updateView(view.id, { locked: true });
    expect(codeOf(() => c.updateView(view.id, { config: { sorts: [] } }))).toBe(
      "locked",
    );
    expect(codeOf(() => c.updateView(view.id, { type: "board" }))).toBe("locked");
    expect(c.updateView(view.id, { name: "Renamed" }).name).toBe("Renamed");
    expect(c.updateView(view.id, { locked: false }).locked).toBe(false);
    expect(c.updateView(view.id, { type: "board" }).type).toBe("board");
  });

  it("refuses to delete the last view and reorders views", () => {
    const { c, dataSourceId, view } = fixture();
    expect(codeOf(() => c.deleteView(view.id))).toBe("invalid");
    const board = c.createView(dataSourceId, { name: "Board", type: "board" });
    c.reorderView(board.id, null);
    expect(c.getDataSource(dataSourceId)?.views.map((v) => v.id)).toEqual([
      board.id,
      view.id,
    ]);
    c.deleteView(view.id);
    expect(c.getDataSource(dataSourceId)?.views.map((v) => v.id)).toEqual([board.id]);
    expect(codeOf(() => c.deleteView(board.id))).toBe("invalid");
    expect(codeOf(() => c.reorderView("nope", null))).toBe("not_found");
  });
});
