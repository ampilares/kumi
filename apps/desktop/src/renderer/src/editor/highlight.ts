/**
 * Syntax highlighting for `code` blocks, as ProseMirror decorations.
 *
 * lowlight parses to a hast tree; each leaf becomes an inline decoration with
 * highlight.js class names, which styles.css maps onto Kumi's tokens. Nothing
 * is written to the document, so highlighting never produces a block op.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { common, createLowlight } from "lowlight";
import type { Node as PmNode } from "@tiptap/pm/model";

const lowlight = createLowlight(common);

export const PLAIN_LANGUAGE = "plain text";

/** Languages offered in the code block's picker, Notion-style naming. */
export const CODE_LANGUAGES: readonly string[] = [
  PLAIN_LANGUAGE,
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "less",
  "lua",
  "markdown",
  "php",
  "plaintext",
  "python",
  "r",
  "ruby",
  "rust",
  "scss",
  "shell",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
];

interface HastNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function collect(
  node: HastNode,
  base: number,
  classes: string[],
  out: Decoration[],
): number {
  let offset = base;
  for (const child of node.children ?? []) {
    if (child.type === "text") {
      const length = (child.value ?? "").length;
      if (length > 0 && classes.length > 0) {
        out.push(Decoration.inline(offset, offset + length, { class: classes.join(" ") }));
      }
      offset += length;
      continue;
    }
    const raw = child.properties?.className;
    const own = Array.isArray(raw) ? raw.filter((c): c is string => typeof c === "string") : [];
    offset = collect(child, offset, [...classes, ...own], out);
  }
  return offset;
}

function decorateCode(node: PmNode, pos: number, out: Decoration[]): void {
  const language = typeof node.attrs["language"] === "string" ? node.attrs["language"] : PLAIN_LANGUAGE;
  if (language === PLAIN_LANGUAGE || !lowlight.registered(language)) return;
  const text = node.textContent;
  if (text === "") return;
  try {
    const tree = lowlight.highlight(language, text) as unknown as HastNode;
    collect(tree, pos + 1, [], out);
  } catch {
    // An unknown grammar simply renders unhighlighted.
  }
}

export const KumiHighlight = Extension.create({
  name: "kumiHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("kumiHighlight"),
        props: {
          decorations(state) {
            const out: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (node.type.name === "code") decorateCode(node, offset, out);
            });
            return out.length === 0 ? null : DecorationSet.create(state.doc, out);
          },
        },
      }),
    ];
  },
});
