import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { KumiError, onChanged, type CommandName } from "./ipc";
import { invalidatePageCache } from "./lib/pageCache";
import { useUi } from "./store";

/**
 * Commands that can change a page's title or icon. Only these invalidate the
 * mention-chip cache — `applyBlockOps` fires on every debounced keystroke and
 * must not send every chip on the page back to the database.
 */
const TITLE_AFFECTING: ReadonlySet<CommandName> = new Set<CommandName>([
  "createPage",
  "updatePage",
  "duplicatePage",
  "trashPage",
  "restorePage",
  "deletePagePermanently",
]);

export interface AsyncState<T> {
  data: T | undefined;
  error: KumiError | null;
  loading: boolean;
  reload(): void;
}

/**
 * Thin data hook: runs `fn` on mount and whenever `deps` change. When `live`
 * (default) it also re-runs after any `kumi:changed` broadcast.
 */
/** Monotonic id per deps-generation; module-level so remounts never collide. */
let nextRunId = 1;

interface Settled<T> {
  runId: number;
  data: T | undefined;
  error: KumiError | null;
}

export function useAsync<T>(
  fn: () => Promise<T>,
  deps: readonly unknown[],
  live = true,
): AsyncState<T> {
  const revision = useUi((s) => s.revision);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  // The previous fetch's {data, loading: false} must NEVER be observable for
  // new deps — a consumer that treats "null and not loading" as "missing"
  // would act on a stale frame (this bounced every first navigation out of
  // Home back to Home in the packaged app). A render-phase setState reset was
  // tried and is not reliably honored before the commit when the render is
  // driven by useSyncExternalStore (zustand), so staleness is DERIVED instead:
  // the settled result is keyed to the deps-generation it answered, and any
  // mismatch reads as "loading" — structurally, a stale pair cannot exist.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const runId = useMemo(() => nextRunId++, deps);
  const [settled, setSettled] = useState<Settled<T>>({
    runId: 0,
    data: undefined,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fnRef
      .current()
      .then((value) => {
        if (!cancelled) setSettled({ runId, data: value, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSettled({
          runId,
          data: undefined,
          error:
            err instanceof KumiError
              ? err
              : new KumiError({ code: "UNEXPECTED", message: String(err) }),
        });
      });
    return () => {
      cancelled = true;
    };
    // `revision`/`nonce` refetches keep the same runId, so the old data stays
    // visible while the reload is in flight (no flicker on kumi:changed).
  }, [runId, nonce, live ? revision : 0]);

  const current = settled.runId === runId;
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return {
    data: current ? settled.data : undefined,
    error: current ? settled.error : null,
    loading: !current,
    reload,
  };
}

/** Wires the main-process broadcast into the store's revision counter. */
export function useChangeBroadcast(): void {
  const bump = useUi((s) => s.bumpRevision);
  useEffect(
    () =>
      onChanged((event) => {
        if (TITLE_AFFECTING.has(event.method)) invalidatePageCache();
        bump();
      }),
    [bump],
  );
}

/**
 * Calls `handler` on Escape and on pointerdown outside every given ref.
 *
 * `ignoreSelector` names surfaces that are *visually* above this one but live
 * in their own portal — a menu a modal opened, say. Without it every anchored
 * menu inside a peek would tear down the peek that owns it.
 */
export function useDismiss(
  active: boolean,
  refs: Array<RefObject<HTMLElement | null>>,
  handler: () => void,
  ignoreSelector?: string,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const refsRef = useRef(refs);
  refsRef.current = refs;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        handlerRef.current();
      }
    };
    const onDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (!target) return;
      for (const ref of refsRef.current) {
        if (ref.current && ref.current.contains(target)) return;
      }
      if (
        ignoreSelector !== undefined &&
        target instanceof Element &&
        target.closest(ignoreSelector) !== null
      ) {
        return;
      }
      handlerRef.current();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [active, ignoreSelector]);
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Traps Tab focus inside `ref` and restores focus on unmount. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || !ref.current) return;
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (!firstEl || !lastEl) return;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, [ref, active]);
}

/** Returns a debounced version of `fn` that also flushes on unmount. */
export function useDebounced<A extends unknown[]>(
  fn: (...args: A) => void,
  delay = 400,
): (...args: A) => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<number | null>(null);
  const pending = useRef<A | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        if (pending.current) fnRef.current(...pending.current);
      }
    },
    [],
  );

  return useCallback(
    (...args: A) => {
      pending.current = args;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        pending.current = null;
        fnRef.current(...args);
      }, delay);
    },
    [delay],
  );
}

/** Grows a textarea to fit its content without layout jank. */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value]);
}

/** Anchors a floating element under (or above) a trigger rect. */
export function useAnchoredPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatRef: RefObject<HTMLElement | null>,
  active: boolean,
  align: "start" | "end" = "start",
): { top: number; left: number } {
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useLayoutEffect(() => {
    if (!active) return;
    const place = (): void => {
      const anchor = anchorRef.current;
      const float = floatRef.current;
      if (!anchor) return;
      const a = anchor.getBoundingClientRect();
      const fw = float?.offsetWidth ?? 220;
      const fh = float?.offsetHeight ?? 200;
      let left = align === "end" ? a.right - fw : a.left;
      let top = a.bottom + 4;
      left = Math.min(Math.max(8, left), window.innerWidth - fw - 8);
      if (top + fh > window.innerHeight - 8) top = Math.max(8, a.top - fh - 4);
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef, floatRef, active, align]);

  return pos;
}
