/**
 * The center peek (Fig. 4).
 *
 * A row *is* a page, so the peek mounts the real `PageView` — same title field,
 * same block editor, same persistence — inside a modal shell, with the row's
 * property panel injected between the title and the body. Nothing about a row
 * page is re-implemented here; only its chrome differs.
 *
 * Escape and an outside click close it (both handled by `Modal`), after which
 * the table refetches from the `kumi:changed` broadcast the edits produced.
 */

import type { PropertyDef, PropertyValue, SelectOption } from "@kumi/core";
import { Modal } from "../components/ui";
import { PageView } from "../components/PageView";
import { usePage } from "../data";
import { useAsync } from "../hooks";
import { commands } from "../ipc";
import { displayTitle } from "../utils";
import { PropertyCell, type RelationCandidate } from "./Cells";
import { propertyGlyph, valueOf } from "./properties";

export function RowPeek({
  pageId,
  properties,
  locked,
  onClose,
  onCommitValue,
  onOptionsChange,
  onSearchRelated,
  onOpenPage,
}: {
  pageId: string;
  properties: PropertyDef[];
  locked: boolean;
  onClose(): void;
  onCommitValue(pageId: string, property: PropertyDef, next: PropertyValue | null): void;
  onOptionsChange(property: PropertyDef, options: SelectOption[]): void;
  onSearchRelated?(property: PropertyDef, query: string): Promise<RelationCandidate[]>;
  /** Following a relation chip re-points the peek at that row. */
  onOpenPage?(pageId: string): void;
}): JSX.Element | null {
  const page = usePage(pageId);
  const row = useAsync(() => commands.getRow(pageId), [pageId]);

  const values = row.data?.values ?? {};
  const fields = properties.filter((property) => property.type !== "title");

  return (
    <Modal
      open
      onClose={onClose}
      className="modal--peek"
      label={displayTitle(page.data?.title)}
      // Cell menus (select, date, the emoji picker) portal to the body; a click
      // in one of them must not close the peek that opened it.
      dismissIgnoreSelector=".popover"
    >
      <div className="peek__scroll">
        {page.data ? (
          <PageView page={page.data} presentation="peek">
            <div className="peek__props">
              {fields.map((property) => (
                <div key={property.id} className="peek__prop">
                  <span className="peek__proplabel">
                    <span className="propglyph">{propertyGlyph(property.type)}</span>
                    {property.name}
                  </span>
                  <div className="peek__propvalue">
                    <PropertyCell
                      property={property}
                      value={valueOf(values, property)}
                      editable={!locked}
                      variant="field"
                      onCommit={(next) => onCommitValue(pageId, property, next)}
                      onOptionsChange={(options) => onOptionsChange(property, options)}
                      {...(onSearchRelated
                        ? { onSearchRelated: (query: string) => onSearchRelated(property, query) }
                        : {})}
                      {...(onOpenPage ? { onOpenPage } : {})}
                    />
                  </div>
                </div>
              ))}
              {fields.length === 0 ? (
                <div className="peek__empty">This database has no properties yet.</div>
              ) : null}
            </div>
          </PageView>
        ) : (
          <div className="panel">
            <div className="skeleton" style={{ width: "50%", height: 28, marginBottom: 16 }} />
            <div className="skeleton" style={{ width: "70%" }} />
          </div>
        )}
      </div>
    </Modal>
  );
}
