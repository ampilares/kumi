/**
 * Select / multi-select option reducers.
 *
 * Pure functions over an option list: the cell menu and the schema editor both
 * build the next `config.options` array here and hand it to `updateProperty`,
 * so option identity (never the name) is what values reference.
 */

import type { SelectOption } from "@kumi/core";

/** The Kumi chip palette — the same names the rich-text colour marks use. */
export const OPTION_COLORS: readonly string[] = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

/**
 * Notion assigns a new option the next colour in the palette rather than a
 * random one, so a fresh list reads as a deliberate sequence.
 */
export function nextOptionColor(options: readonly SelectOption[]): string {
  return OPTION_COLORS[options.length % OPTION_COLORS.length] ?? "gray";
}

export interface AddOptionResult {
  options: SelectOption[];
  option: SelectOption;
  /** True when an option with that name already existed and was reused. */
  existed: boolean;
}

/**
 * Add (or find) an option by name. Names are compared case-insensitively and
 * trimmed, matching Notion's "create «foo»" behaviour in the option menu.
 */
export function addOption(
  options: readonly SelectOption[],
  name: string,
  makeId: () => string,
): AddOptionResult {
  const trimmed = name.trim();
  const existing = options.find((o) => o.name.trim().toLowerCase() === trimmed.toLowerCase());
  if (existing) return { options: [...options], option: existing, existed: true };
  const option: SelectOption = { id: makeId(), name: trimmed, color: nextOptionColor(options) };
  return { options: [...options, option], option, existed: false };
}

export function renameOption(
  options: readonly SelectOption[],
  id: string,
  name: string,
): SelectOption[] {
  return options.map((o) => (o.id === id ? { ...o, name: name.trim() } : o));
}

export function recolorOption(
  options: readonly SelectOption[],
  id: string,
  color: string,
): SelectOption[] {
  return options.map((o) => (o.id === id ? { ...o, color } : o));
}

export function removeOption(options: readonly SelectOption[], id: string): SelectOption[] {
  return options.filter((o) => o.id !== id);
}

/** Toggle one option in a multi-select value, preserving selection order. */
export function toggleOptionId(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((o) => o !== id) : [...selected, id];
}

/** Case-insensitive contains, used by every option menu's search field. */
export function searchOptions(options: readonly SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter((o) => o.name.toLowerCase().includes(needle));
}

/** True when `query` names no existing option, so "Create «query»" should show. */
export function canCreateOption(options: readonly SelectOption[], query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === "") return false;
  return !options.some((o) => o.name.trim().toLowerCase() === trimmed.toLowerCase());
}
