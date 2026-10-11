/**
 * Template state: a self-contained serialization of a page subtree.
 *
 * `saveAsTemplate` writes one of these into `templates.state`;
 * `instantiateTemplate` reads it back, remaps every id, and inserts the result
 * as a fresh subtree. The shape is a flat set of table-shaped arrays rather
 * than a nested document, because that is what the storage layer inserts and it
 * keeps the remap a single pass per array.
 *
 * ```jsonc
 * {
 *   "templateVersion": 1,
 *   "rootPageId": "<page id>",          // the subtree's root; parentId is null
 *   "pages":     [{ id, parentId, title, icon, coverAssetId, fullWidth, smallText, rank }],
 *   "blocks":    [{ id, pageId, parentBlockId, rank, type, payload }],
 *   "dataSources":  [{ id, pageId, title }],
 *   "properties":   [{ id, dataSourceId, name, type, config, rank }],
 *   "views":        [{ id, dataSourceId, name, type, config, rank, locked }],
 *   "dsRows":       [{ pageId, dataSourceId, rank }],
 *   "propertyValues": [{ pageId, propertyId, value }]
 * }
 * ```
 *
 * What is included
 * ----------------
 * Every live page of the subtree — including the row pages of the databases it
 * owns — with their blocks, and every data source those pages own with its
 * schema, views, rows and cells. Trashed pages are skipped: a template is a
 * starting point, not a backup.
 *
 * Assets are referenced by id only and never copied into the state. They live
 * in the workspace-wide, content-addressed store, so a template that shows the
 * same image ten times still costs one file, and an instantiated copy points at
 * the very same bytes.
 *
 * What the remap fixes
 * --------------------
 * Everything internal gets a fresh id and every reference to it follows: page
 * parent edges, block parents, `child_page`/`linked_page` `payload.pageId`,
 * `child_database` `payload.dataSourceId`/`activeViewId`, `synced_reference`
 * `payload.syncedSourceId`, `kumi://page/<id>` hrefs and page mentions, select
 * and multi-select option ids, view filters/sorts/grouping, relation cells, and
 * relation/rollup property configs.
 *
 * References that point *outside* the template are kept verbatim, because they
 * still name something real: a relation whose target data source is not part of
 * the template keeps that target (its pairing is dropped, since the far side
 * points back at the original data source, not at the copy), a rollup keeps an
 * external target property, and a link to a page outside the subtree still
 * resolves to that page. A relation whose two sides are *both* inside the
 * template stays paired — between the copies.
 */

import type {
  BlockPayload,
  BlockType,
  FilterGroup,
  FilterNode,
  Id,
  PropertyConfig,
  PropertyType,
  PropertyValue,
  Rank,
  RichText,
  ViewConfig,
  ViewType,
} from "./types";
import { relationConfigOf, rollupConfigOf } from "./values";

export const TEMPLATE_VERSION = 1;

export interface TemplatePage {
  id: Id;
  /** Parent inside the template; null for the root. */
  parentId: Id | null;
  title: string;
  icon: string | null;
  coverAssetId: string | null;
  fullWidth: boolean;
  smallText: boolean;
  rank: Rank;
}

export interface TemplateBlock {
  id: Id;
  pageId: Id;
  parentBlockId: Id | null;
  rank: Rank;
  type: BlockType;
  payload: BlockPayload;
}

export interface TemplateDataSource {
  id: Id;
  pageId: Id;
  title: string;
}

export interface TemplateProperty {
  id: Id;
  dataSourceId: Id;
  name: string;
  type: PropertyType;
  config: PropertyConfig;
  rank: Rank;
}

export interface TemplateView {
  id: Id;
  dataSourceId: Id;
  name: string;
  type: ViewType;
  config: ViewConfig;
  rank: Rank;
  locked: boolean;
}

export interface TemplateDsRow {
  pageId: Id;
  dataSourceId: Id;
  rank: Rank;
}

export interface TemplatePropertyValue {
  pageId: Id;
  propertyId: Id;
  value: PropertyValue;
}

export interface TemplateState {
  templateVersion: number;
  rootPageId: Id;
  pages: TemplatePage[];
  blocks: TemplateBlock[];
  dataSources: TemplateDataSource[];
  properties: TemplateProperty[];
  views: TemplateView[];
  dsRows: TemplateDsRow[];
  propertyValues: TemplatePropertyValue[];
}

const PAGE_URL_PREFIX = "kumi://page/";

/** The id maps one instantiation works from; every entry is old id → new id. */
interface IdMaps {
  pages: Map<Id, Id>;
  blocks: Map<Id, Id>;
  dataSources: Map<Id, Id>;
  properties: Map<Id, Id>;
  views: Map<Id, Id>;
  /** Select/multi-select option ids, remapped consistently across the copy. */
  options: Map<Id, Id>;
}

/** Map an id that may or may not be internal; external ids pass through. */
function mapId(map: ReadonlyMap<Id, Id>, id: Id): Id {
  return map.get(id) ?? id;
}

function mapNullable(
  map: ReadonlyMap<Id, Id>,
  id: Id | null | undefined,
): Id | null {
  if (id === null || id === undefined) return null;
  return map.get(id) ?? id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function remapRichText(value: unknown, maps: IdMaps): unknown {
  if (!Array.isArray(value)) return value;
  return (value as RichText).map((span) => {
    if (span === null || typeof span !== "object") return span;
    if (span.type === "mention" && span.mention.kind === "page") {
      const mapped = maps.pages.get(span.mention.pageId);
      if (mapped === undefined) return span;
      return { ...span, mention: { ...span.mention, pageId: mapped } };
    }
    if (span.type === "text" && typeof span.href === "string") {
      if (!span.href.startsWith(PAGE_URL_PREFIX)) return span;
      const rest = span.href.slice(PAGE_URL_PREFIX.length);
      const id = rest.split(/[?#]/, 1)[0] ?? "";
      const mapped = maps.pages.get(id);
      if (mapped === undefined) return span;
      return { ...span, href: `${PAGE_URL_PREFIX}${mapped}${rest.slice(id.length)}` };
    }
    return span;
  });
}

function remapPayload(payload: BlockPayload, maps: IdMaps): BlockPayload {
  const next: BlockPayload = { ...payload };
  if (next.richText !== undefined) {
    next.richText = remapRichText(next.richText, maps) as RichText;
  }
  if (next.caption !== undefined) {
    next.caption = remapRichText(next.caption, maps) as RichText;
  }
  if (Array.isArray(next.cells)) {
    next.cells = next.cells.map((cell) => remapRichText(cell, maps) as RichText);
  }
  if (typeof next.pageId === "string") next.pageId = mapId(maps.pages, next.pageId);
  if (typeof next.dataSourceId === "string") {
    next.dataSourceId = mapId(maps.dataSources, next.dataSourceId);
  }
  if (typeof next.activeViewId === "string") {
    next.activeViewId = mapId(maps.views, next.activeViewId);
  }
  if (typeof next.syncedSourceId === "string") {
    next.syncedSourceId = mapId(maps.blocks, next.syncedSourceId);
  }
  return next;
}

/**
 * Remap a property config: option ids always, a relation's target and pairing
 * only when they are internal, a rollup's relation always (it is a sibling) and
 * its target property when internal.
 */
function remapPropertyConfig(
  config: PropertyConfig,
  type: PropertyType,
  maps: IdMaps,
): PropertyConfig {
  const next: PropertyConfig = { ...config };

  if (Array.isArray(next.options)) {
    next.options = next.options.map((option) => ({
      ...option,
      id: mapId(maps.options, option.id),
    }));
  }

  if (type === "relation") {
    const relation = relationConfigOf(config);
    if (relation !== null) {
      const internal = maps.dataSources.has(relation.dataSourceId);
      const paired = relation.pairedPropertyId;
      next.relation = {
        dataSourceId: mapId(maps.dataSources, relation.dataSourceId),
        // A pairing survives only when both sides are copied: an external
        // partner still points at the ORIGINAL data source, so keeping it would
        // wire the copy to a property that never writes back.
        pairedPropertyId:
          internal && paired !== null && maps.properties.has(paired)
            ? mapId(maps.properties, paired)
            : null,
      };
    }
  }

  if (type === "rollup") {
    const rollup = rollupConfigOf(config);
    if (rollup !== null) {
      next.rollup = {
        relationPropertyId: mapId(maps.properties, rollup.relationPropertyId),
        targetPropertyId: mapNullable(maps.properties, rollup.targetPropertyId),
        aggregation: rollup.aggregation,
      };
    }
  }

  return next;
}

function remapFilterNode(node: FilterNode, maps: IdMaps): FilterNode {
  if (node.kind === "group") {
    return {
      ...node,
      children: node.children.map((child) => remapFilterNode(child, maps)),
    };
  }
  const value: unknown = node.value;
  // A select/multi-select operand is an option id (or a list of them).
  const remappedValue =
    typeof value === "string"
      ? mapId(maps.options, value)
      : Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === "string" ? mapId(maps.options, entry) : entry,
          )
        : value;
  return {
    ...node,
    propertyId: mapId(maps.properties, node.propertyId),
    value: remappedValue,
  };
}

function remapViewConfig(config: ViewConfig, maps: IdMaps): ViewConfig {
  const next: ViewConfig = { ...config };
  if (next.filter !== null && next.filter !== undefined) {
    next.filter = remapFilterNode(next.filter, maps) as FilterGroup;
  }
  next.sorts = (next.sorts ?? []).map((sort) => ({
    ...sort,
    propertyId: mapId(maps.properties, sort.propertyId),
  }));
  if (next.groupByPropertyId !== undefined) {
    next.groupByPropertyId = mapNullable(maps.properties, next.groupByPropertyId);
  }
  if (next.datePropertyId !== undefined) {
    next.datePropertyId = mapNullable(maps.properties, next.datePropertyId);
  }
  if (Array.isArray(next.visibleProperties)) {
    next.visibleProperties = next.visibleProperties.map((id) =>
      mapId(maps.properties, id),
    );
  }
  if (Array.isArray(next.collapsedGroups)) {
    next.collapsedGroups = next.collapsedGroups.map((key) =>
      mapId(maps.options, key),
    );
  }
  if (isRecord(next.propertyWidths)) {
    const widths: Record<Id, number> = {};
    for (const [propertyId, width] of Object.entries(next.propertyWidths)) {
      if (typeof width === "number") widths[mapId(maps.properties, propertyId)] = width;
    }
    next.propertyWidths = widths;
  }
  return next;
}

function remapValue(value: PropertyValue, maps: IdMaps): PropertyValue {
  switch (value.type) {
    case "select":
      return {
        type: "select",
        optionId: value.optionId === null ? null : mapId(maps.options, value.optionId),
      };
    case "multi_select":
      return {
        type: "multi_select",
        optionIds: value.optionIds.map((id) => mapId(maps.options, id)),
      };
    case "relation":
      // Ids outside the template still name live rows of an external database.
      return {
        type: "relation",
        pageIds: value.pageIds.map((id) => mapId(maps.pages, id)),
      };
    default:
      return value;
  }
}

/**
 * Produce an independent copy of `state` in which every id the template owns is
 * fresh. The input is left untouched, so one stored template can be
 * instantiated any number of times and the copies share nothing.
 */
export function remapTemplateState(
  state: TemplateState,
  newId: () => Id,
): TemplateState {
  const maps: IdMaps = {
    pages: new Map(),
    blocks: new Map(),
    dataSources: new Map(),
    properties: new Map(),
    views: new Map(),
    options: new Map(),
  };
  for (const page of state.pages) maps.pages.set(page.id, newId());
  for (const block of state.blocks) maps.blocks.set(block.id, newId());
  for (const ds of state.dataSources) maps.dataSources.set(ds.id, newId());
  for (const prop of state.properties) {
    maps.properties.set(prop.id, newId());
    const options: unknown = prop.config.options;
    if (!Array.isArray(options)) continue;
    for (const option of options) {
      if (isRecord(option) && typeof option.id === "string") {
        maps.options.set(option.id, newId());
      }
    }
  }
  for (const view of state.views) maps.views.set(view.id, newId());

  return {
    templateVersion: TEMPLATE_VERSION,
    rootPageId: mapId(maps.pages, state.rootPageId),
    pages: state.pages.map((page) => ({
      ...page,
      id: mapId(maps.pages, page.id),
      parentId: page.parentId === null ? null : mapId(maps.pages, page.parentId),
    })),
    blocks: state.blocks.map((block) => ({
      ...block,
      id: mapId(maps.blocks, block.id),
      pageId: mapId(maps.pages, block.pageId),
      parentBlockId:
        block.parentBlockId === null ? null : mapId(maps.blocks, block.parentBlockId),
      payload: remapPayload(block.payload, maps),
    })),
    dataSources: state.dataSources.map((ds) => ({
      ...ds,
      id: mapId(maps.dataSources, ds.id),
      pageId: mapId(maps.pages, ds.pageId),
    })),
    properties: state.properties.map((prop) => ({
      ...prop,
      id: mapId(maps.properties, prop.id),
      dataSourceId: mapId(maps.dataSources, prop.dataSourceId),
      config: remapPropertyConfig(prop.config, prop.type, maps),
    })),
    views: state.views.map((view) => ({
      ...view,
      id: mapId(maps.views, view.id),
      dataSourceId: mapId(maps.dataSources, view.dataSourceId),
      config: remapViewConfig(view.config, maps),
    })),
    dsRows: state.dsRows.map((row) => ({
      ...row,
      pageId: mapId(maps.pages, row.pageId),
      dataSourceId: mapId(maps.dataSources, row.dataSourceId),
    })),
    propertyValues: state.propertyValues.map((cell) => ({
      pageId: mapId(maps.pages, cell.pageId),
      propertyId: mapId(maps.properties, cell.propertyId),
      value: remapValue(cell.value, maps),
    })),
  };
}
