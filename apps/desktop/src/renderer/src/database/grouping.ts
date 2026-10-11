/**
 * Row grouping — the pure half of the board and of the list's optional sections.
 *
 * A group is identified by a *key*, never by its label: option ids and the two
 * checkbox states are stable, whereas a renamed option must not orphan the
 * collapsed set persisted in `ViewConfig.collapsedGroups`. `NO_GROUP_KEY` is
 * the sentinel core's type comment already names, so the CLI and the UI agree
 * on what "no value" collapses to.
 */

import type {
  PropertyDef,
  PropertyType,
  PropertyValue,
  RowRecord,
  SelectOption,
} from "@kumi/core";
import { optionsOf, rowValue } from "./properties";

export const NO_GROUP_KEY = "__none__";
export const CHECKED_KEY = "checked";
export const UNCHECKED_KEY = "unchecked";

/** Property types the board can group by. */
export const GROUPABLE_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  "select",
  "checkbox",
]);

export function isGroupable(property: PropertyDef): boolean {
  return GROUPABLE_TYPES.has(property.type);
}

export function groupableProperties(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter(isGroupable);
}

export interface RowGroup {
  /** Stable identity: option id, "checked"/"unchecked", or `NO_GROUP_KEY`. */
  key: string;
  label: string;
  /** Present only for select groups; drives the column's colour chip. */
  option: SelectOption | null;
  rows: RowRecord[];
  collapsed: boolean;
}

/** The group key a single row falls into for `property`. */
export function groupKeyOf(row: RowRecord, property: PropertyDef): string {
  const value = rowValue(row, property);
  if (value.type === "select") return value.optionId ?? NO_GROUP_KEY;
  if (value.type === "checkbox") return value.checked ? CHECKED_KEY : UNCHECKED_KEY;
  return NO_GROUP_KEY;
}

/**
 * Every column the board shows, in schema order, with the "no value" column
 * last. Empty option columns are kept — a board whose columns appeared and
 * vanished with their contents would be unusable as a workflow.
 */
export function buildGroups(
  rows: readonly RowRecord[],
  property: PropertyDef,
  collapsedKeys: readonly string[] = [],
): RowGroup[] {
  const collapsed = new Set(collapsedKeys);
  const skeleton: RowGroup[] =
    property.type === "checkbox"
      ? [
          { key: CHECKED_KEY, label: property.name, option: null, rows: [], collapsed: false },
          {
            key: UNCHECKED_KEY,
            label: `Not ${property.name.toLowerCase()}`,
            option: null,
            rows: [],
            collapsed: false,
          },
        ]
      : optionsOf(property).map((option) => ({
          key: option.id,
          label: option.name,
          option,
          rows: [],
          collapsed: false,
        }));

  const none: RowGroup = {
    key: NO_GROUP_KEY,
    label: `No ${property.name}`,
    option: null,
    rows: [],
    collapsed: false,
  };

  const byKey = new Map<string, RowGroup>(skeleton.map((group) => [group.key, group]));
  for (const row of rows) {
    const key = groupKeyOf(row, property);
    (byKey.get(key) ?? none).rows.push(row);
  }

  // The checkbox layout has no "no value" column: false *is* a value.
  const all = property.type === "checkbox" ? skeleton : [...skeleton, none];
  return all.map((group) => ({ ...group, collapsed: collapsed.has(group.key) }));
}

/** The `collapsedGroups` array after toggling one column. Pure; order-stable. */
export function toggleCollapsed(collapsedKeys: readonly string[], key: string): string[] {
  return collapsedKeys.includes(key)
    ? collapsedKeys.filter((k) => k !== key)
    : [...collapsedKeys, key];
}

/**
 * The property value a row must take to *belong* to a group — what a drop onto
 * a column and a per-column "+ New" both write. `null` clears the property.
 */
export function valueForGroup(property: PropertyDef, key: string): PropertyValue | null {
  if (property.type === "checkbox") return { type: "checkbox", checked: key === CHECKED_KEY };
  if (key === NO_GROUP_KEY) return null;
  return { type: "select", optionId: key };
}

/* ------------------------------------------------------------- card sizing */

export type CardSize = "small" | "medium" | "large";

export const CARD_SIZES: readonly CardSize[] = ["small", "medium", "large"];

export const CARD_SIZE_LABEL: Readonly<Record<CardSize, string>> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
};

/** Board column / gallery tile width in px for each card size. */
export const CARD_WIDTH: Readonly<Record<CardSize, number>> = {
  small: 200,
  medium: 260,
  large: 320,
};

export function cardSizeOf(value: unknown): CardSize {
  return value === "small" || value === "large" ? value : "medium";
}
