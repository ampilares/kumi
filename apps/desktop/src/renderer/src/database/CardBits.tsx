/**
 * Pieces every card-shaped layout shares: the card itself, the "pick a
 * property" empty state, and the `+ New page` affordance.
 *
 * Board, gallery, list and calendar all render the same card so a row looks the
 * same wherever it is seen — the only difference between the layouts is how the
 * cards are arranged, which is the point of keeping this here rather than
 * duplicating a card body four times.
 */

import type { PropertyDef, PropertyValue, RowRecord, ViewConfig } from "@kumi/core";
import { cx, displayTitle } from "../utils";
import { PropertyPill } from "./Cells";
import { propertyGlyph, rowValue } from "./properties";

/**
 * What every non-table layout is handed. Exactly like `TableViewProps`, no
 * layout calls IPC itself: mutations are props, so a board can be mounted
 * inline, full-page or (later) inside a peek without changing its wiring.
 */
export interface BaseLayoutProps {
  /** Visible properties in display order, title first. */
  columns: PropertyDef[];
  /** The full schema — the layout pickers need hidden properties too. */
  properties: PropertyDef[];
  rows: RowRecord[];
  config: ViewConfig;
  locked: boolean;
  onOpenRow(row: RowRecord): void;
  /** Open an arbitrary page (a relation chip's target). */
  onOpenPage(pageId: string): void;
  /** Create a row, optionally pre-seeded with property values. */
  onNewRow(values?: Record<string, PropertyValue>): void;
  /** Persist a patch into `view.config` (debounced by the owner). */
  onConfig(patch: Record<string, unknown>): void;
}

/** Visible non-title properties whose value is worth showing on a card. */
export function cardProperties(columns: PropertyDef[]): PropertyDef[] {
  return columns.filter((property) => property.type !== "title");
}

export function RowCard({
  row,
  columns,
  onOpen,
  onOpenPage,
  draggable = false,
  onDragStart,
}: {
  row: RowRecord;
  columns: PropertyDef[];
  onOpen(): void;
  onOpenPage?(pageId: string): void;
  draggable?: boolean;
  onDragStart?(event: React.DragEvent): void;
}): JSX.Element {
  const pills = cardProperties(columns);
  return (
    <div
      className="dbcard"
      role="button"
      tabIndex={0}
      draggable={draggable}
      {...(onDragStart ? { onDragStart } : {})}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <div className="dbcard__title">{displayTitle(row.page.title)}</div>
      <div className="dbcard__pills">
        {pills.map((property) => (
          <PropertyPill
            key={property.id}
            property={property}
            value={rowValue(row, property)}
            {...(onOpenPage ? { onOpenPage } : {})}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The prompt a layout shows when the property it needs is not chosen yet.
 * Notion refuses to guess here and so do we: a board silently grouping by the
 * first select it finds would rewrite the view's meaning behind the user's back.
 */
export function PickPropertyEmptyState({
  title,
  hint,
  candidates,
  disabled,
  onPick,
  emptyHint,
}: {
  title: string;
  hint: string;
  candidates: PropertyDef[];
  disabled: boolean;
  onPick(propertyId: string): void;
  /** Shown instead of the list when the schema has no usable property. */
  emptyHint: string;
}): JSX.Element {
  return (
    <div className="dbempty">
      <div className="dbempty__title">{title}</div>
      <div className="dbempty__hint">{hint}</div>
      {candidates.length === 0 ? (
        <div className="dbempty__hint">{emptyHint}</div>
      ) : (
        <div className="dbempty__list">
          {candidates.map((property) => (
            <button
              key={property.id}
              type="button"
              className="menuitem"
              disabled={disabled}
              onClick={() => onPick(property.id)}
            >
              <span className="propglyph">{propertyGlyph(property.type)}</span>
              <span className="menuitem__label">{property.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewRowButton({
  label = "+ New page",
  disabled,
  onClick,
  className,
}: {
  label?: string;
  disabled: boolean;
  onClick(): void;
  className?: string;
}): JSX.Element {
  return (
    <button type="button" className={cx("dbnew", className)} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}
