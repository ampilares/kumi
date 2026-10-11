/**
 * Filter chips ⇄ `FilterGroup`.
 *
 * The toolbar edits a *flat* list of conditions joined by one connective —
 * exactly what Notion's chip row is — while storage holds the general nested
 * tree. Converting in both directions here keeps the UI honest about what it
 * can express: `filterToChips` refuses to flatten a genuinely nested tree
 * (written by the CLI or a later phase) and the chip row goes read-only rather
 * than silently rewriting it.
 *
 * OPERAND SHAPES — one per property type, the same JSON the CLI would write:
 *   text/url/email/phone  string
 *   number                number
 *   select/multi_select   option id (string)
 *   date                  `YYYY-MM-DD`
 *   checkbox              boolean
 *   relation              related row page id (string)
 *   rollup                number for numeric aggregations, string otherwise
 * `is_empty` / `is_not_empty` carry no operand at all.
 */

import type {
  FilterCondition,
  FilterGroup,
  FilterNode,
  FilterOperator,
  PropertyDef,
  PropertyType,
} from "@kumi/core";
import { NUMERIC_AGGREGATIONS, rollupConfigOf } from "./properties";

/** Operators whose operand is a number when the property yields numbers. */
const NUMERIC_OPS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
]);

export interface OperatorInfo {
  op: FilterOperator;
  label: string;
  /** False for the emptiness tests, which take no value. */
  needsOperand: boolean;
}

const EMPTINESS: OperatorInfo[] = [
  { op: "is_empty", label: "Is empty", needsOperand: false },
  { op: "is_not_empty", label: "Is not empty", needsOperand: false },
];

const TEXT_OPS: OperatorInfo[] = [
  { op: "contains", label: "Contains", needsOperand: true },
  { op: "not_contains", label: "Does not contain", needsOperand: true },
  { op: "equals", label: "Is", needsOperand: true },
  { op: "not_equals", label: "Is not", needsOperand: true },
  { op: "starts_with", label: "Starts with", needsOperand: true },
  { op: "ends_with", label: "Ends with", needsOperand: true },
  ...EMPTINESS,
];

const NUMBER_OPS: OperatorInfo[] = [
  { op: "equals", label: "=", needsOperand: true },
  { op: "not_equals", label: "≠", needsOperand: true },
  { op: "gt", label: ">", needsOperand: true },
  { op: "gte", label: "≥", needsOperand: true },
  { op: "lt", label: "<", needsOperand: true },
  { op: "lte", label: "≤", needsOperand: true },
  ...EMPTINESS,
];

const SELECT_OPS: OperatorInfo[] = [
  { op: "equals", label: "Is", needsOperand: true },
  { op: "not_equals", label: "Is not", needsOperand: true },
  ...EMPTINESS,
];

const MULTI_OPS: OperatorInfo[] = [
  { op: "contains", label: "Contains", needsOperand: true },
  { op: "not_contains", label: "Does not contain", needsOperand: true },
  ...EMPTINESS,
];

const DATE_OPS: OperatorInfo[] = [
  { op: "equals", label: "Is", needsOperand: true },
  { op: "before", label: "Is before", needsOperand: true },
  { op: "after", label: "Is after", needsOperand: true },
  { op: "on_or_before", label: "Is on or before", needsOperand: true },
  { op: "on_or_after", label: "Is on or after", needsOperand: true },
  ...EMPTINESS,
];

const CHECKBOX_OPS: OperatorInfo[] = [
  { op: "equals", label: "Is", needsOperand: true },
  { op: "not_equals", label: "Is not", needsOperand: true },
];

/**
 * Relation filters name a *row*, not a string: `contains` / `not_contains`
 * carry a page id, and core rejects anything else. Nothing text-like is
 * offered, because "contains 'mil'" over row titles is not a thing core does.
 */
const RELATION_OPS: OperatorInfo[] = [
  { op: "contains", label: "Contains", needsOperand: true },
  { op: "not_contains", label: "Does not contain", needsOperand: true },
  ...EMPTINESS,
];

/**
 * Core filters a rollup by the *number* it computes and rejects every operator
 * — the emptiness tests included — on a non-numeric one. So a `show_originals`
 * or date-valued rollup offers nothing at all rather than offering chips that
 * would come back as a red toast.
 */
const NO_OPS: OperatorInfo[] = [];

export function operatorsFor(type: PropertyType): OperatorInfo[] {
  switch (type) {
    case "number":
      return NUMBER_OPS;
    case "select":
      return SELECT_OPS;
    case "multi_select":
      return MULTI_OPS;
    case "date":
      return DATE_OPS;
    case "checkbox":
      return CHECKBOX_OPS;
    case "relation":
      return RELATION_OPS;
    case "rollup":
      // Without the property we cannot know the aggregation; assume the common
      // numeric case. `operatorsForProperty` is the accurate entry point.
      return NUMBER_OPS;
    default:
      return TEXT_OPS;
  }
}

/**
 * Operators for a concrete property. Identical to `operatorsFor` except for
 * rollups, where the *aggregation* decides: numeric aggregations filter with
 * the numeric comparisons, `show_originals` and date min/max do not.
 */
export function operatorsForProperty(
  property: PropertyDef,
  /** Type of the rolled-up target property, when the caller can resolve it. */
  targetType?: PropertyType | null,
): OperatorInfo[] {
  if (property.type !== "rollup") return operatorsFor(property.type);
  const aggregation = rollupConfigOf(property)?.aggregation ?? "count";
  if (NUMERIC_AGGREGATIONS.has(aggregation)) return NUMBER_OPS;
  if (aggregation === "min" || aggregation === "max") {
    // min/max is numeric over numbers and a date over dates; without the target
    // property's type the numeric comparisons are the safe default, and core's
    // date-valued rollups are not filterable at all.
    return targetType === "date" ? NO_OPS : NUMBER_OPS;
  }
  return NO_OPS;
}

/** False when a property cannot be filtered at all, so the menu can hide it. */
export function isFilterable(property: PropertyDef, targetType?: PropertyType | null): boolean {
  return operatorsForProperty(property, targetType).length > 0;
}

/**
 * Core refuses to sort by a relation (no natural order) or by a
 * `show_originals` rollup (a list, not a scalar). The sort menu hides both.
 */
export function isSortable(property: PropertyDef): boolean {
  if (property.type === "relation") return false;
  if (property.type !== "rollup") return true;
  return rollupConfigOf(property)?.aggregation !== "show_originals";
}

export function operatorInfo(type: PropertyType, op: FilterOperator): OperatorInfo | undefined {
  return operatorsFor(type).find((info) => info.op === op);
}

export function operatorLabel(type: PropertyType, op: FilterOperator): string {
  return operatorInfo(type, op)?.label ?? op.replace(/_/g, " ");
}

export function defaultOperator(type: PropertyType): FilterOperator {
  return operatorsFor(type)[0]?.op ?? "equals";
}

/**
 * Whether an operator takes an operand at all. Decided by the operator rather
 * than by looking it up in a per-type list, so a rollup — whose operator set
 * depends on its aggregation — never loses its operand on a type mismatch.
 */
export function needsOperand(op: FilterOperator): boolean {
  return op !== "is_empty" && op !== "is_not_empty";
}

/** The operand a freshly added chip starts with — `undefined` when it takes none. */
export function defaultOperand(type: PropertyType, op: FilterOperator): unknown {
  if (!needsOperand(op)) return undefined;
  switch (type) {
    case "number":
      return null;
    case "checkbox":
      return true;
    case "select":
    case "multi_select":
      return null;
    case "date":
      return "";
    case "relation":
      // A page id, chosen from the row picker — never typed.
      return "";
    case "rollup":
      return NUMERIC_OPS.has(op) ? null : "";
    default:
      return "";
  }
}

/* ------------------------------------------------------------------- chips */

export interface FilterChip {
  /** Client-side identity so React keys survive edits and reordering. */
  id: string;
  propertyId: string;
  op: FilterOperator;
  /** Absent for the emptiness operators. */
  value?: unknown;
}

export function newChip(property: PropertyDef, id: string): FilterChip {
  const op = operatorsForProperty(property)[0]?.op ?? defaultOperator(property.type);
  const operand = defaultOperand(property.type, op);
  return operand === undefined
    ? { id, propertyId: property.id, op }
    : { id, propertyId: property.id, op, value: operand };
}

/**
 * A chip is only sent to core once its operand is usable — a half-typed filter
 * must not empty the table.
 */
export function isChipComplete(chip: FilterChip, type: PropertyType): boolean {
  if (!needsOperand(chip.op)) return true;
  const value = chip.value;
  switch (type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "checkbox":
      return typeof value === "boolean";
    case "rollup":
      return NUMERIC_OPS.has(chip.op)
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === "string" && value !== "";
    default:
      return typeof value === "string" && value !== "";
  }
}

/** Re-target a chip at another property, resetting whatever no longer applies. */
export function retargetChip(chip: FilterChip, property: PropertyDef): FilterChip {
  return { ...newChip(property, chip.id) };
}

/** Change a chip's operator, dropping or seeding its operand as needed. */
export function setChipOperator(
  chip: FilterChip,
  type: PropertyType,
  op: FilterOperator,
): FilterChip {
  if (!needsOperand(op)) return { id: chip.id, propertyId: chip.propertyId, op };
  const keep = chip.value !== undefined && isChipComplete({ ...chip, op }, type);
  return {
    id: chip.id,
    propertyId: chip.propertyId,
    op,
    value: keep ? chip.value : defaultOperand(type, op),
  };
}

export function setChipValue(chip: FilterChip, value: unknown): FilterChip {
  return { ...chip, value };
}

/* --------------------------------------------------------- chips ⇄ storage */

export function chipToCondition(chip: FilterChip): FilterCondition {
  const condition: FilterCondition = { kind: "condition", propertyId: chip.propertyId, op: chip.op };
  if (chip.value !== undefined) condition.value = chip.value;
  return condition;
}

/**
 * The `FilterGroup` for a chip row, or null when nothing usable is set. Only
 * complete chips are emitted, so typing into an operand never blanks the table.
 */
export function chipsToFilter(
  chips: FilterChip[],
  typeOf: (propertyId: string) => PropertyType | undefined,
  connective: "and" | "or" = "and",
): FilterGroup | null {
  const children: FilterNode[] = [];
  for (const chip of chips) {
    const type = typeOf(chip.propertyId);
    if (type === undefined || !isChipComplete(chip, type)) continue;
    children.push(chipToCondition(chip));
  }
  return children.length === 0 ? null : { kind: "group", op: connective, children };
}

export interface ChipsFromFilter {
  chips: FilterChip[];
  connective: "and" | "or";
  /** True when the stored tree is nested and the chip row cannot represent it. */
  nested: boolean;
}

export function filterToChips(
  filter: FilterGroup | null | undefined,
  makeId: () => string,
): ChipsFromFilter {
  if (!filter || !Array.isArray(filter.children)) {
    return { chips: [], connective: "and", nested: false };
  }
  const chips: FilterChip[] = [];
  let nested = false;
  for (const child of filter.children) {
    if (child.kind !== "condition") {
      nested = true;
      continue;
    }
    const chip: FilterChip = { id: makeId(), propertyId: child.propertyId, op: child.op };
    if (child.value !== undefined) chip.value = child.value;
    chips.push(chip);
  }
  return { chips, connective: filter.op === "or" ? "or" : "and", nested };
}

/** Human summary shown on the toolbar's filter button ("2 filters"). */
export function filterSummary(chips: FilterChip[]): string {
  if (chips.length === 0) return "Filter";
  return chips.length === 1 ? "1 filter" : `${chips.length} filters`;
}
