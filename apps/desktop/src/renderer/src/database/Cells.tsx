/**
 * Typed property cells.
 *
 * One component per property type, all sharing the same contract: they render
 * the stored `PropertyValue`, and on commit hand back a *complete* value (or
 * `null` to clear). Nothing here talks to IPC — the table and the row peek both
 * mount the same components and own persistence, which is what lets the peek
 * show a vertical property panel with identical editors.
 *
 * `variant` is the only presentation difference: `cell` fills a table cell,
 * `field` is the stacked form row used inside the peek, and `card` is the
 * read-only pill the board, list, gallery and calendar layouts put on a card.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PropertyDef, PropertyValue, SelectOption } from "@kumi/core";
import { Popover } from "../components/ui";
import { cx } from "../utils";
import {
  formatDateValue,
  formatNumber,
  optionById,
  optionsOf,
  parseDateInput,
  parseNumber,
  plainToRichText,
  richTextToPlain,
  rollupText,
  toggleRelationId,
} from "./properties";
import { resolveRelationChips } from "./relations";
import { usePageStubs } from "./usePageStubs";
import {
  OPTION_COLORS,
  addOption,
  canCreateOption,
  recolorOption,
  removeOption,
  renameOption,
  searchOptions,
  toggleOptionId,
} from "./options";

export type CellVariant = "cell" | "field" | "card";

/** One row of the target database, as the relation picker needs it. */
export interface RelationCandidate {
  id: string;
  title: string;
}

export interface CellProps {
  property: PropertyDef;
  value: PropertyValue;
  editable: boolean;
  variant?: CellVariant;
  onCommit(next: PropertyValue | null): void;
  /** Persist an edited option list (select / multi-select only). */
  onOptionsChange?(options: SelectOption[]): void;
  /**
   * Relation only. The cell still owns no IPC: the view supplies the search,
   * because only it knows which data source the property points at.
   */
  onSearchRelated?(query: string): Promise<RelationCandidate[]>;
  /** Relation only: open the peek for a related row. */
  onOpenPage?(pageId: string): void;
}

/* ------------------------------------------------------------------- text */

/**
 * A text input that keeps its own draft while focused, so a `kumi:changed`
 * refetch mid-typing can never move the caret or clobber the keystroke.
 */
function TextInput({
  value,
  editable,
  align,
  placeholder,
  displayValue,
  onCommit,
  onOpenBlank,
}: {
  value: string;
  editable: boolean;
  align?: "right";
  placeholder?: string;
  /** Shown when the input is *not* focused (formatted numbers, for example). */
  displayValue?: string;
  onCommit(next: string): void;
  onOpenBlank?: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);

  const shown = focused ? draft : (displayValue ?? value);

  return (
    <div className={cx("dbcell__text", align === "right" && "dbcell__text--right")}>
      <input
        ref={inputRef}
        className="dbcell__input"
        value={shown}
        placeholder={placeholder}
        readOnly={!editable}
        spellCheck={false}
        onFocus={() => {
          setDraft(value);
          setFocused(true);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setFocused(false);
          if (draft !== value) onCommit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(value);
            setFocused(false);
            inputRef.current?.blur();
          }
        }}
      />
      {onOpenBlank && value !== "" ? (
        <button
          type="button"
          className="dbcell__link"
          title="Open link"
          aria-label="Open link"
          onClick={onOpenBlank}
        >
          ↗
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ chips */

export function OptionChip({ option }: { option: SelectOption }): JSX.Element {
  return <span className={cx("chip", `chip--${option.color}`)}>{option.name}</span>;
}

/** Anchored surface used by the select, multi-select and date editors. */
function CellPopover({
  label,
  width,
  editable,
  display,
  render,
}: {
  label: string;
  width: number;
  editable: boolean;
  display: ReactNode;
  render(close: () => void): ReactNode;
}): JSX.Element {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="dbcell__open"
        aria-label={label}
        onClick={() => {
          if (editable) setOpen(true);
        }}
      >
        {display}
      </button>
      <Popover
        open={open}
        anchorRef={anchor}
        onClose={() => setOpen(false)}
        label={label}
        width={width}
      >
        {render(() => setOpen(false))}
      </Popover>
    </>
  );
}

/* ----------------------------------------------------------------- select */

function OptionMenu({
  property,
  selected,
  multi,
  editable,
  onToggle,
  onOptionsChange,
  onClose,
}: {
  property: PropertyDef;
  selected: string[];
  multi: boolean;
  editable: boolean;
  onToggle(optionId: string): void;
  onOptionsChange?(options: SelectOption[]): void;
  onClose(): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const options = optionsOf(property);
  const matches = searchOptions(options, query);

  const create = (): void => {
    if (!onOptionsChange) return;
    const result = addOption(options, query, () => crypto.randomUUID());
    if (!result.existed) onOptionsChange(result.options);
    onToggle(result.option.id);
    setQuery("");
    if (!multi) onClose();
  };

  return (
    <div className="optmenu">
      <input
        className="field"
        autoFocus
        value={query}
        placeholder="Search for an option…"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canCreateOption(options, query)) {
            e.preventDefault();
            create();
          }
        }}
      />
      <div className="menu__label">Select an option</div>
      <div className="optmenu__list">
        {matches.map((option) => (
          <div key={option.id} className="optmenu__row">
            <button
              type="button"
              className={cx("optmenu__pick", selected.includes(option.id) && "is-on")}
              onClick={() => {
                onToggle(option.id);
                if (!multi) onClose();
              }}
            >
              <OptionChip option={option} />
              {selected.includes(option.id) ? <span className="optmenu__tick">✓</span> : null}
            </button>
            {onOptionsChange && editable ? (
              <button
                type="button"
                className="optmenu__edit"
                title="Edit option"
                aria-label={`Edit ${option.name}`}
                onClick={() => setEditing(editing === option.id ? null : option.id)}
              >
                ✎
              </button>
            ) : null}
            {editing === option.id && onOptionsChange ? (
              <div className="optmenu__editor">
                <input
                  className="field"
                  defaultValue={option.name}
                  aria-label="Option name"
                  onBlur={(e) => onOptionsChange(renameOption(options, option.id, e.target.value))}
                />
                <div className="optmenu__colors">
                  {OPTION_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={cx("swatch", `chip--${color}`, option.color === color && "is-on")}
                      title={color}
                      aria-label={color}
                      onClick={() => onOptionsChange(recolorOption(options, option.id, color))}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="menuitem menuitem--danger"
                  onClick={() => {
                    onOptionsChange(removeOption(options, option.id));
                    setEditing(null);
                  }}
                >
                  <span className="menuitem__label">Delete option</span>
                </button>
              </div>
            ) : null}
          </div>
        ))}
        {onOptionsChange && canCreateOption(options, query) ? (
          <button type="button" className="menuitem" onClick={create}>
            <span className="menuitem__label">Create “{query.trim()}”</span>
          </button>
        ) : null}
        {matches.length === 0 && !canCreateOption(options, query) ? (
          <div className="menu__empty">No options yet.</div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- date */

function DateEditor({
  start,
  end,
  onCommit,
}: {
  start: string | null;
  end: string | null;
  onCommit(start: string | null, end: string | null): void;
}): JSX.Element {
  const [hasEnd, setHasEnd] = useState(end !== null && end !== "");
  return (
    <div className="dateedit">
      <label className="dateedit__row">
        <span className="dateedit__label">Date</span>
        <input
          className="field"
          type="date"
          autoFocus
          defaultValue={start ?? ""}
          onChange={(e) => onCommit(parseDateInput(e.target.value), hasEnd ? end : null)}
        />
      </label>
      {hasEnd ? (
        <label className="dateedit__row">
          <span className="dateedit__label">End</span>
          <input
            className="field"
            type="date"
            defaultValue={end ?? ""}
            onChange={(e) => onCommit(start, parseDateInput(e.target.value))}
          />
        </label>
      ) : null}
      <button
        type="button"
        className="menuitem"
        onClick={() => {
          const next = !hasEnd;
          setHasEnd(next);
          if (!next) onCommit(start, null);
        }}
      >
        <span className="menuitem__label">{hasEnd ? "Remove end date" : "Add an end date"}</span>
      </button>
      <button type="button" className="menuitem" onClick={() => onCommit(null, null)}>
        <span className="menuitem__label">Clear</span>
      </button>
    </div>
  );
}

/* --------------------------------------------------------------- relation */

/** Chips of related row titles; each one opens that row's peek. */
function RelationChips({
  pageIds,
  onOpenPage,
}: {
  pageIds: string[];
  onOpenPage?(pageId: string): void;
}): JSX.Element {
  const stubs = usePageStubs(pageIds);
  const chips = resolveRelationChips(pageIds, stubs);
  if (chips.length === 0) return <span className="dbcell__empty">Empty</span>;
  return (
    <span className="dbcell__chips">
      {chips.map((chip) => (
        <span
          key={chip.pageId}
          className={cx("chip", "chip--relation", chip.missing && "is-missing")}
          role={onOpenPage ? "button" : undefined}
          tabIndex={onOpenPage ? 0 : undefined}
          onClick={(event) => {
            if (!onOpenPage) return;
            event.stopPropagation();
            onOpenPage(chip.pageId);
          }}
          onKeyDown={(event) => {
            if (!onOpenPage || event.key !== "Enter") return;
            event.preventDefault();
            event.stopPropagation();
            onOpenPage(chip.pageId);
          }}
        >
          {chip.title}
        </span>
      ))}
    </span>
  );
}

/** Searchable multi-toggle over the target data source's rows. */
function RelationPicker({
  selected,
  onSearch,
  onToggle,
}: {
  selected: string[];
  onSearch(query: string): Promise<RelationCandidate[]>;
  onToggle(pageId: string): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<RelationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchRef
        .current(query)
        .then((result) => {
          if (!cancelled) setRows(result);
        })
        .catch(() => {
          if (!cancelled) setRows([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return (
    <div className="optmenu">
      <input
        className="field"
        autoFocus
        value={query}
        placeholder="Search for a page…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu__label">Link a page</div>
      <div className="optmenu__list">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            className={cx("optmenu__pick", selected.includes(row.id) && "is-on")}
            onClick={() => onToggle(row.id)}
          >
            <span className="menuitem__label">{row.title.trim() === "" ? "Untitled" : row.title}</span>
            {selected.includes(row.id) ? <span className="optmenu__tick">✓</span> : null}
          </button>
        ))}
        {rows.length === 0 ? (
          <div className="menu__empty">{loading ? "Searching…" : "No pages match."}</div>
        ) : null}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- rollup */

/** Rollups are computed at read time; core rejects writes, so this never edits. */
function RollupCell({
  property,
  value,
}: {
  property: PropertyDef;
  value: Extract<PropertyValue, { type: "rollup" }>;
}): JSX.Element {
  const text = rollupText(value, property);
  return (
    <div className="dbcell__rollup" title={`Rollup · ${value.aggregation.replace(/_/g, " ")}`}>
      <span className="dbcell__rollupmark" aria-hidden="true">
        ∑
      </span>
      {text === "" ? <span className="dbcell__empty">Empty</span> : <span>{text}</span>}
    </div>
  );
}

/* ------------------------------------------------------------- card pills */

/**
 * The read-only presentation a card uses. Empty values render nothing at all —
 * a card padded out with "Empty" placeholders is noise, not information.
 */
export function PropertyPill({
  property,
  value,
  onOpenPage,
}: {
  property: PropertyDef;
  value: PropertyValue;
  onOpenPage?(pageId: string): void;
}): JSX.Element | null {
  switch (value.type) {
    case "title":
    case "text": {
      const text = richTextToPlain(value.richText);
      return text === "" ? null : <span className="cardpill">{text}</span>;
    }
    case "number":
      return value.number === null ? null : (
        <span className="cardpill">
          {formatNumber(value.number, property.config.numberFormat ?? "number")}
        </span>
      );
    case "select": {
      const option = optionById(property, value.optionId);
      return option ? <OptionChip option={option} /> : null;
    }
    case "multi_select": {
      const chosen = value.optionIds
        .map((id) => optionById(property, id))
        .filter((option): option is SelectOption => option !== null);
      return chosen.length === 0 ? null : (
        <>
          {chosen.map((option) => (
            <OptionChip key={option.id} option={option} />
          ))}
        </>
      );
    }
    case "date": {
      const text = formatDateValue(value.start, value.end ?? null);
      return text === "" ? null : <span className="cardpill">{text}</span>;
    }
    case "checkbox":
      return (
        <span className="cardpill">
          {value.checked ? "☑" : "☐"} {property.name}
        </span>
      );
    case "url":
    case "email":
    case "phone":
      return value.value === null || value.value === "" ? null : (
        <span className="cardpill">{value.value}</span>
      );
    case "relation":
      return value.pageIds.length === 0 ? null : (
        <RelationChips pageIds={value.pageIds} {...(onOpenPage ? { onOpenPage } : {})} />
      );
    case "rollup": {
      const text = rollupText(value, property);
      return text === "" ? null : <span className="cardpill">∑ {text}</span>;
    }
  }
}

/* ------------------------------------------------------------- the switch */

export function PropertyCell(props: CellProps): JSX.Element {
  const { property, value, editable, variant, onCommit, onOptionsChange, onOpenPage } = props;

  if (variant === "card") {
    return (
      <span className="dbcell__card">
        <PropertyPill property={property} value={value} {...(onOpenPage ? { onOpenPage } : {})} />
      </span>
    );
  }

  switch (value.type) {
    case "title":
    case "text":
      return (
        <TextInput
          value={richTextToPlain(value.richText)}
          editable={editable}
          placeholder="Empty"
          onCommit={(next) =>
            onCommit({ type: value.type, richText: plainToRichText(next) } as PropertyValue)
          }
        />
      );

    case "number": {
      const format = property.config.numberFormat;
      return (
        <TextInput
          value={value.number === null ? "" : String(value.number)}
          displayValue={formatNumber(value.number, format ?? "number")}
          align="right"
          editable={editable}
          placeholder="Empty"
          onCommit={(next) => onCommit({ type: "number", number: parseNumber(next) })}
        />
      );
    }

    case "checkbox":
      return (
        <div className="dbcell__check">
          <input
            type="checkbox"
            checked={value.checked}
            disabled={!editable}
            aria-label={property.name}
            onChange={(e) => onCommit({ type: "checkbox", checked: e.target.checked })}
          />
        </div>
      );

    case "select": {
      const option = optionById(property, value.optionId);
      return (
        <CellPopover
          label={property.name}
          width={260}
          editable={editable}
          display={
            option ? <OptionChip option={option} /> : <span className="dbcell__empty">Empty</span>
          }
          render={(close) => (
            <OptionMenu
              property={property}
              selected={value.optionId === null ? [] : [value.optionId]}
              multi={false}
              editable={editable}
              onToggle={(id) =>
                onCommit({ type: "select", optionId: value.optionId === id ? null : id })
              }
              {...(onOptionsChange ? { onOptionsChange } : {})}
              onClose={close}
            />
          )}
        />
      );
    }

    case "multi_select": {
      const chosen = value.optionIds
        .map((id) => optionById(property, id))
        .filter((option): option is SelectOption => option !== null);
      return (
        <CellPopover
          label={property.name}
          width={260}
          editable={editable}
          display={
            chosen.length === 0 ? (
              <span className="dbcell__empty">Empty</span>
            ) : (
              <span className="dbcell__chips">
                {chosen.map((option) => (
                  <OptionChip key={option.id} option={option} />
                ))}
              </span>
            )
          }
          render={(close) => (
            <OptionMenu
              property={property}
              selected={value.optionIds}
              multi
              editable={editable}
              onToggle={(id) =>
                onCommit({ type: "multi_select", optionIds: toggleOptionId(value.optionIds, id) })
              }
              {...(onOptionsChange ? { onOptionsChange } : {})}
              onClose={close}
            />
          )}
        />
      );
    }

    case "date": {
      const text = formatDateValue(value.start, value.end ?? null);
      return (
        <CellPopover
          label={property.name}
          width={240}
          editable={editable}
          display={text === "" ? <span className="dbcell__empty">Empty</span> : <span>{text}</span>}
          render={() => (
            <DateEditor
              start={value.start}
              end={value.end ?? null}
              onCommit={(start, end) =>
                onCommit(start === null ? null : { type: "date", start, end })
              }
            />
          )}
        />
      );
    }

    case "url":
    case "email":
    case "phone": {
      const kind = value.type;
      const text = value.value ?? "";
      const open =
        kind === "url" && text !== ""
          ? () => window.open(normalizeHref(text), "_blank", "noopener")
          : undefined;
      return (
        <TextInput
          value={text}
          editable={editable}
          placeholder="Empty"
          {...(open ? { onOpenBlank: open } : {})}
          onCommit={(next) =>
            onCommit({ type: kind, value: next === "" ? null : next } as PropertyValue)
          }
        />
      );
    }

    case "relation": {
      const search = props.onSearchRelated;
      const pageIds = value.pageIds;
      return (
        <CellPopover
          label={property.name}
          width={280}
          editable={editable && search !== undefined}
          display={
            <RelationChips pageIds={pageIds} {...(onOpenPage ? { onOpenPage } : {})} />
          }
          render={() =>
            search === undefined ? (
              <div className="menu__empty">This relation has no target database yet.</div>
            ) : (
              <RelationPicker
                selected={pageIds}
                onSearch={search}
                onToggle={(id) =>
                  onCommit({ type: "relation", pageIds: toggleRelationId(pageIds, id) })
                }
              />
            )
          }
        />
      );
    }

    case "rollup":
      return <RollupCell property={property} value={value} />;
  }
}

function normalizeHref(raw: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
}
