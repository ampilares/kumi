/**
 * The filter menu (Fig. 19) and the chip row it produces.
 *
 * Picking a property from the anchored "Filter by…" list appends a chip; the
 * chip itself opens an operator + operand popover typed to the property. All of
 * the state arithmetic lives in `filters.ts` — this file is the surface.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { FilterOperator, PropertyDef, PropertyType } from "@kumi/core";
import { Popover } from "../components/ui";
import { cx, displayTitle } from "../utils";
import {
  formatDateValue,
  optionById,
  optionsOf,
  parseDateInput,
  parseNumber,
  propertyGlyph,
} from "./properties";
import {
  isFilterable,
  newChip,
  operatorLabel,
  operatorsForProperty,
  setChipOperator,
  setChipValue,
  type FilterChip,
} from "./filters";
import { OptionChip, type RelationCandidate } from "./Cells";
import { usePageStubs } from "./usePageStubs";
import type { RollupTargetTypes } from "./rollupTargets";

/** Searches the target data source of a relation property; supplied by the view. */
export type RelationSearch = (
  property: PropertyDef,
  query: string,
) => Promise<RelationCandidate[]>;

/* --------------------------------------------------------- "Filter by…" */

export function FilterMenu({
  open,
  anchorRef,
  properties,
  rollupTargetTypes,
  onClose,
  onPick,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  properties: PropertyDef[];
  /** Rollup property id → its target property's type; see `rollupTargets.ts`. */
  rollupTargetTypes?: RollupTargetTypes;
  onClose(): void;
  onPick(property: PropertyDef): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // A non-numeric rollup has no operators core accepts, so it is not offered.
    const filterable = properties.filter((p) => isFilterable(p, rollupTargetTypes?.get(p.id)));
    if (needle === "") return filterable;
    return filterable.filter((p) => p.name.toLowerCase().includes(needle));
  }, [properties, query, rollupTargetTypes]);

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} label="Filter" width={260}>
      <input
        className="field"
        autoFocus
        value={query}
        placeholder="Filter by…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu__scroll">
        {matches.map((property) => (
          <button
            key={property.id}
            type="button"
            className="menuitem"
            onClick={() => {
              onPick(property);
              setQuery("");
              onClose();
            }}
          >
            <span className="propglyph">{propertyGlyph(property.type)}</span>
            <span className="menuitem__label">{property.name}</span>
          </button>
        ))}
        {matches.length === 0 ? <div className="menu__empty">No properties match.</div> : null}
      </div>
      <div className="menu__sep" role="separator" />
      <button type="button" className="menuitem" disabled title="Nested AND/OR is still CLI-only">
        <span className="menuitem__label">+ Add advanced filter</span>
        <span className="menuitem__hint">CLI only</span>
      </button>
    </Popover>
  );
}

/* ------------------------------------------------------------- chip row */

export function FilterChipRow({
  chips,
  properties,
  connective,
  locked,
  onChange,
  onRemove,
  onConnective,
  onSearchRelated,
  rollupTargetTypes,
}: {
  chips: FilterChip[];
  properties: PropertyDef[];
  connective: "and" | "or";
  locked: boolean;
  onChange(chip: FilterChip): void;
  onRemove(id: string): void;
  onConnective(next: "and" | "or"): void;
  onSearchRelated?: RelationSearch;
  rollupTargetTypes?: RollupTargetTypes;
}): JSX.Element | null {
  if (chips.length === 0) return null;
  const byId = new Map(properties.map((p) => [p.id, p]));

  return (
    <div className="dbfilters">
      {chips.map((chip, index) => {
        const property = byId.get(chip.propertyId);
        if (!property) return null;
        return (
          <div key={chip.id} className="dbfilters__slot">
            {index === 0 ? (
              <span className="dbfilters__join is-static">Where</span>
            ) : index === 1 ? (
              <button
                type="button"
                className="dbfilters__join"
                onClick={() => onConnective(connective === "and" ? "or" : "and")}
              >
                {connective === "and" ? "And" : "Or"}
              </button>
            ) : (
              <span className="dbfilters__join is-static">
                {connective === "and" ? "And" : "Or"}
              </span>
            )}
            <ChipButton
              chip={chip}
              property={property}
              locked={locked}
              onChange={onChange}
              onRemove={() => onRemove(chip.id)}
              targetType={rollupTargetTypes?.get(property.id)}
              {...(onSearchRelated ? { onSearchRelated } : {})}
            />
          </div>
        );
      })}
    </div>
  );
}

function chipSummary(chip: FilterChip, property: PropertyDef, relationTitle?: string): string {
  const op = operatorLabel(property.type, chip.op);
  if (chip.value === undefined) return `${property.name} · ${op}`;
  const value = chip.value;
  if (property.type === "relation") {
    return `${property.name} ${op.toLowerCase()} ${relationTitle ?? "…"}`;
  }
  if (property.type === "select" || property.type === "multi_select") {
    const name = optionById(property, typeof value === "string" ? value : null)?.name ?? "…";
    return `${property.name} ${op.toLowerCase()} ${name}`;
  }
  if (property.type === "date") {
    const text = typeof value === "string" ? formatDateValue(value) : "";
    return `${property.name} ${op.toLowerCase()} ${text === "" ? "…" : text}`;
  }
  if (property.type === "checkbox") {
    return `${property.name} ${op.toLowerCase()} ${value === true ? "checked" : "unchecked"}`;
  }
  const text = value === null || value === "" ? "…" : String(value);
  return `${property.name} ${op.toLowerCase()} ${text}`;
}

function ChipButton({
  chip,
  property,
  locked,
  onChange,
  onRemove,
  onSearchRelated,
  targetType,
}: {
  chip: FilterChip;
  property: PropertyDef;
  locked: boolean;
  onChange(chip: FilterChip): void;
  onRemove(): void;
  onSearchRelated?: RelationSearch;
  targetType?: PropertyType | null;
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const relationId =
    property.type === "relation" && typeof chip.value === "string" && chip.value !== ""
      ? chip.value
      : null;
  const stubs = usePageStubs(relationId === null ? [] : [relationId]);
  const relationTitle =
    relationId === null ? undefined : displayTitle(stubs.get(relationId)?.title);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx("dbfilters__chip", open && "is-open")}
        onClick={() => {
          if (!locked) setOpen(true);
        }}
      >
        <span className="propglyph">{propertyGlyph(property.type)}</span>
        {chipSummary(chip, property, relationTitle)}
      </button>
      <Popover
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        label={`${property.name} filter`}
        width={252}
      >
        <div className="menu__label">Condition</div>
        <div className="menu__scroll">
          {operatorsForProperty(property, targetType).map((info) => (
            <button
              key={info.op}
              type="button"
              className={cx("menuitem", chip.op === info.op && "is-on")}
              onClick={() => onChange(setChipOperator(chip, property.type, info.op))}
            >
              <span className="menuitem__label">{info.label}</span>
              {chip.op === info.op ? <span className="menuitem__hint">✓</span> : null}
            </button>
          ))}
        </div>
        {chip.value === undefined ? null : (
          <>
            <div className="menu__sep" role="separator" />
            <OperandEditor
              property={property}
              op={chip.op}
              value={chip.value}
              onChange={(value) => onChange(setChipValue(chip, value))}
              {...(onSearchRelated ? { onSearchRelated } : {})}
            />
          </>
        )}
        <div className="menu__sep" role="separator" />
        <button
          type="button"
          className="menuitem menuitem--danger"
          onClick={() => {
            setOpen(false);
            onRemove();
          }}
        >
          <span className="menuitem__label">Delete filter</span>
        </button>
      </Popover>
    </>
  );
}

/** The typed operand input — one per property type, per the filters.ts shapes. */
export function OperandEditor({
  property,
  op,
  value,
  onChange,
  onSearchRelated,
}: {
  property: PropertyDef;
  op: FilterOperator;
  value: unknown;
  onChange(next: unknown): void;
  onSearchRelated?: RelationSearch;
}): JSX.Element {
  switch (property.type) {
    case "relation":
      return onSearchRelated === undefined ? (
        <div className="menu__empty">This relation has no target database yet.</div>
      ) : (
        <RelationOperand
          property={property}
          value={value}
          onChange={onChange}
          onSearchRelated={onSearchRelated}
        />
      );
    case "rollup":
      // The operator decides the operand's shape — see `filters.ts`.
      return op === "contains" || op === "not_contains" ? (
        <input
          className="field"
          placeholder="Value"
          defaultValue={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className="field"
          inputMode="decimal"
          placeholder="Value"
          defaultValue={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(parseNumber(e.target.value))}
        />
      );
    case "number":
      return (
        <input
          className="field"
          inputMode="decimal"
          placeholder="Value"
          defaultValue={typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(parseNumber(e.target.value))}
        />
      );
    case "checkbox":
      return (
        <div className="menu__scroll">
          {[true, false].map((option) => (
            <button
              key={String(option)}
              type="button"
              className={cx("menuitem", value === option && "is-on")}
              onClick={() => onChange(option)}
            >
              <span className="menuitem__label">{option ? "Checked" : "Unchecked"}</span>
            </button>
          ))}
        </div>
      );
    case "select":
    case "multi_select":
      return (
        <div className="menu__scroll">
          {optionsOf(property).map((option) => (
            <button
              key={option.id}
              type="button"
              className={cx("menuitem", value === option.id && "is-on")}
              onClick={() => onChange(option.id)}
            >
              <OptionChip option={option} />
            </button>
          ))}
          {optionsOf(property).length === 0 ? (
            <div className="menu__empty">No options yet.</div>
          ) : null}
        </div>
      );
    case "date":
      return (
        <input
          className="field"
          type="date"
          defaultValue={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(parseDateInput(e.target.value) ?? "")}
        />
      );
    default:
      return (
        <input
          className="field"
          placeholder="Value"
          defaultValue={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** The relation operand is a *row*, so the operand editor is a row picker. */
function RelationOperand({
  property,
  value,
  onChange,
  onSearchRelated,
}: {
  property: PropertyDef;
  value: unknown;
  onChange(next: unknown): void;
  onSearchRelated: RelationSearch;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RelationCandidate[]>([]);
  const searchRef = useRef(onSearchRelated);
  searchRef.current = onSearchRelated;

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchRef
        .current(property, query)
        .then((result) => {
          if (!cancelled) setRows(result);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [property, query]);

  return (
    <>
      <input
        className="field"
        value={query}
        placeholder="Search for a page…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu__scroll">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={cx("menuitem", value === row.id && "is-on")}
            onClick={() => onChange(row.id)}
          >
            <span className="menuitem__label">{displayTitle(row.title)}</span>
          </button>
        ))}
        {rows.length === 0 ? <div className="menu__empty">No pages match.</div> : null}
      </div>
    </>
  );
}
