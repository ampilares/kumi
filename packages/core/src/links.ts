/**
 * Outgoing page references of a block, the raw material of the `links` index
 * that backs `getBacklinks`.
 *
 * Three things count as a reference:
 *
 * - a rich-text span whose `href` is an internal `kumi://page/<id>` link,
 * - a `mention` span of kind `"page"`,
 * - the `pageId` of a `linked_page` block.
 *
 * `child_page` deliberately does not: a child page is already the caller's
 * subtree, and listing every parent as a "backlink" would bury the real ones.
 */

import type { BlockPayload, BlockType, Id, RichText } from "./types";

const PAGE_URL_PREFIX = "kumi://page/";

/**
 * The page id an internal link points at, or `null` for anything else
 * (external URLs, mailto:, a prefix with no id). Query strings and fragments
 * are trimmed so `kumi://page/<id>#block` resolves to the page.
 */
export function pageIdFromHref(href: string): Id | null {
  if (!href.startsWith(PAGE_URL_PREFIX)) return null;
  const rest = href.slice(PAGE_URL_PREFIX.length);
  const id = rest.split(/[?#]/, 1)[0] ?? "";
  return id === "" ? null : id;
}

function collectFromRichText(value: unknown, out: Id[]): void {
  if (!Array.isArray(value)) return;
  for (const span of value as RichText) {
    if (span === null || typeof span !== "object") continue;
    if (span.type === "text" && typeof span.href === "string") {
      const target = pageIdFromHref(span.href);
      if (target !== null) out.push(target);
    } else if (span.type === "mention" && span.mention.kind === "page") {
      out.push(span.mention.pageId);
    }
  }
}

/**
 * Every page this block links to, in payload order and deduplicated. Targets
 * are not checked for existence here — the caller skips unknown ones, so an
 * import may reference a page that has not been created yet and pick it up the
 * next time the block is edited.
 */
export function extractLinkTargets(
  type: BlockType,
  payload: BlockPayload,
): Id[] {
  const found: Id[] = [];
  // Every rich-text field of the payload, so a link inside a caption or a
  // table cell counts exactly like one in the body.
  collectFromRichText(payload.richText, found);
  collectFromRichText(payload.caption, found);
  if (Array.isArray(payload.cells)) {
    for (const cell of payload.cells) collectFromRichText(cell, found);
  }
  if (type === "linked_page" && typeof payload.pageId === "string") {
    found.push(payload.pageId);
  }
  return [...new Set(found)];
}
