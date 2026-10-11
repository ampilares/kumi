/**
 * The backlinks row at the foot of a page.
 *
 * Notion collapses this to a single "N backlinks" line and hides it entirely
 * when nothing links here, so an ordinary page carries no extra chrome. The
 * `links` index is maintained by core's `applyBlockOps`, so the list refreshes
 * on the ordinary `kumi:changed` broadcast — no editor coupling.
 */

import { useState } from "react";
import type { Backlink } from "@kumi/core";
import { commands } from "../ipc";
import { useAsync } from "../hooks";
import { useUi } from "../store";
import { cx, displayTitle } from "../utils";
import { ChevronRight, DocIcon } from "./icons";

export function Backlinks({ pageId }: { pageId: string }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const openPage = useUi((s) => s.openPage);
  const { data } = useAsync<Backlink[]>(() => commands.getBacklinks(pageId), [pageId]);

  const links = data ?? [];
  if (links.length === 0) return null;

  // One row per source page: several blocks on one page are one backlink here.
  const pages = new Map<string, Backlink>();
  for (const link of links) if (!pages.has(link.sourcePageId)) pages.set(link.sourcePageId, link);
  const sources = [...pages.values()];

  return (
    <div className={cx("backlinks", open && "is-open")}>
      <button
        type="button"
        className="backlinks__toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className="backlinks__caret" width={12} height={12} />
        <span>
          {sources.length} backlink{sources.length === 1 ? "" : "s"}
        </span>
      </button>

      {open ? (
        <div className="backlinks__list">
          {sources.map((link) => (
            <button
              key={link.sourcePageId}
              type="button"
              className="row"
              onClick={() => openPage(link.sourcePageId)}
            >
              <span className="row__icon">{link.sourcePageIcon ?? <DocIcon />}</span>
              <span className="row__label">{displayTitle(link.sourcePageTitle)}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
