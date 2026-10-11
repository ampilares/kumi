/**
 * Schema surfaces: the `+` add-column menu, the column-header context menu and
 * the inspector's "Edit properties" list.
 *
 * They are one file because they are one vocabulary — name field, type picker,
 * number format, option list — reused at three anchor points.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import type {
  NumberFormat,
  PropertyConfig,
  PropertyDef,
  PropertyType,
  RollupAggregation,
} from "@kumi/core";
import { ConfirmDialog, Popover, Toggle } from "../components/ui";
import { cx } from "../utils";
import { commands } from "../ipc";
import { useAsync } from "../hooks";
import {
  CREATABLE_PROPERTY_TYPES,
  NUMBER_FORMATS,
  NUMBER_FORMAT_LABEL,
  ROLLUP_AGGREGATIONS,
  ROLLUP_AGGREGATION_LABEL,
  allowedAggregations,
  defaultAggregation,
  isAggregationAllowed,
  isRollupTarget,
  propertyGlyph,
  propertyTypeInfo,
  relationConfigOf,
  rollupConfigOf,
} from "./properties";
import { useAllDataSources } from "./dataSourceIndex";

/* ---------------------------------------------------------- add property */

export interface AddPropertyMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  onCreate(name: string, type: PropertyType): void;
  /**
   * Relation and rollup need configuration before they mean anything, so they
   * are created *with* a config rather than created blank and fixed up after.
   * Omitting this simply hides the two panels (the peek's schema list, say).
   */
  onCreateConfigured?(name: string, type: PropertyType, config: PropertyConfig): void;
  /** This data source's own schema — the rollup panel picks a relation from it. */
  properties?: PropertyDef[];
  /** Shown as the default paired-property name on the target database. */
  ownerTitle?: string;
}

type AddPanel = "types" | "relation" | "rollup";

export function AddPropertyMenu({
  open,
  anchorRef,
  onClose,
  onCreate,
  onCreateConfigured,
  properties = [],
  ownerTitle = "Related",
}: AddPropertyMenuProps): JSX.Element {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [panel, setPanel] = useState<AddPanel>("types");

  useEffect(() => {
    if (open) {
      setName("");
      setQuery("");
      setPanel("types");
    }
  }, [open]);

  const matches = CREATABLE_PROPERTY_TYPES.filter((info) => {
    const needle = query.trim().toLowerCase();
    return needle === "" || info.label.toLowerCase().includes(needle);
  });

  const finalName = (fallback: string): string => (name.trim() === "" ? fallback : name.trim());

  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} label="New property" width={280}>
      <input
        className="field"
        autoFocus
        value={name}
        placeholder="Property name"
        onChange={(e) => setName(e.target.value)}
      />

      {panel === "types" ? (
        <>
          <div className="menu__label">Type</div>
          <input
            className="field"
            value={query}
            placeholder="Search for a property type…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="menu__scroll">
            {matches.map((info) => (
              <button
                key={info.type}
                type="button"
                className="menuitem"
                onClick={() => {
                  onCreate(finalName(info.label), info.type);
                  onClose();
                }}
              >
                <span className="propglyph">{info.glyph}</span>
                <span className="menuitem__label">{info.label}</span>
                <span className="menuitem__hint">{info.hint}</span>
              </button>
            ))}
          </div>
          {onCreateConfigured ? (
            <>
              <div className="menu__sep" role="separator" />
              <button type="button" className="menuitem" onClick={() => setPanel("relation")}>
                <span className="propglyph">{propertyGlyph("relation")}</span>
                <span className="menuitem__label">Relation</span>
                <span className="menuitem__hint">Pick a database ▸</span>
              </button>
              <button
                type="button"
                className="menuitem"
                disabled={properties.every((p) => p.type !== "relation")}
                title={
                  properties.some((p) => p.type === "relation")
                    ? undefined
                    : "Add a relation property first — a rollup reads through one."
                }
                onClick={() => setPanel("rollup")}
              >
                <span className="propglyph">{propertyGlyph("rollup")}</span>
                <span className="menuitem__label">Rollup</span>
                <span className="menuitem__hint">Through a relation ▸</span>
              </button>
            </>
          ) : null}
        </>
      ) : null}

      {panel === "relation" && onCreateConfigured ? (
        <RelationPanel
          ownerTitle={ownerTitle}
          onBack={() => setPanel("types")}
          onCreate={(config, fallbackName) => {
            onCreateConfigured(finalName(fallbackName), "relation", config);
            onClose();
          }}
        />
      ) : null}

      {panel === "rollup" && onCreateConfigured ? (
        <RollupPanel
          properties={properties}
          onBack={() => setPanel("types")}
          onCreate={(config, fallbackName) => {
            onCreateConfigured(finalName(fallbackName), "rollup", config);
            onClose();
          }}
        />
      ) : null}
    </Popover>
  );
}

/* ------------------------------------------------------------ relation panel */

function RelationPanel({
  ownerTitle,
  onBack,
  onCreate,
}: {
  ownerTitle: string;
  onBack(): void;
  onCreate(config: PropertyConfig, fallbackName: string): void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const sources = useAllDataSources(true);

  const entries = (sources.data ?? []).filter((entry) => {
    const needle = query.trim().toLowerCase();
    return needle === "" || entry.dataSource.title.toLowerCase().includes(needle);
  });
  const target = (sources.data ?? []).find((entry) => entry.dataSource.id === targetId) ?? null;

  return (
    <>
      <button type="button" className="menuitem" onClick={onBack}>
        <span className="menuitem__label">‹ Relation</span>
      </button>
      <div className="menu__label">Related database</div>
      <input
        className="field"
        value={query}
        placeholder="Search databases…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="menu__scroll">
        {entries.map((entry) => (
          <button
            key={entry.dataSource.id}
            type="button"
            className={cx("menuitem", entry.dataSource.id === targetId && "is-on")}
            onClick={() => setTargetId(entry.dataSource.id)}
          >
            <span className="menuitem__label">{entry.dataSource.title || "Untitled"}</span>
            <span className="menuitem__hint">{entry.ownerTitle || "Untitled"}</span>
          </button>
        ))}
        {entries.length === 0 ? (
          <div className="menu__empty">
            {sources.loading ? "Looking for databases…" : "No databases found."}
          </div>
        ) : null}
      </div>

      <div className="menu__sep" role="separator" />
      <button
        type="button"
        className="menuitem"
        disabled={target === null}
        onClick={() => setPaired((value) => !value)}
      >
        <span className="menuitem__label">
          Show on {target ? target.dataSource.title || "Untitled" : "the other database"}
        </span>
        <Toggle on={paired} />
      </button>

      <button
        type="button"
        className="menuitem"
        disabled={target === null}
        onClick={() => {
          if (!target) return;
          const config: PropertyConfig = {
            relation: { dataSourceId: target.dataSource.id, pairedPropertyId: null },
          };
          // Core creates the reverse property itself, so the paired id is never
          // guessed here — only the name of the property to create over there.
          if (paired) config.createPaired = { name: ownerTitle };
          onCreate(config, target.dataSource.title || "Relation");
        }}
      >
        <span className="menuitem__label">Create relation</span>
      </button>
    </>
  );
}

/* -------------------------------------------------------------- rollup panel */

function RollupPanel({
  properties,
  onBack,
  onCreate,
}: {
  properties: PropertyDef[];
  onBack(): void;
  onCreate(config: PropertyConfig, fallbackName: string): void;
}): JSX.Element {
  const relations = properties.filter((p) => p.type === "relation");
  const [relationId, setRelationId] = useState<string | null>(relations[0]?.id ?? null);
  const [targetId, setTargetId] = useState<string | null>(null);
  const [aggregation, setAggregation] = useState<RollupAggregation>("count");

  const relation = relations.find((p) => p.id === relationId) ?? null;
  const targetDataSourceId = relation ? (relationConfigOf(relation)?.dataSourceId ?? null) : null;

  const bundle = useAsync(
    () =>
      targetDataSourceId === null
        ? Promise.resolve(null)
        : commands.getDataSource(targetDataSourceId),
    [targetDataSourceId],
  );
  const targetProperties = (bundle.data?.properties ?? []).filter((p) => isRollupTarget(p.type));
  const targetProperty = targetProperties.find((p) => p.id === targetId) ?? null;
  const allowed = allowedAggregations(targetProperty?.type ?? null);

  const pickTarget = (id: string | null): void => {
    setTargetId(id);
    const type = targetProperties.find((p) => p.id === id)?.type ?? null;
    if (!isAggregationAllowed(type, aggregation)) setAggregation(defaultAggregation(type));
  };

  return (
    <>
      <button type="button" className="menuitem" onClick={onBack}>
        <span className="menuitem__label">‹ Rollup</span>
      </button>

      <div className="menu__label">Relation</div>
      <div className="menu__scroll">
        {relations.map((property) => (
          <button
            key={property.id}
            type="button"
            className={cx("menuitem", property.id === relationId && "is-on")}
            onClick={() => {
              setRelationId(property.id);
              pickTarget(null);
            }}
          >
            <span className="propglyph">{propertyGlyph("relation")}</span>
            <span className="menuitem__label">{property.name}</span>
          </button>
        ))}
        {relations.length === 0 ? (
          <div className="menu__empty">This database has no relation property yet.</div>
        ) : null}
      </div>

      <div className="menu__label">Property</div>
      <div className="menu__scroll">
        <button
          type="button"
          className={cx("menuitem", targetId === null && "is-on")}
          onClick={() => pickTarget(null)}
        >
          <span className="menuitem__label">None — count the rows</span>
        </button>
        {targetProperties.map((property) => (
          <button
            key={property.id}
            type="button"
            className={cx("menuitem", property.id === targetId && "is-on")}
            onClick={() => pickTarget(property.id)}
          >
            <span className="propglyph">{propertyGlyph(property.type)}</span>
            <span className="menuitem__label">{property.name}</span>
          </button>
        ))}
        {bundle.loading ? <div className="menu__empty">Loading properties…</div> : null}
      </div>

      <div className="menu__label">Calculate</div>
      <div className="menu__scroll">
        {ROLLUP_AGGREGATIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={cx("menuitem", option === aggregation && "is-on")}
            disabled={!allowed.includes(option)}
            title={
              allowed.includes(option)
                ? undefined
                : "Not available for the selected property's type."
            }
            onClick={() => setAggregation(option)}
          >
            <span className="menuitem__label">{ROLLUP_AGGREGATION_LABEL[option]}</span>
          </button>
        ))}
      </div>

      <div className="menu__sep" role="separator" />
      <button
        type="button"
        className="menuitem"
        disabled={relation === null || !allowed.includes(aggregation)}
        onClick={() => {
          if (!relation) return;
          onCreate(
            { rollup: { relationPropertyId: relation.id, targetPropertyId: targetId, aggregation } },
            targetProperty ? `${targetProperty.name} rollup` : "Rollup",
          );
        }}
      >
        <span className="menuitem__label">Create rollup</span>
      </button>
    </>
  );
}

/* ------------------------------------------------------- header context */

export interface PropertyActions {
  onRename(property: PropertyDef, name: string): void;
  onChangeType(property: PropertyDef, type: PropertyType): void;
  onNumberFormat(property: PropertyDef, format: NumberFormat): void;
  onSort(property: PropertyDef, direction: "asc" | "desc"): void;
  onHide(property: PropertyDef): void;
  onDuplicate(property: PropertyDef): void;
  onDelete(property: PropertyDef): void;
}

export function PropertyMenu({
  open,
  anchorRef,
  property,
  locked,
  actions,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  property: PropertyDef;
  locked: boolean;
  actions: PropertyActions;
  onClose(): void;
}): JSX.Element {
  const [name, setName] = useState(property.name);
  const [typeOpen, setTypeOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const isTitle = property.type === "title";

  useEffect(() => {
    if (open) {
      setName(property.name);
      setTypeOpen(false);
    }
  }, [open, property.name]);

  return (
    <>
      <Popover
        open={open && !confirm}
        anchorRef={anchorRef}
        onClose={onClose}
        label={`${property.name} options`}
        width={244}
      >
        <input
          className="field"
          autoFocus
          value={name}
          aria-label="Property name"
          readOnly={locked}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== "" && name !== property.name) actions.onRename(property, name.trim());
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            if (name.trim() !== "" && name !== property.name) actions.onRename(property, name.trim());
            onClose();
          }}
        />

        <button
          type="button"
          className="menuitem"
          disabled={locked || isTitle}
          onClick={() => setTypeOpen((value) => !value)}
        >
          <span className="propglyph">{propertyGlyph(property.type)}</span>
          <span className="menuitem__label">Type</span>
          <span className="menuitem__hint">{propertyTypeInfo(property.type).label} ▸</span>
        </button>
        {typeOpen ? (
          <div className="menu__scroll">
            {CREATABLE_PROPERTY_TYPES.map((info) => (
              <button
                key={info.type}
                type="button"
                className={cx("menuitem", info.type === property.type && "is-on")}
                onClick={() => {
                  actions.onChangeType(property, info.type);
                  setTypeOpen(false);
                  onClose();
                }}
              >
                <span className="propglyph">{info.glyph}</span>
                <span className="menuitem__label">{info.label}</span>
              </button>
            ))}
          </div>
        ) : null}

        {property.type === "number" ? (
          <>
            <div className="menu__sep" role="separator" />
            <div className="menu__label">Number format</div>
            <div className="menu__scroll">
              {NUMBER_FORMATS.map((format) => (
                <button
                  key={format}
                  type="button"
                  className={cx(
                    "menuitem",
                    (property.config.numberFormat ?? "number") === format && "is-on",
                  )}
                  disabled={locked}
                  onClick={() => actions.onNumberFormat(property, format)}
                >
                  <span className="menuitem__label">{NUMBER_FORMAT_LABEL[format]}</span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {property.type === "relation" || property.type === "rollup" ? (
          <>
            <div className="menu__sep" role="separator" />
            <div className="menu__label">{propertyTypeInfo(property.type).label}</div>
            <div className="menu__empty">{configuredSummary(property)}</div>
          </>
        ) : null}

        <div className="menu__sep" role="separator" />
        <button
          type="button"
          className="menuitem"
          onClick={() => {
            actions.onSort(property, "asc");
            onClose();
          }}
        >
          <span className="menuitem__label">Sort ascending</span>
        </button>
        <button
          type="button"
          className="menuitem"
          onClick={() => {
            actions.onSort(property, "desc");
            onClose();
          }}
        >
          <span className="menuitem__label">Sort descending</span>
        </button>
        <button
          type="button"
          className="menuitem"
          disabled={isTitle}
          onClick={() => {
            actions.onHide(property);
            onClose();
          }}
        >
          <span className="menuitem__label">Hide in view</span>
        </button>
        <button
          type="button"
          className="menuitem"
          // A relation's pairing is established at creation and cannot be
          // shared: copying its config would claim a partner core has already
          // given to this property, and the copy would be rejected.
          disabled={locked || isTitle || property.type === "relation"}
          title={
            property.type === "relation"
              ? "Create a second relation instead — a pairing cannot be copied."
              : undefined
          }
          onClick={() => {
            actions.onDuplicate(property);
            onClose();
          }}
        >
          <span className="menuitem__label">Duplicate property</span>
          <span className="menuitem__hint">Schema only</span>
        </button>
        <button
          type="button"
          className="menuitem menuitem--danger"
          disabled={locked || isTitle}
          onClick={() => setConfirm(true)}
        >
          <span className="menuitem__label">Delete property</span>
        </button>
      </Popover>

      <ConfirmDialog
        open={confirm}
        title={`Delete “${property.name}”?`}
        body="Every row loses this property's value. This cannot be undone."
        confirmLabel="Delete property"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          actions.onDelete(property);
          onClose();
        }}
      />
    </>
  );
}

/**
 * A one-line description of a configured property. Read-only: reconfiguring a
 * relation or a rollup after the fact would rewrite stored values, so this
 * phase shows what it is and leaves changing it to delete-and-recreate.
 */
function configuredSummary(property: PropertyDef): string {
  if (property.type === "relation") {
    const relation = relationConfigOf(property);
    if (relation === null) return "No target database — this relation is not configured.";
    return relation.pairedPropertyId === null
      ? "One-way relation."
      : "Two-way relation — the reverse property is kept in sync.";
  }
  const rollup = rollupConfigOf(property);
  if (rollup === null) return "Not configured.";
  const target = rollup.targetPropertyId === null ? "the related rows" : "a related property";
  return `${ROLLUP_AGGREGATION_LABEL[rollup.aggregation]} over ${target}.`;
}

/* --------------------------------------------------- edit properties list */

/** The inspector's schema section: every property, its type, and its menu. */
export function EditPropertiesList({
  properties,
  locked,
  actions,
  onAdd,
  onAddConfigured,
  ownerTitle,
}: {
  properties: PropertyDef[];
  locked: boolean;
  actions: PropertyActions;
  onAdd(name: string, type: PropertyType): void;
  onAddConfigured?(name: string, type: PropertyType, config: PropertyConfig): void;
  ownerTitle?: string;
}): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="schemalist">
      {properties.map((property) => (
        <SchemaRow
          key={property.id}
          property={property}
          locked={locked}
          actions={actions}
          open={openId === property.id}
          onToggle={() => setOpenId(openId === property.id ? null : property.id)}
          onClose={() => setOpenId(null)}
        />
      ))}
      <button
        ref={addRef}
        type="button"
        className="menuitem"
        disabled={locked}
        onClick={() => setAdding(true)}
      >
        <span className="menuitem__label">+ New property</span>
      </button>
      <AddPropertyMenu
        open={adding}
        anchorRef={addRef}
        onClose={() => setAdding(false)}
        onCreate={onAdd}
        properties={properties}
        {...(onAddConfigured ? { onCreateConfigured: onAddConfigured } : {})}
        {...(ownerTitle === undefined ? {} : { ownerTitle })}
      />
    </div>
  );
}

function SchemaRow({
  property,
  locked,
  actions,
  open,
  onToggle,
  onClose,
}: {
  property: PropertyDef;
  locked: boolean;
  actions: PropertyActions;
  open: boolean;
  onToggle(): void;
  onClose(): void;
}): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className="menuitem" onClick={onToggle}>
        <span className="propglyph">{propertyGlyph(property.type)}</span>
        <span className="menuitem__label">{property.name}</span>
        <span className="menuitem__hint">{propertyTypeInfo(property.type).label}</span>
      </button>
      <PropertyMenu
        open={open}
        anchorRef={ref}
        property={property}
        locked={locked}
        actions={actions}
        onClose={onClose}
      />
    </>
  );
}
