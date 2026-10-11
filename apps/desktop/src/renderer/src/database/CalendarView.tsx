/**
 * The calendar layout — a month grid over `config.datePropertyId`.
 *
 * The visible month is *local* state, never persisted: which month you happen
 * to be looking at is navigation, not configuration, and writing it into the
 * view would make two windows fight over the same scroll position.
 *
 * Rows are chips on their **start day**; multi-day spans are not drawn across
 * cells this phase (the timeline is where a span reads properly).
 */

import { useState } from "react";
import { cx } from "../utils";
import { displayTitle } from "../utils";
import {
  MAX_CHIPS_PER_DAY,
  WEEKDAY_LABELS,
  datePlacementProperties,
  monthLabel,
  monthMatrix,
  monthOf,
  rowsByDay,
  shiftMonth,
  todayIso,
  undatedCount,
} from "./calendar";
import { PickPropertyEmptyState, type BaseLayoutProps } from "./CardBits";

export function CalendarView(props: BaseLayoutProps): JSX.Element {
  const { properties, rows, config, locked } = props;
  const today = todayIso();
  const [cursor, setCursor] = useState(() => monthOf(today));
  const [expandedDay, setExpandedDay] = useState<string | null>(null);

  const dateProperty = properties.find((p) => p.id === config.datePropertyId) ?? null;
  const candidates = datePlacementProperties(properties);

  if (dateProperty === null) {
    return (
      <PickPropertyEmptyState
        title="Choose a date"
        hint="A calendar places each row on one of its date properties."
        candidates={candidates}
        disabled={locked}
        emptyHint="Add a date property first — a calendar has nothing to place rows on."
        onPick={(propertyId) => props.onConfig({ datePropertyId: propertyId })}
      />
    );
  }

  const days = monthMatrix(cursor, today);
  const byDay = rowsByDay(rows, dateProperty);
  const undated = undatedCount(rows, dateProperty);

  return (
    <div className="dbcal">
      <div className="dbcal__bar">
        <span className="dbcal__month">{monthLabel(cursor)}</span>
        <span className="dbcal__nav">
          <button
            type="button"
            className="iconbtn iconbtn--xs"
            aria-label="Previous month"
            onClick={() => setCursor((month) => shiftMonth(month, -1))}
          >
            ‹
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => setCursor(monthOf(today))}
          >
            Today
          </button>
          <button
            type="button"
            className="iconbtn iconbtn--xs"
            aria-label="Next month"
            onClick={() => setCursor((month) => shiftMonth(month, 1))}
          >
            ›
          </button>
        </span>
        {undated > 0 ? (
          <span className="dbcal__undated">
            {undated} {undated === 1 ? "row has" : "rows have"} no {dateProperty.name}
          </span>
        ) : null}
      </div>

      <div className="dbcal__weekdays">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="dbcal__weekday">
            {label}
          </div>
        ))}
      </div>

      <div className="dbcal__grid">
        {days.map((day) => {
          const dayRows = byDay.get(day.iso) ?? [];
          const expanded = expandedDay === day.iso;
          const shown = expanded ? dayRows : dayRows.slice(0, MAX_CHIPS_PER_DAY);
          const hidden = dayRows.length - shown.length;
          return (
            <div
              key={day.iso}
              className={cx(
                "dbcal__day",
                !day.inMonth && "is-outside",
                day.isToday && "is-today",
              )}
            >
              <div className="dbcal__daybar">
                <span className="dbcal__daynum">{day.day}</span>
                <button
                  type="button"
                  className="dbcal__add"
                  title={`New page on ${day.iso}`}
                  aria-label={`New page on ${day.iso}`}
                  disabled={locked}
                  onClick={() =>
                    props.onNewRow({ [dateProperty.id]: { type: "date", start: day.iso } })
                  }
                >
                  +
                </button>
              </div>
              {shown.map((row) => (
                <button
                  key={row.page.id}
                  type="button"
                  className="dbcal__chip"
                  onClick={() => props.onOpenRow(row)}
                >
                  {displayTitle(row.page.title)}
                </button>
              ))}
              {hidden > 0 ? (
                <button
                  type="button"
                  className="dbcal__more"
                  onClick={() => setExpandedDay(day.iso)}
                >
                  +{hidden} more
                </button>
              ) : null}
              {expanded && dayRows.length > MAX_CHIPS_PER_DAY ? (
                <button type="button" className="dbcal__more" onClick={() => setExpandedDay(null)}>
                  Show less
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
