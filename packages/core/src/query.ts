/**
 * The query engine: filter trees, typed sorting and pagination over row
 * records that the command layer has already materialised.
 *
 * Correctness first — rows for one data source are fetched with two queries
 * (pages + values) and evaluated in JS. Pushing filters into SQL is a later
 * optimisation; the shapes here (`RowRecord[]` in, `RowRecord[]` out) do not
 * change when it happens.
 *
 * Loud, never silent: an unknown property id, an operator the property type
 * does not support, or an operand of the wrong shape throws `invalid` rather
 * than quietly matching nothing — an agent must be told its query is wrong.
 *
 * Operand shapes per property type
 * --------------------------------
 * - title/text/url/email/phone — `string` (comparisons are case-insensitive)
 * - number                     — `number`
 * - checkbox                   — `boolean`
 * - select                     — option id `string` (must exist on the property)
 * - multi_select               — `contains`/`not_contains`: one option id;
 *                                `equals`/`not_equals`: an option id or an
 *                                array of them, compared as a set
 * - date                       — ISO `string` (`YYYY-MM-DD` or full ISO)
 * - relation                   — `contains`/`not_contains`: one related row
 *                                page id; `equals`/`not_equals`: a page id or
 *                                an array of them, compared as a set. Sorting
 *                                by a relation is invalid.
 * - rollup                     — the operand of the value it computes, i.e. a
 *                                `number`. Only numeric aggregations are
 *                                filterable/sortable numerically; date
 *                                `min`/`max` sort chronologically and reject
 *                                every operator; `show_originals` rejects both.
 * - is_empty / is_not_empty    — no operand, every type except a non-numeric
 *                                rollup
 */

import { invalid } from "./errors";
import type {
  FilterCondition,
  FilterNode,
  FilterOperator,
  Id,
  PropertyDef,
  PropertyType,
  PropertyValue,
  RowRecord,
  SortSpec,
} from "./types";
import {
  dateMs,
  isEmptyValue,
  isNumericAggregation,
  optionOrder,
  plainTextOf,
  rollupConfigOf,
  rollupKind,
  type RollupKind,
} from "./values";

export const DEFAULT_QUERY_LIMIT = 100;
export const MAX_QUERY_LIMIT = 500;

const STRING_TYPES: readonly PropertyType[] = [
  "title",
  "text",
  "url",
  "email",
  "phone",
];

/** Which property types each operator accepts. */
const OPERATOR_TYPES: Record<FilterOperator, readonly PropertyType[] | "all"> = {
  equals: "all",
  not_equals: "all",
  contains: [...STRING_TYPES, "multi_select", "relation"],
  not_contains: [...STRING_TYPES, "multi_select", "relation"],
  starts_with: STRING_TYPES,
  ends_with: STRING_TYPES,
  is_empty: "all",
  is_not_empty: "all",
  gt: ["number", "rollup"],
  gte: ["number", "rollup"],
  lt: ["number", "rollup"],
  lte: ["number", "rollup"],
  before: ["date"],
  after: ["date"],
  on_or_before: ["date"],
  on_or_after: ["date"],
};

/** The operators a numeric rollup accepts; every other one is invalid. */
const ROLLUP_OPERATORS: readonly FilterOperator[] = [
  "equals",
  "not_equals",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_empty",
  "is_not_empty",
];

export type PropertyIndex = ReadonlyMap<Id, PropertyDef>;

/**
 * Extra facts the engine cannot derive from a data source's own properties: a
 * rollup's target property lives on the *related* data source, and its type
 * decides whether `min`/`max` are numbers or dates. The command layer resolves
 * it; an absent entry means "no target" (or a dangling one).
 */
export interface QueryContext {
  rollupTargetTypes?: ReadonlyMap<Id, PropertyType>;
}

function requireProperty(properties: PropertyIndex, id: Id): PropertyDef {
  const prop = properties.get(id);
  if (prop === undefined) {
    throw invalid(`unknown property in query: ${id}`);
  }
  return prop;
}

/** The value shape a rollup property produces, given the resolved target type. */
function kindOfRollup(prop: PropertyDef, ctx: QueryContext | undefined): RollupKind {
  const config = rollupConfigOf(prop.config);
  if (config === null) return "number";
  return rollupKind(
    config.aggregation,
    ctx?.rollupTargetTypes?.get(prop.id) ?? null,
  );
}

function assertOperator(
  prop: PropertyDef,
  op: FilterOperator,
  ctx: QueryContext | undefined,
): void {
  const allowed = OPERATOR_TYPES[op];
  if (allowed === undefined) throw invalid(`unknown filter operator: ${String(op)}`);
  if (prop.type === "rollup") {
    const config = rollupConfigOf(prop.config);
    const numeric =
      config !== null &&
      isNumericAggregation(
        config.aggregation,
        ctx?.rollupTargetTypes?.get(prop.id) ?? null,
      );
    if (!numeric || !ROLLUP_OPERATORS.includes(op)) {
      throw invalid(
        `filter operator ${op} does not apply to rollup property "${prop.name}" (${prop.id}); only ${ROLLUP_OPERATORS.join("/")} on a numeric aggregation are supported`,
      );
    }
    return;
  }
  if (allowed === "all") return;
  if (!allowed.includes(prop.type)) {
    throw invalid(
      `filter operator ${op} does not apply to property "${prop.name}" (${prop.id}) of type ${prop.type}`,
    );
  }
}

function operandString(c: FilterCondition): string {
  if (typeof c.value !== "string") {
    throw invalid(
      `filter ${c.op} on property ${c.propertyId} needs a string value`,
    );
  }
  return c.value;
}

function operandNumber(c: FilterCondition): number {
  if (typeof c.value !== "number" || !Number.isFinite(c.value)) {
    throw invalid(
      `filter ${c.op} on property ${c.propertyId} needs a finite number value`,
    );
  }
  return c.value;
}

function operandBoolean(c: FilterCondition): boolean {
  if (typeof c.value !== "boolean") {
    throw invalid(
      `filter ${c.op} on property ${c.propertyId} needs a boolean value`,
    );
  }
  return c.value;
}

function operandDateMs(c: FilterCondition): number {
  const raw = operandString(c);
  const ms = dateMs(raw);
  if (ms === null) {
    throw invalid(
      `filter ${c.op} on property ${c.propertyId} needs an ISO date value, got ${JSON.stringify(raw)}`,
    );
  }
  return ms;
}

function operandOptionId(c: FilterCondition, prop: PropertyDef): Id {
  const id = operandString(c);
  if (!optionOrder(prop.config).has(id)) {
    throw invalid(`property "${prop.name}" (${prop.id}) has no option ${id}`);
  }
  return id;
}

function operandOptionIds(c: FilterCondition, prop: PropertyDef): Id[] {
  const known = optionOrder(prop.config);
  const raw = Array.isArray(c.value) ? c.value : [c.value];
  return raw.map((entry) => {
    if (typeof entry !== "string") {
      throw invalid(
        `filter ${c.op} on property ${c.propertyId} needs option ids`,
      );
    }
    if (!known.has(entry)) {
      throw invalid(`property "${prop.name}" (${prop.id}) has no option ${entry}`);
    }
    return entry;
  });
}

/** A related row page id operand: `contains` / `not_contains` on a relation. */
function operandPageId(c: FilterCondition): Id {
  const id = operandString(c);
  if (id === "") {
    throw invalid(
      `filter ${c.op} on property ${c.propertyId} needs a related row page id`,
    );
  }
  return id;
}

/** A set of related row page ids: `equals` / `not_equals` on a relation. */
function operandPageIds(c: FilterCondition): Id[] {
  const raw = Array.isArray(c.value) ? c.value : [c.value];
  return raw.map((entry) => {
    if (typeof entry !== "string" || entry === "") {
      throw invalid(
        `filter ${c.op} on property ${c.propertyId} needs related row page ids`,
      );
    }
    return entry;
  });
}

const lower = (text: string): string => text.toLowerCase();

function valueText(value: PropertyValue | undefined, prop: PropertyDef): string {
  return value === undefined ? "" : plainTextOf(value, prop.config);
}

/** The numeric projection of a value: a number cell, or a rollup's number. */
function valueNumber(value: PropertyValue | undefined): number | null {
  if (value === undefined) return null;
  if (value.type === "number") return value.number;
  if (value.type === "rollup") return value.number ?? null;
  return null;
}

function valueDateMs(value: PropertyValue | undefined): number | null {
  if (value === undefined) return null;
  if (value.type === "rollup") {
    const start = value.date?.start;
    return start === null || start === undefined ? null : dateMs(start);
  }
  if (value.type !== "date") return null;
  return value.start === null || value.start === undefined
    ? null
    : dateMs(value.start);
}

function valueRelationIds(value: PropertyValue | undefined): Id[] {
  return value !== undefined && value.type === "relation" ? value.pageIds : [];
}

function valueOptionIds(value: PropertyValue | undefined): Id[] {
  if (value === undefined) return [];
  if (value.type === "select") return value.optionId === null ? [] : [value.optionId];
  if (value.type === "multi_select") return value.optionIds;
  return [];
}

function valueChecked(value: PropertyValue | undefined): boolean {
  return value !== undefined && value.type === "checkbox" && value.checked;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const entry of left) if (!right.has(entry)) return false;
  return true;
}

/** `equals` semantics per type; `not_equals` is its negation. */
function equalsValue(
  c: FilterCondition,
  prop: PropertyDef,
  value: PropertyValue | undefined,
): boolean {
  switch (prop.type) {
    case "title":
    case "text":
    case "url":
    case "email":
    case "phone":
      return lower(valueText(value, prop)) === lower(operandString(c));
    case "number": {
      const operand = operandNumber(c);
      const actual = valueNumber(value);
      return actual !== null && actual === operand;
    }
    case "checkbox":
      return valueChecked(value) === operandBoolean(c);
    case "select": {
      const operand = operandOptionId(c, prop);
      return valueOptionIds(value)[0] === operand;
    }
    case "multi_select":
      return sameSet(valueOptionIds(value), operandOptionIds(c, prop));
    case "date": {
      const operand = operandDateMs(c);
      const actual = valueDateMs(value);
      return actual !== null && actual === operand;
    }
    case "relation":
      return sameSet(valueRelationIds(value), operandPageIds(c));
    case "rollup": {
      // Only numeric aggregations reach here; assertOperator rejects the rest.
      const operand = operandNumber(c);
      const actual = valueNumber(value);
      return actual !== null && actual === operand;
    }
  }
}

function compareDate(
  c: FilterCondition,
  value: PropertyValue | undefined,
  test: (actual: number, operand: number) => boolean,
): boolean {
  const actual = valueDateMs(value);
  const operand = operandDateMs(c);
  return actual !== null && test(actual, operand);
}

function compareNumber(
  c: FilterCondition,
  value: PropertyValue | undefined,
  test: (actual: number, operand: number) => boolean,
): boolean {
  const actual = valueNumber(value);
  const operand = operandNumber(c);
  return actual !== null && test(actual, operand);
}

function matchesCondition(
  c: FilterCondition,
  properties: PropertyIndex,
  row: RowRecord,
  ctx: QueryContext | undefined,
): boolean {
  const prop = requireProperty(properties, c.propertyId);
  assertOperator(prop, c.op, ctx);
  const value = row.values[c.propertyId];

  switch (c.op) {
    case "equals":
      return equalsValue(c, prop, value);
    case "not_equals":
      return !equalsValue(c, prop, value);
    case "is_empty":
      return isEmptyValue(value);
    case "is_not_empty":
      return !isEmptyValue(value);
    case "contains":
      if (prop.type === "relation") {
        return valueRelationIds(value).includes(operandPageId(c));
      }
      return prop.type === "multi_select"
        ? valueOptionIds(value).includes(operandOptionId(c, prop))
        : lower(valueText(value, prop)).includes(lower(operandString(c)));
    case "not_contains":
      if (prop.type === "relation") {
        return !valueRelationIds(value).includes(operandPageId(c));
      }
      return prop.type === "multi_select"
        ? !valueOptionIds(value).includes(operandOptionId(c, prop))
        : !lower(valueText(value, prop)).includes(lower(operandString(c)));
    case "starts_with":
      return lower(valueText(value, prop)).startsWith(lower(operandString(c)));
    case "ends_with":
      return lower(valueText(value, prop)).endsWith(lower(operandString(c)));
    case "gt":
      return compareNumber(c, value, (a, b) => a > b);
    case "gte":
      return compareNumber(c, value, (a, b) => a >= b);
    case "lt":
      return compareNumber(c, value, (a, b) => a < b);
    case "lte":
      return compareNumber(c, value, (a, b) => a <= b);
    case "before":
      return compareDate(c, value, (a, b) => a < b);
    case "after":
      return compareDate(c, value, (a, b) => a > b);
    case "on_or_before":
      return compareDate(c, value, (a, b) => a <= b);
    case "on_or_after":
      return compareDate(c, value, (a, b) => a >= b);
  }
}

function matchesNode(
  node: FilterNode,
  properties: PropertyIndex,
  row: RowRecord,
  ctx: QueryContext | undefined,
): boolean {
  if (node.kind === "group") {
    if (!Array.isArray(node.children)) {
      throw invalid("filter group `children` must be an array");
    }
    if (node.op !== "and" && node.op !== "or") {
      throw invalid(`unknown filter group operator: ${String(node.op)}`);
    }
    // An empty group matches everything (and) / nothing (or), matching the
    // identity element of the operator.
    if (node.op === "and") {
      return node.children.every((child) =>
        matchesNode(child, properties, row, ctx),
      );
    }
    return node.children.some((child) => matchesNode(child, properties, row, ctx));
  }
  if (node.kind !== "condition") {
    throw invalid(`unknown filter node kind: ${String((node as { kind: unknown }).kind)}`);
  }
  return matchesCondition(node, properties, row, ctx);
}

/** Rows matching `filter`; a null filter matches everything. */
export function filterRows(
  rows: RowRecord[],
  properties: PropertyIndex,
  filter: FilterNode | null | undefined,
  ctx?: QueryContext,
): RowRecord[] {
  if (filter === null || filter === undefined) return rows;
  return rows.filter((row) => matchesNode(filter, properties, row, ctx));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/**
 * Typed comparison of one property across two rows.
 *
 * Missing values sort last in **both** directions, so the caller's `direction`
 * is applied only to the present-vs-present comparison. `checkbox` has no
 * missing state: false sorts before true.
 */
/**
 * Reject sorts the engine cannot order: a relation has no natural order, and
 * `show_originals` produces a list rather than a scalar.
 */
function assertSortable(prop: PropertyDef, ctx: QueryContext | undefined): void {
  if (prop.type === "relation") {
    throw invalid(
      `cannot sort by relation property "${prop.name}" (${prop.id}); relations have no order`,
    );
  }
  if (prop.type === "rollup" && kindOfRollup(prop, ctx) === "values") {
    throw invalid(
      `cannot sort by rollup property "${prop.name}" (${prop.id}); show_originals produces a list, not a scalar`,
    );
  }
}

function compareValues(
  prop: PropertyDef,
  a: PropertyValue | undefined,
  b: PropertyValue | undefined,
  direction: 1 | -1,
  kind: RollupKind | null,
): number {
  if (prop.type === "checkbox") {
    const left = valueChecked(a) ? 1 : 0;
    const right = valueChecked(b) ? 1 : 0;
    return (left - right) * direction;
  }

  const aMissing = isEmptyValue(a);
  const bMissing = isEmptyValue(b);
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;

  switch (prop.type) {
    case "number": {
      const left = valueNumber(a) ?? 0;
      const right = valueNumber(b) ?? 0;
      return (left - right) * direction;
    }
    case "date": {
      const left = valueDateMs(a) ?? 0;
      const right = valueDateMs(b) ?? 0;
      return (left - right) * direction;
    }
    case "select": {
      const order = optionOrder(prop.config);
      const left = order.get(valueOptionIds(a)[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
      const right = order.get(valueOptionIds(b)[0] ?? "") ?? Number.MAX_SAFE_INTEGER;
      return (left - right) * direction;
    }
    case "rollup": {
      // Numeric aggregations sort numerically, date min/max chronologically;
      // `show_originals` was rejected by assertSortable.
      if (kind === "date") {
        return ((valueDateMs(a) ?? 0) - (valueDateMs(b) ?? 0)) * direction;
      }
      return ((valueNumber(a) ?? 0) - (valueNumber(b) ?? 0)) * direction;
    }
    default: {
      const left = valueText(a, prop);
      const right = valueText(b, prop);
      const cmp = left.localeCompare(right, undefined, { sensitivity: "base" });
      return cmp * direction;
    }
  }
}

/**
 * Stable multi-key sort. Ties keep the incoming order (rank order), so a query
 * with no sorts — or with sorts that do not discriminate — returns rows in
 * their stored order.
 */
export function sortRows(
  rows: RowRecord[],
  properties: PropertyIndex,
  sorts: readonly SortSpec[] | undefined,
  ctx?: QueryContext,
): RowRecord[] {
  if (sorts === undefined || sorts.length === 0) return rows;
  const specs = sorts.map((sort) => {
    const prop = requireProperty(properties, sort.propertyId);
    assertSortable(prop, ctx);
    return {
      prop,
      direction: (sort.direction === "desc" ? -1 : 1) as 1 | -1,
      kind: prop.type === "rollup" ? kindOfRollup(prop, ctx) : null,
    };
  });

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      for (const spec of specs) {
        const cmp = compareValues(
          spec.prop,
          left.row.values[spec.prop.id],
          right.row.values[spec.prop.id],
          spec.direction,
          spec.kind,
        );
        if (cmp !== 0) return cmp;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}

/** Clamp pagination: limit 1..500 (default 100), offset >= 0. */
export function clampPagination(limit?: number, offset?: number): {
  limit: number;
  offset: number;
} {
  const rawLimit = limit === undefined ? DEFAULT_QUERY_LIMIT : Math.trunc(limit);
  const rawOffset = offset === undefined ? 0 : Math.trunc(offset);
  return {
    limit: Math.min(Math.max(1, rawLimit), MAX_QUERY_LIMIT),
    offset: Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0),
  };
}
