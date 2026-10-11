/**
 * Calendar month arithmetic.
 *
 * Every calculation runs in UTC over `YYYY-MM-DD` strings, never over local
 * `Date` objects: a date property stores a *day*, and doing the arithmetic in
 * local time makes that day drift by one either side of a DST boundary or a
 * negative UTC offset. Nothing here touches the clock except `todayIso`.
 */

import type { PropertyDef, PropertyType, RowRecord } from "@kumi/core";
import { rowValue } from "./properties";

/** Property types a calendar or timeline can place rows on. */
export const DATE_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>(["date"]);

export function datePlacementProperties(properties: PropertyDef[]): PropertyDef[] {
  return properties.filter((p) => DATE_TYPES.has(p.type));
}

export const WEEKDAY_LABELS: readonly string[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Rows shown per calendar cell before the "+N more" affordance takes over. */
export const MAX_CHIPS_PER_DAY = 3;

export interface YearMonth {
  year: number;
  /** Zero-based, like `Date#getUTCMonth`. */
  month: number;
}

export interface CalendarDay {
  iso: string;
  /** Day of the month, 1–31. */
  day: number;
  /** False for the leading/trailing days borrowed from the adjacent months. */
  inMonth: boolean;
  isToday: boolean;
  /** 0 = Sunday. */
  weekday: number;
}

/* ------------------------------------------------------------ iso helpers */

export function isoOf(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month, day)).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` (with or without a time part) → a UTC-midnight timestamp. */
export function isoToUtc(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  const value = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(value) ? null : value;
}

/** The normalised day part of a stored date string, or null when unusable. */
export function dayOf(iso: string | null | undefined): string | null {
  if (typeof iso !== "string" || iso === "") return null;
  const utc = isoToUtc(iso);
  return utc === null ? null : new Date(utc).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const utc = isoToUtc(iso);
  if (utc === null) return iso;
  return new Date(utc + days * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b`; negative when `b` is earlier. */
export function daysBetween(a: string, b: string): number {
  const from = isoToUtc(a);
  const to = isoToUtc(b);
  if (from === null || to === null) return 0;
  return Math.round((to - from) / 86_400_000);
}

export function todayIso(now: Date = new Date()): string {
  // The *user's* today, not UTC's: a calendar highlighting yesterday because
  // the machine is west of Greenwich would be plainly wrong.
  return isoOf(now.getFullYear(), now.getMonth(), now.getDate());
}

export function monthOf(iso: string): YearMonth {
  const utc = isoToUtc(iso);
  const date = new Date(utc ?? Date.UTC(1970, 0, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

/** Month arithmetic that carries across year boundaries in both directions. */
export function shiftMonth({ year, month }: YearMonth, delta: number): YearMonth {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}

export function monthLabel({ year, month }: YearMonth): string {
  const date = new Date(Date.UTC(year, month, 1));
  return `${date.toLocaleDateString(undefined, { month: "long", timeZone: "UTC" })} ${year}`;
}

/* -------------------------------------------------------------- the grid */

export const CALENDAR_ROWS = 6;
export const CALENDAR_CELLS = CALENDAR_ROWS * 7;

/**
 * The 6×7 grid for a month, Sunday-first, padded with the adjacent months'
 * days. Always 42 cells so the grid never reflows between months — Notion's
 * calendar keeps a constant height for exactly that reason.
 */
export function monthMatrix(
  { year, month }: YearMonth,
  today: string = todayIso(),
): CalendarDay[] {
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const start = Date.UTC(year, month, 1 - firstWeekday);
  const days: CalendarDay[] = [];
  for (let i = 0; i < CALENDAR_CELLS; i += 1) {
    const date = new Date(start + i * 86_400_000);
    const iso = date.toISOString().slice(0, 10);
    days.push({
      iso,
      day: date.getUTCDate(),
      inMonth: date.getUTCMonth() === month && date.getUTCFullYear() === year,
      isToday: iso === today,
      weekday: date.getUTCDay(),
    });
  }
  return days;
}

/* ------------------------------------------------------------ row placing */

/** The day a row sits on, from its date property's *start*. */
export function rowDay(row: RowRecord, property: PropertyDef): string | null {
  const value = rowValue(row, property);
  return value.type === "date" ? dayOf(value.start) : null;
}

/** The row's `[start, end]` days; `end` falls back to `start` for a 1-day span. */
export function rowSpan(
  row: RowRecord,
  property: PropertyDef,
): { start: string; end: string } | null {
  const value = rowValue(row, property);
  if (value.type !== "date") return null;
  const start = dayOf(value.start);
  if (start === null) return null;
  const end = dayOf(value.end ?? null);
  return { start, end: end !== null && daysBetween(start, end) > 0 ? end : start };
}

/**
 * Rows keyed by the day they start on. Rows with no date are dropped — the
 * calendar has nowhere to put them, and inventing a day would be a silent edit.
 */
export function rowsByDay(
  rows: readonly RowRecord[],
  property: PropertyDef,
): Map<string, RowRecord[]> {
  const out = new Map<string, RowRecord[]>();
  for (const row of rows) {
    const day = rowDay(row, property);
    if (day === null) continue;
    const bucket = out.get(day);
    if (bucket) bucket.push(row);
    else out.set(day, [row]);
  }
  return out;
}

/** How many rows the current filter leaves off the calendar entirely. */
export function undatedCount(rows: readonly RowRecord[], property: PropertyDef): number {
  return rows.filter((row) => rowDay(row, property) === null).length;
}
