/**
 * Inline-mark logic behind the selection toolbar.
 *
 * Kept free of React and of the DOM so the parts that are easy to get subtly
 * wrong — which marks count as active across a multi-node selection, what
 * counts as a URL, how an internal page link is spelled — are directly testable.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { COLOR_MARK, CODE_MARK } from "../lib/richText";

/** Notion's ten text colours; `default` means "remove the colour mark". */
export const TEXT_COLORS: readonly string[] = [
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

/** The same palette as backgrounds. `default_background` clears it. */
export const BACKGROUND_COLORS: readonly string[] = TEXT_COLORS.map((name) =>
  name === "default" ? "default_background" : `${name}_background`,
);

export function isBackgroundColor(color: string): boolean {
  return color.endsWith("_background");
}

/** "red_background" → "Red background", "gray" → "Gray". */
export function colorLabel(color: string): string {
  const base = color.replace(/_background$/, "");
  const name = base.charAt(0).toUpperCase() + base.slice(1);
  return isBackgroundColor(color) ? `${name} background` : name;
}

export interface MarkSnapshot {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  /** The href of the link mark covering the selection, or null. */
  link: string | null;
  /** The active colour name, or "default". */
  color: string;
}

const EMPTY: MarkSnapshot = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: null,
  color: "default",
};

/**
 * Marks active across the whole selection. A mark counts as active only when it
 * covers *every* text node in the range — the same rule Notion applies, so a
 * partially bold selection shows Bold as inactive and one click bolds it all.
 */
export function activeMarks(state: EditorState): MarkSnapshot {
  const { from, to, empty } = state.selection;
  if (empty) {
    const stored = state.storedMarks ?? state.selection.$from.marks();
    const names = new Set(stored.map((mark) => mark.type.name));
    const link = stored.find((mark) => mark.type.name === "link");
    const color = stored.find((mark) => mark.type.name === COLOR_MARK);
    return {
      bold: names.has("bold"),
      italic: names.has("italic"),
      underline: names.has("underline"),
      strike: names.has("strike"),
      code: names.has(CODE_MARK),
      link: typeof link?.attrs["href"] === "string" ? (link.attrs["href"] as string) : null,
      color: typeof color?.attrs["color"] === "string" ? (color.attrs["color"] as string) : "default",
    };
  }

  let seen = 0;
  const counts = new Map<string, number>();
  let href: string | null = null;
  let color: string | null = null;

  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText && !node.isAtom) return true;
    if (node.isText && (node.text ?? "") === "") return true;
    seen += 1;
    for (const mark of node.marks) {
      counts.set(mark.type.name, (counts.get(mark.type.name) ?? 0) + 1);
      if (mark.type.name === "link" && typeof mark.attrs["href"] === "string") {
        href = mark.attrs["href"] as string;
      }
      if (mark.type.name === COLOR_MARK && typeof mark.attrs["color"] === "string") {
        color = mark.attrs["color"] as string;
      }
    }
    return true;
  });

  if (seen === 0) return EMPTY;
  const all = (name: string): boolean => (counts.get(name) ?? 0) === seen;
  return {
    bold: all("bold"),
    italic: all("italic"),
    underline: all("underline"),
    strike: all("strike"),
    code: all(CODE_MARK),
    link: all("link") ? href : null,
    color: all(COLOR_MARK) && color !== null ? color : "default",
  };
}

/* ------------------------------------------------------------------- links */

export const PAGE_HREF_PREFIX = "kumi://page/";

export function pageHref(pageId: string): string {
  return `${PAGE_HREF_PREFIX}${pageId}`;
}

/** The page id of an internal link, or null for anything external. */
export function parsePageHref(href: string): string | null {
  if (!href.startsWith(PAGE_HREF_PREFIX)) return null;
  const id = href.slice(PAGE_HREF_PREFIX.length).split(/[?#]/)[0] ?? "";
  return id === "" ? null : id;
}

/**
 * What the user typed → a usable href. Bare hosts and paths get `https://`,
 * internal `kumi://` links and explicit schemes are left alone, and anything
 * that cannot be a URL at all returns null so the toolbar can refuse it.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (raw === "") return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) {
    try {
      return new URL(raw).toString();
    } catch {
      return null;
    }
  }
  if (raw.startsWith("//")) return normalizeUrl(`https:${raw}`);
  if (!/^[^\s/]+\.[^\s/]/.test(raw)) return null;
  try {
    return new URL(`https://${raw}`).toString();
  } catch {
    return null;
  }
}

/** True when the text looks like a link a paste menu should offer to embed. */
export function looksLikeUrl(input: string): boolean {
  const trimmed = input.trim();
  if (trimmed === "" || /\s/.test(trimmed)) return false;
  return /^https?:\/\//i.test(trimmed);
}

/* ---------------------------------------------------------------- commands */

/** Apply (or clear) a colour over the selection. */
export function applyColor(editor: Editor, color: string): void {
  const chain = editor.chain().focus();
  if (color === "default" || color === "default_background") {
    chain.unsetMark(COLOR_MARK).run();
    return;
  }
  chain.setMark(COLOR_MARK, { color }).run();
}

export function applyLink(editor: Editor, href: string): void {
  editor.chain().focus().extendMarkRange("link").setMark("link", { href }).run();
}

export function clearLink(editor: Editor): void {
  editor.chain().focus().extendMarkRange("link").unsetMark("link").run();
}
