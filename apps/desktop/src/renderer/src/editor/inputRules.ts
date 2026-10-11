/**
 * Markdown-style input shortcuts.
 *
 * DOCUMENTED DECISION — the two ambiguous triggers.
 * Notion binds `>` + space to a **toggle list** and has no `>` quote shortcut;
 * a quote is produced by `"` + space. Kumi follows Notion here rather than
 * CommonMark, because the point of the shortcut set is muscle-memory parity for
 * people moving off Notion:
 *
 *   #  ##  ###   headings 1–3          -  *   bulleted list
 *   1.            numbered list        []  [x]  to-do (unchecked / checked)
 *   >             toggle list          "   quote
 *   ```           code (optionally ```ts to set the language)
 *   ---           divider
 *
 * Inline: **bold**, *italic*, `code`, ~strike~ / ~~strike~~.
 */

import { Extension, InputRule, markInputRule } from "@tiptap/core";
import type { MarkType } from "@tiptap/pm/model";

/** Replace the current block's type, dropping the matched shortcut text. */
function blockRule(
  find: RegExp,
  typeName: string,
  attrsFor?: (match: RegExpMatchArray) => Record<string, unknown>,
): InputRule {
  return new InputRule({
    find,
    handler: ({ state, range, match }) => {
      const type = state.schema.nodes[typeName];
      const resolved = state.doc.resolve(range.from);
      if (!type || resolved.depth < 1) return;
      const blockPos = resolved.before(1);
      const node = state.doc.nodeAt(blockPos);
      if (!node || node.type.name === typeName) return;

      const tr = state.tr;
      tr.delete(range.from, range.to);
      tr.setNodeMarkup(blockPos, type, {
        blockId: node.attrs["blockId"],
        depth: node.attrs["depth"],
        ...(attrsFor ? attrsFor(match) : {}),
      });
      if (typeName === "code") {
        const updated = tr.doc.nodeAt(blockPos);
        if (updated) tr.removeMark(blockPos + 1, blockPos + updated.nodeSize - 1);
      }
    },
  });
}

/** `---` replaces the block with a divider and leaves an empty paragraph below. */
function dividerRule(): InputRule {
  return new InputRule({
    find: /^---$/,
    handler: ({ state, range }) => {
      const divider = state.schema.nodes["divider"];
      const paragraph = state.schema.nodes["paragraph"];
      const resolved = state.doc.resolve(range.from);
      if (!divider || !paragraph || resolved.depth < 1) return;
      const blockPos = resolved.before(1);
      const node = state.doc.nodeAt(blockPos);
      if (!node) return;

      const depth = node.attrs["depth"];
      state.tr.replaceWith(blockPos, blockPos + node.nodeSize, [
        divider.create({ blockId: node.attrs["blockId"], depth }),
        paragraph.create({ blockId: null, depth }),
      ]);
    },
  });
}

export const KumiInputRules = Extension.create({
  name: "kumiInputRules",

  addInputRules() {
    return [
      blockRule(/^#\s$/, "heading1"),
      blockRule(/^##\s$/, "heading2"),
      blockRule(/^###\s$/, "heading3"),
      blockRule(/^[-*]\s$/, "bulleted_list_item"),
      blockRule(/^\d+\.\s$/, "numbered_list_item"),
      blockRule(/^\[([ xX]?)\]\s$/, "to_do", (match) => ({
        checked: (match[1] ?? "").toLowerCase() === "x",
      })),
      blockRule(/^>\s$/, "toggle", () => ({ collapsed: false })),
      blockRule(/^"\s$/, "quote"),
      blockRule(/^```([a-zA-Z0-9+#.-]*)\s$/, "code", (match) => ({
        language: match[1] !== undefined && match[1] !== "" ? match[1] : "plain text",
      })),
      dividerRule(),
    ];
  },
});

/** Single-tilde strikethrough, which Notion accepts alongside `~~`. */
export function singleTildeStrike(type: MarkType): InputRule {
  return markInputRule({ find: /(?:^|\s)(~(?!\s+~)([^~]+)~(?!\s+~))$/, type });
}
