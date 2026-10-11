/**
 * Thin data layer: async hooks over the typed IPC proxy plus the optimistic
 * mutation helpers used by the tree, the title field and the star toggle.
 */
import { create } from "zustand";
import type {
  Block,
  Page,
  PageSnapshot,
  PageTreeNode,
  SearchResult,
  SnapshotMeta,
  TemplateMeta,
  UserState,
  WorkspaceInfo,
} from "@kumi/core";
import { commands } from "./ipc";
import { useAsync, type AsyncState } from "./hooks";
import { recentsToResults, type RecentEntry } from "./lib/search";
import { useUi } from "./store";

/* ------------------------------------------------------------- optimistic */

interface OptimisticState {
  titles: Record<string, string>;
  favorites: Record<string, boolean>;
  setTitle(id: string, title: string): void;
  setFavorite(id: string, favorite: boolean): void;
  clear(id: string): void;
}

export const useOptimistic = create<OptimisticState>((set) => ({
  titles: {},
  favorites: {},
  setTitle: (id, title) => set((s) => ({ titles: { ...s.titles, [id]: title } })),
  setFavorite: (id, favorite) => set((s) => ({ favorites: { ...s.favorites, [id]: favorite } })),
  clear: (id) =>
    set((s) => {
      const titles = { ...s.titles };
      const favorites = { ...s.favorites };
      delete titles[id];
      delete favorites[id];
      return { titles, favorites };
    }),
}));

/** Title with any in-flight optimistic rename applied. */
export function useOptimisticTitle(id: string | null, serverTitle: string | undefined): string {
  const override = useOptimistic((s) => (id ? s.titles[id] : undefined));
  return override ?? serverTitle ?? "";
}

/* ------------------------------------------------------------------ reads */

export function useWorkspaceInfo(): AsyncState<WorkspaceInfo> {
  return useAsync(() => commands.getWorkspaceInfo(), []);
}

export function useUserState(): AsyncState<UserState> {
  return useAsync(() => commands.getUserState(), []);
}

export function useRootPages(): AsyncState<PageTreeNode[]> {
  return useAsync(() => commands.listRootPages(), []);
}

export function useChildren(pageId: string, enabled: boolean): AsyncState<PageTreeNode[]> {
  return useAsync(
    () => (enabled ? commands.listChildren(pageId) : Promise.resolve([])),
    [pageId, enabled],
  );
}

export function usePage(pageId: string | null): AsyncState<Page | null> {
  return useAsync(
    () => (pageId ? commands.getPage(pageId) : Promise.resolve(null)),
    [pageId],
  );
}

export function useBlocks(pageId: string | null): AsyncState<Block[]> {
  return useAsync(
    () => (pageId ? commands.getBlocks(pageId) : Promise.resolve([])),
    [pageId],
  );
}

export function useBreadcrumb(
  pageId: string | null,
): AsyncState<Pick<Page, "id" | "title" | "icon">[]> {
  return useAsync(
    () => (pageId ? commands.getBreadcrumb(pageId) : Promise.resolve([])),
    [pageId],
  );
}

export function useTrash(enabled: boolean): AsyncState<Page[]> {
  return useAsync(() => (enabled ? commands.listTrash() : Promise.resolve([])), [enabled]);
}

export function usePages(ids: string[]): AsyncState<Page[]> {
  const key = ids.join(",");
  return useAsync(async () => {
    const pages = await Promise.all(ids.map((id) => commands.getPage(id)));
    return pages.filter((p): p is Page => p !== null);
  }, [key]);
}

export function useSearch(query: string, titleOnly: boolean): AsyncState<SearchResult[]> {
  const trimmed = query.trim();
  return useAsync(
    () => (trimmed ? commands.search(trimmed, { limit: 40, titleOnly }) : Promise.resolve([])),
    [trimmed, titleOnly],
    false,
  );
}

/**
 * Recent pages shaped as search results, for the idle state of the search
 * modal (Fig. 11 shows recents before anything is typed).
 *
 * `getUserState` only stores ids, so each one costs a page read plus a
 * breadcrumb read. Capped well below core's recents cap to keep opening the
 * modal cheap — the list is scannable, not exhaustive.
 */
export function useRecentResults(enabled: boolean): AsyncState<SearchResult[]> {
  const user = useUserState();
  const ids = (user.data?.recents ?? []).slice(0, RECENT_RESULTS);
  const key = ids.join(",");
  return useAsync(async () => {
    if (!enabled || ids.length === 0) return [];
    const entries = await Promise.all(
      ids.map(async (id) => {
        const [page, chain] = await Promise.all([
          commands.getPage(id),
          commands.getBreadcrumb(id),
        ]);
        // `getBreadcrumb` ends with the page itself; SearchResult's breadcrumb stops at the parent.
        return page ? { page, breadcrumb: chain.slice(0, -1).map((p) => p.title) } : null;
      }),
    );
    return recentsToResults(
      ids,
      entries.filter((e): e is RecentEntry => e !== null),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}

const RECENT_RESULTS = 12;

/* ----------------------------------------------- history & templates (P6) */

export function useSnapshots(pageId: string | null): AsyncState<SnapshotMeta[]> {
  return useAsync(
    () => (pageId ? commands.listSnapshots(pageId) : Promise.resolve([])),
    [pageId],
  );
}

export function useSnapshot(snapshotId: string | null): AsyncState<PageSnapshot | null> {
  return useAsync(
    () => (snapshotId ? commands.getSnapshot(snapshotId) : Promise.resolve(null)),
    [snapshotId],
  );
}

export function useTemplates(enabled: boolean): AsyncState<TemplateMeta[]> {
  return useAsync(() => (enabled ? commands.listTemplates() : Promise.resolve([])), [enabled]);
}

/* -------------------------------------------------------------- mutations */

export async function renamePage(id: string, title: string): Promise<void> {
  useOptimistic.getState().setTitle(id, title);
  try {
    await commands.updatePage(id, { title });
  } finally {
    useOptimistic.getState().clear(id);
  }
}

export async function toggleFavorite(id: string, favorite: boolean): Promise<void> {
  useOptimistic.getState().setFavorite(id, favorite);
  try {
    await commands.setFavorite(id, favorite);
  } finally {
    useOptimistic.getState().clear(id);
  }
}

export async function setExpanded(id: string, expanded: boolean): Promise<void> {
  useUi.getState().setExpandedLocal(id, expanded);
  await commands.setExpanded(id, expanded);
}

export async function createPage(parentId: string | null): Promise<Page> {
  const page = await commands.createPage({ parentId, title: "" });
  if (parentId) await setExpanded(parentId, true);
  useUi.getState().openPage(page.id);
  await commands.touchRecent(page.id);
  return page;
}
