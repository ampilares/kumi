/**
 * Property-type metadata and value formatting — the pure half of the table.
 *
 * Everything a cell needs to *decide* what to render (glyph, label, empty
 * value, display string) lives here so it can be unit-tested without a DOM and
 * reused unchanged by the Phase 5 board/gallery/calendar cards.
 */

import type {
  NumberFormat,
  PropertyDef,
  PropertyType,
  PropertyValue,
  RelationConfig,
  RichText,
  RollupAggregation,
  RollupConfig,
  RowRecord,
  SelectOption,
} from "@kumi/core";

export interface PropertyTypeInfo {
  type: PropertyType;
  label: string;
  /** Column-header glyph, Notion-style (`Aa` title, `≡` text, `⊙` select). */
  glyph: string;
  hint: string;
}

/**
 * `title` is deliberately included: the schema editor has to *show* it, even
 * though core forbids creating a second one or changing its type.
 */
export const PROPERTY_TYPE_INFO: readonly PropertyTypeInfo[] = [
  { type: "title", label: "Title", glyph: "Aa", hint: "The row's name — also the page title." },
  { type: "text", label: "Text", glyph: "≡", hint: "Plain text." },
  { type: "number", label: "Number", glyph: "#", hint: "A number with an optional format." },
  { type: "select", label: "Select", glyph: "⊙", hint: "One option from a list." },
  { type: "multi_select", label: "Multi-select", glyph: "⊟", hint: "Any number of options." },
  { type: "date", label: "Date", glyph: "▤", hint: "A day, optionally a range." },
  { type: "checkbox", label: "Checkbox", glyph: "☑", hint: "A true/false tick." },
  { type: "url", label: "URL", glyph: "⧉", hint: "A link." },
  { type: "email", label: "Email", glyph: "@", hint: "An email address." },
  { type: "phone", label: "Phone", glyph: "☎", hint: "A phone number." },
  { type: "relation", label: "Relation", glyph: "↗", hint: "Rows from another database." },
  { type: "rollup", label: "Rollup", glyph: "∑", hint: "A value computed through a relation." },
];

/**
 * Types the plain "pick a type" list offers. Relation and rollup are excluded
 * because neither is usable without configuration — they get their own panels
 * in the add-property menu, which create the property *with* its config.
 */
export const CONFIGURED_PROPERTY_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  "relation",
  "rollup",
]);

/** Types the "add property" and "change type" menus offer (never `title`). */
export const CREATABLE_PROPERTY_TYPES: readonly PropertyTypeInfo[] = PROPERTY_TYPE_INFO.filter(
  (info) => info.type !== "title" && !CONFIGURED_PROPERTY_TYPES.has(info.type),
);

const INFO_BY_TYPE = new Map<PropertyType, PropertyTypeInfo>(
  PROPERTY_TYPE_INFO.map((info) => [info.type, info]),
);

export function propertyTypeInfo(type: PropertyType): PropertyTypeInfo {
  return INFO_BY_TYPE.get(type) ?? { type, label: type, glyph: "?", hint: "" };
}

export function propertyGlyph(type: PropertyType): string {
  return propertyTypeInfo(type).glyph;
}

/* ------------------------------------------------------------------ values */

/** The "cleared" value for a type — what an untouched cell means. */
export function emptyValue(type: PropertyType): PropertyValue {
  switch (type) {
    case "title":
      return { type: "title", richText: [] };
    case "text":
      return { type: "text", richText: [] };
    case "number":
      return { type: "number", number: null };
    case "select":
      return { type: "select", optionId: null };
    case "multi_select":
      return { type: "multi_select", optionIds: [] };
    case "date":
      return { type: "date", start: null };
    case "checkbox":
      return { type: "checkbox", checked: false };
    case "url":
      return { type: "url", value: null };
    case "email":
      return { type: "email", value: null };
    case "phone":
      return { type: "phone", value: null };
    case "relation":
      return { type: "relation", pageIds: [] };
    case "rollup":
      // A rollup is computed at read time, so this is only ever the placeholder
      // a cell renders before core has answered — never a value that is written.
      return { type: "rollup", aggregation: "count", number: null };
  }
}

/** The stored value for a property, or its empty form when the row has none. */
export function valueOf(
  values: Record<string, PropertyValue>,
  property: PropertyDef,
): PropertyValue {
  const stored = values[property.id];
  return stored !== undefined && stored.type === property.type
    ? stored
    : emptyValue(property.type);
}

/**
 * A row's value for one property.
 *
 * The title is the one property core does *not* keep in `values`: it mirrors
 * `pages.title`, so reading it from the row's page is the only correct source.
 * Writing still goes through `setPropertyValues` with a `title` variant.
 */
export function rowValue(row: RowRecord, property: PropertyDef): PropertyValue {
  if (property.type === "title") {
    return { type: "title", richText: plainToRichText(row.page.title) };
  }
  return valueOf(row.values, property);
}

export function isEmptyValue(value: PropertyValue): boolean {
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
      return value.start === null || value.start === "";
    case "checkbox":
      return value.checked === false;
    case "url":
    case "email":
    case "phone":
      return value.value === null || value.value === "";
    case "relation":
      return value.pageIds.length === 0;
    case "rollup":
      return (
        (value.number === null || value.number === undefined) &&
        (value.date === null || value.date === undefined) &&
        (value.values === undefined || value.values.length === 0)
      );
  }
}

export function richTextToPlain(rich: RichText | undefined): string {
  if (!Array.isArray(rich)) return "";
  return rich
    .map((span) =>
      span.type === "text" ? span.text : span.type === "equation" ? span.expression : "",
    )
    .join("");
}

/** Plain text becomes the single-span rich text every scalar property stores. */
export function plainToRichText(text: string): RichText {
  return text === "" ? [] : [{ type: "text", text }];
}

/* ----------------------------------------------------------------- numbers */

const CURRENCY_PREFIX: Partial<Record<NumberFormat, string>> = {
  dollar: "$",
  euro: "€",
  pound: "£",
  yen: "¥",
};

const GROUPED: ReadonlySet<NumberFormat> = new Set<NumberFormat>([
  "number_with_commas",
  "dollar",
  "euro",
  "pound",
  "yen",
]);

/**
 * Display form of a number cell. `percent` appends the sign rather than
 * scaling — the stored number is what the user typed, so 12 reads as "12%".
 */
export function formatNumber(value: number | null, format: NumberFormat = "number"): string {
  if (value === null || !Number.isFinite(value)) return "";
  const body = GROUPED.has(format)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 10 })
    : String(value);
  if (format === "percent") return `${body}%`;
  const prefix = CURRENCY_PREFIX[format];
  return prefix === undefined ? body : `${prefix}${body}`;
}

/** Parse a number cell's raw input. Empty (or nonsense) clears the cell. */
export function parseNumber(raw: string): number | null {
  const trimmed = raw.replace(/[,\s]/g, "").trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

export const NUMBER_FORMAT_LABEL: Readonly<Record<NumberFormat, string>> = {
  number: "Number",
  number_with_commas: "Number with commas",
  percent: "Percent",
  dollar: "Dollar",
  euro: "Euro",
  pound: "Pound",
  yen: "Yen",
};

export const NUMBER_FORMATS: readonly NumberFormat[] = [
  "number",
  "number_with_commas",
  "percent",
  "dollar",
  "euro",
  "pound",
  "yen",
];

/* ------------------------------------------------------------------- dates */

/** `YYYY-MM-DD` (with an optional time part) → a short human date. */
export function formatDateValue(start: string | null, end?: string | null): string {
  const left = formatOneDate(start);
  if (left === "") return "";
  const right = formatOneDate(end ?? null);
  return right === "" ? left : `${left} → ${right}`;
}

function formatOneDate(iso: string | null): string {
  if (iso === null || iso === "") return "";
  const parsed = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Accepts `YYYY-MM-DD`; anything else clears the date. */
export function parseDateInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

/* ------------------------------------------------------------------ select */

export function optionsOf(property: PropertyDef): SelectOption[] {
  const options = property.config.options;
  return Array.isArray(options) ? options : [];
}

export function optionById(property: PropertyDef, id: string | null): SelectOption | null {
  if (id === null) return null;
  return optionsOf(property).find((option) => option.id === id) ?? null;
}

/* ------------------------------------------------------------------ search */

/**
 * The text a cell contributes to the toolbar's client-side search. Options are
 * resolved through the property so searching for a chip's *name* works.
 */
export function valueText(value: PropertyValue, property: PropertyDef): string {
  switch (value.type) {
    case "title":
    case "text":
      return richTextToPlain(value.richText);
    case "number":
      return value.number === null ? "" : String(value.number);
    case "select":
      return optionById(property, value.optionId)?.name ?? "";
    case "multi_select":
      return value.optionIds
        .map((id) => optionById(property, id)?.name ?? "")
        .filter((name) => name !== "")
        .join(" ");
    case "date":
      return [value.start, value.end].filter((part) => typeof part === "string").join(" ");
    case "checkbox":
      return value.checked ? "yes" : "no";
    case "url":
    case "email":
    case "phone":
      return value.value ?? "";
    case "relation":
      // Deliberately empty: a relation's *text* is the related rows' titles,
      // which only resolve asynchronously through the page cache. Use
      // `relationText` once the stubs are in hand.
      return "";
    case "rollup":
      return rollupText(value, property);
  }
}

/* -------------------------------------------------------- relation & rollup */

export function relationConfigOf(property: PropertyDef): RelationConfig | null {
  const relation = property.config.relation;
  if (typeof relation !== "object" || relation === null) return null;
  const candidate = relation as Partial<RelationConfig>;
  return typeof candidate.dataSourceId === "string"
    ? { dataSourceId: candidate.dataSourceId, pairedPropertyId: candidate.pairedPropertyId ?? null }
    : null;
}

export function rollupConfigOf(property: PropertyDef): RollupConfig | null {
  const rollup = property.config.rollup;
  if (typeof rollup !== "object" || rollup === null) return null;
  const candidate = rollup as Partial<RollupConfig>;
  if (typeof candidate.relationPropertyId !== "string") return null;
  return {
    relationPropertyId: candidate.relationPropertyId,
    targetPropertyId: candidate.targetPropertyId ?? null,
    aggregation: candidate.aggregation ?? "count",
  };
}

/**
 * A relation cell's display text, given whatever titles have resolved. Unknown
 * ids render as "Untitled" rather than disappearing, so a broken reference is
 * visible instead of silently shrinking the chip row.
 */
export function relationText(
  value: Extract<PropertyValue, { type: "relation" }>,
  titles: ReadonlyMap<string, string>,
): string {
  return value.pageIds.map((id) => titles.get(id) ?? "Untitled").join(", ");
}

/**
 * A rollup's display text. `show_originals` joins its member values with the
 * *scalar* formatter, because the originals belong to a property on the target
 * data source whose option list this side does not have.
 */
export function rollupText(
  value: Extract<PropertyValue, { type: "rollup" }>,
  property?: PropertyDef,
): string {
  if (value.aggregation === "show_originals") {
    return (value.values ?? [])
      .map((member) => scalarValueText(member))
      .filter((text) => text !== "")
      .join(", ");
  }
  if (value.date !== undefined && value.date !== null) {
    return formatDateValue(value.date.start, value.date.end ?? null);
  }
  if (value.number === undefined || value.number === null) return "";
  const format = property?.config.numberFormat;
  return formatNumber(value.number, format ?? "number");
}

/** Option-free formatting for a value whose property definition is elsewhere. */
function scalarValueText(value: PropertyValue): string {
  switch (value.type) {
    case "title":
    case "text":
      return richTextToPlain(value.richText);
    case "number":
      return value.number === null ? "" : String(value.number);
    case "select":
      return value.optionId ?? "";
    case "multi_select":
      return value.optionIds.join(", ");
    case "date":
      return formatDateValue(value.start, value.end ?? null);
    case "checkbox":
      return value.checked ? "Yes" : "No";
    case "url":
    case "email":
    case "phone":
      return value.value ?? "";
    case "relation":
      return "";
    case "rollup":
      return rollupText(value);
  }
}

/** Toggle one related row id, preserving the user's selection order. */
export function toggleRelationId(pageIds: readonly string[], id: string): string[] {
  return pageIds.includes(id) ? pageIds.filter((p) => p !== id) : [...pageIds, id];
}

/* ----------------------------------------------------- rollup aggregations */

export const ROLLUP_AGGREGATION_LABEL: Readonly<Record<RollupAggregation, string>> = {
  count: "Count all",
  count_values: "Count values",
  sum: "Sum",
  avg: "Average",
  min: "Min",
  max: "Max",
  show_originals: "Show original",
};

export const ROLLUP_AGGREGATIONS: readonly RollupAggregation[] = [
  "count",
  "count_values",
  "sum",
  "avg",
  "min",
  "max",
  "show_originals",
];

/** Aggregations whose result is a number, and so filter with numeric operators. */
export const NUMERIC_AGGREGATIONS: ReadonlySet<RollupAggregation> = new Set<RollupAggregation>([
  "count",
  "count_values",
  "sum",
  "avg",
]);

/**
 * The allowed (target property type → aggregation) matrix, mirroring core:
 *   count                       no target property at all
 *   count_values/show_originals any target that is not a relation or a rollup
 *   sum/avg                     number only
 *   min/max                     number or date
 *
 * Nesting a rollup inside a rollup, or rolling up a relation, is refused
 * outright rather than half-supported.
 */
export function allowedAggregations(targetType: PropertyType | null): RollupAggregation[] {
  if (targetType === null) return ["count"];
  switch (targetType) {
    case "number":
      return ["count_values", "sum", "avg", "min", "max", "show_originals"];
    case "date":
      return ["count_values", "min", "max", "show_originals"];
    case "relation":
    case "rollup":
      return [];
    default:
      return ["count_values", "show_originals"];
  }
}

/** Property types a rollup can aggregate over on the target data source. */
export function isRollupTarget(type: PropertyType): boolean {
  return allowedAggregations(type).length > 0;
}

export function isAggregationAllowed(
  targetType: PropertyType | null,
  aggregation: RollupAggregation,
): boolean {
  return allowedAggregations(targetType).includes(aggregation);
}

/** The aggregation a freshly configured rollup starts on for a given target. */
export function defaultAggregation(targetType: PropertyType | null): RollupAggregation {
  const allowed = allowedAggregations(targetType);
  if (targetType === "number" && allowed.includes("sum")) return "sum";
  return allowed[0] ?? "count";
}
