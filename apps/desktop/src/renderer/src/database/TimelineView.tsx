/**
 * The timeline layout — one lane per row, bars over a shared horizontal axis.
 *
 * Bars are read-only this phase: there is no drag-to-move or drag-to-resize, so
 * a date is only ever changed through a cell editor where the value being
 * written is visible. The zoom (weeks / months) and the scroll position are
 * local state for the same reason the calendar's month is.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cx, displayTitle } from "../utils";
import { datePlacementProperties, rowSpan, todayIso } from "./calendar";
import { formatDateValue } from "./properties";
import {
  DAY_PX,
  TIMELINE_SCALES,
  TIMELINE_SCALE_LABEL,
  barFor,
  ticksFor,
  timelineRange,
  timelineWidth,
  todayOffset,
  type TimelineScale,
} from "./timeline";
import { PickPropertyEmptyState, type BaseLayoutProps } from "./CardBits";

const LANE_HEIGHT = 32;

export function TimelineView(props: BaseLayoutProps): JSX.Element {
  const { properties, rows, config, locked } = props;
  const [scale, setScale] = useState<TimelineScale>("weeks");
  const scrollRef = useRef<HTMLDivElement>(null);
  const today = todayIso();

  const dateProperty = properties.find((p) => p.id === config.datePropertyId) ?? null;

  const range = useMemo(
    () =>
      dateProperty === null
        ? null
        : timelineRange(rows, dateProperty, scale, today),
    [rows, dateProperty, scale, today],
  );

  // Open on today rather than at the padded left edge, which is usually empty.
  const marker = range === null ? null : todayOffset(range, scale, today);
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || marker === null) return;
    node.scrollLeft = Math.max(0, marker - node.clientWidth / 3);
  }, [marker, scale]);

  if (dateProperty === null || range === null) {
    return (
      <PickPropertyEmptyState
        title="Choose a date"
        hint="A timeline lays each row out along one of its date properties."
        candidates={datePlacementProperties(properties)}
        disabled={locked}
        emptyHint="Add a date property first — a timeline has nothing to lay rows out along."
        onPick={(propertyId) => props.onConfig({ datePropertyId: propertyId })}
      />
    );
  }

  const width = timelineWidth(range, scale);
  const ticks = ticksFor(range, scale);
  const placed = rows.filter((row) => rowSpan(row, dateProperty) !== null);
  const undated = rows.length - placed.length;

  return (
    <div className="dbtl">
      <div className="dbtl__bar">
        <span className="dbtl__zoom">
          {TIMELINE_SCALES.map((option) => (
            <button
              key={option}
              type="button"
              className={cx("btn btn--ghost btn--xs", option === scale && "is-on")}
              onClick={() => setScale(option)}
            >
              {TIMELINE_SCALE_LABEL[option]}
            </button>
          ))}
        </span>
        {undated > 0 ? (
          <span className="dbcal__undated">
            {undated} {undated === 1 ? "row has" : "rows have"} no {dateProperty.name}
          </span>
        ) : null}
      </div>

      <div className="dbtl__scroll" ref={scrollRef}>
        <div className="dbtl__canvas" style={{ width }}>
          <div className="dbtl__axis">
            {ticks.map((tick) => (
              <span
                key={tick.iso}
                className={cx("dbtl__tick", tick.major && "is-major")}
                style={{ left: tick.left }}
              >
                {tick.label}
              </span>
            ))}
          </div>

          <div className="dbtl__lanes" style={{ height: Math.max(1, placed.length) * LANE_HEIGHT }}>
            {ticks.map((tick) => (
              <span
                key={`grid-${tick.iso}`}
                className={cx("dbtl__gridline", tick.major && "is-major")}
                style={{ left: tick.left }}
              />
            ))}
            {marker === null ? null : (
              <span className="dbtl__today" style={{ left: marker }} aria-label="Today" />
            )}
            {placed.map((row, index) => {
              const bar = barFor(row, dateProperty, range, scale);
              if (bar === null) return null;
              return (
                <button
                  key={row.page.id}
                  type="button"
                  className="dbtl__bar-item"
                  style={{
                    left: bar.left,
                    width: bar.width,
                    top: index * LANE_HEIGHT + 4,
                    minWidth: DAY_PX[scale],
                  }}
                  title={`${displayTitle(row.page.title)} · ${formatDateValue(
                    bar.start,
                    bar.end === bar.start ? null : bar.end,
                  )}`}
                  onClick={() => props.onOpenRow(row)}
                >
                  <span className="dbtl__barlabel">{displayTitle(row.page.title)}</span>
                </button>
              );
            })}
            {placed.length === 0 ? (
              <div className="dbtl__blank">No rows have a {dateProperty.name} yet.</div>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        className="dblist__new"
        disabled={locked}
        onClick={() => props.onNewRow()}
      >
        + New page
      </button>
    </div>
  );
}
