/**
 * Database reads and guarded writes.
 *
 * Reads go through the shared `useAsync` hook, so every one of them already
 * refetches on the `kumi:changed` broadcast — that is the whole of the live-
 * update story for the table (see shared/ipc.ts `MUTATING_COMMANDS`).
 *
 * Writes go through `guard`, which turns a rejected core command into a toast
 * instead of an unhandled rejection: the caller reverts its optimistic state
 * and the table refetches from the broadcast that never came.
 */

import type {
  DataSource,
  PropertyDef,
  QueryOptions,
  QueryResult,
  View,
} from "@kumi/core";
import { commands } from "../ipc";
import { useAsync, type AsyncState } from "../hooks";
import { toastError } from "../components/Toasts";

export interface DataSourceBundle {
  dataSource: DataSource;
  properties: PropertyDef[];
  views: View[];
}

export function useDataSourceBundle(id: string | null): AsyncState<DataSourceBundle | null> {
  return useAsync(
    () => (id ? commands.getDataSource(id) : Promise.resolve(null)),
    [id],
  );
}

/**
 * Rows for a view. `opts` is serialised into the dependency key so a new object
 * with the same filter does not re-run the query on every render.
 */
export function useRows(
  dataSourceId: string | null,
  opts: QueryOptions,
): AsyncState<QueryResult> {
  const key = JSON.stringify(opts);
  return useAsync(
    () =>
      dataSourceId
        ? commands.queryDataSource(dataSourceId, opts)
        : Promise.resolve({ rows: [], total: 0 }),
    [dataSourceId, key],
  );
}

export function useDataSources(ownerPageId: string | null): AsyncState<DataSource[]> {
  return useAsync(
    () => (ownerPageId ? commands.listDataSources(ownerPageId) : Promise.resolve([])),
    [ownerPageId],
  );
}

/**
 * Run a core write, surfacing its validation error as a toast and resolving to
 * null so callers can revert. Never rethrows: a rejected cell edit is a normal
 * outcome, not an application error.
 */
export async function guard<T>(run: () => Promise<T>, fallback?: string): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    toastError(error, fallback ?? "That change could not be saved.");
    return null;
  }
}
