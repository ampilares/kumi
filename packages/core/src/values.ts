/**
 * Typed property values: validation, projection and conversion.
 *
 * Two rules drive everything here:
 *
 * - **Values are never coerced on write.** A write whose variant does not match
 *   the property's type, or that names an option the property does not define,
 *   or that carries a non-ISO date, is rejected as `invalid`. Accepted values
 *   are stored verbatim (unknown extra keys survive round-trip).
 * - **Retyping a property converts conservatively.** Anything that cannot be
 *   represented in the new type is dropped (the stored cell is deleted) rather
 *   than guessed at. Raw preservation for import lands in Phase 7.
 */

import { invalid } from "./errors";
import { richTextToPlain } from "./text";
import type {
  Id,
  PropertyConfig,
  PropertyDef,
  PropertyType,
  PropertyValue,
  RelationConfig,
  RichText,
  RollupAggregation,
  RollupConfig,
  SelectOption,
} from "./types";

/** Every property type the storage layer accepts, for runtime validation. */
export const PROPERTY_TYPES: readonly PropertyType[] = [
  "title",
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "relation",
  "rollup",
];

/** Every rollup aggregation the storage layer accepts. */
export const ROLLUP_AGGREGATIONS: readonly RollupAggregation[] = [
  "count",
  "count_values",
  "sum",
  "avg",
  "min",
  "max",
  "show_originals",
];

const ROLLUP_AGGREGATION_SET = new Set<string>(ROLLUP_AGGREGATIONS);

/**
 * Aggregations whose result is always a number, whatever the target type.
 * `min`/`max` are the exception: they follow their target (number or date).
 */
const NUMERIC_AGGREGATIONS: readonly RollupAggregation[] = [
  "count",
  "count_values",
  "sum",
  "avg",
];

const PROPERTY_TYPE_SET = new Set<string>(PROPERTY_TYPES);

/** Types whose value is a single free string (or rich text flattened to one). */
const STRING_LIKE: readonly PropertyType[] = [
  "title",
  "text",
  "url",
  "email",
  "phone",
];

export function isStringLike(type: PropertyType): boolean {
  return STRING_LIKE.includes(type);
}

export function assertPropertyType(value: string): PropertyType {
  if (!PROPERTY_TYPE_SET.has(value)) {
    throw invalid(`unknown property type: ${value}`);
  }
  return value as PropertyType;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** `YYYY-MM-DD` or a full ISO-8601 datetime, and a real calendar date. */
export function isIsoDateString(value: string): boolean {
  if (!ISO_DAY.test(value) && !ISO_DATETIME.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

/** Epoch ms of an ISO date string, or null when it is not one. */
export function dateMs(value: string): number | null {
  if (!isIsoDateString(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Select options
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Well-formed options of a config; malformed entries are ignored on read. */
export function optionsOf(config: PropertyConfig): SelectOption[] {
  const raw: unknown = config.options;
  if (!Array.isArray(raw)) return [];
  const out: SelectOption[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { id, name, color } = entry;
    if (typeof id !== "string" || typeof name !== "string") continue;
    out.push({ id, name, color: typeof color === "string" ? color : "default" });
  }
  return out;
}

export function optionIdSet(config: PropertyConfig): Set<Id> {
  return new Set(optionsOf(config).map((o) => o.id));
}

/** Position of each option id in config order; used for select sorting. */
export function optionOrder(config: PropertyConfig): Map<Id, number> {
  const order = new Map<Id, number>();
  optionsOf(config).forEach((option, index) => order.set(option.id, index));
  return order;
}

export function optionName(config: PropertyConfig, id: Id): string {
  return optionsOf(config).find((o) => o.id === id)?.name ?? "";
}

// ---------------------------------------------------------------------------
// Relation & rollup configs
// ---------------------------------------------------------------------------

/**
 * The relation config of a property, or null when it is absent/malformed.
 * Referential checks (does the data source exist, is the partner really a
 * relation) belong to the command layer, which owns the database.
 */
export function relationConfigOf(config: PropertyConfig): RelationConfig | null {
  const raw: unknown = config.relation;
  if (!isRecord(raw)) return null;
  const { dataSourceId, pairedPropertyId } = raw;
  if (typeof dataSourceId !== "string" || dataSourceId === "") return null;
  return {
    dataSourceId,
    pairedPropertyId:
      typeof pairedPropertyId === "string" && pairedPropertyId !== ""
        ? pairedPropertyId
        : null,
  };
}

/** The rollup config of a property, or null when it is absent/malformed. */
export function rollupConfigOf(config: PropertyConfig): RollupConfig | null {
  const raw: unknown = config.rollup;
  if (!isRecord(raw)) return null;
  const { relationPropertyId, targetPropertyId, aggregation } = raw;
  if (typeof relationPropertyId !== "string" || relationPropertyId === "") return null;
  if (typeof aggregation !== "string" || !ROLLUP_AGGREGATION_SET.has(aggregation)) {
    return null;
  }
  return {
    relationPropertyId,
    targetPropertyId:
      typeof targetPropertyId === "string" && targetPropertyId !== ""
        ? targetPropertyId
        : null,
    aggregation: aggregation as RollupAggregation,
  };
}

/** Which `PropertyValue` shape a rollup produces. */
export type RollupKind = "number" | "date" | "values";

/**
 * The value shape a rollup materialises into. Only `min`/`max` depend on the
 * target: over a date property they yield a date, over anything else a number.
 * A dangling rollup (unknown target) falls back to its aggregation's default.
 */
export function rollupKind(
  aggregation: RollupAggregation,
  targetType: PropertyType | null,
): RollupKind {
  if (aggregation === "show_originals") return "values";
  if (aggregation === "min" || aggregation === "max") {
    return targetType === "date" ? "date" : "number";
  }
  return "number";
}

/** True when the aggregation always produces a number (filterable numerically). */
export function isNumericAggregation(
  aggregation: RollupAggregation,
  targetType: PropertyType | null,
): boolean {
  return (
    NUMERIC_AGGREGATIONS.includes(aggregation) ||
    rollupKind(aggregation, targetType) === "number"
  );
}

/**
 * Read-time hooks the value projections need but cannot look up themselves:
 * related page titles, and the config of a rollup's target property (so
 * `show_originals` renders select option names rather than raw ids).
 */
export interface ValueContext {
  /** Title of a related row page; "" when it is unknown or untitled. */
  titleOf?: (pageId: Id) => string;
  /** Config of the rollup's target property, for rendering its values. */
  targetConfig?: PropertyConfig;
}

/**
 * Normalise a caller-supplied config: option ids default to a fresh UUID and
 * colors to "default", so callers may add options by name alone; a relation or
 * rollup sub-object is checked for shape and rewritten in canonical form
 * (`pairedPropertyId`/`targetPropertyId` always present, null when absent).
 * Everything else in the config is preserved verbatim.
 */
export function normalizeConfig(
  type: PropertyType,
  config: PropertyConfig,
  newId: () => Id,
): PropertyConfig {
  if (type === "relation") {
    const raw: unknown = config.relation;
    if (!isRecord(raw)) {
      throw invalid(
        "a relation property needs config.relation = { dataSourceId, pairedPropertyId }",
      );
    }
    if (typeof raw.dataSourceId !== "string" || raw.dataSourceId === "") {
      throw invalid("config.relation.dataSourceId must be a data source id");
    }
    const paired: unknown = raw.pairedPropertyId;
    if (paired !== undefined && paired !== null && typeof paired !== "string") {
      throw invalid(
        "config.relation.pairedPropertyId must be a property id or null",
      );
    }
    return { ...config, relation: relationConfigOf(config) as RelationConfig };
  }

  if (type === "rollup") {
    const raw: unknown = config.rollup;
    if (!isRecord(raw)) {
      throw invalid(
        "a rollup property needs config.rollup = { relationPropertyId, targetPropertyId, aggregation }",
      );
    }
    if (
      typeof raw.relationPropertyId !== "string" ||
      raw.relationPropertyId === ""
    ) {
      throw invalid("config.rollup.relationPropertyId must be a property id");
    }
    const target: unknown = raw.targetPropertyId;
    if (target !== undefined && target !== null && typeof target !== "string") {
      throw invalid("config.rollup.targetPropertyId must be a property id or null");
    }
    if (
      typeof raw.aggregation !== "string" ||
      !ROLLUP_AGGREGATION_SET.has(raw.aggregation)
    ) {
      throw invalid(
        `config.rollup.aggregation must be one of ${ROLLUP_AGGREGATIONS.join(", ")}`,
      );
    }
    return { ...config, rollup: rollupConfigOf(config) as RollupConfig };
  }

  if (type !== "select" && type !== "multi_select") return config;
  const raw: unknown = config.options;
  if (raw === undefined) return { ...config, options: [] };
  if (!Array.isArray(raw)) {
    throw invalid("property config `options` must be an array");
  }
  const seen = new Set<string>();
  const options: SelectOption[] = raw.map((entry) => {
    if (!isRecord(entry)) throw invalid("each select option must be an object");
    const { id, name, color } = entry;
    if (typeof name !== "string" || name === "") {
      throw invalid("each select option needs a non-empty `name`");
    }
    if (id !== undefined && typeof id !== "string") {
      throw invalid("a select option `id` must be a string");
    }
    const optionId = typeof id === "string" ? id : newId();
    if (seen.has(optionId)) {
      throw invalid(`duplicate select option id: ${optionId}`);
    }
    seen.add(optionId);
    return {
      id: optionId,
      name,
      color: typeof color === "string" ? color : "default",
    };
  });
  return { ...config, options };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function mismatch(prop: PropertyDef, got: string): never {
  throw invalid(
    `property "${prop.name}" (${prop.id}) is of type ${prop.type}; got a ${got} value`,
  );
}

function requireType(prop: PropertyDef, variant: PropertyType): void {
  if (prop.type !== variant) mismatch(prop, variant);
}

/** Rich text as a single plain span; an empty string produces no spans. */
export function textToRichText(text: string): RichText {
  return text === "" ? [] : [{ type: "text", text }];
}

/**
 * Throw unless `value` is a legal value for `prop`.
 *
 * Messages are stable enough for an agent to act on:
 * - `property "X" (id) is of type number; got a text value`
 * - `property "X" (id) has no option abc`
 * - `property "X" (id): date must be ISO (YYYY-MM-DD or a full ISO datetime), got "…"`
 * - `property "X" (id): number must be finite or null`
 */
export function validatePropertyValue(
  prop: PropertyDef,
  value: PropertyValue,
): void {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalid(
      `property "${prop.name}" (${prop.id}): value must be a typed object`,
    );
  }
  switch (value.type) {
    case "title":
    case "text": {
      requireType(prop, value.type);
      if (!Array.isArray(value.richText)) {
        throw invalid(
          `property "${prop.name}" (${prop.id}): richText must be an array`,
        );
      }
      return;
    }
    case "number": {
      requireType(prop, "number");
      if (value.number !== null && !Number.isFinite(value.number)) {
        throw invalid(
          `property "${prop.name}" (${prop.id}): number must be finite or null`,
        );
      }
      return;
    }
    case "select": {
      requireType(prop, "select");
      if (value.optionId === null) return;
      if (typeof value.optionId !== "string") {
        throw invalid(
          `property "${prop.name}" (${prop.id}): optionId must be a string or null`,
        );
      }
      if (!optionIdSet(prop.config).has(value.optionId)) {
        throw invalid(
          `property "${prop.name}" (${prop.id}) has no option ${value.optionId}`,
        );
      }
      return;
    }
    case "multi_select": {
      requireType(prop, "multi_select");
      if (!Array.isArray(value.optionIds)) {
        throw invalid(
          `property "${prop.name}" (${prop.id}): optionIds must be an array`,
        );
      }
      const known = optionIdSet(prop.config);
      for (const id of value.optionIds) {
        if (typeof id !== "string") {
          throw invalid(
            `property "${prop.name}" (${prop.id}): optionIds must be strings`,
          );
        }
        if (!known.has(id)) {
          throw invalid(`property "${prop.name}" (${prop.id}) has no option ${id}`);
        }
      }
      return;
    }
    case "date": {
      requireType(prop, "date");
      for (const part of [value.start, value.end]) {
        if (part === null || part === undefined) continue;
        if (typeof part !== "string" || !isIsoDateString(part)) {
          throw invalid(
            `property "${prop.name}" (${prop.id}): date must be ISO (YYYY-MM-DD or a full ISO datetime), got ${JSON.stringify(part)}`,
          );
        }
      }
      return;
    }
    case "checkbox": {
      requireType(prop, "checkbox");
      if (typeof value.checked !== "boolean") {
        throw invalid(
          `property "${prop.name}" (${prop.id}): checked must be a boolean`,
        );
      }
      return;
    }
    case "url":
    case "email":
    case "phone": {
      requireType(prop, value.type);
      if (value.value !== null && typeof value.value !== "string") {
        throw invalid(
          `property "${prop.name}" (${prop.id}): value must be a string or null`,
        );
      }
      return;
    }
    case "relation": {
      requireType(prop, "relation");
      if (!Array.isArray(value.pageIds)) {
        throw invalid(
          `property "${prop.name}" (${prop.id}): pageIds must be an array`,
        );
      }
      for (const id of value.pageIds) {
        if (typeof id !== "string" || id === "") {
          throw invalid(
            `property "${prop.name}" (${prop.id}): pageIds must be page ids`,
          );
        }
      }
      // That each id is a live row of the configured target data source is
      // checked by the command layer, which can see the database.
      return;
    }
    case "rollup": {
      throw invalid(
        `property "${prop.name}" (${prop.id}): rollup values are computed and cannot be written`,
      );
    }
    default:
      throw invalid(
        `property "${prop.name}" (${prop.id}): unknown value variant ${String(
          (value as { type: unknown }).type,
        )}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Projections (shared by the query engine and conversions)
// ---------------------------------------------------------------------------

/**
 * Human/plain projection of a value; "" when the value carries no text.
 *
 * `relation` and `rollup` need data this module cannot reach — related page
 * titles and the rollup target's config — so the caller threads them in via
 * `ctx`. Without it a relation renders "" (ids are never shown as text).
 */
export function plainTextOf(
  value: PropertyValue,
  config: PropertyConfig,
  ctx?: ValueContext,
): string {
  switch (value.type) {
    case "title":
    case "text":
      return richTextToPlain(value.richText);
    case "number":
      return value.number === null ? "" : String(value.number);
    case "select":
      return value.optionId === null ? "" : optionName(config, value.optionId);
    case "multi_select":
      return value.optionIds.map((id) => optionName(config, id)).join(", ");
    case "date":
      return value.start ?? "";
    case "checkbox":
      return value.checked ? "true" : "false";
    case "url":
    case "email":
    case "phone":
      return value.value ?? "";
    case "relation": {
      const titleOf = ctx?.titleOf;
      if (titleOf === undefined) return "";
      // Blank titles are omitted rather than rendered as empty list entries.
      return value.pageIds
        .map((id) => titleOf(id))
        .filter((title) => title !== "")
        .join(", ");
    }
    case "rollup": {
      if (value.values !== undefined) {
        const targetConfig = ctx?.targetConfig ?? {};
        return value.values
          .map((entry) => plainTextOf(entry, targetConfig, ctx))
          .filter((text) => text !== "")
          .join(", ");
      }
      if (value.date !== undefined) {
        return value.date === null ? "" : (value.date.start ?? "");
      }
      return value.number === null || value.number === undefined
        ? ""
        : String(value.number);
    }
  }
}

/**
 * Emptiness, as `is_empty` sees it: no stored value, a null scalar, empty rich
 * text, an empty option list — and, for checkbox, unchecked.
 *
 * A relation is empty when it has no *live* related rows (reads are already
 * trash-filtered). A rollup is empty when its computed number/date is null or
 * its `show_originals` list is empty — `count` of nothing is `0`, which is a
 * value, not emptiness.
 */
export function isEmptyValue(value: PropertyValue | undefined): boolean {
  if (value === undefined) return true;
  switch (value.type) {
    case "title":
    case "text":
      return richTextToPlain(value.richText) === "";
    case "number":
      return value.number === null;
    case "select":
      return value.optionId === null;
    case "multi_select":
      return value.optionIds.length === 0;
    case "date":
      return value.start === null || value.start === undefined;
    case "checkbox":
      return !value.checked;
    case "url":
    case "email":
    case "phone":
      return value.value === null || value.value === "";
    case "relation":
      return value.pageIds.length === 0;
    case "rollup": {
      if (value.values !== undefined) return value.values.length === 0;
      if (value.date !== undefined) {
        return (
          value.date === null ||
          value.date.start === null ||
          value.date.start === undefined
        );
      }
      return value.number === null || value.number === undefined;
    }
  }
}

/** Leading numeric prefix of a string, or null. `"12.5 kg"` → `12.5`. */
function leadingNumber(text: string): number | null {
  const match = /^\s*[-+]?(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?/.exec(text);
  if (match === null) return null;
  const parsed = Number(match[0].trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a stored value to `to`, or return null when it must be dropped.
 *
 * Matrix (from → to), `—` meaning dropped:
 *
 * |            | text/url/email/phone | number        | date        | select   | multi_select | checkbox |
 * |------------|----------------------|---------------|-------------|----------|--------------|----------|
 * | text-like  | keep the string      | leading digits| ISO or —    | —        | —            | —        |
 * | number     | decimal string       | keep          | —           | —        | —            | —        |
 * | date       | `start`              | —             | keep        | —        | —            | —        |
 * | select     | option name          | —             | —           | keep     | wrap in list | —        |
 * | multi_select | names, ", "-joined | —             | —           | first    | keep         | —        |
 * | checkbox   | —                    | —             | —           | —        | —            | keep     |
 * | relation   | titles, ", "-joined (text only) — every other target drops     |
 * | rollup     | — (a rollup stores nothing, so there is never a value to move) |
 *
 * Nothing converts *into* a relation or a rollup: a relation's cells must name
 * real rows of its target data source, and a rollup is computed, so both start
 * empty and the old cells are dropped.
 *
 * `title` never participates: a data source has exactly one title property and
 * it can neither be retyped nor created a second time.
 */
export function convertPropertyValue(
  value: PropertyValue,
  fromConfig: PropertyConfig,
  to: PropertyType,
  toConfig: PropertyConfig,
  ctx?: ValueContext,
): PropertyValue | null {
  if (value.type === to) return pruneToConfig(value, toConfig);
  if (value.type === "checkbox" || to === "checkbox" || to === "title") {
    return null;
  }
  // Computed or reference-carrying targets never inherit old cells.
  if (value.type === "rollup" || to === "relation" || to === "rollup") {
    return null;
  }
  if (value.type === "relation") {
    if (to !== "text") return null;
    const titles = plainTextOf(value, fromConfig, ctx);
    return titles === ""
      ? null
      : { type: "text", richText: textToRichText(titles) };
  }

  switch (to) {
    case "text": {
      const text = plainTextOf(value, fromConfig);
      return text === "" ? null : { type: "text", richText: textToRichText(text) };
    }
    case "url":
    case "email":
    case "phone": {
      if (value.type === "select" || value.type === "multi_select") return null;
      const text = plainTextOf(value, fromConfig);
      return text === "" ? null : { type: to, value: text };
    }
    case "number": {
      if (!isStringLike(value.type)) return null;
      const parsed = leadingNumber(plainTextOf(value, fromConfig));
      return parsed === null ? null : { type: "number", number: parsed };
    }
    case "date": {
      if (!isStringLike(value.type)) return null;
      const text = plainTextOf(value, fromConfig).trim();
      return isIsoDateString(text) ? { type: "date", start: text } : null;
    }
    case "select": {
      if (value.type !== "multi_select") return null;
      const first = value.optionIds[0];
      if (first === undefined || !optionIdSet(toConfig).has(first)) return null;
      return { type: "select", optionId: first };
    }
    case "multi_select": {
      if (value.type !== "select" || value.optionId === null) return null;
      if (!optionIdSet(toConfig).has(value.optionId)) return null;
      return { type: "multi_select", optionIds: [value.optionId] };
    }
    default:
      return null;
  }
}

/**
 * Re-check a value against a (possibly edited) config: options that no longer
 * exist are dropped eagerly, and a value left empty is deleted.
 */
export function pruneToConfig(
  value: PropertyValue,
  config: PropertyConfig,
): PropertyValue | null {
  if (value.type === "select") {
    if (value.optionId === null) return null;
    return optionIdSet(config).has(value.optionId) ? value : null;
  }
  if (value.type === "multi_select") {
    const known = optionIdSet(config);
    const kept = value.optionIds.filter((id) => known.has(id));
    if (kept.length === 0) return null;
    return kept.length === value.optionIds.length
      ? value
      : { type: "multi_select", optionIds: kept };
  }
  return value;
}
