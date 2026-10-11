/**
 * A workspace-wide list of data sources.
 *
 * The core contract has `listDataSources(ownerPageId)` but no global list, so
 * the relation picker builds one by walking the page tree and asking each page
 * what it owns. That is O(pages) round trips, which is fine at local scale and
 * honest about the contract's shape — the alternative would be inventing a
 * command in the renderer that the CLI does not have.
 *
 * The result is cached for the life of a `kumi:changed` epoch: the walk is
 * cheap but not free, and every relation menu on screen would otherwise repeat
 * it. `invalidateDataSourceIndex` is wired to the same broadcast the tables use.
 */

import type { DataSource } from "@kumi/core";
import { commands } from "../ipc";
import { useAsync } from "../hooks";
import type { AsyncState } from "../hooks";

export interface DataSourceEntry {
  dataSource: DataSource;
  /** The page that owns it — shown as the picker's second line. */
  ownerPageId: string;
  ownerTitle: string;
}

/** Guard against a cyclic or pathological tree; a local workspace is far smaller. */
const MAX_PAGES = 5000;

let cache: Promise<DataSourceEntry[]> | null = null;

export function invalidateDataSourceIndex(): void {
  cache = null;
}

export function listAllDataSources(): Promise<DataSourceEntry[]> {
  cache ??= walk();
  return cache;
}

async function walk(): Promise<DataSourceEntry[]> {
  const entries: DataSourceEntry[] = [];
  const seen = new Set<string>();
  const roots = await commands.listRootPages();
  const queue = roots.map((node) => node.page);

  while (queue.length > 0 && seen.size < MAX_PAGES) {
    const page = queue.shift();
    if (!page || seen.has(page.id)) continue;
    seen.add(page.id);

    const [sources, children] = await Promise.all([
      commands.listDataSources(page.id).catch(() => []),
      commands.listChildren(page.id).catch(() => []),
    ]);
    for (const dataSource of sources) {
      entries.push({ dataSource, ownerPageId: page.id, ownerTitle: page.title });
    }
    for (const child of children) queue.push(child.page);
  }

  entries.sort((a, b) => a.dataSource.title.localeCompare(b.dataSource.title));
  return entries;
}

/** Live list of every data source, refetched with the rest of the database UI. */
export function useAllDataSources(enabled: boolean): AsyncState<DataSourceEntry[]> {
  return useAsync(() => {
    if (!enabled) return Promise.resolve([]);
    // The hook re-runs on `kumi:changed`; drop the memo so a database created in
    // another window shows up in the picker rather than a stale snapshot.
    invalidateDataSourceIndex();
    return listAllDataSources();
  }, [enabled]);
}
