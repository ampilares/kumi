/**
 * The block types the Phase 2 editor can create, with the metadata the slash
 * menu and the "Turn into" submenu render.
 *
 * `type` doubles as the ProseMirror node name — the schema deliberately names
 * its nodes after Kumi `BlockType`s so the mapping is identity.
 */
import type { BlockType } from "@kumi/core";

/** Types a paragraph can be turned *into* — the "Turn into" submenu. */
export type TextualBlockType =
  | "paragraph"
  | "heading1"
  | "heading2"
  | "heading3"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  | "code";

/**
 * Types the slash menu can *insert* but that are not text containers, so they
 * never appear in "Turn into" (Notion behaves the same way).
 */
export type InsertBlockType =
  | "equation"
  | "image"
  | "file"
  | "video"
  | "audio"
  | "bookmark"
  | "embed"
  | "column_list"
  | "column"
  | "child_database"
  | "child_page";

export type EditorBlockType = TextualBlockType | InsertBlockType;

export interface BlockTypeInfo {
  type: EditorBlockType;
  label: string;
  hint: string;
  /** Glyph shown in the slash menu tile. */
  glyph: string;
  /** Markdown shortcut echoed in menus, Notion-style. */
  shortcut?: string;
  keywords: string[];
  /** Slash-menu section header, Notion-style. */
  group?: "basic" | "media" | "advanced";
}

/** Types offered by "Turn into" — every one of them holds inline text. */
export const BLOCK_TYPE_INFO: readonly BlockTypeInfo[] = [
  {
    type: "paragraph",
    label: "Text",
    hint: "Just start writing with plain text.",
    glyph: "¶",
    keywords: ["text", "paragraph", "plain"],
  },
  {
    type: "heading1",
    label: "Heading 1",
    hint: "Big section heading.",
    glyph: "H1",
    shortcut: "#",
    keywords: ["heading", "h1", "title", "large"],
  },
  {
    type: "heading2",
    label: "Heading 2",
    hint: "Medium section heading.",
    glyph: "H2",
    shortcut: "##",
    keywords: ["heading", "h2", "subtitle", "medium"],
  },
  {
    type: "heading3",
    label: "Heading 3",
    hint: "Small section heading.",
    glyph: "H3",
    shortcut: "###",
    keywords: ["heading", "h3", "small"],
  },
  {
    type: "bulleted_list_item",
    label: "Bulleted list",
    hint: "Create a simple bulleted list.",
    glyph: "•",
    shortcut: "-",
    keywords: ["bullet", "list", "unordered", "ul"],
  },
  {
    type: "numbered_list_item",
    label: "Numbered list",
    hint: "Create a list with numbering.",
    glyph: "1.",
    shortcut: "1.",
    keywords: ["number", "list", "ordered", "ol"],
  },
  {
    type: "to_do",
    label: "To-do list",
    hint: "Track tasks with a to-do list.",
    glyph: "☐",
    shortcut: "[]",
    keywords: ["todo", "task", "checkbox", "check"],
  },
  {
    type: "toggle",
    label: "Toggle list",
    hint: "Toggles can hide and show content.",
    glyph: "▸",
    shortcut: ">",
    keywords: ["toggle", "collapse", "expand", "details"],
  },
  {
    type: "quote",
    label: "Quote",
    hint: "Capture a quote.",
    glyph: "❝",
    shortcut: '"',
    keywords: ["quote", "blockquote", "citation"],
  },
  {
    type: "divider",
    label: "Divider",
    hint: "Visually divide blocks.",
    glyph: "―",
    shortcut: "---",
    keywords: ["divider", "line", "separator", "hr", "rule"],
  },
  {
    type: "callout",
    label: "Callout",
    hint: "Make writing stand out.",
    glyph: "💡",
    keywords: ["callout", "note", "info", "highlight"],
  },
  {
    type: "code",
    label: "Code",
    hint: "Capture a code snippet.",
    glyph: "</>",
    shortcut: "```",
    keywords: ["code", "snippet", "syntax", "pre"],
  },
];

/**
 * Phase 3 insert-only blocks. `column` is deliberately absent from the menu:
 * columns are only ever created through their container.
 */
export const INSERT_BLOCK_INFO: readonly BlockTypeInfo[] = [
  {
    type: "child_page",
    label: "Page",
    hint: "Embed a sub-page inside this page.",
    glyph: "📄",
    keywords: ["page", "subpage", "child", "new", "sub"],
    group: "basic",
  },
  {
    type: "equation",
    label: "Block equation",
    hint: "Display a standalone math equation.",
    glyph: "∑",
    keywords: ["equation", "math", "katex", "latex", "tex", "formula"],
    group: "advanced",
  },
  {
    type: "image",
    label: "Image",
    hint: "Upload or embed with a link.",
    glyph: "🖼",
    keywords: ["image", "picture", "photo", "img", "upload", "media"],
    group: "media",
  },
  {
    type: "file",
    label: "File",
    hint: "Upload or embed with a link.",
    glyph: "📎",
    keywords: ["file", "attachment", "upload", "document", "pdf", "media"],
    group: "media",
  },
  {
    type: "video",
    label: "Video",
    hint: "Embed from your computer.",
    glyph: "🎬",
    keywords: ["video", "movie", "mp4", "media", "upload"],
    group: "media",
  },
  {
    type: "audio",
    label: "Audio",
    hint: "Embed a sound file.",
    glyph: "🎵",
    keywords: ["audio", "sound", "music", "mp3", "media", "upload"],
    group: "media",
  },
  {
    type: "bookmark",
    label: "Web bookmark",
    hint: "Save a link as a visual bookmark.",
    glyph: "🔖",
    keywords: ["bookmark", "link", "url", "web", "preview"],
    group: "media",
  },
  {
    type: "embed",
    label: "Embed",
    hint: "Embed a YouTube video or any page.",
    glyph: "▶",
    keywords: ["embed", "iframe", "youtube", "video", "url"],
    group: "media",
  },
  {
    type: "child_database",
    label: "Table",
    hint: "Add a table database to this page.",
    glyph: "▦",
    keywords: ["table", "database", "db", "grid", "rows", "data"],
    group: "advanced",
  },
  {
    type: "column_list",
    label: "2 columns",
    hint: "Create two columns of blocks.",
    glyph: "⫼",
    keywords: ["column", "columns", "2", "two", "side", "split", "layout"],
    group: "advanced",
  },
];

/** Every block type the Phase 3 editor renders natively. */
export const EDITOR_BLOCK_TYPES: readonly EditorBlockType[] = [
  ...BLOCK_TYPE_INFO.map((i) => i.type),
  ...INSERT_BLOCK_INFO.map((i) => i.type),
  "column",
];

const INFO_BY_TYPE = new Map<string, BlockTypeInfo>(
  [...BLOCK_TYPE_INFO, ...INSERT_BLOCK_INFO].map((i) => [i.type, i]),
);

const EDITOR_TYPE_SET: ReadonlySet<string> = new Set<string>(EDITOR_BLOCK_TYPES);

export function blockTypeInfo(type: string): BlockTypeInfo | undefined {
  return INFO_BY_TYPE.get(type);
}

export function isEditorBlockType(type: string): type is EditorBlockType {
  return EDITOR_TYPE_SET.has(type);
}

/** Types that hold inline text (everything except the atoms and containers). */
export const TEXT_BLOCK_TYPES: readonly EditorBlockType[] = BLOCK_TYPE_INFO.map((i) => i.type).filter(
  (t) => t !== "divider" && t !== "code",
);

/** Media placeholder copy, Notion-style. */
export const MEDIA_PROMPT: Readonly<Record<string, string>> = {
  image: "Add an image",
  file: "Add a file",
  video: "Add a video",
  audio: "Add an audio file",
};

/** List-like types whose Enter behaviour continues the list. */
export const LIST_TYPES: ReadonlySet<string> = new Set<string>([
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
]);

/** Node name used for any block type Phase 2 cannot render yet. */
export const UNSUPPORTED_NODE = "unsupported_block";

/** Compile-time proof that every editor type is a real Kumi block type. */
const _typesAreBlockTypes: readonly BlockType[] = EDITOR_BLOCK_TYPES;
void _typesAreBlockTypes;
