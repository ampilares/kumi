/**
 * Timeline scale arithmetic.
 *
 * The timeline is a fixed pixels-per-day scale with one lane per row, so every
 * geometry question reduces to "how many days from the range start". Keeping
 * that in one pure module means the axis ticks, the bars and the today line can
 * never disagree about where a date lands.
 */

import type { PropertyDef, RowRecord } from "@kumi/core";
import { addDays, daysBetween, isoToUtc, rowSpan, todayIso } from "./calendar";

export type TimelineScale = "weeks" | "months";

export const TIMELINE_SCALES: readonly TimelineScale[] = ["weeks", "months"];

export const TIMELINE_SCALE_LABEL: Readonly<Record<TimelineScale, string>> = {
  weeks: "Weeks",
  months: "Months",
};

/** Pixels per day at each zoom level. */
export const DAY_PX: Readonly<Record<TimelineScale, number>> = { weeks: 26, months: 6 };

/** Days of breathing room on each side of the data. */
const PAD_DAYS: Readonly<Record<TimelineScale, number>> = { weeks: 7, months: 30 };

/** Minimum axis width in days, so a one-row timeline still reads as a timeline. */
const MIN_SPAN_DAYS: Readonly<Record<TimelineScale, number>> = { weeks: 42, months: 180 };

export interface TimelineRange {
  start: string;
  end: string;
  /** Inclusive day count, so a same-day range is 1. */
  days: number;
}

/**
 * The axis window: the rows' own extent, padded, widened to a readable minimum
 * and always containing today so the today line has somewhere to be.
 */
export function timelineRange(
  rows: readonly RowRecord[],
  property: PropertyDef,
  scale: TimelineScale,
  today: string = todayIso(),
): TimelineRange {
  let min: string | null = null;
  let max: string | null = null;
  for (const row of rows) {
    const span = rowSpan(row, property);
    if (span === null) continue;
    if (min === null || daysBetween(span.start, min) > 0) min = span.start;
    if (max === null || daysBetween(max, span.end) > 0) max = span.end;
  }
  if (min === null || max === null) {
    min = today;
    max = today;
  }
  if (daysBetween(today, min) > 0) min = today;
  if (daysBetween(max, today) > 0) max = today;

  const pad = PAD_DAYS[scale];
  let start = addDays(min, -pad);
  let end = addDays(max, pad);
  const minimum = MIN_SPAN_DAYS[scale];
  const span = daysBetween(start, end) + 1;
  if (span < minimum) end = addDays(start, minimum - 1);

  // Snap the left edge to a Sunday so the week ticks line up with the grid.
  const utc = isoToUtc(start);
  if (utc !== null) start = addDays(start, -new Date(utc).getUTCDay());

  return { start, end, days: daysBetween(start, end) + 1 };
}

export function timelineWidth(range: TimelineRange, scale: TimelineScale): number {
  return range.days * DAY_PX[scale];
}

/** X offset in px of a day within the range. Out-of-range days are not clamped. */
export function offsetOf(range: TimelineRange, iso: string, scale: TimelineScale): number {
  return daysBetween(range.start, iso) * DAY_PX[scale];
}

export interface TimelineBar {
  left: number;
  width: number;
  start: string;
  end: string;
}

/**
 * A row's bar. A missing end date is a one-day bar rather than a zero-width
 * sliver, which is what makes "start only" rows still clickable.
 */
export function barFor(
  row: RowRecord,
  property: PropertyDef,
  range: TimelineRange,
  scale: TimelineScale,
): TimelineBar | null {
  const span = rowSpan(row, property);
  if (span === null) return null;
  const days = daysBetween(span.start, span.end) + 1;
  return {
    left: offsetOf(range, span.start, scale),
    width: Math.max(1, days) * DAY_PX[scale],
    start: span.start,
    end: span.end,
  };
}

export interface TimelineTick {
  iso: string;
  label: string;
  left: number;
  /** True on the first tick of a month, which the axis draws heavier. */
  major: boolean;
}

/**
 * Axis ticks: week starts (Sundays) at the `weeks` zoom, month starts at
 * `months`. Labels are locale-formatted in UTC to match the range arithmetic.
 */
export function ticksFor(range: TimelineRange, scale: TimelineScale): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  const startUtc = isoToUtc(range.start);
  if (startUtc === null) return ticks;

  if (scale === "weeks") {
    const firstOffset = (7 - new Date(startUtc).getUTCDay()) % 7;
    for (let day = firstOffset; day < range.days; day += 7) {
      const iso = addDays(range.start, day);
      const date = new Date(isoToUtc(iso) ?? 0);
      ticks.push({
        iso,
        label: date.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        left: day * DAY_PX[scale],
        major: date.getUTCDate() <= 7,
      });
    }
    return ticks;
  }

  const first = new Date(startUtc);
  let cursor = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth() + (first.getUTCDate() === 1 ? 0 : 1),
    1,
  );
  const endUtc = isoToUtc(range.end) ?? startUtc;
  while (cursor <= endUtc) {
    const date = new Date(cursor);
    const iso = date.toISOString().slice(0, 10);
    ticks.push({
      iso,
      label: date.toLocaleDateString(undefined, {
        month: "short",
        year: date.getUTCMonth() === 0 ? "numeric" : undefined,
        timeZone: "UTC",
      }),
      left: offsetOf(range, iso, scale),
      major: true,
    });
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return ticks;
}

/** X offset of the today line, or null when today falls outside the range. */
export function todayOffset(
  range: TimelineRange,
  scale: TimelineScale,
  today: string = todayIso(),
): number | null {
  const offset = daysBetween(range.start, today);
  if (offset < 0 || offset >= range.days) return null;
  return offset * DAY_PX[scale];
}
