/**
 * Page title cache.
 *
 * Mention chips render the *current* title of the page they point at, but a
 * block payload only stores the id — storing the title would go stale the
 * moment the page is renamed. So chips read from this cache, which fetches a
 * title once per page and then notifies every chip that is showing it.
 *
 * `kumi:changed` invalidates the cache (see `useChangeBroadcast`), so renaming
 * a page updates every chip pointing at it without a reload.
 */
import type { Id, Page } from "@kumi/core";
import { commands } from "../ipc";

export interface PageStub {
  id: Id;
  title: string;
  icon: string | null;
  /** Set when the page has been deleted or was never found. */
  missing: boolean;
}

const cache = new Map<Id, PageStub>();
const inFlight = new Map<Id, Promise<PageStub | null>>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe to cache updates. Returns an unsubscribe function. */
export function onPageCacheChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function cachedPage(id: Id): PageStub | undefined {
  return cache.get(id);
}

export function primePage(page: Pick<Page, "id" | "title" | "icon">): void {
  const previous = cache.get(page.id);
  if (previous && previous.title === page.title && previous.icon === page.icon) return;
  cache.set(page.id, { id: page.id, title: page.title, icon: page.icon, missing: false });
  notify();
}

/** Fetch a page's title once; concurrent callers share the same request. */
export function ensurePage(id: Id): Promise<PageStub | null> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inFlight.get(id);
  if (pending) return pending;

  const request = commands
    .getPage(id)
    .then((page) => {
      const stub: PageStub = page
        ? { id, title: page.title, icon: page.icon, missing: false }
        : { id, title: "Untitled", icon: null, missing: true };
      cache.set(id, stub);
      notify();
      return stub;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(id);
    });

  inFlight.set(id, request);
  return request;
}

/** Drop every cached title so the next render refetches. */
export function invalidatePageCache(): void {
  if (cache.size === 0) return;
  cache.clear();
  notify();
}
