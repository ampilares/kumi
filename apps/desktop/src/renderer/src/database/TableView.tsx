/**
 * The table layout.
 *
 * A plain `<table>` with `table-layout: fixed` and an explicit `<colgroup>`:
 * at Phase 4 scale virtualisation buys nothing, and a real table keeps column
 * widths, sticky headers and keyboard traversal to the browser rather than to
 * hand-written geometry.
 *
 * Everything that mutates goes out through props — the component itself never
 * calls IPC, so the same grid can be mounted inline, full-page, or (Phase 5)
 * inside a board's expanded group.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  PropertyConfig,
  PropertyDef,
  PropertyType,
  PropertyValue,
  RowRecord,
  SelectOption,
  ViewConfig,
} from "@kumi/core";
import { cx, displayTitle } from "../utils";
import { useDismiss } from "../hooks";
import { PropertyCell, type RelationCandidate } from "./Cells";
import { propertyGlyph, rowValue } from "./properties";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH, columnWidth } from "./viewConfig";
import { AddPropertyMenu, PropertyMenu, type PropertyActions } from "./PropertyMenus";

export interface TableViewProps {
  /** Visible properties in display order; the title column is always first. */
  columns: PropertyDef[];
  /** The full schema, including hidden properties — the add menus need it. */
  schema: PropertyDef[];
  rows: RowRecord[];
  config: ViewConfig;
  locked: boolean;
  actions: PropertyActions;
  onCommitValue(row: RowRecord, property: PropertyDef, next: PropertyValue | null): void;
  onOptionsChange(property: PropertyDef, options: SelectOption[]): void;
  onWidth(propertyId: string, width: number): void;
  onReorderColumn(propertyId: string, afterPropertyId: string | null): void;
  onAddProperty(name: string, type: PropertyType): void;
  /** Relation / rollup, which are created together with their configuration. */
  onAddPropertyConfigured(name: string, type: PropertyType, config: PropertyConfig): void;
  /** Name the paired reverse relation gets on the target database. */
  ownerTitle: string;
  /** Relation cells: search the target data source for rows to link. */
  onSearchRelated(property: PropertyDef, query: string): Promise<RelationCandidate[]>;
  onOpenPage(pageId: string): void;
  onOpenRow(row: RowRecord): void;
  onDuplicateRow(row: RowRecord): void;
  onDeleteRow(row: RowRecord): void;
  onNewRow(): void;
  /** Row page id whose title cell should take focus after a create. */
  focusRowId: string | null;
}

interface RowMenuState {
  row: RowRecord;
  x: number;
  y: number;
}

export function TableView(props: TableViewProps): JSX.Element {
  const { columns, rows, config, locked } = props;
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [menuProperty, setMenuProperty] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const [dragColumn, setDragColumn] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const headRefs = useRef(new Map<string, HTMLTableCellElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // A freshly created row lands with the caret in its title, Notion-style.
  useEffect(() => {
    const id = props.focusRowId;
    if (id === null) return;
    const input = bodyRef.current?.querySelector<HTMLInputElement>(
      `[data-row-title="${CSS.escape(id)}"] input`,
    );
    input?.focus();
  }, [props.focusRowId, rows]);

  const widthOf = (property: PropertyDef): number =>
    drafts[property.id] ?? columnWidth(config, property);

  /* -------------------------------------------------------------- resize */

  const startResize = (property: PropertyDef, event: React.PointerEvent): void => {
    if (locked) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = widthOf(property);
    let last = startWidth;

    const onMove = (move: PointerEvent): void => {
      last = Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(MIN_COLUMN_WIDTH, Math.round(startWidth + (move.clientX - startX))),
      );
      setDrafts((current) => ({ ...current, [property.id]: last }));
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrafts((current) => {
        const next = { ...current };
        delete next[property.id];
        return next;
      });
      if (last !== startWidth) props.onWidth(property.id, last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* ------------------------------------------------------------- reorder */

  const startColumnDrag = (property: PropertyDef, event: React.PointerEvent): void => {
    // The title column is pinned, and a locked view never reorders.
    if (locked || property.type === "title") return;
    const startX = event.clientX;
    let moved = false;
    let target: number | null = null;

    const onMove = (move: PointerEvent): void => {
      if (!moved && Math.abs(move.clientX - startX) < 4) return;
      moved = true;
      setDragColumn(property.id);
      let index = columns.length;
      for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        const el = column ? headRefs.current.get(column.id) : undefined;
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (move.clientX < rect.left + rect.width / 2) {
          index = i;
          break;
        }
      }
      target = Math.max(1, index); // never before the pinned title column
      setDropIndex(target);
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragColumn(null);
      setDropIndex(null);
      if (!moved || target === null) {
        setMenuProperty(property.id);
        return;
      }
      const without = columns.filter((c) => c.id !== property.id);
      const at = Math.min(Math.max(1, target), without.length);
      const after = without[at - 1] ?? null;
      if (after && after.id !== property.id) props.onReorderColumn(property.id, after.id);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /* -------------------------------------------------------------- render */

  return (
    <div className="dbtable__scroll">
      <table className="dbtable">
        <colgroup>
          {columns.map((property) => (
            <col key={property.id} style={{ width: widthOf(property) }} />
          ))}
          <col style={{ width: 44 }} />
        </colgroup>
        <thead>
          <tr>
            {columns.map((property, index) => (
              <th
                key={property.id}
                ref={(el) => {
                  if (el) headRefs.current.set(property.id, el);
                  else headRefs.current.delete(property.id);
                }}
                className={cx(
                  "dbth",
                  dragColumn === property.id && "is-dragging",
                  dropIndex === index && "is-droptarget",
                )}
                scope="col"
              >
                <button
                  type="button"
                  className="dbth__btn"
                  onPointerDown={(event) => startColumnDrag(property, event)}
                  onClick={() => {
                    if (property.type === "title" || locked) setMenuProperty(property.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenuProperty(property.id);
                  }}
                >
                  <span className="propglyph">{propertyGlyph(property.type)}</span>
                  <span className="dbth__name">{property.name}</span>
                </button>
                <span
                  className="dbth__resize"
                  role="separator"
                  aria-orientation="vertical"
                  onPointerDown={(event) => startResize(property, event)}
                />
                <HeaderMenuMount
                  property={property}
                  open={menuProperty === property.id}
                  locked={locked}
                  actions={props.actions}
                  headRefs={headRefs}
                  onClose={() => setMenuProperty(null)}
                />
              </th>
            ))}
            <th className="dbth dbth--add" scope="col">
              <button
                ref={addRef}
                type="button"
                className="dbth__btn dbth__add"
                title="Add a property"
                aria-label="Add a property"
                disabled={locked}
                onClick={() => setAdding(true)}
              >
                +
              </button>
            </th>
          </tr>
        </thead>

        <tbody ref={bodyRef}>
          {rows.map((row) => (
            <tr
              key={row.page.id}
              className="dbrow"
              onContextMenu={(event) => {
                event.preventDefault();
                setRowMenu({ row, x: event.clientX, y: event.clientY });
              }}
            >
              {columns.map((property) => (
                <td key={property.id} className={cx("dbcell", `dbcell--${property.type}`)}>
                  {property.type === "title" ? (
                    // Single click edits the name (Notion's behaviour); the
                    // OPEN pill and a double click both open the row.
                    <div
                      className="dbcell__title"
                      data-row-title={row.page.id}
                      onDoubleClick={() => props.onOpenRow(row)}
                    >
                      <PropertyCell
                        property={property}
                        value={rowValue(row, property)}
                        editable={!locked}
                        onCommit={(next) => props.onCommitValue(row, property, next)}
                      />
                      <button
                        type="button"
                        className="dbcell__openpill"
                        onClick={() => props.onOpenRow(row)}
                      >
                        OPEN
                      </button>
                    </div>
                  ) : (
                    <PropertyCell
                      property={property}
                      value={rowValue(row, property)}
                      editable={!locked}
                      onCommit={(next) => props.onCommitValue(row, property, next)}
                      onOptionsChange={(options) => props.onOptionsChange(property, options)}
                      onSearchRelated={(query) => props.onSearchRelated(property, query)}
                      onOpenPage={props.onOpenPage}
                    />
                  )}
                </td>
              ))}
              <td className="dbcell dbcell--pad" />
            </tr>
          ))}

          {rows.length === 0 ? (
            <tr className="dbrow dbrow--empty">
              <td className="dbcell" colSpan={columns.length + 1}>
                No rows yet.
              </td>
            </tr>
          ) : null}

          <tr className="dbrow dbrow--new">
            <td className="dbcell" colSpan={columns.length + 1}>
              <button
                type="button"
                className="dbnew"
                disabled={locked}
                onClick={props.onNewRow}
              >
                + New page
              </button>
            </td>
          </tr>
        </tbody>
      </table>

      <AddPropertyMenu
        open={adding}
        anchorRef={addRef}
        onClose={() => setAdding(false)}
        onCreate={props.onAddProperty}
        onCreateConfigured={props.onAddPropertyConfigured}
        properties={props.schema}
        ownerTitle={props.ownerTitle}
      />

      {rowMenu ? (
        <RowMenu
          state={rowMenu}
          locked={locked}
          onClose={() => setRowMenu(null)}
          onOpen={() => props.onOpenRow(rowMenu.row)}
          onDuplicate={() => props.onDuplicateRow(rowMenu.row)}
          onDelete={() => props.onDeleteRow(rowMenu.row)}
        />
      ) : null}
    </div>
  );
}

/** Keeps the header menu anchored to its own `<th>` without prop-drilling refs. */
function HeaderMenuMount({
  property,
  open,
  locked,
  actions,
  headRefs,
  onClose,
}: {
  property: PropertyDef;
  open: boolean;
  locked: boolean;
  actions: PropertyActions;
  headRefs: React.MutableRefObject<Map<string, HTMLTableCellElement>>;
  onClose(): void;
}): JSX.Element | null {
  const anchor = useRef<HTMLElement | null>(null);
  anchor.current = headRefs.current.get(property.id) ?? null;
  if (!open) return null;
  return (
    <PropertyMenu
      open={open}
      anchorRef={anchor}
      property={property}
      locked={locked}
      actions={actions}
      onClose={onClose}
    />
  );
}

function RowMenu({
  state,
  locked,
  onClose,
  onOpen,
  onDuplicate,
  onDelete,
}: {
  state: RowMenuState;
  locked: boolean;
  onClose(): void;
  onOpen(): void;
  onDuplicate(): void;
  onDelete(): void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, [ref], onClose);
  const title = displayTitle(state.row.page.title);

  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="menu"
      aria-label={`${title} options`}
      style={{ top: state.y, left: state.x, width: 200 }}
    >
      <button
        type="button"
        className="menuitem"
        onClick={() => {
          onOpen();
          onClose();
        }}
      >
        <span className="menuitem__label">Open</span>
      </button>
      <button
        type="button"
        className="menuitem"
        disabled={locked}
        onClick={() => {
          onDuplicate();
          onClose();
        }}
      >
        <span className="menuitem__label">Duplicate</span>
      </button>
      <button
        type="button"
        className="menuitem menuitem--danger"
        disabled={locked}
        onClick={() => {
          onDelete();
          onClose();
        }}
      >
        <span className="menuitem__label">Delete</span>
      </button>
    </div>,
    document.body,
  );
}
