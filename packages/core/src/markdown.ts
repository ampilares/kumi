/**
 * GitHub-flavoured Markdown projection of a page's block tree.
 *
 * This module is pure: it turns blocks into text and never touches the database
 * or the filesystem. Everything it cannot know for itself — where another page's
 * file ended up, what an asset is called on disk, which CSV a child database was
 * written to — comes in through {@link MarkdownContext}, which the export
 * command supplies.
 *
 * Block mapping
 * -------------
 * | block                              | markdown                                  |
 * |------------------------------------|-------------------------------------------|
 * | paragraph                          | the text (empty paragraphs are dropped)   |
 * | heading1/2/3                       | `#` / `##` / `###`                        |
 * | bulleted_list_item, toggle         | `- …`, children indented two spaces       |
 * | numbered_list_item                 | `1. …`, numbered among adjacent siblings  |
 * | to_do                              | `- [ ] …` / `- [x] …`                     |
 * | quote                              | `> …`                                     |
 * | callout                            | `> <icon> …`, children inside the quote   |
 * | divider                            | `---`                                     |
 * | code                               | fenced block, `language` on the fence     |
 * | equation                           | `$$` … `$$`                               |
 * | bookmark                           | `[title](url)`                            |
 * | embed                              | the bare URL                              |
 * | image                              | `![caption](assets/<file>)`               |
 * | file / video / audio               | `[name](assets/<file>)`                   |
 * | child_page / linked_page           | `[Title](<relative .md>)` when exported    |
 * | child_database                     | `[DB title](<relative .csv>)`             |
 * | table + table_row                  | a Markdown table                          |
 * | column_list / column               | children flattened in order               |
 * | synced_block                       | children rendered in place                |
 * | table_of_contents, synced_reference| nothing (no faithful Markdown form)       |
 * | anything else                      | the payload's plain text                  |
 *
 * Inline marks map to `**bold**`, `*italic*`, `~~strike~~` and `` `code` ``.
 * Underline and colour have no Markdown form and are dropped. `kumi://page/<id>`
 * hrefs and page mentions become relative links when the target is part of the
 * same export, and keep their `kumi://` URL otherwise so nothing is silently
 * lost.
 */

import { pageIdFromHref } from "./links";
import { payloadToPlain, richTextToPlain } from "./text";
import type { Block, BlockPayload, BlockType, Id, RichText } from "./types";

/** The export's answers to "where did that end up?". */
export interface MarkdownContext {
  /** Relative href of another page's Markdown file; null when not exported. */
  pageHref(pageId: Id): string | null;
  /** Display title of a page, "Untitled" when it has none. */
  pageTitle(pageId: Id): string;
  /** Relative href and on-disk name of an asset; null when unknown. */
  asset(assetId: Id): { href: string; name: string } | null;
  /** Relative href and title of a data source's CSV; null when not exported. */
  database(dataSourceId: Id): { href: string; title: string } | null;
}

/**
 * List "families": consecutive items of the same family render tight (no blank
 * line between them), and a change of family separates the two lists so a
 * checklist after a bullet list does not read as one run.
 */
function listFamily(type: BlockType): string | null {
  switch (type) {
    case "bulleted_list_item":
    case "toggle":
      return "bulleted";
    case "numbered_list_item":
      return "numbered";
    case "to_do":
      return "to_do";
    default:
      return null;
  }
}

/** Types that contribute no line of their own; their children take their place. */
const FLATTENED_TYPES: ReadonlySet<string> = new Set<BlockType>([
  "column_list",
  "column",
  "synced_block",
]);

const UNTITLED = "Untitled";

/**
 * Escape the characters that would otherwise start Markdown syntax. `_` is
 * deliberately left alone: intra-word underscores are common in prose and code
 * identifiers, and GFM does not treat them as emphasis there.
 */
function escapeInline(text: string): string {
  return text.replace(/([\\`*[\]])/g, "\\$1");
}

function escapeCell(text: string): string {
  return escapeInline(text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Wrap `text` in `marker` unless it is blank (marks around spaces do nothing). */
function wrap(text: string, marker: string): string {
  return text.trim() === "" ? text : `${marker}${text}${marker}`;
}

function hrefFor(href: string, ctx: MarkdownContext): string {
  const pageId = pageIdFromHref(href);
  if (pageId === null) return href;
  return ctx.pageHref(pageId) ?? href;
}

/** Render one rich-text array as inline Markdown. */
export function richTextToMarkdown(
  value: RichText | undefined,
  ctx: MarkdownContext,
): string {
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const span of value) {
    if (span === null || typeof span !== "object") continue;
    if (span.type === "equation") {
      parts.push(`$${span.expression}$`);
      continue;
    }
    if (span.type === "mention") {
      if (span.mention.kind === "date") {
        const { start, end } = span.mention;
        parts.push(end === undefined || end === null ? start : `${start} → ${end}`);
        continue;
      }
      const title = ctx.pageTitle(span.mention.pageId);
      const href = ctx.pageHref(span.mention.pageId);
      const label = `@${escapeInline(title)}`;
      parts.push(
        href === null
          ? `[${label}](kumi://page/${span.mention.pageId})`
          : `[${label}](${href})`,
      );
      continue;
    }
    const marks = span.annotations ?? {};
    // Code is innermost: its content is literal, so it is never escaped.
    let text = marks.code === true ? `\`${span.text}\`` : escapeInline(span.text);
    if (marks.strikethrough === true) text = wrap(text, "~~");
    if (marks.italic === true) text = wrap(text, "*");
    if (marks.bold === true) text = wrap(text, "**");
    if (typeof span.href === "string" && span.href !== "") {
      text = `[${text}](${hrefFor(span.href, ctx)})`;
    }
    parts.push(text);
  }
  return parts.join("");
}

interface Node {
  block: Block;
  children: Node[];
}

/** Rebuild the parent/child tree of one page's flat, rank-ordered block list. */
function buildTree(blocks: Block[]): Node[] {
  const nodes = new Map<Id, Node>();
  for (const block of blocks) nodes.set(block.id, { block, children: [] });
  const roots: Node[] = [];
  for (const block of blocks) {
    const node = nodes.get(block.id);
    if (node === undefined) continue;
    const parent =
      block.parentBlockId === null ? undefined : nodes.get(block.parentBlockId);
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
  }
  const byRank = (a: Node, b: Node): number =>
    a.block.rank < b.block.rank ? -1 : a.block.rank > b.block.rank ? 1 : 0;
  roots.sort(byRank);
  for (const node of nodes.values()) node.children.sort(byRank);
  return roots;
}

function prefixed(lines: string[], prefix: string): string[] {
  return lines.map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`));
}

function textOf(payload: BlockPayload, ctx: MarkdownContext): string {
  return richTextToMarkdown(payload.richText, ctx);
}

function captionOf(payload: BlockPayload, ctx: MarkdownContext): string {
  return richTextToMarkdown(payload.caption, ctx);
}

/** `![caption](href)` / `[name](href)`, or the plain caption when unresolved. */
function mediaLines(
  block: Block,
  ctx: MarkdownContext,
  embedded: boolean,
): string[] {
  const caption = captionOf(block.payload, ctx);
  const assetId = block.payload.assetId;
  const asset = typeof assetId === "string" ? ctx.asset(assetId) : null;
  if (asset === null) return caption === "" ? [] : [caption];
  if (embedded) return [`![${caption}](${asset.href})`];
  const name = caption === "" ? escapeInline(asset.name) : caption;
  return [`[${name}](${asset.href})`];
}

function pageLinkLine(block: Block, ctx: MarkdownContext): string[] {
  const pageId = block.payload.pageId;
  if (typeof pageId !== "string") {
    const text = textOf(block.payload, ctx);
    return text === "" ? [] : [text];
  }
  const title = escapeInline(ctx.pageTitle(pageId));
  const href = ctx.pageHref(pageId);
  return [`[${title}](${href ?? `kumi://page/${pageId}`})`];
}

function tableLines(node: Node, ctx: MarkdownContext): string[] {
  const rows: string[][] = [];
  for (const child of node.children) {
    if (child.block.type !== "table_row") continue;
    const cells = child.block.payload.cells;
    const texts = Array.isArray(cells)
      ? cells.map((cell) => escapeCell(richTextToPlain(cell)))
      : [];
    rows.push(texts);
  }
  if (rows.length === 0) return [];
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const pad = (row: string[]): string[] => {
    const out = row.slice(0, width);
    while (out.length < width) out.push("");
    return out;
  };
  const line = (row: string[]): string => `| ${pad(row).join(" | ")} |`;
  const divider = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;

  const hasHeader = node.block.payload.hasColumnHeader === true;
  const header = hasHeader ? rows[0] : undefined;
  const body = hasHeader ? rows.slice(1) : rows;
  const out: string[] = [];
  // GFM tables always need a header row; a table without one gets a blank one.
  out.push(line(header ?? Array.from({ length: width }, () => "")));
  out.push(divider);
  for (const row of body) out.push(line(row));
  return out;
}

/** Render one block (children included) as indent-free lines. */
function renderNode(node: Node, ctx: MarkdownContext, ordinal: number): string[] {
  const { block } = node;
  const payload = block.payload;
  const text = textOf(payload, ctx);

  if (FLATTENED_TYPES.has(block.type)) return renderNodes(node.children, ctx);

  const withChildren = (lines: string[]): string[] => {
    const children = renderNodes(node.children, ctx);
    if (children.length === 0) return lines;
    if (lines.length === 0) return children;
    return [...lines, "", ...children];
  };

  switch (block.type) {
    case "paragraph":
      return withChildren(text === "" ? [] : text.split("\n"));

    case "heading1":
    case "heading2":
    case "heading3": {
      const level = Number(block.type.slice("heading".length));
      return withChildren([`${"#".repeat(level)} ${text}`.trimEnd()]);
    }

    case "bulleted_list_item":
    case "toggle":
      return [`- ${text}`.trimEnd(), ...prefixed(renderNodes(node.children, ctx), "  ")];

    case "numbered_list_item":
      return [
        `${ordinal}. ${text}`.trimEnd(),
        ...prefixed(renderNodes(node.children, ctx), "   "),
      ];

    case "to_do": {
      const mark = payload.checked === true ? "x" : " ";
      return [
        `- [${mark}] ${text}`.trimEnd(),
        ...prefixed(renderNodes(node.children, ctx), "  "),
      ];
    }

    case "quote":
    case "callout": {
      const icon = typeof payload.icon === "string" ? payload.icon : "";
      const head =
        block.type === "callout" && icon !== "" ? `${icon} ${text}`.trim() : text;
      const inner = [...head.split("\n"), ...(node.children.length === 0 ? [] : ["", ...renderNodes(node.children, ctx)])];
      return prefixed(inner, "> ");
    }

    case "divider":
      return withChildren(["---"]);

    case "code": {
      const language = typeof payload.language === "string" ? payload.language : "";
      const body = richTextToPlain(payload.richText);
      return withChildren([`\`\`\`${language}`, ...body.split("\n"), "```"]);
    }

    case "equation": {
      const expression =
        typeof payload.expression === "string"
          ? payload.expression
          : richTextToPlain(payload.richText);
      return withChildren(["$$", ...expression.split("\n"), "$$"]);
    }

    case "bookmark": {
      const url = typeof payload.url === "string" ? payload.url : "";
      if (url === "") return withChildren(text === "" ? [] : [text]);
      const label = text !== "" ? text : captionOf(payload, ctx);
      return withChildren([`[${label === "" ? escapeInline(url) : label}](${url})`]);
    }

    case "embed": {
      const url = typeof payload.url === "string" ? payload.url : "";
      return withChildren(url === "" ? [] : [url]);
    }

    case "image":
      return withChildren(mediaLines(block, ctx, true));

    case "file":
    case "video":
    case "audio":
      return withChildren(mediaLines(block, ctx, false));

    case "child_page":
    case "linked_page":
      return withChildren(pageLinkLine(block, ctx));

    case "child_database": {
      const dataSourceId = payload.dataSourceId;
      const database =
        typeof dataSourceId === "string" ? ctx.database(dataSourceId) : null;
      if (database === null) return withChildren(text === "" ? [] : [text]);
      const title = database.title === "" ? UNTITLED : database.title;
      return withChildren([`[${escapeInline(title)}](${database.href})`]);
    }

    case "table":
      return tableLines(node, ctx);

    case "table_row":
      // Only reachable outside a table; degrade to the joined cell text.
      return withChildren([
        (Array.isArray(payload.cells) ? payload.cells : [])
          .map((cell) => richTextToPlain(cell))
          .join(" "),
      ]);

    case "table_of_contents":
    case "synced_reference":
      return [];

    default: {
      const plain = payloadToPlain(payload);
      return withChildren(plain === "" ? [] : [plain]);
    }
  }
}

/** Render a sibling list, blank-separated except inside a run of list items. */
function renderNodes(nodes: Node[], ctx: MarkdownContext): string[] {
  const out: string[] = [];
  let ordinal = 0;
  let previous: Node | undefined;
  for (const node of nodes) {
    ordinal =
      node.block.type === "numbered_list_item"
        ? previous !== undefined && previous.block.type === "numbered_list_item"
          ? ordinal + 1
          : 1
        : 0;
    const chunk = renderNode(node, ctx, ordinal);
    if (chunk.length === 0) continue;
    if (out.length > 0) {
      const family = listFamily(node.block.type);
      const tight =
        previous !== undefined &&
        family !== null &&
        listFamily(previous.block.type) === family;
      if (!tight) out.push("");
    }
    out.push(...chunk);
    previous = node;
  }
  return out;
}

/**
 * Render a page's blocks as a Markdown document body. The result ends with a
 * single trailing newline, or is empty when the page has no renderable content.
 */
export function blocksToMarkdown(blocks: Block[], ctx: MarkdownContext): string {
  const lines = renderNodes(buildTree(blocks), ctx);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/** Device names Windows refuses as a filename, whatever the extension. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

const MAX_NAME_LENGTH = 120;

/** Characters no Windows path segment may contain. */
const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*]/g;

/**
 * A page title turned into a filename that is legal on Windows (and therefore
 * everywhere): `<>:"/\|?*`, control characters and trailing dots/spaces are
 * replaced or trimmed, reserved device names get an underscore, and the result
 * is capped so nested exports stay inside the path limit.
 */
export function safeFileName(title: string): string {
  const cleaned = Array.from(title)
    // Control characters are illegal in a path segment on every platform.
    .map((ch) => ((ch.codePointAt(0) ?? 0) < 0x20 ? " " : ch))
    .join("")
    .replace(ILLEGAL_NAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    // Windows silently drops trailing dots and spaces; do it explicitly.
    .replace(/[. ]+$/, "");
  if (cleaned === "") return UNTITLED;
  return RESERVED_NAMES.has(cleaned.toLowerCase()) ? `${cleaned}_` : cleaned;
}

/**
 * Make `${base}${ext}` unique within `taken`, Notion-style: the second "Notes"
 * becomes "Notes (2)". Comparison is case-insensitive because the export may
 * land on a case-insensitive filesystem.
 */
export function uniqueFileName(
  base: string,
  ext: string,
  taken: Set<string>,
): string {
  let candidate = `${base}${ext}`;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${counter})${ext}`;
    counter += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}
