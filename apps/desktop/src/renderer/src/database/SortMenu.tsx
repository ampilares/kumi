/**
 * The sort menu: the view's ordered `SortSpec[]` on top (first entry wins),
 * then a property picker that appends one. Reordering is by arrows rather than
 * drag — the list is short, and arrows are keyboard-reachable, which the drag
 * affordance on its own would not be.
 */

import { useMemo, useState, type RefObject } from "react";
import type { PropertyDef, SortSpec } from "@kumi/core";
import { Popover } from "../components/ui";
import { cx } from "../utils";
import { propertyGlyph } from "./properties";
import { isSortable } from "./filters";
import { moveItem, removeSort, setSort, toggleSortDirection } from "./viewConfig";

export function SortMenu({
  open,
  anchorRef,
  properties,
  sorts,
  locked,
  onClose,
  onChange,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  properties: PropertyDef[];
  sorts: SortSpec[];
  locked: boolean;
  onClose(): void;
  onChange(next: SortSpec[]): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const byId = useMemo(() => new Map(properties.map((p) => [p.id, p])), [properties]);
  const sorted = new Set(sorts.map((s) => s.propertyId));
  const available = properties.filter((p) => {
    // Core rejects a sort on a relation or a show_originals rollup outright.
    if (sorted.has(p.id) || !isSortable(p)) return false;
    const needle = query.trim().toLowerCase();
    return needle === "" || p.name.toLowerCase().includes(needle);
  });

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} label="Sort" width={272}>
      {sorts.length > 0 ? (
        <>
          <div className="menu__label">Sort by</div>
          {sorts.map((sort, index) => {
            const property = byId.get(sort.propertyId);
            return (
              <div key={sort.propertyId} className="sortrow">
                <span className="propglyph">
                  {property ? propertyGlyph(property.type) : "?"}
                </span>
                <span className="sortrow__name">{property?.name ?? "Unknown property"}</span>
                <button
                  type="button"
                  className="sortrow__dir"
                  disabled={locked}
                  onClick={() => onChange(toggleSortDirection(sorts, index))}
                >
                  {sort.direction === "asc" ? "Ascending" : "Descending"}
                </button>
                <button
                  type="button"
                  className="iconbtn iconbtn--xs"
                  title="Move up"
                  aria-label="Move sort up"
                  disabled={locked || index === 0}
                  onClick={() => onChange(moveItem(sorts, index, index - 1))}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="iconbtn iconbtn--xs"
                  title="Move down"
                  aria-label="Move sort down"
                  disabled={locked || index === sorts.length - 1}
                  onClick={() => onChange(moveItem(sorts, index, index + 1))}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="iconbtn iconbtn--xs"
                  title="Remove"
                  aria-label="Remove sort"
                  disabled={locked}
                  onClick={() => onChange(removeSort(sorts, sort.propertyId))}
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="menu__sep" role="separator" />
        </>
      ) : null}

      <input
        className="field"
        value={query}
        placeholder="Sort by…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu__scroll">
        {available.map((property) => (
          <button
            key={property.id}
            type="button"
            className="menuitem"
            disabled={locked}
            onClick={() => {
              onChange(setSort(sorts, property.id, "asc"));
              setQuery("");
            }}
          >
            <span className="propglyph">{propertyGlyph(property.type)}</span>
            <span className="menuitem__label">{property.name}</span>
          </button>
        ))}
        {available.length === 0 ? (
          <div className={cx("menu__empty")}>Every property is already sorted.</div>
        ) : null}
      </div>
    </Popover>
  );
}
