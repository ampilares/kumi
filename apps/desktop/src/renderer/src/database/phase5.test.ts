/**
 * Phase 5 pure logic: board grouping, calendar month arithmetic, timeline
 * scale math, and the relation / rollup value and operator maps.
 *
 * Same discipline as the Phase 4 suite — everything the five new layouts
 * *decide* is a function over plain data, so it is tested without a DOM and the
 * components are left with nothing but arrangement.
 */

import { describe, expect, it } from "vitest";
import type { PropertyDef, RowRecord, SelectOption, ViewConfig } from "@kumi/core";
import type { PageStub } from "../lib/pageCache";
import {
  CHECKED_KEY,
  NO_GROUP_KEY,
  UNCHECKED_KEY,
  buildGroups,
  cardSizeOf,
  groupKeyOf,
  groupableProperties,
  isGroupable,
  toggleCollapsed,
  valueForGroup,
} from "./grouping";
import {
  CALENDAR_CELLS,
  addDays,
  dayOf,
  daysBetween,
  monthLabel,
  monthMatrix,
  monthOf,
  rowDay,
  rowSpan,
  rowsByDay,
  shiftMonth,
  undatedCount,
} from "./calendar";
import {
  DAY_PX,
  barFor,
  ticksFor,
  timelineRange,
  timelineWidth,
  todayOffset,
} from "./timeline";
import {
  RELATION_MISSING_TITLE,
  RELATION_PENDING_TITLE,
  relationSummary,
  resolveRelationChips,
  unresolvedIds,
} from "./relations";
import {
  allowedAggregations,
  defaultAggregation,
  isAggregationAllowed,
  isRollupTarget,
  relationConfigOf,
  relationText,
  rollupConfigOf,
  rollupText,
  toggleRelationId,
  valueText,
} from "./properties";
import {
  isChipComplete,
  isFilterable,
  isSortable,
  newChip,
  operatorsFor,
  operatorsForProperty,
} from "./filters";
import { collapsedGroupsOf, configOf, layoutSettings } from "./viewConfig";

/* --------------------------------------------------------------- fixtures */

function property(over: Partial<PropertyDef> & Pick<PropertyDef, "id" | "type">): PropertyDef {
  return {
    dataSourceId: "ds",
    name: over.name ?? over.id,
    config: over.config ?? {},
    rank: over.rank ?? "a0",
    ...over,
  };
}

function row(id: string, title: string, values: RowRecord["values"] = {}): RowRecord {
  return {
    page: {
      id,
      parentId: "owner",
      title,
      icon: null,
      coverAssetId: null,
      locked: false,
      fullWidth: false,
      smallText: false,
      rank: "a0",
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
    },
    values,
  };
}

const OPTIONS: SelectOption[] = [
  { id: "o-todo", name: "Todo", color: "gray" },
  { id: "o-doing", name: "Doing", color: "blue" },
  { id: "o-done", name: "Done", color: "green" },
];

const status = property({
  id: "p-status",
  type: "select",
  name: "Status",
  config: { options: OPTIONS },
});
const shipped = property({ id: "p-shipped", type: "checkbox", name: "Shipped" });
const due = property({ id: "p-due", type: "date", name: "Due" });
const notes = property({ id: "p-notes", type: "text", name: "Notes" });

/* ---------------------------------------------------------------- grouping */

describe("board grouping", () => {
  const rows = [
    row("r1", "One", { [status.id]: { type: "select", optionId: "o-todo" } }),
    row("r2", "Two", { [status.id]: { type: "select", optionId: "o-done" } }),
    row("r3", "Three", { [status.id]: { type: "select", optionId: "o-todo" } }),
    row("r4", "Four"),
    row("r5", "Five", { [status.id]: { type: "select", optionId: "gone" } }),
  ];

  it("only offers select and checkbox as grouping properties", () => {
    expect(isGroupable(status)).toBe(true);
    expect(isGroupable(shipped)).toBe(true);
    expect(isGroupable(due)).toBe(false);
    expect(groupableProperties([status, due, notes, shipped]).map((p) => p.id)).toEqual([
      status.id,
      shipped.id,
    ]);
  });

  it("keys a row by its option id, and by the sentinel when it has none", () => {
    expect(groupKeyOf(rows[0] as RowRecord, status)).toBe("o-todo");
    expect(groupKeyOf(rows[3] as RowRecord, status)).toBe(NO_GROUP_KEY);
  });

  it("builds one column per option in schema order, with the none column last", () => {
    const groups = buildGroups(rows, status);
    expect(groups.map((g) => g.key)).toEqual(["o-todo", "o-doing", "o-done", NO_GROUP_KEY]);
    expect(groups.at(-1)?.label).toBe("No Status");
  });

  it("keeps empty option columns, because a board's lanes are its workflow", () => {
    const groups = buildGroups(rows, status);
    expect(groups.find((g) => g.key === "o-doing")?.rows).toEqual([]);
  });

  it("sweeps rows whose option no longer exists into the none column", () => {
    const none = buildGroups(rows, status).find((g) => g.key === NO_GROUP_KEY);
    expect(none?.rows.map((r) => r.page.id)).toEqual(["r4", "r5"]);
  });

  it("groups a checkbox into two columns and no none column", () => {
    const checkRows = [
      row("a", "A", { [shipped.id]: { type: "checkbox", checked: true } }),
      row("b", "B", { [shipped.id]: { type: "checkbox", checked: false } }),
      row("c", "C"),
    ];
    const groups = buildGroups(checkRows, shipped);
    expect(groups.map((g) => g.key)).toEqual([CHECKED_KEY, UNCHECKED_KEY]);
    expect(groups[0]?.rows.map((r) => r.page.id)).toEqual(["a"]);
    // An absent value is `false`, not "no value".
    expect(groups[1]?.rows.map((r) => r.page.id)).toEqual(["b", "c"]);
  });

  it("marks the persisted collapsed columns and toggles the stored array purely", () => {
    const groups = buildGroups(rows, status, ["o-done", NO_GROUP_KEY]);
    expect(groups.filter((g) => g.collapsed).map((g) => g.key)).toEqual(["o-done", NO_GROUP_KEY]);

    const keys = ["o-done"];
    expect(toggleCollapsed(keys, "o-todo")).toEqual(["o-done", "o-todo"]);
    expect(toggleCollapsed(keys, "o-done")).toEqual([]);
    expect(keys).toEqual(["o-done"]);
  });

  it("normalises whatever collapsedGroups the config happens to hold", () => {
    const base = configOf(null);
    expect(collapsedGroupsOf(base)).toEqual([]);
    expect(collapsedGroupsOf({ ...base, collapsedGroups: ["a", 2 as never] })).toEqual(["a"]);
  });

  it("gives a drop target the value a row must take to belong there", () => {
    expect(valueForGroup(status, "o-done")).toEqual({ type: "select", optionId: "o-done" });
    expect(valueForGroup(status, NO_GROUP_KEY)).toBeNull();
    expect(valueForGroup(shipped, CHECKED_KEY)).toEqual({ type: "checkbox", checked: true });
    expect(valueForGroup(shipped, UNCHECKED_KEY)).toEqual({ type: "checkbox", checked: false });
  });

  it("falls back to medium for an unset or nonsense card size", () => {
    expect(cardSizeOf(undefined)).toBe("medium");
    expect(cardSizeOf("huge")).toBe("medium");
    expect(cardSizeOf("small")).toBe("small");
  });
});

/* --------------------------------------------------------------- calendar */

describe("calendar month arithmetic", () => {
  it("always produces a 6×7 grid, whatever the month starts on", () => {
    for (const month of [0, 1, 5, 11]) {
      expect(monthMatrix({ year: 2026, month })).toHaveLength(CALENDAR_CELLS);
    }
  });

  it("pads with the neighbouring months and marks which days are in-month", () => {
    // 1 Aug 2026 is a Saturday, so six leading days come from July.
    const grid = monthMatrix({ year: 2026, month: 7 }, "2026-08-19");
    expect(grid[0]?.iso).toBe("2026-07-26");
    expect(grid[0]?.inMonth).toBe(false);
    expect(grid[6]?.iso).toBe("2026-08-01");
    expect(grid[6]?.inMonth).toBe(true);
    expect(grid[0]?.weekday).toBe(0);
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
  });

  it("marks exactly one day as today, and none when today is elsewhere", () => {
    const grid = monthMatrix({ year: 2026, month: 7 }, "2026-08-19");
    expect(grid.filter((d) => d.isToday).map((d) => d.iso)).toEqual(["2026-08-19"]);
    expect(monthMatrix({ year: 2026, month: 0 }, "2026-08-19").some((d) => d.isToday)).toBe(false);
  });

  it("gets February right in a leap year and in a common one", () => {
    expect(monthMatrix({ year: 2024, month: 1 }).filter((d) => d.inMonth)).toHaveLength(29);
    expect(monthMatrix({ year: 2026, month: 1 }).filter((d) => d.inMonth)).toHaveLength(28);
  });

  it("carries month arithmetic across both year boundaries", () => {
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 5 }, 14)).toEqual({ year: 2027, month: 7 });
    expect(shiftMonth({ year: 2026, month: 5 }, -30)).toEqual({ year: 2023, month: 11 });
  });

  it("labels a month with its year", () => {
    expect(monthLabel({ year: 2026, month: 7 })).toContain("2026");
    expect(monthOf("2026-08-19")).toEqual({ year: 2026, month: 7 });
  });

  it("does day arithmetic in UTC, so a date never drifts by a timezone", () => {
    expect(dayOf("2026-08-19T23:30:00Z")).toBe("2026-08-19");
    expect(dayOf("")).toBeNull();
    expect(dayOf(null)).toBeNull();
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(daysBetween("2026-08-19", "2026-08-21")).toBe(2);
    expect(daysBetween("2026-08-21", "2026-08-19")).toBe(-2);
  });

  it("places rows on their start day and reports the ones it cannot place", () => {
    const rows = [
      row("a", "A", { [due.id]: { type: "date", start: "2026-08-19", end: "2026-08-22" } }),
      row("b", "B", { [due.id]: { type: "date", start: "2026-08-19" } }),
      row("c", "C"),
    ];
    expect(rowDay(rows[0] as RowRecord, due)).toBe("2026-08-19");
    expect(rowDay(rows[2] as RowRecord, due)).toBeNull();
    expect(rowsByDay(rows, due).get("2026-08-19")?.map((r) => r.page.id)).toEqual(["a", "b"]);
    expect(rowsByDay(rows, due).size).toBe(1);
    expect(undatedCount(rows, due)).toBe(1);
  });

  it("treats a missing or backwards end date as a single-day span", () => {
    expect(rowSpan(row("a", "A", { [due.id]: { type: "date", start: "2026-08-19" } }), due)).toEqual(
      { start: "2026-08-19", end: "2026-08-19" },
    );
    expect(
      rowSpan(
        row("b", "B", { [due.id]: { type: "date", start: "2026-08-19", end: "2026-08-10" } }),
        due,
      ),
    ).toEqual({ start: "2026-08-19", end: "2026-08-19" });
    expect(rowSpan(row("c", "C"), due)).toBeNull();
  });
});

/* --------------------------------------------------------------- timeline */

describe("timeline scale", () => {
  const rows = [
    row("a", "A", { [due.id]: { type: "date", start: "2026-08-10", end: "2026-08-14" } }),
    row("b", "B", { [due.id]: { type: "date", start: "2026-08-20" } }),
    row("c", "C"),
  ];

  it("pads the rows' extent and snaps the left edge to a Sunday", () => {
    const range = timelineRange(rows, due, "weeks", "2026-08-19");
    expect(daysBetween(range.start, "2026-08-10")).toBeGreaterThanOrEqual(7);
    expect(monthMatrix(monthOf(range.start))[0]).toBeDefined();
    // Sunday-aligned: day 0 of the range is a Sunday.
    expect(new Date(`${range.start}T00:00:00Z`).getUTCDay()).toBe(0);
    expect(range.days).toBe(daysBetween(range.start, range.end) + 1);
  });

  it("always contains today, so the today line has somewhere to land", () => {
    const range = timelineRange(rows, due, "weeks", "2027-01-05");
    expect(todayOffset(range, "weeks", "2027-01-05")).not.toBeNull();
    expect(daysBetween(range.start, "2027-01-05")).toBeGreaterThan(0);
  });

  it("falls back to a window around today when nothing is dated", () => {
    const range = timelineRange([row("x", "X")], due, "weeks", "2026-08-19");
    expect(todayOffset(range, "weeks", "2026-08-19")).not.toBeNull();
    expect(range.days).toBeGreaterThanOrEqual(42);
  });

  it("scales width with the zoom level", () => {
    const range = timelineRange(rows, due, "weeks", "2026-08-19");
    expect(timelineWidth(range, "weeks")).toBe(range.days * DAY_PX.weeks);
    expect(DAY_PX.months).toBeLessThan(DAY_PX.weeks);
  });

  it("draws a bar from start to end, and a one-day bar when the end is missing", () => {
    const range = timelineRange(rows, due, "weeks", "2026-08-19");
    const spanned = barFor(rows[0] as RowRecord, due, range, "weeks");
    const single = barFor(rows[1] as RowRecord, due, range, "weeks");
    expect(spanned?.width).toBe(5 * DAY_PX.weeks);
    expect(single?.width).toBe(DAY_PX.weeks);
    expect(spanned?.left).toBe(daysBetween(range.start, "2026-08-10") * DAY_PX.weeks);
    expect(barFor(rows[2] as RowRecord, due, range, "weeks")).toBeNull();
  });

  it("ticks on Sundays at the week zoom and on the 1st at the month zoom", () => {
    const range = timelineRange(rows, due, "weeks", "2026-08-19");
    const weekly = ticksFor(range, "weeks");
    expect(weekly.length).toBeGreaterThan(1);
    for (const tick of weekly) {
      expect(new Date(`${tick.iso}T00:00:00Z`).getUTCDay()).toBe(0);
    }

    const wide = timelineRange(rows, due, "months", "2026-08-19");
    const monthly = ticksFor(wide, "months");
    expect(monthly.length).toBeGreaterThan(1);
    for (const tick of monthly) {
      expect(tick.iso.endsWith("-01")).toBe(true);
      expect(tick.major).toBe(true);
    }
  });

  it("puts the today line at a whole number of days from the range start", () => {
    const range = timelineRange(rows, due, "weeks", "2026-08-19");
    const offset = todayOffset(range, "weeks", "2026-08-19");
    expect(offset).toBe(daysBetween(range.start, "2026-08-19") * DAY_PX.weeks);
    expect(todayOffset(range, "weeks", "2030-01-01")).toBeNull();
  });
});

/* -------------------------------------------------------------- relations */

describe("relation chips", () => {
  const stub = (id: string, title: string, missing = false): PageStub => ({
    id,
    title,
    icon: null,
    missing,
  });

  it("keeps the value's order, not the cache's", () => {
    const stubs = new Map([stub("b", "Beta"), stub("a", "Alpha")].map((s) => [s.id, s]));
    expect(resolveRelationChips(["a", "b"], stubs).map((c) => c.title)).toEqual(["Alpha", "Beta"]);
  });

  it("marks an unfetched id pending rather than rendering it as missing", () => {
    const chip = resolveRelationChips(["a"], new Map())[0];
    expect(chip?.pending).toBe(true);
    expect(chip?.missing).toBe(false);
    expect(chip?.title).toBe(RELATION_PENDING_TITLE);
  });

  it("shows a dangling reference instead of dropping it", () => {
    const stubs = new Map([["gone", stub("gone", "Untitled", true)]]);
    const chip = resolveRelationChips(["gone"], stubs)[0];
    expect(chip?.missing).toBe(true);
    expect(chip?.title).toBe(RELATION_MISSING_TITLE);
  });

  it("falls back to Untitled for a blank title", () => {
    const stubs = new Map([["a", stub("a", "   ")]]);
    expect(resolveRelationChips(["a"], stubs)[0]?.title).toBe(RELATION_MISSING_TITLE);
  });

  it("asks for each unresolved id exactly once", () => {
    const stubs = new Map([["a", stub("a", "Alpha")]]);
    expect(unresolvedIds(["a", "b", "b", "c"], stubs)).toEqual(["b", "c"]);
    expect(unresolvedIds([], stubs)).toEqual([]);
  });

  it("summarises a long chip row", () => {
    const stubs = new Map(
      [stub("a", "Alpha"), stub("b", "Beta"), stub("c", "Gamma")].map((s) => [s.id, s]),
    );
    const chips = resolveRelationChips(["a", "b", "c"], stubs);
    expect(relationSummary(chips)).toBe("Alpha, Beta +1");
    expect(relationSummary([])).toBe("");
  });

  it("toggles a related id while preserving selection order", () => {
    expect(toggleRelationId(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleRelationId(["a", "b"], "a")).toEqual(["b"]);
  });

  it("reads a relation config back, and refuses a malformed one", () => {
    const rel = property({
      id: "p-rel",
      type: "relation",
      config: { relation: { dataSourceId: "ds-2", pairedPropertyId: null } },
    });
    expect(relationConfigOf(rel)?.dataSourceId).toBe("ds-2");
    expect(relationConfigOf(property({ id: "x", type: "relation" }))).toBeNull();
  });
});

/* ---------------------------------------------------- relation / rollup values */

describe("relation and rollup values", () => {
  const relation = property({
    id: "p-rel",
    type: "relation",
    name: "Tasks",
    config: { relation: { dataSourceId: "ds-2", pairedPropertyId: null } },
  });
  const rollup = property({
    id: "p-roll",
    type: "rollup",
    name: "Total",
    config: {
      rollup: { relationPropertyId: "p-rel", targetPropertyId: "p-n", aggregation: "sum" },
      numberFormat: "dollar",
    },
  });

  it("leaves a relation out of the search text, because titles resolve async", () => {
    expect(valueText({ type: "relation", pageIds: ["a", "b"] }, relation)).toBe("");
  });

  it("renders relation text from resolved titles, unknown ids included", () => {
    const titles = new Map([["a", "Alpha"]]);
    expect(relationText({ type: "relation", pageIds: ["a", "missing"] }, titles)).toBe(
      "Alpha, Untitled",
    );
  });

  it("formats a numeric rollup with the property's number format", () => {
    expect(rollupText({ type: "rollup", aggregation: "sum", number: 1234 }, rollup)).toBe("$1,234");
    expect(valueText({ type: "rollup", aggregation: "sum", number: 1234 }, rollup)).toBe("$1,234");
    expect(rollupText({ type: "rollup", aggregation: "count", number: 0 })).toBe("0");
    expect(rollupText({ type: "rollup", aggregation: "sum", number: null })).toBe("");
  });

  it("formats a date rollup as a range", () => {
    expect(
      rollupText({
        type: "rollup",
        aggregation: "max",
        date: { start: "2026-08-19", end: "2026-08-21" },
      }),
    ).toContain("→");
  });

  it("joins show_originals without needing the target's option list", () => {
    expect(
      rollupText({
        type: "rollup",
        aggregation: "show_originals",
        values: [
          { type: "text", richText: [{ type: "text", text: "one" }] },
          { type: "number", number: 2 },
          { type: "text", richText: [] },
          { type: "checkbox", checked: true },
        ],
      }),
    ).toBe("one, 2, Yes");
  });

  it("reads a rollup config back, defaulting the aggregation", () => {
    expect(rollupConfigOf(rollup)?.aggregation).toBe("sum");
    expect(rollupConfigOf(property({ id: "x", type: "rollup" }))).toBeNull();
  });
});

describe("rollup aggregation matrix", () => {
  it("offers `count` only when no target property is chosen", () => {
    expect(allowedAggregations(null)).toEqual(["count"]);
    expect(defaultAggregation(null)).toBe("count");
    for (const type of ["number", "date", "text", "select"] as const) {
      expect(allowedAggregations(type)).not.toContain("count");
    }
  });

  it("offers the arithmetic aggregations only for numbers", () => {
    expect(allowedAggregations("number")).toContain("sum");
    expect(allowedAggregations("number")).toContain("avg");
    expect(allowedAggregations("text")).not.toContain("sum");
    expect(allowedAggregations("select")).not.toContain("avg");
    expect(defaultAggregation("number")).toBe("sum");
  });

  it("offers min/max for numbers and dates, and nowhere else", () => {
    expect(allowedAggregations("date")).toContain("min");
    expect(allowedAggregations("date")).toContain("max");
    expect(allowedAggregations("date")).not.toContain("sum");
    expect(allowedAggregations("text")).not.toContain("min");
  });

  it("refuses to roll up a relation or another rollup", () => {
    expect(allowedAggregations("rollup")).toEqual([]);
    expect(allowedAggregations("relation")).toEqual([]);
    expect(isAggregationAllowed("rollup", "count")).toBe(false);
    expect(isRollupTarget("rollup")).toBe(false);
    expect(isRollupTarget("relation")).toBe(false);
    expect(isRollupTarget("number")).toBe(true);
  });

  it("validates a combination the panel would otherwise let through", () => {
    expect(isAggregationAllowed("text", "count_values")).toBe(true);
    expect(isAggregationAllowed("text", "sum")).toBe(false);
    expect(isAggregationAllowed("checkbox", "show_originals")).toBe(true);
    expect(defaultAggregation("text")).toBe("count_values");
  });
});

/* ---------------------------------------------------- filters for new types */

describe("relation and rollup filters", () => {
  const relation = property({ id: "p-rel", type: "relation" });
  const rollupSum = property({
    id: "p-sum",
    type: "rollup",
    config: { rollup: { relationPropertyId: "p-rel", targetPropertyId: "p-n", aggregation: "sum" } },
  });
  const rollupOriginals = property({
    id: "p-orig",
    type: "rollup",
    config: {
      rollup: {
        relationPropertyId: "p-rel",
        targetPropertyId: "p-t",
        aggregation: "show_originals",
      },
    },
  });

  it("gives a relation only the row-membership and emptiness operators", () => {
    expect(operatorsFor("relation").map((o) => o.op)).toEqual([
      "contains",
      "not_contains",
      "is_empty",
      "is_not_empty",
    ]);
    expect(operatorsFor("relation").map((o) => o.op)).not.toContain("equals");
  });

  it("gives a numeric rollup the numeric comparisons", () => {
    expect(operatorsForProperty(rollupSum).map((o) => o.op)).toContain("gte");
    expect(operatorsForProperty(rollupSum).map((o) => o.op)).not.toContain("contains");
  });

  it("offers nothing for show_originals, which core refuses to filter at all", () => {
    expect(operatorsForProperty(rollupOriginals)).toEqual([]);
    expect(isFilterable(rollupOriginals)).toBe(false);
    expect(isFilterable(rollupSum)).toBe(true);
    expect(isFilterable(relation)).toBe(true);
  });

  it("uses the target's type to disambiguate min/max when the caller knows it", () => {
    const minMax = property({
      id: "p-mm",
      type: "rollup",
      config: {
        rollup: { relationPropertyId: "p-rel", targetPropertyId: "p-d", aggregation: "max" },
      },
    });
    // A date-valued rollup is not filterable; a number-valued one is numeric.
    expect(operatorsForProperty(minMax, "date")).toEqual([]);
    expect(operatorsForProperty(minMax, "number").map((o) => o.op)).toContain("gte");
    expect(operatorsForProperty(minMax).map((o) => o.op)).toContain("gte");
  });

  it("hides from the sort menu what core refuses to order by", () => {
    expect(isSortable(relation)).toBe(false);
    expect(isSortable(rollupOriginals)).toBe(false);
    expect(isSortable(rollupSum)).toBe(true);
    expect(isSortable(status)).toBe(true);
  });

  it("starts a relation chip on `contains` with an empty page id", () => {
    const chip = newChip(relation, "c1");
    expect(chip.op).toBe("contains");
    expect(chip.value).toBe("");
    expect(isChipComplete(chip, "relation")).toBe(false);
    expect(isChipComplete({ ...chip, value: "page-1" }, "relation")).toBe(true);
  });

  it("types a rollup operand by its operator, not by the property type", () => {
    expect(isChipComplete({ id: "c", propertyId: "p", op: "gt", value: 5 }, "rollup")).toBe(true);
    expect(isChipComplete({ id: "c", propertyId: "p", op: "gt", value: "5" }, "rollup")).toBe(false);
    expect(isChipComplete({ id: "c", propertyId: "p", op: "contains", value: "a" }, "rollup")).toBe(
      true,
    );
    expect(isChipComplete({ id: "c", propertyId: "p", op: "is_empty" }, "rollup")).toBe(true);
  });
});

/* ------------------------------------------------------- layout settings */

describe("view config for layouts", () => {
  it("carries the layout keys through configOf untouched", () => {
    const config = configOf({
      id: "v",
      dataSourceId: "ds",
      name: "Board",
      type: "board",
      rank: "a0",
      locked: false,
      config: {
        filter: null,
        sorts: [],
        visibleProperties: null,
        propertyWidths: {},
        openMode: "center_peek",
        groupByPropertyId: status.id,
        cardSize: "large",
        collapsedGroups: ["o-done"],
        importedExtra: 7,
      } as ViewConfig,
    });
    expect(config.groupByPropertyId).toBe(status.id);
    expect(config.cardSize).toBe("large");
    expect(config.collapsedGroups).toEqual(["o-done"]);
    // Unknown keys survive, per the type's own round-trip promise.
    expect(config.importedExtra).toBe(7);
  });

  it("shows each layout only the settings it can act on", () => {
    expect(layoutSettings("board")).toEqual({ groupBy: true, dateProperty: false, cardSize: true });
    expect(layoutSettings("list")).toEqual({ groupBy: true, dateProperty: false, cardSize: false });
    expect(layoutSettings("gallery")).toEqual({
      groupBy: false,
      dateProperty: false,
      cardSize: true,
    });
    expect(layoutSettings("calendar")).toEqual({
      groupBy: false,
      dateProperty: true,
      cardSize: false,
    });
    expect(layoutSettings("timeline").dateProperty).toBe(true);
    expect(layoutSettings("table")).toEqual({
      groupBy: false,
      dateProperty: false,
      cardSize: false,
    });
  });
});
