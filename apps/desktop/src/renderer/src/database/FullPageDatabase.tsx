/**
 * The full-page presentation (Fig. 10).
 *
 * Deliberately thin: it is the *same* `DatabaseView`, given a breadcrumb back
 * to the page that owns the data source and a wider canvas. Nothing about the
 * schema, the toolbar or the table is duplicated here — the build plan calls
 * that out explicitly, and it is what keeps Phase 5's layouts a one-place change.
 */

import { useUi } from "../store";
import { displayTitle } from "../utils";
import { useAsync } from "../hooks";
import { commands } from "../ipc";
import { DatabaseView } from "./DatabaseView";

export function FullPageDatabase({ dataSourceId }: { dataSourceId: string }): JSX.Element {
  const openPage = useUi((s) => s.openPage);
  const bundle = useAsync(() => commands.getDataSource(dataSourceId), [dataSourceId]);
  const ownerId = bundle.data?.dataSource.pageId ?? null;
  const owner = useAsync(
    () => (ownerId ? commands.getPage(ownerId) : Promise.resolve(null)),
    [ownerId],
  );

  return (
    <div className="dbpage">
      <nav className="dbpage__crumbs" aria-label="Breadcrumb">
        <button
          type="button"
          className="crumb"
          disabled={ownerId === null}
          onClick={() => {
            if (ownerId) openPage(ownerId);
          }}
        >
          {owner.data?.icon ?? "📄"} {displayTitle(owner.data?.title)}
        </button>
        <span className="crumb__sep">/</span>
        <span className="crumb is-current">
          {displayTitle(bundle.data?.dataSource.title)}
        </span>
      </nav>

      <DatabaseView dataSourceId={dataSourceId} presentation="full" />
    </div>
  );
}
