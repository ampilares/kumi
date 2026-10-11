/**
 * Plain-text projection of block payloads (what the search index stores) and
 * sanitisation of user queries into safe FTS5 expressions.
 */

import type { BlockPayload, RichText } from "./types";

function isRichText(value: unknown): value is RichText {
  return Array.isArray(value);
}

/** Flatten rich-text spans to their searchable text. */
export function richTextToPlain(value: unknown): string {
  if (!isRichText(value)) return "";
  const parts: string[] = [];
  for (const span of value) {
    if (span === null || typeof span !== "object") continue;
    switch (span.type) {
      case "text":
        parts.push(span.text);
        break;
      case "equation":
        parts.push(span.expression);
        break;
      case "mention":
        if (span.mention.kind === "date") {
          parts.push(span.mention.start);
          if (span.mention.end !== undefined) parts.push(span.mention.end);
        }
        break;
      default:
        break;
    }
  }
  return parts.join("");
}

/** Searchable text of a single block payload. */
export function payloadToPlain(payload: BlockPayload): string {
  const parts: string[] = [];
  const push = (value: string): void => {
    const trimmed = value.trim();
    if (trimmed !== "") parts.push(trimmed);
  };

  push(richTextToPlain(payload.richText));
  push(richTextToPlain(payload.caption));
  if (typeof payload.url === "string") push(payload.url);
  if (typeof payload.expression === "string") push(payload.expression);
  if (typeof payload.language === "string" && typeof payload.url !== "string") {
    // Code blocks: the language is useful to match ("python", "sql").
    push(payload.language);
  }
  if (Array.isArray(payload.cells)) {
    for (const cell of payload.cells) push(richTextToPlain(cell));
  }
  return parts.join(" ");
}

/**
 * Split a raw user query into index-compatible tokens.
 *
 * Anything the FTS5 `unicode61` tokenizer would drop (punctuation, operators
 * like `AND`/`OR`/`NEAR` used as syntax, emoji) is either kept as a literal
 * term or dropped, so no user input can reach FTS5 as syntax.
 */
export function tokenizeQuery(query: string): string[] {
  const matches = query.match(/[\p{L}\p{N}_]+/gu);
  return matches === null ? [] : matches;
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

/**
 * Build an FTS5 MATCH expression: every token quoted (so it is a literal, never
 * an operator), ANDed together, with prefix matching on the final token so
 * search feels live as the user types. Returns `null` when nothing is
 * searchable.
 */
export function buildMatchExpression(
  query: string,
  opts: { titleOnly?: boolean } = {},
): string | null {
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return null;

  const terms = tokens.map((token, i) => {
    const quoted = quoteToken(token);
    return i === tokens.length - 1 ? `${quoted}*` : quoted;
  });
  const expression = terms.join(" AND ");
  return opts.titleOnly === true
    ? `{title} : (${expression})`
    : `(${expression})`;
}
