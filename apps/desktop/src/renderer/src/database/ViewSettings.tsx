/**
 * The view-settings inspector (Fig. 8).
 *
 * Right-anchored rather than a dropdown on purpose: deep configuration must not
 * move the page underneath it, so the table stays exactly where it was while
 * layout, visibility, filters, sorts and the schema are edited beside it.
 *
 * Sections are layered — the root list drills into a sub-panel and back — which
 * is how Notion keeps a panel this dense navigable.
 */

import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  PropertyConfig,
  PropertyDef,
  PropertyType,
  SortSpec,
  View,
  ViewConfig,
  ViewType,
} from "@kumi/core";
import { useDismiss } from "../hooks";
import { cx } from "../utils";
import { Toggle } from "../components/ui";
import { propertyGlyph } from "./properties";
import { datePlacementProperties } from "./calendar";
import { CARD_SIZES, CARD_SIZE_LABEL, cardSizeOf, groupableProperties } from "./grouping";
import {
  SHIPPED_VIEW_TYPES,
  VIEW_TYPE_INFO,
  hiddenProperties,
  layoutSettings,
  moveItem,
  orderedProperties,
  toggleVisibility,
} from "./viewConfig";
import { EditPropertiesList, type PropertyActions } from "./PropertyMenus";
import { toastInfo } from "../components/Toasts";

type Panel = "root" | "layout" | "properties" | "schema";

export function ViewSettings({
  open,
  view,
  config,
  properties,
  onClose,
  onRenameView,
  onVisibleProperties,
  onLock,
  onOpenFilter,
  onOpenSort,
  onAddProperty,
  onAddPropertyConfigured,
  ownerTitle,
  onChangeLayout,
  onConfig,
  propertyActions,
  sorts,
}: {
  open: boolean;
  view: View;
  config: ViewConfig;
  properties: PropertyDef[];
  sorts: SortSpec[];
  onClose(): void;
  onRenameView(name: string): void;
  onVisibleProperties(ids: string[]): void;
  onLock(locked: boolean): void;
  onOpenFilter(): void;
  onOpenSort(): void;
  onAddProperty(name: string, type: PropertyType): void;
  onAddPropertyConfigured(name: string, type: PropertyType, config: PropertyConfig): void;
  ownerTitle: string;
  onChangeLayout(type: ViewType): void;
  onConfig(patch: Record<string, unknown>): void;
  propertyActions: PropertyActions;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [panel, setPanel] = useState<Panel>("root");
  // The inspector's own menus (property options, add property) are portalled.
  useDismiss(open, [ref], onClose, ".popover, .overlay");

  if (!open) return null;

  const visible = orderedProperties(properties, config).filter((p) => p.type !== "title");
  const hidden = hiddenProperties(properties, config);

  const move = (from: number, to: number): void => {
    onVisibleProperties(moveItem(visible.map((p) => p.id), from, to));
  };

  return createPortal(
    <div className="dbinspector" ref={ref} role="dialog" aria-label="View settings">
      <div className="dbinspector__head">
        {panel === "root" ? null : (
          <button
            type="button"
            className="iconbtn iconbtn--xs"
            aria-label="Back"
            onClick={() => setPanel("root")}
          >
            ‹
          </button>
        )}
        <span className="dbinspector__title">
          {panel === "root"
            ? "View settings"
            : panel === "layout"
              ? "Layout"
              : panel === "properties"
                ? "Properties"
                : "Edit properties"}
        </span>
        <button type="button" className="iconbtn iconbtn--xs" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {panel === "root" ? (
        <div className="dbinspector__body">
          <input
            className="field"
            defaultValue={view.name}
            aria-label="View name"
            readOnly={view.locked}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next !== "" && next !== view.name) onRenameView(next);
            }}
          />

          <button type="button" className="menuitem" onClick={() => setPanel("layout")}>
            <span className="propglyph">▦</span>
            <span className="menuitem__label">Layout</span>
            <span className="menuitem__hint">
              {VIEW_TYPE_INFO.find((info) => info.type === view.type)?.label ?? view.type} ▸
            </span>
          </button>
          <button type="button" className="menuitem" onClick={() => setPanel("properties")}>
            <span className="propglyph">☰</span>
            <span className="menuitem__label">Properties</span>
            <span className="menuitem__hint">
              {hidden.length === 0 ? "All shown" : `${hidden.length} hidden`} ▸
            </span>
          </button>
          <button type="button" className="menuitem" onClick={onOpenFilter}>
            <span className="propglyph">▽</span>
            <span className="menuitem__label">Filter</span>
            <span className="menuitem__hint">
              {config.filter ? `${config.filter.children.length}` : "None"} ▸
            </span>
          </button>
          <button type="button" className="menuitem" onClick={onOpenSort}>
            <span className="propglyph">⇅</span>
            <span className="menuitem__label">Sort</span>
            <span className="menuitem__hint">
              {sorts.length === 0 ? "None" : String(sorts.length)} ▸
            </span>
          </button>

          <div className="menu__sep" role="separator" />
          <div className="menu__label">Data source settings</div>
          <button type="button" className="menuitem" onClick={() => setPanel("schema")}>
            <span className="propglyph">⊞</span>
            <span className="menuitem__label">Edit properties</span>
            <span className="menuitem__hint">{properties.length} ▸</span>
          </button>
          <button
            type="button"
            className="menuitem"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(`kumi://view/${view.id}`)
                .then(() => toastInfo("Link to view copied."));
            }}
          >
            <span className="propglyph">⧉</span>
            <span className="menuitem__label">Copy link to view</span>
          </button>

          <div className="menu__sep" role="separator" />
          <button type="button" className="menuitem" onClick={() => onLock(!view.locked)}>
            <span className="propglyph">⊡</span>
            <span className="menuitem__label">Lock view</span>
            <Toggle on={view.locked} />
          </button>
        </div>
      ) : null}

      {panel === "layout" ? (
        <div className="dbinspector__body">
          <div className="layoutgrid">
            {VIEW_TYPE_INFO.map((info) => {
              const shipped = SHIPPED_VIEW_TYPES.has(info.type);
              return (
                <button
                  key={info.type}
                  type="button"
                  className={cx("layouttile", view.type === info.type && "is-on")}
                  disabled={!shipped || view.locked}
                  title={info.label}
                  onClick={() => {
                    if (info.type !== view.type) onChangeLayout(info.type);
                  }}
                >
                  <span className="layouttile__glyph">{info.glyph}</span>
                  <span className="layouttile__label">{info.label}</span>
                </button>
              );
            })}
          </div>

          <LayoutOptions
            type={view.type}
            config={config}
            properties={properties}
            locked={view.locked}
            onConfig={onConfig}
          />
        </div>
      ) : null}

      {panel === "properties" ? (
        <div className="dbinspector__body">
          <div className="menu__label">Shown in table</div>
          {visible.map((property, index) => (
            <div key={property.id} className="visrow">
              <span className="propglyph">{propertyGlyph(property.type)}</span>
              <span className="visrow__name">{property.name}</span>
              <button
                type="button"
                className="iconbtn iconbtn--xs"
                aria-label="Move up"
                disabled={index === 0}
                onClick={() => move(index, index - 1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="iconbtn iconbtn--xs"
                aria-label="Move down"
                disabled={index === visible.length - 1}
                onClick={() => move(index, index + 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="iconbtn iconbtn--xs"
                title="Hide"
                aria-label={`Hide ${property.name}`}
                onClick={() => onVisibleProperties(toggleVisibility(properties, config, property.id))}
              >
                👁
              </button>
            </div>
          ))}
          {hidden.length > 0 ? (
            <>
              <div className="menu__label">Hidden</div>
              {hidden.map((property) => (
                <div key={property.id} className="visrow is-hidden">
                  <span className="propglyph">{propertyGlyph(property.type)}</span>
                  <span className="visrow__name">{property.name}</span>
                  <button
                    type="button"
                    className="iconbtn iconbtn--xs"
                    title="Show"
                    aria-label={`Show ${property.name}`}
                    onClick={() =>
                      onVisibleProperties(toggleVisibility(properties, config, property.id))
                    }
                  >
                    👁
                  </button>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}

      {panel === "schema" ? (
        <div className="dbinspector__body">
          <EditPropertiesList
            properties={properties}
            locked={view.locked}
            actions={propertyActions}
            onAdd={onAddProperty}
            onAddConfigured={onAddPropertyConfigured}
            ownerTitle={ownerTitle}
          />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

/**
 * The layout-specific settings rows. Which of them appear is decided by
 * `layoutSettings`, so adding a layout is one entry in that switch rather than
 * a new conditional here and another one somewhere else.
 */
function LayoutOptions({
  type,
  config,
  properties,
  locked,
  onConfig,
}: {
  type: ViewType;
  config: ViewConfig;
  properties: PropertyDef[];
  locked: boolean;
  onConfig(patch: Record<string, unknown>): void;
}): JSX.Element | null {
  const settings = layoutSettings(type);
  if (!settings.groupBy && !settings.dateProperty && !settings.cardSize) return null;

  const groupable = groupableProperties(properties);
  const dated = datePlacementProperties(properties);
  const size = cardSizeOf(config.cardSize);

  return (
    <>
      {settings.groupBy ? (
        <>
          <div className="menu__label">Group by</div>
          <div className="menu__scroll">
            {groupable.map((property) => (
              <button
                key={property.id}
                type="button"
                className={cx("menuitem", config.groupByPropertyId === property.id && "is-on")}
                disabled={locked}
                onClick={() => onConfig({ groupByPropertyId: property.id })}
              >
                <span className="propglyph">{propertyGlyph(property.type)}</span>
                <span className="menuitem__label">{property.name}</span>
              </button>
            ))}
            {config.groupByPropertyId ? (
              <button
                type="button"
                className="menuitem"
                disabled={locked}
                onClick={() => onConfig({ groupByPropertyId: null, collapsedGroups: [] })}
              >
                <span className="menuitem__label">No grouping</span>
              </button>
            ) : null}
            {groupable.length === 0 ? (
              <div className="menu__empty">No select or checkbox property to group by.</div>
            ) : null}
          </div>
        </>
      ) : null}

      {settings.dateProperty ? (
        <>
          <div className="menu__label">Date property</div>
          <div className="menu__scroll">
            {dated.map((property) => (
              <button
                key={property.id}
                type="button"
                className={cx("menuitem", config.datePropertyId === property.id && "is-on")}
                disabled={locked}
                onClick={() => onConfig({ datePropertyId: property.id })}
              >
                <span className="propglyph">{propertyGlyph(property.type)}</span>
                <span className="menuitem__label">{property.name}</span>
              </button>
            ))}
            {dated.length === 0 ? (
              <div className="menu__empty">No date property to place rows on.</div>
            ) : null}
          </div>
        </>
      ) : null}

      {settings.cardSize ? (
        <>
          <div className="menu__label">Card size</div>
          <div className="menu__scroll">
            {CARD_SIZES.map((option) => (
              <button
                key={option}
                type="button"
                className={cx("menuitem", size === option && "is-on")}
                disabled={locked}
                onClick={() => onConfig({ cardSize: option })}
              >
                <span className="menuitem__label">{CARD_SIZE_LABEL[option]}</span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
