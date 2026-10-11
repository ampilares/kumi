/**
 * The list layout.
 *
 * Notion's list is the quiet one: full-bleed rows, the title carrying all the
 * weight, the visible properties dimmed and right-aligned so they read as
 * metadata rather than as columns. There is no grid here on purpose — a list
 * that lines its properties up is just a table with worse ergonomics.
 *
 * `config.groupByPropertyId` optionally sections the list, reusing the board's
 * grouping so the two layouts can never disagree about what a group is.
 */

import type { RowRecord } from "@kumi/core";
import { displayTitle } from "../utils";
import { PropertyPill } from "./Cells";
import { cardProperties, type BaseLayoutProps } from "./CardBits";
import { rowValue } from "./properties";
import { buildGroups } from "./grouping";

export function ListView(props: BaseLayoutProps): JSX.Element {
  const { columns, properties, rows, config, locked } = props;
  const pills = cardProperties(columns);

  const groupBy = properties.find((p) => p.id === config.groupByPropertyId) ?? null;
  const collapsedKeys = Array.isArray(config.collapsedGroups) ? config.collapsedGroups : [];
  const sections =
    groupBy === null
      ? [{ key: "__all__", label: "", rows, collapsed: false }]
      : buildGroups(rows, groupBy, collapsedKeys).filter((group) => group.rows.length > 0);

  const line = (row: RowRecord): JSX.Element => (
    <div
      key={row.page.id}
      className="dblist__row"
      role="button"
      tabIndex={0}
      onClick={() => props.onOpenRow(row)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onOpenRow(row);
      }}
    >
      <span className="dblist__title">{displayTitle(row.page.title)}</span>
      <span className="dblist__meta">
        {pills.map((property) => (
          <PropertyPill
            key={property.id}
            property={property}
            value={rowValue(row, property)}
            onOpenPage={props.onOpenPage}
          />
        ))}
      </span>
    </div>
  );

  return (
    <div className="dblist">
      {sections.map((section) => (
        <div key={section.key} className="dblist__section">
          {section.label === "" ? null : (
            <div className="dblist__sectionhead">
              {section.label}
              <span className="dbboard__count">{section.rows.length}</span>
            </div>
          )}
          {section.rows.map(line)}
        </div>
      ))}

      {rows.length === 0 ? <div className="dblist__empty">No rows yet.</div> : null}

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
