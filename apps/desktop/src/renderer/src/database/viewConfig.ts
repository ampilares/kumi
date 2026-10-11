/**
 * View-config helpers.
 *
 * `ViewConfig.visibleProperties` is `null` for "everything, in schema order",
 * which is what a fresh view stores; the moment the user hides or reorders a
 * column it becomes an explicit ordered list. These helpers are the only place
 * that distinction is resolved, so the table, the inspector and Phase 5's other
 * layouts all agree on what "visible" means.
 */

import type { PropertyDef, SortSpec, View, ViewConfig, ViewType } from "@kumi/core";

export const DEFAULT_COLUMN_WIDTH = 176;
export const TITLE_COLUMN_WIDTH = 260;
export const MIN_COLUMN_WIDTH = 88;
export const MAX_COLUMN_WIDTH = 720;

/** Every layout, in the order the add-view grid (Fig. 7) lays them out. */
export const VIEW_TYPE_INFO: readonly { type: ViewType; label: string; glyph: string }[] = [
  { type: "table", label: "Table", glyph: "▦" },
  { type: "board", label: "Board", glyph: "▤" },
  { type: "list", label: "List", glyph: "☰" },
  { type: "gallery", label: "Gallery", glyph: "▩" },
  { type: "calendar", label: "Calendar", glyph: "▣" },
  { type: "timeline", label: "Timeline", glyph: "▭" },
];

/** All six layouts ship as of Phase 5. */
export const SHIPPED_VIEW_TYPES: ReadonlySet<ViewType> = new Set<ViewType>(
  VIEW_TYPE_INFO.map((info) => info.type),
);

/**
 * A config with every required field resolved — never mutated in place.
 *
 * Optional and unknown keys are carried through by the spread rather than
 * enumerated: `groupByPropertyId`, `datePropertyId`, `cardSize` and
 * `collapsedGroups` reach the layouts untouched, and an imported view keeps
 * whatever else it arrived with (the type's own "preserved verbatim" promise).
 */
export function configOf(view: View | null | undefined): ViewConfig {
  const config: Partial<ViewConfig> = view?.config ?? {};
  const widths = config.propertyWidths;
  return {
    ...config,
    filter: config.filter ?? null,
    sorts: Array.isArray(config.sorts) ? config.sorts : [],
    visibleProperties: Array.isArray(config.visibleProperties) ? config.visibleProperties : null,
    propertyWidths:
      typeof widths === "object" && widths !== null && !Array.isArray(widths) ? widths : {},
    openMode: config.openMode ?? "center_peek",
  };
}

/** Which per-layout settings rows the inspector shows for a view type. */
export interface LayoutSettings {
  groupBy: boolean;
  dateProperty: boolean;
  cardSize: boolean;
}

export function layoutSettings(type: ViewType): LayoutSettings {
  switch (type) {
    case "board":
      return { groupBy: true, dateProperty: false, cardSize: true };
    case "list":
      return { groupBy: true, dateProperty: false, cardSize: false };
    case "gallery":
      return { groupBy: false, dateProperty: false, cardSize: true };
    case "calendar":
    case "timeline":
      return { groupBy: false, dateProperty: true, cardSize: false };
    case "table":
      return { groupBy: false, dateProperty: false, cardSize: false };
  }
}

/** The persisted collapsed-group keys, defensively normalised. */
export function collapsedGroupsOf(config: ViewConfig): string[] {
  const stored = config.collapsedGroups;
  return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === "string") : [];
}

/**
 * Properties in display order. The title column is pinned first — Notion never
 * lets it move or hide, and the table's row-open affordance lives on it.
 */
export function orderedProperties(properties: PropertyDef[], config: ViewConfig): PropertyDef[] {
  const byId = new Map(properties.map((p) => [p.id, p]));
  const title = properties.find((p) => p.type === "title") ?? null;
  const rest = config.visibleProperties;

  if (rest === null) return [...properties].sort(schemaOrder(title));

  const out: PropertyDef[] = [];
  if (title) out.push(title);
  for (const id of rest) {
    const property = byId.get(id);
    if (property && property.type !== "title") out.push(property);
  }
  return out;
}

function schemaOrder(title: PropertyDef | null): (a: PropertyDef, b: PropertyDef) => number {
  return (a, b) => {
    if (title && a.id === title.id) return -1;
    if (title && b.id === title.id) return 1;
    return a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0;
  };
}

/** Hidden (non-title) properties, in schema order. */
export function hiddenProperties(properties: PropertyDef[], config: ViewConfig): PropertyDef[] {
  const visible = new Set(orderedProperties(properties, config).map((p) => p.id));
  return properties
    .filter((p) => p.type !== "title" && !visible.has(p.id))
    .sort((a, b) => (a.rank < b.rank ? -1 : 1));
}

/**
 * Explicit visible list after toggling one property. Always materialises the
 * list, because "all" can no longer describe a view with something hidden.
 */
export function toggleVisibility(
  properties: PropertyDef[],
  config: ViewConfig,
  propertyId: string,
): string[] {
  const current = orderedProperties(properties, config)
    .filter((p) => p.type !== "title")
    .map((p) => p.id);
  if (current.includes(propertyId)) return current.filter((id) => id !== propertyId);

  // Re-inserted columns go back to their schema position, not to the end.
  const order = properties
    .filter((p) => p.type !== "title")
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .map((p) => p.id);
  const next = [...current, propertyId];
  return next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

/** Move one entry of an array from `from` to `to`, clamped. Pure. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const [moved] = out.splice(from, 1);
  if (moved === undefined) return out;
  out.splice(Math.min(Math.max(0, to), out.length), 0, moved);
  return out;
}

export function columnWidth(config: ViewConfig, property: PropertyDef): number {
  const stored = config.propertyWidths[property.id];
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, stored));
  }
  return property.type === "title" ? TITLE_COLUMN_WIDTH : DEFAULT_COLUMN_WIDTH;
}

/* ------------------------------------------------------------------- sorts */

export function toggleSortDirection(sorts: SortSpec[], index: number): SortSpec[] {
  return sorts.map((sort, i) =>
    i === index ? { ...sort, direction: sort.direction === "asc" ? "desc" : "asc" } : sort,
  );
}

/** Add or replace the sort on `propertyId`, keeping it a single entry. */
export function setSort(
  sorts: SortSpec[],
  propertyId: string,
  direction: "asc" | "desc",
): SortSpec[] {
  const without = sorts.filter((sort) => sort.propertyId !== propertyId);
  return [...without, { propertyId, direction }];
}

export function removeSort(sorts: SortSpec[], propertyId: string): SortSpec[] {
  return sorts.filter((sort) => sort.propertyId !== propertyId);
}

export function sortSummary(sorts: SortSpec[]): string {
  if (sorts.length === 0) return "Sort";
  return sorts.length === 1 ? "1 sort" : `${sorts.length} sorts`;
}
