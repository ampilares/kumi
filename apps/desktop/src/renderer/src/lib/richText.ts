/**
 * Kumi `RichText` ⇄ ProseMirror inline content.
 *
 * Mapping
 * -------
 *   annotations.bold          ↔ mark `bold`
 *   annotations.italic        ↔ mark `italic`
 *   annotations.underline     ↔ mark `underline`
 *   annotations.strikethrough ↔ mark `strike`
 *   annotations.code          ↔ mark `code`
 *   annotations.color         ↔ mark `kumiColor` (attrs.color = Notion color name)
 *   href                      ↔ mark `link`   (attrs.href)
 *   { type: "equation" }      ↔ inline atom `equation_span`
 *   { type: "mention" }       ↔ inline atom `mention_span`
 *
 * Equation and mention spans are modelled as atoms rather than flattened to
 * text so that opening a page written by the CLI (or a later phase) and typing
 * elsewhere in it can never silently destroy them.
 */

import type { RichText, RichTextAnnotations, RichTextSpan } from "@kumi/core";
import type { PmMark, PmNode } from "./pmjson";
import { deepEqual } from "./pmjson";

export const EQUATION_SPAN = "equation_span";
export const MENTION_SPAN = "mention_span";
export const COLOR_MARK = "kumiColor";
/**
 * The inline-code mark cannot be called `code`: that name belongs to the code
 * *block* node, and a ProseMirror schema may not use one name for both.
 */
export const CODE_MARK = "inlineCode";

type MentionValue = Extract<RichTextSpan, { type: "mention" }>["mention"];

type BooleanAnnotation = Exclude<keyof RichTextAnnotations, "color">;

const ANNOTATION_MARKS: ReadonlyArray<[BooleanAnnotation, string]> = [
  ["bold", "bold"],
  ["italic", "italic"],
  ["underline", "underline"],
  ["strikethrough", "strike"],
  ["code", CODE_MARK],
];

/* ------------------------------------------------------------- marks → spans */

interface SpanStyle {
  annotations?: RichTextAnnotations;
  href?: string;
}

function styleFromMarks(marks: PmMark[] | undefined): SpanStyle {
  const annotations: RichTextAnnotations = {};
  let href: string | undefined;
  for (const mark of marks ?? []) {
    const pair = ANNOTATION_MARKS.find(([, name]) => name === mark.type);
    if (pair) {
      annotations[pair[0]] = true;
      continue;
    }
    if (mark.type === COLOR_MARK) {
      const color = mark.attrs?.["color"];
      if (typeof color === "string" && color !== "" && color !== "default") {
        annotations.color = color;
      }
      continue;
    }
    if (mark.type === "link") {
      const value = mark.attrs?.["href"];
      if (typeof value === "string" && value !== "") href = value;
    }
  }
  const style: SpanStyle = {};
  if (Object.keys(annotations).length > 0) style.annotations = annotations;
  if (href !== undefined) style.href = href;
  return style;
}

function marksFromStyle(style: SpanStyle): PmMark[] | undefined {
  const marks: PmMark[] = [];
  const annotations = style.annotations ?? {};
  for (const [key, name] of ANNOTATION_MARKS) {
    if (annotations[key] === true) marks.push({ type: name });
  }
  const color = annotations.color;
  if (typeof color === "string" && color !== "" && color !== "default") {
    marks.push({ type: COLOR_MARK, attrs: { color } });
  }
  if (style.href !== undefined && style.href !== "") {
    marks.push({ type: "link", attrs: { href: style.href } });
  }
  return marks.length > 0 ? marks : undefined;
}

/* ------------------------------------------------------- RichText → PM inline */

export function richTextToInline(rich: RichText | undefined): PmNode[] {
  const out: PmNode[] = [];
  for (const span of rich ?? []) {
    const style: SpanStyle = {};
    if (span.annotations && Object.keys(span.annotations).length > 0) {
      style.annotations = span.annotations;
    }
    if (span.type === "text" && span.href !== undefined) style.href = span.href;
    const marks = marksFromStyle(style);

    if (span.type === "text") {
      if (span.text === "") continue;
      out.push(marks ? { type: "text", text: span.text, marks } : { type: "text", text: span.text });
    } else if (span.type === "equation") {
      const node: PmNode = { type: EQUATION_SPAN, attrs: { expression: span.expression } };
      if (marks) node.marks = marks;
      out.push(node);
    } else {
      const node: PmNode = { type: MENTION_SPAN, attrs: { mention: span.mention } };
      if (marks) node.marks = marks;
      out.push(node);
    }
  }
  return out;
}

/* ------------------------------------------------------- PM inline → RichText */

function sameStyle(a: RichTextSpan, b: RichTextSpan): boolean {
  if (a.type !== "text" || b.type !== "text") return false;
  return deepEqual(a.annotations, b.annotations) && a.href === b.href;
}

export function inlineToRichText(content: PmNode[] | undefined): RichText {
  const spans: RichTextSpan[] = [];
  const push = (span: RichTextSpan): void => {
    const last = spans[spans.length - 1];
    if (last && span.type === "text" && sameStyle(last, span) && last.type === "text") {
      last.text += span.text;
      return;
    }
    spans.push(span);
  };

  for (const node of content ?? []) {
    const style = styleFromMarks(node.marks);
    if (node.type === "text") {
      const text = node.text ?? "";
      if (text === "") continue;
      const span: RichTextSpan = { type: "text", text };
      if (style.annotations) span.annotations = style.annotations;
      if (style.href !== undefined) span.href = style.href;
      push(span);
    } else if (node.type === EQUATION_SPAN) {
      const expression = node.attrs?.["expression"];
      const span: RichTextSpan = {
        type: "equation",
        expression: typeof expression === "string" ? expression : "",
      };
      if (style.annotations) span.annotations = style.annotations;
      push(span);
    } else if (node.type === MENTION_SPAN) {
      const mention = node.attrs?.["mention"];
      if (mention === null || typeof mention !== "object") continue;
      const span: RichTextSpan = {
        type: "mention",
        mention: mention as MentionValue,
      };
      if (style.annotations) span.annotations = style.annotations;
      push(span);
    }
    // Any other inline node type is ignored: nothing else can enter the schema.
  }
  return spans;
}

/** Flat text of a rich-text run — used for placeholders, titles and search. */
export function plainText(rich: RichText | undefined): string {
  return (rich ?? [])
    .map((span) => {
      if (span.type === "text") return span.text;
      if (span.type === "equation") return span.expression;
      return span.mention.kind === "page" ? "↗" : span.mention.start;
    })
    .join("");
}
