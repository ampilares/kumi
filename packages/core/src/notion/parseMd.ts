/**
 * Stage 2a of the Notion import: Markdown → Kumi block payload trees.
 *
 * This module is pure — no database, no filesystem. It knows the dialect Notion
 * actually writes (GFM plus a handful of Notion-isms) and nothing about where
 * the export lives, so it is exhaustively unit-testable:
 *
 * | Notion markdown                     | Kumi block                            |
 * |-------------------------------------|---------------------------------------|
 * | `# …` / `## …` / `### …`            | heading1 / heading2 / heading3        |
 * | `#### …` and deeper                 | heading3 + `heading_depth` loss       |
 * | `- …`, `* …`, `+ …`                 | bulleted_list_item (children indented)|
 * | `1. …`                              | numbered_list_item                    |
 * | `- [ ] …` / `- [x] …`               | to_do                                 |
 * | `> …`                               | quote                                 |
 * | `> 💡 …`                            | callout with `icon`                   |
 * | ` ``` ` fenced                      | code (`language` from the fence)      |
 * | `$$ … $$`                           | equation; `$…$` inline → equation span|
 * | `---`                               | divider                               |
 * | GFM table                           | table + table_row children            |
 * | `![alt](local)` on its own line     | image/video/audio/file (asset ref)    |
 * | `![alt](https://…)`                 | bookmark + `external_image` loss      |
 * | `[text](Other%20<id>.md)`           | link span, href `notion-rel:<path>`   |
 *
 * Internal targets keep a `notion-rel:` href until the write stage resolves
 * them to `kumi://page/<id>`; unresolved ones are demoted to plain text and
 * reported as a loss, so a link is never silently dropped.
 *
 * Notion's toggles export as ordinary bullets with nested content and are
 * indistinguishable from real bullets — they import as bullets, with no loss
 * item, because there is nothing to detect.
 */

import type { BlockPayload, BlockType, RichText, RichTextAnnotations, RichTextSpan } from "../types";

/** Prefix marking an href that still points at a file inside the export. */
export const REL_HREF_PREFIX = "notion-rel:";

export interface ParsedBlock {
  type: BlockType;
  payload: BlockPayload;
  children: ParsedBlock[];
  /** Relative export path of the file this media block must import. */
  assetRef?: string;
  /** Filename to give the imported asset. */
  assetName?: string;
}

export interface MarkdownLoss {
  kind: string;
  detail: string;
  /** 1-based line in the source file. */
  line: number;
}

export interface ParsedMarkdown {
  /** The leading `# Title` Notion writes, when present. */
  title: string | null;
  blocks: ParsedBlock[];
  losses: MarkdownLoss[];
}

export interface ParseMarkdownOptions {
  /**
   * Drop the `Key: value` lines Notion writes under a database row's title —
   * they duplicate the CSV, which is the typed source of truth.
   */
  stripProperties?: boolean;
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

const EMOJI_LEAD = /^(\p{Extended_Pictographic}️?(?:‍\p{Extended_Pictographic}️?)*)\s+/u;

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"]);

/** Block type for a media file, chosen by extension. */
export function mediaTypeForPath(target: string): BlockType {
  const match = /\.[^./\\]+$/.exec(target.split(/[?#]/)[0] ?? target);
  const ext = (match?.[0] ?? "").toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  return "file";
}

/** True when a link target names something outside the export. */
export function isExternalTarget(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}

function decodePath(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    // A stray `%` that is not an escape: keep the raw text rather than fail.
    return target;
  }
}

/**
 * Turn a Markdown target into an href: external URLs pass through, everything
 * else becomes a `notion-rel:` reference to a file inside the export.
 */
export function hrefForTarget(target: string): string {
  const cleaned = target.trim().replace(/^<(.*)>$/, "$1");
  if (cleaned === "") return "";
  if (isExternalTarget(cleaned)) return cleaned;
  return `${REL_HREF_PREFIX}${decodePath(cleaned)}`;
}

/** The export-relative path behind a `notion-rel:` href, or null. */
export function relTargetOf(href: string): string | null {
  return href.startsWith(REL_HREF_PREFIX) ? href.slice(REL_HREF_PREFIX.length) : null;
}

function sameAnnotations(a: RichTextAnnotations, b: RichTextAnnotations): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.strikethrough === b.strikethrough &&
    a.code === b.code &&
    a.underline === b.underline &&
    a.color === b.color
  );
}

function pushText(out: RichTextSpan[], text: string, ann: RichTextAnnotations, href?: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (
    last !== undefined &&
    last.type === "text" &&
    last.href === href &&
    sameAnnotations(last.annotations ?? {}, ann)
  ) {
    last.text += text;
    return;
  }
  const span: RichTextSpan = { type: "text", text };
  if (Object.keys(ann).length > 0) span.annotations = { ...ann };
  if (href !== undefined && href !== "") span.href = href;
  out.push(span);
}

/** Index of `needle` at or after `from`, skipping backslash-escaped hits. */
function findUnescaped(text: string, needle: string, from: number): number {
  let index = from;
  while (index < text.length) {
    const hit = text.indexOf(needle, index);
    if (hit < 0) return -1;
    if (hit === 0 || text[hit - 1] !== "\\") return hit;
    index = hit + 1;
  }
  return -1;
}

/** Matching `)` for the `(` at `open`, honouring nesting. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Matching `]` for the `[` at `open`, honouring nesting. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Strip an optional `"title"` from a Markdown destination. */
function destinationOf(raw: string): string {
  const trimmed = raw.trim();
  const quoted = /^(\S*)\s+["'(].*["')]$/.exec(trimmed);
  return (quoted?.[1] ?? trimmed).trim();
}

interface InlineSink {
  spans: RichTextSpan[];
  /** Inline images cannot be blocks; the caller reports them. */
  inlineImages: string[];
}

function parseInlineInto(
  text: string,
  ann: RichTextAnnotations,
  href: string | undefined,
  sink: InlineSink,
): void {
  let i = 0;
  let buffer = "";
  const flush = (): void => {
    pushText(sink.spans, buffer, ann, href);
    buffer = "";
  };

  while (i < text.length) {
    const ch = text[i] ?? "";

    if (ch === "\\" && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

    // Code spans are literal: nothing inside them is markup.
    if (ch === "`") {
      let run = 0;
      while (text[i + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close > 0) {
        flush();
        pushText(sink.spans, text.slice(i + run, close), { ...ann, code: true }, href);
        i = close + run;
        continue;
      }
      buffer += fence;
      i += run;
      continue;
    }

    // `$…$` inline equation (but not `$$`, which is a block).
    if (ch === "$" && text[i + 1] !== "$") {
      const close = findUnescaped(text, "$", i + 1);
      const expression = close < 0 ? "" : text.slice(i + 1, close);
      if (close > 0 && expression !== "" && !expression.includes("\n")) {
        flush();
        const span: RichTextSpan = { type: "equation", expression };
        if (Object.keys(ann).length > 0) span.annotations = { ...ann };
        sink.spans.push(span);
        i = close + 1;
        continue;
      }
    }

    // Inline image: no block form is possible mid-sentence, so it degrades to
    // a link on its alt text and is reported.
    if (ch === "!" && text[i + 1] === "[") {
      const close = matchBracket(text, i + 1);
      const parenOpen = close + 1;
      if (close > 0 && text[parenOpen] === "(") {
        const parenClose = matchParen(text, parenOpen);
        if (parenClose > 0) {
          const alt = text.slice(i + 2, close);
          const target = destinationOf(text.slice(parenOpen + 1, parenClose));
          flush();
          sink.inlineImages.push(target);
          pushText(sink.spans, alt === "" ? target : alt, ann, hrefForTarget(target));
          i = parenClose + 1;
          continue;
        }
      }
    }

    if (ch === "[") {
      const close = matchBracket(text, i);
      const parenOpen = close + 1;
      if (close > 0 && text[parenOpen] === "(") {
        const parenClose = matchParen(text, parenOpen);
        if (parenClose > 0) {
          const label = text.slice(i + 1, close);
          const target = destinationOf(text.slice(parenOpen + 1, parenClose));
          flush();
          const linkHref = hrefForTarget(target);
          if (label === "") pushText(sink.spans, target, ann, linkHref);
          else parseInlineInto(label, ann, linkHref, sink);
          i = parenClose + 1;
          continue;
        }
      }
    }

    // `<https://example.com>` autolink.
    if (ch === "<") {
      const close = text.indexOf(">", i + 1);
      const url = close < 0 ? "" : text.slice(i + 1, close);
      if (close > 0 && /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url)) {
        flush();
        pushText(sink.spans, url, ann, url);
        i = close + 1;
        continue;
      }
    }

    const marker =
      text.startsWith("**", i) || text.startsWith("__", i)
        ? { delim: text.slice(i, i + 2), mark: "bold" as const }
        : text.startsWith("~~", i)
          ? { delim: "~~", mark: "strikethrough" as const }
          : ch === "*" || ch === "_"
            ? { delim: ch, mark: "italic" as const }
            : null;
    if (marker !== null && ann[marker.mark] !== true) {
      const close = findUnescaped(text, marker.delim, i + marker.delim.length);
      const inner = close < 0 ? "" : text.slice(i + marker.delim.length, close);
      if (close > 0 && inner !== "") {
        flush();
        parseInlineInto(inner, { ...ann, [marker.mark]: true }, href, sink);
        i = close + marker.delim.length;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
}

/** Parse one line of Markdown into rich-text spans. */
export function parseInline(text: string): RichText {
  const sink: InlineSink = { spans: [], inlineImages: [] };
  parseInlineInto(text, {}, undefined, sink);
  return sink.spans;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const TAB_WIDTH = 4;

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += TAB_WIDTH;
    else break;
  }
  return width;
}

interface Line {
  /** Text with its indentation removed. */
  text: string;
  indent: number;
  /** 1-based line number in the original file. */
  number: number;
}

function toLines(text: string, offset: number): Line[] {
  return text.split(/\r?\n/).map((raw, index) => ({
    text: raw.trimStart().trimEnd(),
    indent: indentOf(raw),
    number: offset + index + 1,
  }));
}

const FENCE = /^(`{3,}|~{3,})\s*([A-Za-z0-9+#._-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const DIVIDER = /^(-{3,}|\*{3,}|_{3,})$/;
const TODO = /^[-*+]\s+\[([ xX])\]\s?(.*)$/;
const BULLET = /^[-*+](\s+.*|\s*)$/;
const NUMBERED = /^(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const STANDALONE_IMAGE = /^!\[([^\]]*)\]\(([^)]*)\)$/;
const TABLE_DIVIDER = /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/;
const PROPERTY_LINE = /^[^:\n]{1,80}:\s?.*$/;

class Parser {
  readonly losses: MarkdownLoss[] = [];

  parse(lines: Line[]): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.text === "") {
        i += 1;
        continue;
      }
      const consumed = this.parseBlock(lines, i, blocks);
      i = consumed > i ? consumed : i + 1;
    }
    return blocks;
  }

  /** Parse the block starting at `start`; returns the index after it. */
  private parseBlock(lines: Line[], start: number, out: ParsedBlock[]): number {
    const line = lines[start];
    if (line === undefined) return start + 1;
    const { text } = line;

    const fence = FENCE.exec(text);
    if (fence !== null) return this.parseFence(lines, start, out, fence[1] ?? "```", fence[2] ?? "");

    if (text === "$$" || (text.startsWith("$$") && text.endsWith("$$") && text.length > 4)) {
      return this.parseEquation(lines, start, out);
    }

    const heading = HEADING.exec(text);
    if (heading !== null) {
      const hashes = (heading[1] ?? "#").length;
      if (hashes > 3) {
        this.losses.push({
          kind: "heading_depth",
          detail: `heading level ${hashes} imported as heading 3`,
          line: line.number,
        });
      }
      const level = Math.min(hashes, 3);
      out.push({
        type: (`heading${level}` as BlockType),
        payload: { richText: parseInline(heading[2] ?? "") },
        children: [],
      });
      return start + 1;
    }

    if (DIVIDER.test(text)) {
      out.push({ type: "divider", payload: {}, children: [] });
      return start + 1;
    }

    if (QUOTE.test(text)) return this.parseQuote(lines, start, out);

    const standalone = STANDALONE_IMAGE.exec(text);
    if (standalone !== null) {
      this.pushMedia(out, standalone[1] ?? "", standalone[2] ?? "", line.number);
      return start + 1;
    }

    if (text.startsWith("|") && lines[start + 1] !== undefined && TABLE_DIVIDER.test(lines[start + 1]?.text ?? "")) {
      return this.parseTable(lines, start, out);
    }

    if (TODO.test(text) || BULLET.test(text) || NUMBERED.test(text)) {
      return this.parseListItem(lines, start, out);
    }

    return this.parseParagraph(lines, start, out);
  }

  private parseFence(
    lines: Line[],
    start: number,
    out: ParsedBlock[],
    fence: string,
    language: string,
  ): number {
    const marker = fence[0] ?? "`";
    const body: string[] = [];
    let i = start + 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;
      if (line.text.startsWith(marker.repeat(3)) && line.text.trim().replace(/[`~]/g, "") === "") {
        i += 1;
        break;
      }
      body.push(" ".repeat(Math.max(0, line.indent - (lines[start]?.indent ?? 0))) + line.text);
      i += 1;
    }
    out.push({
      type: "code",
      payload: {
        richText: body.length === 0 ? [] : [{ type: "text", text: body.join("\n") }],
        language: language === "" ? "plain text" : language,
      },
      children: [],
    });
    return i;
  }

  private parseEquation(lines: Line[], start: number, out: ParsedBlock[]): number {
    const first = lines[start]?.text ?? "";
    if (first !== "$$") {
      out.push({
        type: "equation",
        payload: { expression: first.slice(2, -2).trim() },
        children: [],
      });
      return start + 1;
    }
    const body: string[] = [];
    let i = start + 1;
    while (i < lines.length && lines[i]?.text !== "$$") {
      body.push(lines[i]?.text ?? "");
      i += 1;
    }
    out.push({
      type: "equation",
      payload: { expression: body.join("\n").trim() },
      children: [],
    });
    return i + 1;
  }

  /**
   * A run of `>` lines. Notion exports callouts as a blockquote whose first
   * line starts with the callout's emoji, which is the only signal available.
   */
  private parseQuote(lines: Line[], start: number, out: ParsedBlock[]): number {
    const inner: Line[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined) break;
      const quote = QUOTE.exec(line.text);
      if (quote === null) break;
      const content = quote[1] ?? "";
      inner.push({ text: content.trimStart(), indent: indentOf(content), number: line.number });
      i += 1;
    }

    const firstText = inner[0]?.text ?? "";
    const emoji = EMOJI_LEAD.exec(firstText);
    const head = inner.slice(0, 1);
    const rest = inner.slice(1);
    if (emoji !== null && head[0] !== undefined) {
      head[0] = { ...head[0], text: firstText.slice(emoji[0].length) };
    }

    const bodyBlocks = this.parse([...head, ...rest]);
    const lead = bodyBlocks[0];
    const richText = lead !== undefined && lead.type === "paragraph" ? (lead.payload.richText ?? []) : [];
    const children = lead === undefined ? [] : bodyBlocks.slice(1);

    out.push({
      type: emoji === null ? "quote" : "callout",
      payload: emoji === null ? { richText } : { richText, icon: emoji[1] ?? "" },
      children,
    });
    return i;
  }

  private parseTable(lines: Line[], start: number, out: ParsedBlock[]): number {
    const rows: string[][] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || !line.text.startsWith("|")) break;
      if (i !== start + 1) rows.push(splitTableRow(line.text));
      i += 1;
    }
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const children: ParsedBlock[] = rows.map((row) => {
      const cells: RichText[] = [];
      for (let c = 0; c < width; c += 1) cells.push(parseInline(row[c] ?? ""));
      return { type: "table_row" as BlockType, payload: { cells }, children: [] };
    });
    out.push({
      type: "table",
      payload: { hasColumnHeader: true, hasRowHeader: false },
      children,
    });
    return i;
  }

  /** One list item plus everything indented under it. */
  private parseListItem(lines: Line[], start: number, out: ParsedBlock[]): number {
    const line = lines[start];
    if (line === undefined) return start + 1;
    const todo = TODO.exec(line.text);
    const numbered = todo === null ? NUMBERED.exec(line.text) : null;
    const type: BlockType =
      todo !== null ? "to_do" : numbered !== null ? "numbered_list_item" : "bulleted_list_item";
    const content =
      todo !== null
        ? (todo[2] ?? "")
        : numbered !== null
          ? (numbered[2] ?? "")
          : line.text.replace(/^[-*+]\s*/, "");

    const payload: BlockPayload = { richText: parseInline(content) };
    if (todo !== null) payload.checked = (todo[1] ?? " ").toLowerCase() === "x";

    // Continuation and nesting: every following line indented past the marker.
    const baseIndent = line.indent;
    const nested: Line[] = [];
    let i = start + 1;
    while (i < lines.length) {
      const next = lines[i];
      if (next === undefined) break;
      if (next.text === "") {
        const after = lines[i + 1];
        if (after === undefined || after.text === "" || after.indent <= baseIndent) break;
        nested.push({ ...next });
        i += 1;
        continue;
      }
      if (next.indent <= baseIndent) break;
      nested.push({ ...next, indent: next.indent - baseIndent });
      i += 1;
    }

    const children = nested.length === 0 ? [] : this.parse(dedent(nested));
    out.push({ type, payload, children });
    return i;
  }

  private parseParagraph(lines: Line[], start: number, out: ParsedBlock[]): number {
    const parts: string[] = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      if (line === undefined || line.text === "") break;
      if (i > start && this.startsNewBlock(lines, i)) break;
      parts.push(line.text);
      i += 1;
    }
    const sink: InlineSink = { spans: [], inlineImages: [] };
    parseInlineInto(parts.join("\n"), {}, undefined, sink);
    for (const target of sink.inlineImages) {
      this.losses.push({
        kind: "inline_image",
        detail: `image ${target} appeared mid-paragraph and imported as a link`,
        line: lines[start]?.number ?? 0,
      });
    }
    out.push({ type: "paragraph", payload: { richText: sink.spans }, children: [] });
    return i;
  }

  private startsNewBlock(lines: Line[], index: number): boolean {
    const text = lines[index]?.text ?? "";
    return (
      HEADING.test(text) ||
      DIVIDER.test(text) ||
      FENCE.test(text) ||
      QUOTE.test(text) ||
      TODO.test(text) ||
      BULLET.test(text) ||
      NUMBERED.test(text) ||
      STANDALONE_IMAGE.test(text) ||
      text === "$$" ||
      (text.startsWith("|") && TABLE_DIVIDER.test(lines[index + 1]?.text ?? ""))
    );
  }

  private pushMedia(out: ParsedBlock[], alt: string, rawTarget: string, line: number): void {
    const target = destinationOf(rawTarget);
    const caption = alt === "" ? undefined : parseInline(alt);
    if (isExternalTarget(target)) {
      // Kumi's image block addresses an asset in the workspace store; it has no
      // image-by-URL form, so an external image becomes a bookmark instead.
      this.losses.push({
        kind: "external_image",
        detail: `image at ${target} is not stored locally; imported as a bookmark`,
        line,
      });
      out.push({
        type: "bookmark",
        payload: caption === undefined ? { url: target } : { url: target, caption },
        children: [],
      });
      return;
    }
    const rel = decodePath(target.replace(/^<(.*)>$/, "$1"));
    const payload: BlockPayload = {};
    if (caption !== undefined) payload.caption = caption;
    out.push({
      type: mediaTypeForPath(rel),
      payload,
      children: [],
      assetRef: rel,
      assetName: rel.split("/").pop() ?? rel,
    });
  }
}

function splitTableRow(text: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      current += text[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current);
  // The leading and trailing `|` produce empty edge cells.
  if (cells.length > 0 && (cells[0] ?? "").trim() === "") cells.shift();
  if (cells.length > 0 && (cells[cells.length - 1] ?? "").trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

/** Re-indent a nested chunk so its shallowest line sits at column 0. */
function dedent(lines: Line[]): Line[] {
  const min = lines.reduce(
    (least, line) => (line.text === "" ? least : Math.min(least, line.indent)),
    Number.MAX_SAFE_INTEGER,
  );
  const shift = min === Number.MAX_SAFE_INTEGER ? 0 : min;
  return lines.map((line) => ({ ...line, indent: Math.max(0, line.indent - shift) }));
}

/**
 * Parse one Notion-exported Markdown file.
 *
 * The leading `# Title` heading becomes {@link ParsedMarkdown.title} rather
 * than a block — Kumi pages carry their title outside the block tree.
 */
export function parseNotionMarkdown(
  text: string,
  opts?: ParseMarkdownOptions,
): ParsedMarkdown {
  const withoutBom = text.replace(/^﻿/, "");
  const raw = withoutBom.split(/\r?\n/);

  let cursor = 0;
  let title: string | null = null;
  while (cursor < raw.length && (raw[cursor] ?? "").trim() === "") cursor += 1;
  const first = HEADING.exec((raw[cursor] ?? "").trim());
  if (first !== null && (first[1] ?? "").length === 1) {
    title = (first[2] ?? "").trim();
    cursor += 1;
  }

  if (opts?.stripProperties === true) {
    // Notion writes a row page's properties as `Key: value` lines directly
    // under the title; the CSV carries the same data with usable types.
    while (cursor < raw.length) {
      const line = (raw[cursor] ?? "").trim();
      if (line === "") {
        cursor += 1;
        continue;
      }
      if (!PROPERTY_LINE.test(line) || HEADING.test(line) || line.startsWith("|")) break;
      cursor += 1;
    }
  }

  const body = raw.slice(cursor).join("\n");
  const parser = new Parser();
  const blocks = parser.parse(toLines(body, cursor));
  return { title, blocks, losses: parser.losses };
}

/** Walk a parsed tree depth-first, including the roots. */
export function walkParsedBlocks(
  blocks: ParsedBlock[],
  visit: (block: ParsedBlock) => void,
): void {
  for (const block of blocks) {
    visit(block);
    walkParsedBlocks(block.children, visit);
  }
}

/** Every `notion-rel:` href inside a parsed tree, in document order. */
export function relHrefsOf(blocks: ParsedBlock[]): string[] {
  const out: string[] = [];
  walkParsedBlocks(blocks, (block) => {
    const lists: unknown[] = [block.payload.richText, block.payload.caption];
    if (Array.isArray(block.payload.cells)) lists.push(...block.payload.cells);
    for (const list of lists) {
      if (!Array.isArray(list)) continue;
      for (const span of list as RichTextSpan[]) {
        if (span.type !== "text") continue;
        const rel = typeof span.href === "string" ? relTargetOf(span.href) : null;
        if (rel !== null) out.push(rel);
      }
    }
  });
  return out;
}
