/**
 * Phase 4 pure logic: filter-chip construction, typed operands, number and date
 * formatting, select-option reducers and view-config resolution.
 *
 * These are the pieces the table, the peek and (from Phase 5) the board all
 * share, so they are tested without a DOM.
 */

import { describe, expect, it } from "vitest";
import type { PropertyDef, RowRecord, SelectOption, ViewConfig } from "@kumi/core";
import {
  chipsToFilter,
  defaultOperand,
  defaultOperator,
  filterSummary,
  filterToChips,
  isChipComplete,
  newChip,
  operatorsFor,
  retargetChip,
  setChipOperator,
  setChipValue,
} from "./filters";
import {
  emptyValue,
  formatDateValue,
  formatNumber,
  isEmptyValue,
  parseDateInput,
  parseNumber,
  plainToRichText,
  propertyGlyph,
  richTextToPlain,
  rowValue,
  valueText,
} from "./properties";
import {
  OPTION_COLORS,
  addOption,
  canCreateOption,
  nextOptionColor,
  recolorOption,
  removeOption,
  renameOption,
  searchOptions,
  toggleOptionId,
} from "./options";
import {
  columnWidth,
  configOf,
  hiddenProperties,
  moveItem,
  orderedProperties,
  removeSort,
  setSort,
  sortSummary,
  toggleSortDirection,
  toggleVisibility,
} from "./viewConfig";

/* --------------------------------------------------------------- fixtures */

let seq = 0;
const ids = (): string => `id-${++seq}`;

function property(over: Partial<PropertyDef> & Pick<PropertyDef, "id" | "type">): PropertyDef {
  return {
    dataSourceId: "ds",
    name: over.name ?? over.id,
    config: over.config ?? {},
    rank: over.rank ?? "a0",
    ...over,
  };
}

const title = property({ id: "p-title", type: "title", name: "Name", rank: "a0" });
const notes = property({ id: "p-notes", type: "text", name: "Notes", rank: "a1" });
const score = property({
  id: "p-score",
  type: "number",
  name: "Score",
  rank: "a2",
  config: { numberFormat: "dollar" },
});
const OPTIONS: SelectOption[] = [
  { id: "o-1", name: "Todo", color: "gray" },
  { id: "o-2", name: "Done", color: "green" },
];
const status = property({
  id: "p-status",
  type: "select",
  name: "Status",
  rank: "a3",
  config: { options: OPTIONS },
});
const due = property({ id: "p-due", type: "date", name: "Due", rank: "a4" });
const done = property({ id: "p-done", type: "checkbox", name: "Done", rank: "a5" });

const ALL = [title, notes, score, status, due, done];
const typeOf = (id: string): PropertyDef["type"] | undefined =>
  ALL.find((p) => p.id === id)?.type;

/* -------------------------------------------------------------- properties */

describe("property metadata", () => {
  it("gives every type a glyph, with Notion's Aa / ≡ / ⊙ for the common three", () => {
    expect(propertyGlyph("title")).toBe("Aa");
    expect(propertyGlyph("text")).toBe("≡");
    expect(propertyGlyph("select")).toBe("⊙");
  });

  it("builds an empty value per type that reads as empty", () => {
    for (const p of ALL) {
      expect(isEmptyValue(emptyValue(p.type))).toBe(true);
    }
  });

  it("round-trips plain text through rich text", () => {
    expect(richTextToPlain(plainToRichText("hello"))).toBe("hello");
    expect(plainToRichText("")).toEqual([]);
    expect(richTextToPlain(undefined)).toBe("");
  });

  it("reads a row's title from the page, which is where core mirrors it", () => {
    const row: RowRecord = {
      page: {
        id: "row-1",
        parentId: "owner",
        title: "Buy milk",
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
      values: {},
    };
    expect(valueText(rowValue(row, title), title)).toBe("Buy milk");
    expect(isEmptyValue(rowValue(row, notes))).toBe(true);
  });

  it("resolves select and multi-select values to option names for search", () => {
    expect(valueText({ type: "select", optionId: "o-2" }, status)).toBe("Done");
    expect(valueText({ type: "multi_select", optionIds: ["o-1", "o-2"] }, status)).toBe(
      "Todo Done",
    );
    expect(valueText({ type: "select", optionId: "gone" }, status)).toBe("");
  });
});

describe("number formatting", () => {
  it("formats per the property's numberFormat", () => {
    expect(formatNumber(1234.5, "number")).toBe("1234.5");
    expect(formatNumber(1234.5, "number_with_commas")).toBe("1,234.5");
    expect(formatNumber(12, "percent")).toBe("12%");
    expect(formatNumber(1234, "dollar")).toBe("$1,234");
    expect(formatNumber(1234, "euro")).toBe("€1,234");
    expect(formatNumber(1234, "pound")).toBe("£1,234");
    expect(formatNumber(1234, "yen")).toBe("¥1,234");
  });

  it("renders an empty cell for a cleared or non-finite number", () => {
    expect(formatNumber(null)).toBe("");
    expect(formatNumber(Number.NaN)).toBe("");
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("");
  });

  it("parses input tolerantly and clears on nonsense", () => {
    expect(parseNumber("1,234")).toBe(1234);
    expect(parseNumber("  42 ")).toBe(42);
    expect(parseNumber("-3.5")).toBe(-3.5);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });
});

describe("dates", () => {
  it("accepts YYYY-MM-DD only", () => {
    expect(parseDateInput("2026-08-19")).toBe("2026-08-19");
    expect(parseDateInput("19/08/2026")).toBeNull();
    expect(parseDateInput("")).toBeNull();
  });

  it("formats a range with an arrow and a bare date on its own", () => {
    expect(formatDateValue(null)).toBe("");
    expect(formatDateValue("2026-08-19")).not.toContain("→");
    expect(formatDateValue("2026-08-19", "2026-08-21")).toContain("→");
  });
});

/* ----------------------------------------------------------------- filters */

describe("filter operators", () => {
  it("offers only the operators core accepts for each type", () => {
    const ops = (p: PropertyDef): string[] => operatorsFor(p.type).map((o) => o.op);
    expect(ops(notes)).toContain("starts_with");
    expect(ops(notes)).not.toContain("gt");
    expect(ops(score)).toContain("gte");
    expect(ops(score)).not.toContain("contains");
    expect(ops(due)).toContain("on_or_before");
    expect(ops(status)).toEqual(["equals", "not_equals", "is_empty", "is_not_empty"]);
    // A checkbox is never "empty" — it is false.
    expect(ops(done)).toEqual(["equals", "not_equals"]);
  });

  it("seeds a typed operand, and none at all for the emptiness tests", () => {
    expect(defaultOperand("text", "contains")).toBe("");
    expect(defaultOperand("number", "gt")).toBeNull();
    expect(defaultOperand("checkbox", "equals")).toBe(true);
    expect(defaultOperand("text", "is_empty")).toBeUndefined();
    expect(defaultOperator("number")).toBe("equals");
  });
});

describe("filter chips → FilterGroup", () => {
  it("builds a chip with the type's default operator and operand", () => {
    const chip = newChip(notes, "c1");
    expect(chip).toEqual({ id: "c1", propertyId: notes.id, op: "contains", value: "" });
  });

  it("omits incomplete chips so typing never blanks the table", () => {
    const chip = newChip(notes, "c1");
    expect(isChipComplete(chip, "text")).toBe(false);
    expect(chipsToFilter([chip], typeOf)).toBeNull();

    const filled = setChipValue(chip, "milk");
    expect(isChipComplete(filled, "text")).toBe(true);
    expect(chipsToFilter([filled], typeOf)).toEqual({
      kind: "group",
      op: "and",
      children: [{ kind: "condition", propertyId: notes.id, op: "contains", value: "milk" }],
    });
  });

  it("emits an emptiness condition with no value key at all", () => {
    const chip = setChipOperator(newChip(notes, "c1"), "text", "is_empty");
    expect(chip.value).toBeUndefined();
    const group = chipsToFilter([chip], typeOf);
    expect(group?.children[0]).toEqual({
      kind: "condition",
      propertyId: notes.id,
      op: "is_empty",
    });
    expect(Object.keys(group?.children[0] ?? {})).not.toContain("value");
  });

  it("joins several chips with the chosen connective", () => {
    const a = setChipValue(newChip(notes, "c1"), "milk");
    const b = setChipValue(newChip(score, "c2"), 10);
    expect(chipsToFilter([a, b], typeOf, "or")).toEqual({
      kind: "group",
      op: "or",
      children: [
        { kind: "condition", propertyId: notes.id, op: "contains", value: "milk" },
        { kind: "condition", propertyId: score.id, op: "equals", value: 10 },
      ],
    });
  });

  it("validates the operand against the property type", () => {
    expect(isChipComplete({ id: "c", propertyId: score.id, op: "gt", value: "5" }, "number")).toBe(
      false,
    );
    expect(isChipComplete({ id: "c", propertyId: score.id, op: "gt", value: 5 }, "number")).toBe(
      true,
    );
    expect(
      isChipComplete({ id: "c", propertyId: status.id, op: "equals", value: "o-1" }, "select"),
    ).toBe(true);
    expect(
      isChipComplete({ id: "c", propertyId: done.id, op: "equals", value: true }, "checkbox"),
    ).toBe(true);
  });

  it("keeps a still-valid operand when the operator changes, and drops it otherwise", () => {
    const filled = setChipValue(newChip(notes, "c1"), "milk");
    expect(setChipOperator(filled, "text", "equals").value).toBe("milk");
    expect(setChipOperator(filled, "text", "is_not_empty").value).toBeUndefined();
  });

  it("resets the operand when the chip is re-targeted at another property", () => {
    const filled = setChipValue(newChip(notes, "c1"), "milk");
    const moved = retargetChip(filled, score);
    expect(moved.id).toBe("c1");
    expect(moved.propertyId).toBe(score.id);
    expect(moved.op).toBe("equals");
    expect(moved.value).toBeNull();
  });

  it("hydrates chips back out of a stored flat group", () => {
    const stored = chipsToFilter([setChipValue(newChip(notes, "c1"), "milk")], typeOf, "or");
    const back = filterToChips(stored, ids);
    expect(back.connective).toBe("or");
    expect(back.nested).toBe(false);
    expect(back.chips).toHaveLength(1);
    expect(back.chips[0]?.propertyId).toBe(notes.id);
    expect(back.chips[0]?.value).toBe("milk");
  });

  it("flags a nested tree instead of silently flattening it", () => {
    const back = filterToChips(
      {
        kind: "group",
        op: "and",
        children: [
          { kind: "condition", propertyId: notes.id, op: "contains", value: "a" },
          { kind: "group", op: "or", children: [] },
        ],
      },
      ids,
    );
    expect(back.nested).toBe(true);
    expect(back.chips).toHaveLength(1);
  });

  it("summarises the chip count for the toolbar button", () => {
    expect(filterSummary([])).toBe("Filter");
    expect(filterSummary([newChip(notes, "c1")])).toBe("1 filter");
    expect(filterSummary([newChip(notes, "c1"), newChip(score, "c2")])).toBe("2 filters");
  });
});

/* ----------------------------------------------------------------- options */

describe("select options", () => {
  it("walks the palette rather than picking a random colour", () => {
    expect(nextOptionColor([])).toBe(OPTION_COLORS[0]);
    expect(nextOptionColor(OPTIONS)).toBe(OPTION_COLORS[2]);
  });

  it("creates an option with an auto colour and a stable id", () => {
    const result = addOption(OPTIONS, "  In progress ", ids);
    expect(result.existed).toBe(false);
    expect(result.options).toHaveLength(3);
    expect(result.option.name).toBe("In progress");
    expect(result.option.color).toBe(OPTION_COLORS[2]);
    // The input list is never mutated.
    expect(OPTIONS).toHaveLength(2);
  });

  it("reuses an existing option rather than duplicating it by case", () => {
    const result = addOption(OPTIONS, "done", ids);
    expect(result.existed).toBe(true);
    expect(result.option.id).toBe("o-2");
    expect(result.options).toHaveLength(2);
  });

  it("renames, recolours and removes by id", () => {
    expect(renameOption(OPTIONS, "o-1", " Later ")[0]?.name).toBe("Later");
    expect(recolorOption(OPTIONS, "o-1", "red")[0]?.color).toBe("red");
    expect(removeOption(OPTIONS, "o-1").map((o) => o.id)).toEqual(["o-2"]);
  });

  it("searches case-insensitively and offers creation only for a new name", () => {
    expect(searchOptions(OPTIONS, "DO").map((o) => o.id)).toEqual(["o-1", "o-2"]);
    expect(searchOptions(OPTIONS, "done").map((o) => o.id)).toEqual(["o-2"]);
    expect(canCreateOption(OPTIONS, "Done")).toBe(false);
    expect(canCreateOption(OPTIONS, "Blocked")).toBe(true);
    expect(canCreateOption(OPTIONS, "   ")).toBe(false);
  });

  it("toggles a multi-select id while preserving selection order", () => {
    expect(toggleOptionId(["o-1"], "o-2")).toEqual(["o-1", "o-2"]);
    expect(toggleOptionId(["o-1", "o-2"], "o-1")).toEqual(["o-2"]);
  });
});

/* -------------------------------------------------------------- viewConfig */

describe("view config", () => {
  const base = (over: Partial<ViewConfig> = {}): ViewConfig => ({ ...configOf(null), ...over });

  it("fills in every optional field of a partial config", () => {
    const config = configOf(null);
    expect(config).toEqual({
      filter: null,
      sorts: [],
      visibleProperties: null,
      propertyWidths: {},
      openMode: "center_peek",
    });
  });

  it("null visibleProperties means every property in schema order, title first", () => {
    const shuffled = [score, title, notes];
    expect(orderedProperties(shuffled, base()).map((p) => p.id)).toEqual([
      title.id,
      notes.id,
      score.id,
    ]);
  });

  it("an explicit list pins the title and honours the stored order", () => {
    const config = base({ visibleProperties: [score.id, notes.id] });
    expect(orderedProperties(ALL, config).map((p) => p.id)).toEqual([title.id, score.id, notes.id]);
    expect(hiddenProperties(ALL, config).map((p) => p.id)).toEqual([status.id, due.id, done.id]);
  });

  it("hiding materialises the list; showing puts the column back in schema order", () => {
    const hiddenNotes = toggleVisibility(ALL, base(), notes.id);
    expect(hiddenNotes).not.toContain(notes.id);
    const shown = toggleVisibility(ALL, base({ visibleProperties: hiddenNotes }), notes.id);
    expect(shown).toEqual([notes.id, score.id, status.id, due.id, done.id]);
  });

  it("clamps stored column widths and defaults the title wider", () => {
    expect(columnWidth(base(), title)).toBeGreaterThan(columnWidth(base(), notes));
    expect(columnWidth(base({ propertyWidths: { [notes.id]: 4 } }), notes)).toBe(88);
    expect(columnWidth(base({ propertyWidths: { [notes.id]: 5000 } }), notes)).toBe(720);
    expect(columnWidth(base({ propertyWidths: { [notes.id]: 200 } }), notes)).toBe(200);
  });

  it("moves an item without mutating the source", () => {
    const items = ["a", "b", "c"];
    expect(moveItem(items, 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(items, 0, 99)).toEqual(["b", "c", "a"]);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("keeps one sort entry per property and can flip or drop it", () => {
    const first = setSort([], notes.id, "asc");
    const replaced = setSort(first, notes.id, "desc");
    expect(replaced).toEqual([{ propertyId: notes.id, direction: "desc" }]);
    expect(toggleSortDirection(replaced, 0)[0]?.direction).toBe("asc");
    expect(removeSort(replaced, notes.id)).toEqual([]);
    expect(sortSummary(replaced)).toBe("1 sort");
    expect(sortSummary([])).toBe("Sort");
  });
});
