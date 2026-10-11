/**
 * The board layout (Fig. 9).
 *
 * Columns are the grouping property's options in schema order, each with its
 * colour chip and a count, plus a trailing "No <property>" column. Columns
 * collapse to a vertical rail and that collapse is persisted into
 * `config.collapsedGroups`, because a board is a workspace: which lanes are
 * folded away is part of how the view is set up, not transient UI state.
 *
 * Dragging a card writes the grouping property through `onSetValue` — the board
 * never reorders rows itself, so a drop is one `setPropertyValues` and the
 * refetch does the rest. Card *rank* within a column is deliberately not
 * persisted this phase (see the report).
 */

import { useState } from "react";
import type { PropertyDef, PropertyValue, RowRecord } from "@kumi/core";
import { cx } from "../utils";
import { RowCard, PickPropertyEmptyState, type BaseLayoutProps } from "./CardBits";
import {
  CARD_WIDTH,
  buildGroups,
  cardSizeOf,
  groupableProperties,
  toggleCollapsed,
  valueForGroup,
  type RowGroup,
} from "./grouping";

export interface BoardViewProps extends BaseLayoutProps {
  /** Write the grouping property on one row — a drop, in one call. */
  onSetValue(row: RowRecord, property: PropertyDef, next: PropertyValue | null): void;
}

const DRAG_MIME = "application/x-kumi-row";

export function BoardView(props: BoardViewProps): JSX.Element {
  const { columns, properties, rows, config, locked } = props;
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const groupBy = properties.find((p) => p.id === config.groupByPropertyId) ?? null;
  const candidates = groupableProperties(properties);

  if (groupBy === null) {
    return (
      <PickPropertyEmptyState
        title="Group your board"
        hint="A board needs a property to make its columns from."
        candidates={candidates}
        disabled={locked}
        emptyHint="Add a select or checkbox property first — those are the types a board can group by."
        onPick={(propertyId) => props.onConfig({ groupByPropertyId: propertyId })}
      />
    );
  }

  const collapsedKeys = Array.isArray(config.collapsedGroups) ? config.collapsedGroups : [];
  const groups = buildGroups(rows, groupBy, collapsedKeys);
  const width = CARD_WIDTH[cardSizeOf(config.cardSize)];

  const drop = (group: RowGroup): void => {
    setOverKey(null);
    const rowId = dragRowId;
    setDragRowId(null);
    if (rowId === null || locked) return;
    const row = rows.find((r) => r.page.id === rowId);
    if (!row) return;
    props.onSetValue(row, groupBy, valueForGroup(groupBy, group.key));
  };

  return (
    <div className="dbboard">
      {groups.map((group) =>
        group.collapsed ? (
          <button
            key={group.key}
            type="button"
            className="dbboard__rail"
            title={`Expand ${group.label}`}
            onClick={() =>
              props.onConfig({ collapsedGroups: toggleCollapsed(collapsedKeys, group.key) })
            }
          >
            <span className="dbboard__railcount">{group.rows.length}</span>
            <span className="dbboard__raillabel">{group.label}</span>
          </button>
        ) : (
          <section
            key={group.key}
            className={cx("dbboard__col", overKey === group.key && "is-over")}
            style={{ width }}
            aria-label={group.label}
            onDragOver={(event) => {
              if (locked || dragRowId === null) return;
              event.preventDefault();
              setOverKey(group.key);
            }}
            onDragLeave={() => setOverKey((key) => (key === group.key ? null : key))}
            onDrop={(event) => {
              event.preventDefault();
              drop(group);
            }}
          >
            <header className="dbboard__head">
              {group.option ? (
                <span className={cx("chip", `chip--${group.option.color}`)}>{group.label}</span>
              ) : (
                <span className="chip chip--gray">{group.label}</span>
              )}
              <span className="dbboard__count">{group.rows.length}</span>
              <button
                type="button"
                className="iconbtn iconbtn--xs"
                title={`Collapse ${group.label}`}
                aria-label={`Collapse ${group.label}`}
                onClick={() =>
                  props.onConfig({ collapsedGroups: toggleCollapsed(collapsedKeys, group.key) })
                }
              >
                –
              </button>
            </header>

            <div className="dbboard__cards">
              {group.rows.map((row) => (
                <RowCard
                  key={row.page.id}
                  row={row}
                  columns={columns}
                  draggable={!locked}
                  onDragStart={(event) => {
                    setDragRowId(row.page.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(DRAG_MIME, row.page.id);
                  }}
                  onOpen={() => props.onOpenRow(row)}
                  onOpenPage={props.onOpenPage}
                />
              ))}
              {group.rows.length === 0 ? <div className="dbboard__blank">No pages</div> : null}
            </div>

            <button
              type="button"
              className="dbboard__new"
              disabled={locked}
              onClick={() => {
                const value = valueForGroup(groupBy, group.key);
                props.onNewRow(value === null ? {} : { [groupBy.id]: value });
              }}
            >
              + New page
            </button>
          </section>
        ),
      )}
    </div>
  );
}
