/**
 * The `?print=1&page=<id>` route, rendered in the offscreen window that main
 * hands to `webContents.printToPDF`.
 *
 * It is the page and nothing else: no rail, no topbar, no editor chrome. When
 * the title and blocks have loaded it sets `window.__kumiPrintReady`, which is
 * the signal main polls for before printing — without it the PDF would capture
 * a half-loaded document.
 */
import { useEffect } from "react";
import { usePage, useBlocks } from "../data";
import { displayTitle } from "../utils";
import { ReadOnlyBlocks } from "./ReadOnlyBlocks";

declare global {
  interface Window {
    __kumiPrintReady?: boolean;
  }
}

export function PrintView({ pageId }: { pageId: string }): JSX.Element {
  const page = usePage(pageId);
  const blocks = useBlocks(pageId);
  const ready = !page.loading && !blocks.loading;

  useEffect(() => {
    if (!ready) return;
    // One frame after the last render so node views (code, KaTeX) have painted.
    const handle = requestAnimationFrame(() => {
      window.__kumiPrintReady = true;
    });
    return () => cancelAnimationFrame(handle);
  }, [ready]);

  if (!page.data) {
    return <div className="printview">{page.loading ? "" : "Page not found."}</div>;
  }

  return (
    <div className="printview page">
      {page.data.icon ? <div className="page__icon">{page.data.icon}</div> : null}
      <div className="page__title page__title--static">{displayTitle(page.data.title)}</div>
      <ReadOnlyBlocks blocks={blocks.data ?? []} />
    </div>
  );
}
