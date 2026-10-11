/**
 * Global search (spec Fig. 11).
 *
 * Two shapes share this component:
 *   - `search` — the full two-pane modal: input, filter chips, date-grouped
 *     results on the left, a live preview of the highlighted page on the right.
 *   - `quick` (Ctrl+P) — the same modal with `titleOnly` forced on and both the
 *     chip row and the preview pane suppressed, so jumping to a page stays a
 *     single-column, zero-latency list.
 *
 * The pure parts (bucketing, scope filtering, highlight segmentation, recents
 * shaping, preview truncation) live in `lib/search.ts` and are unit-tested;
 * this file is the wiring.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { SearchResult } from "@kumi/core";
import { commands } from "../ipc";
import { useBlocks, usePage, useRecentResults, useRootPages, useSearch } from "../data";
import { useUi, type SearchMode } from "../store";
import { cx, displayTitle } from "../utils";
import {
  applyScope,
  bodySnippet,
  breadcrumbLabel,
  flattenGroups,
  groupResultsByDate,
  highlightSegments,
  previewBlocks,
  sanitizeSnippet,
  scopeOptions,
  type SearchGroup,
} from "../lib/search";
import { ArrowUpRight, ChevronRight, DocIcon, SearchIcon } from "./icons";
import { Modal } from "./ui";
import { ReadOnlyBlocks } from "./ReadOnlyBlocks";

/** Long enough that arrowing through a list does not fetch every page it passes. */
const PREVIEW_DEBOUNCE_MS = 120;

export function SearchModal({ mode }: { mode: SearchMode }): JSX.Element {
  const close = useUi((s) => s.closeSearch);
  const openPage = useUi((s) => s.openPage);
  const quick = mode === "quick";

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [titleOnlyFilter, setTitleOnlyFilter] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  const [scopeMenu, setScopeMenu] = useState(false);

  const titleOnly = quick || titleOnlyFilter;
  const trimmed = query.trim();
  const results = useSearch(query, titleOnly);
  const recents = useRecentResults(!quick && trimmed === "");
  const roots = useRootPages();

  // Idle shows recents; typing shows hits. Both go through the same pipeline so
  // the grouping, the row renderer and the preview cannot drift apart.
  const source = trimmed === "" ? (recents.data ?? []) : (results.data ?? []);
  const scoped = useMemo(() => applyScope(source, quick ? null : scope), [source, scope, quick]);
  const groups = useMemo(() => groupResultsByDate(scoped), [scoped]);
  const items = useMemo(() => flattenGroups(groups), [groups]);

  useEffect(() => setActive(0), [trimmed, titleOnly, scope, mode]);

  const activeHit = items[active] ?? null;
  const previewId = useDebouncedPageId(quick ? null : (activeHit?.pageId ?? null));

  const choose = (hit: SearchResult | null): void => {
    if (!hit) return;
    openPage(hit.pageId);
    void commands.touchRecent(hit.pageId);
    close();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    // Enter on a focused chip or result row is that control's own business;
    // only the input (and the list at large) opens the highlighted result.
    if (e.key === "Enter" && (e.target as Element).tagName === "BUTTON") return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(items[active] ?? null);
    }
  };

  // Escape closes the scope menu first and only then the modal, so a stray
  // dropdown never costs the user their query.
  const dismiss = (): void => {
    if (scopeMenu) setScopeMenu(false);
    else close();
  };

  const idle = trimmed === "";
  const state = idle ? recents : results;

  return (
    <Modal
      open
      onClose={dismiss}
      className={cx("modal--search", !quick && "modal--search-wide")}
      label={quick ? "Quick switch" : "Search"}
    >
      <div
        className="search"
        onKeyDown={onKeyDown}
        // A click anywhere outside the dropdown dismisses it without also
        // reaching the Modal's outside-click handler.
        onPointerDown={(e) => {
          if (scopeMenu && !(e.target as Element).closest(".search__scopemenu,.search__chip")) {
            setScopeMenu(false);
          }
        }}
      >
        <div className="modal__search">
          <SearchIcon style={{ color: "var(--text-tertiary)" }} />
          <input
            className="modal__input"
            autoFocus
            value={query}
            placeholder={quick ? "Jump to a page…" : "Search or ask a question…"}
            aria-label={quick ? "Jump to a page" : "Search"}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="menuitem__hint">Esc</span>
        </div>

        {quick ? null : (
          <div className="search__filters" role="group" aria-label="Search filters">
            <button
              type="button"
              className={cx("search__chip", titleOnlyFilter && "is-on")}
              aria-pressed={titleOnlyFilter}
              onClick={() => setTitleOnlyFilter((v) => !v)}
            >
              <span className="search__chipglyph" aria-hidden="true">
                Aa
              </span>
              Title only
            </button>

            <div className="search__scope">
              <button
                type="button"
                className={cx("search__chip", scope !== null && "is-on")}
                aria-haspopup="menu"
                aria-expanded={scopeMenu}
                onClick={() => setScopeMenu((v) => !v)}
              >
                <DocIcon />
                {scope === null ? "In" : `In: ${scope}`}
                <ChevronRight className="search__chevron" />
              </button>
              {scopeMenu ? (
                <div className="search__scopemenu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={cx("search__scopeitem", scope === null && "is-on")}
                    onClick={() => {
                      setScope(null);
                      setScopeMenu(false);
                    }}
                  >
                    Everywhere
                  </button>
                  {scopeOptions(roots.data ?? []).map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="menuitem"
                      className={cx("search__scopeitem", scope === option.title && "is-on")}
                      onClick={() => {
                        setScope(option.title);
                        setScopeMenu(false);
                      }}
                    >
                      {option.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        )}

        <div className={cx("search__panes", !quick && "search__panes--split")}>
          <div className="search__results modal__body">
            {state.loading && !state.data ? (
              <div className="empty-hint">{idle ? "Loading…" : "Searching…"}</div>
            ) : state.error ? (
              <div className="empty-hint">Search unavailable: {state.error.message}</div>
            ) : items.length === 0 ? (
              <div className="empty-hint">{emptyMessage(idle, trimmed, scope, quick)}</div>
            ) : (
              <ResultList
                groups={groups}
                active={active}
                query={trimmed}
                showSnippets={!titleOnly}
                onHover={setActive}
                onChoose={choose}
              />
            )}
          </div>

          {quick ? null : <PreviewPane pageId={previewId} onOpen={() => choose(activeHit)} />}
        </div>
      </div>
    </Modal>
  );
}

function emptyMessage(
  idle: boolean,
  trimmed: string,
  scope: string | null,
  quick: boolean,
): string {
  if (idle) return quick ? "Type to jump to a page." : "Nothing recent yet — type to search.";
  if (scope !== null) return `No results for “${trimmed}” in ${scope}`;
  return `No results for “${trimmed}”`;
}

/* ----------------------------------------------------------------- results */

function ResultList({
  groups,
  active,
  query,
  showSnippets,
  onHover,
  onChoose,
}: {
  groups: SearchGroup[];
  active: number;
  query: string;
  showSnippets: boolean;
  onHover(index: number): void;
  onChoose(hit: SearchResult): void;
}): JSX.Element {
  // One running index across groups: the keyboard walks a flat list even though
  // the eye sees date headers.
  let index = -1;
  return (
    <>
      {groups.map((group) => (
        <div key={group.key} className="search__group">
          <div className="search__grouplabel">{group.label}</div>
          {group.results.map((hit) => {
            index += 1;
            const at = index;
            const snippet = showSnippets ? bodySnippet(hit) : null;
            return (
              <button
                key={hit.pageId}
                type="button"
                className={cx("result", at === active && "is-active")}
                ref={at === active ? scrollIntoView : undefined}
                onMouseEnter={() => onHover(at)}
                onClick={() => onChoose(hit)}
              >
                <span className="result__icon">{hit.icon ?? <DocIcon />}</span>
                <span className="result__text">
                  <span className="result__title">
                    <Highlighted text={displayTitle(hit.title)} query={query} />
                  </span>
                  <span className="result__crumb">{breadcrumbLabel(hit.breadcrumb)}</span>
                  {snippet ? (
                    <span
                      className="result__crumb result__snippet"
                      // Snippets come from core's FTS highlighter (<b> markers only).
                      dangerouslySetInnerHTML={{ __html: sanitizeSnippet(snippet) }}
                    />
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

/** Keeps the arrow-key selection inside the scroll port. */
function scrollIntoView(node: HTMLButtonElement | null): void {
  node?.scrollIntoView({ block: "nearest" });
}

function Highlighted({ text, query }: { text: string; query: string }): JSX.Element {
  const segments = highlightSegments(text, query);
  return (
    <>
      {segments.map((segment, i) =>
        segment.hit ? (
          <b key={i} className="result__hit">
            {segment.text}
          </b>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </>
  );
}

/* ----------------------------------------------------------------- preview */

/**
 * The highlighted result's page id, held back briefly.
 *
 * Arrowing down a long list would otherwise fire a page read and a block read
 * per row; the delay means only the row you actually stopped on is fetched.
 */
function useDebouncedPageId(pageId: string | null): string | null {
  const [settled, setSettled] = useState<string | null>(pageId);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      setSettled(pageId);
      return;
    }
    const timer = window.setTimeout(() => setSettled(pageId), PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [pageId]);

  return settled;
}

function PreviewPane({
  pageId,
  onOpen,
}: {
  pageId: string | null;
  onOpen(): void;
}): JSX.Element {
  const page = usePage(pageId);
  const blocks = useBlocks(pageId);
  const shown = useMemo(() => previewBlocks(blocks.data ?? []), [blocks.data]);
  const data = page.data;

  return (
    <aside className="search__preview" aria-label="Result preview">
      {data ? (
        <>
          <div className="search__previewbar">
            <button
              type="button"
              className="iconbtn"
              title="Open page"
              aria-label="Open page"
              onClick={onOpen}
            >
              <ArrowUpRight />
            </button>
          </div>
          <div className="search__previewdoc">
            {data.icon ? <div className="search__previewicon">{data.icon}</div> : null}
            <div className="search__previewtitle">{displayTitle(data.title)}</div>
            <ReadOnlyBlocks blocks={shown} />
          </div>
        </>
      ) : (
        <div className="empty-hint search__previewempty">
          {pageId === null ? "Select a result to preview it." : "Loading preview…"}
        </div>
      )}
    </aside>
  );
}
