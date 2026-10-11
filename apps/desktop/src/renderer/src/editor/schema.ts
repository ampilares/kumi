/**
 * The Kumi editor schema.
 *
 * Every node is named after the Kumi `BlockType` it stores, so `node.type.name`
 * *is* the block type (see lib/blockSync.ts for the flat-with-`depth` rationale).
 * Each block node carries `blockId` (server identity) and `depth` (outline
 * level); nothing else about a block lives outside its attributes.
 */

import { Mark, Node, mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { COLOR_MARK, EQUATION_SPAN, MENTION_SPAN } from "../lib/richText";
import { MEDIA_PROMPT, UNSUPPORTED_NODE } from "../lib/blockTypes";
import { COLUMN, COLUMN_LIST } from "../lib/blockSync";
import {
  bookmarkNodeView,
  columnListNodeView,
  embedNodeView,
  equationBlockNodeView,
  equationSpanNodeView,
  mediaNodeView,
  mentionSpanNodeView,
} from "./nodeViews";

type Attrs = Record<string, unknown>;

/**
 * Ordinary blocks belong to two groups: `block` (a direct child of the page)
 * and `colblock` (legal inside a column). `column_list` is deliberately only in
 * `block`, which is what makes "a column can never contain another column
 * layout" a schema guarantee rather than a runtime check.
 */
const BLOCK_GROUPS = "block colblock";

export const blockAttributes = {
  blockId: {
    default: null,
    parseHTML: (element: HTMLElement): string | null => element.getAttribute("data-block-id"),
    renderHTML: (attributes: Attrs): Attrs => {
      const id = attributes["blockId"];
      return typeof id === "string" ? { "data-block-id": id } : {};
    },
  },
  depth: {
    default: 0,
    parseHTML: (element: HTMLElement): number => Number(element.getAttribute("data-depth") ?? 0),
    renderHTML: (attributes: Attrs): Attrs => ({ "data-depth": String(attributes["depth"] ?? 0) }),
  },
};

function base(name: string, className: string, extra: Attrs = {}): Attrs {
  return mergeAttributes(extra, { "data-kumi": name, class: `kb ${className}` });
}

/* --------------------------------------------------------------------- doc */

export const KumiDocument = Node.create({
  name: "doc",
  topNode: true,
  content: "block+",
});

/* ------------------------------------------------------------- text blocks */

interface TextBlockConfig {
  name: string;
  tag: string;
  className: string;
  attrs?: Record<string, unknown>;
  /** Non-editable leading element (checkbox, caret, callout icon). */
  prefix?: (attrs: Attrs) => DOMOutputSpec | null;
}

function textBlock(config: TextBlockConfig): Node {
  return Node.create({
    name: config.name,
    group: BLOCK_GROUPS,
    content: "inline*",
    defining: true,

    addAttributes() {
      return { ...blockAttributes, ...(config.attrs ?? {}) };
    },

    parseHTML() {
      return [{ tag: `${config.tag}[data-kumi="${config.name}"]` }];
    },

    renderHTML({ node, HTMLAttributes }) {
      const attrs = base(config.name, config.className, HTMLAttributes);
      const prefix = config.prefix?.(node.attrs);
      if (prefix === null || prefix === undefined) {
        return [config.tag, attrs, 0] as DOMOutputSpec;
      }
      return [config.tag, attrs, prefix, ["div", { class: "kb__inner" }, 0]] as DOMOutputSpec;
    },
  });
}

export const Paragraph = textBlock({
  name: "paragraph",
  tag: "div",
  className: "kb--paragraph",
});

export const Heading1 = textBlock({ name: "heading1", tag: "h1", className: "kb--h1" });
export const Heading2 = textBlock({ name: "heading2", tag: "h2", className: "kb--h2" });
export const Heading3 = textBlock({ name: "heading3", tag: "h3", className: "kb--h3" });

export const BulletedListItem = textBlock({
  name: "bulleted_list_item",
  tag: "div",
  className: "kb--bulleted",
});

export const NumberedListItem = textBlock({
  name: "numbered_list_item",
  tag: "div",
  className: "kb--numbered",
});

export const ToDo = textBlock({
  name: "to_do",
  tag: "div",
  className: "kb--todo",
  attrs: { checked: { default: false } },
  prefix: (attrs) =>
    [
      "span",
      {
        class: `kb__check${attrs["checked"] === true ? " is-checked" : ""}`,
        contenteditable: "false",
        "data-kumi-action": "check",
        role: "checkbox",
        "aria-checked": attrs["checked"] === true ? "true" : "false",
      },
    ] as DOMOutputSpec,
});

export const Toggle = textBlock({
  name: "toggle",
  tag: "div",
  className: "kb--toggle",
  attrs: { collapsed: { default: false } },
  prefix: (attrs) =>
    [
      "span",
      {
        class: `kb__caret${attrs["collapsed"] === true ? " is-collapsed" : ""}`,
        contenteditable: "false",
        "data-kumi-action": "collapse",
        role: "button",
        "aria-expanded": attrs["collapsed"] === true ? "false" : "true",
      },
      "▸",
    ] as DOMOutputSpec,
});

export const Quote = textBlock({ name: "quote", tag: "blockquote", className: "kb--quote" });

export const Callout = textBlock({
  name: "callout",
  tag: "div",
  className: "kb--callout",
  attrs: { icon: { default: "💡" } },
  prefix: (attrs) =>
    [
      "span",
      { class: "kb__icon", contenteditable: "false", "data-kumi-action": "icon" },
      typeof attrs["icon"] === "string" && attrs["icon"] !== "" ? attrs["icon"] : "💡",
    ] as DOMOutputSpec,
});

/* ------------------------------------------------------------- atom blocks */

export const CodeBlock = Node.create({
  name: "code",
  group: BLOCK_GROUPS,
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  isolating: true,

  addAttributes() {
    return { ...blockAttributes, language: { default: "plain text" } };
  },

  parseHTML() {
    return [{ tag: 'div[data-kumi="code"]', preserveWhitespace: "full" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const language = typeof node.attrs["language"] === "string" ? node.attrs["language"] : "plain text";
    return [
      "div",
      base("code", "kb--code", HTMLAttributes),
      [
        "div",
        { class: "kb__codebar", contenteditable: "false" },
        ["button", { class: "kb__lang", type: "button", "data-kumi-action": "language" }, language],
        ["button", { class: "kb__copy", type: "button", "data-kumi-action": "copy" }, "Copy"],
      ],
      ["pre", { class: "kb__pre" }, ["code", { class: "kb__code" }, 0]],
    ] as DOMOutputSpec;
  },
});

export const Divider = Node.create({
  name: "divider",
  group: BLOCK_GROUPS,
  atom: true,
  selectable: true,

  addAttributes() {
    return { ...blockAttributes };
  },

  parseHTML() {
    return [{ tag: 'div[data-kumi="divider"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", base("divider", "kb--divider", HTMLAttributes), ["hr"]] as DOMOutputSpec;
  },
});

/**
 * Any block type Phase 2 cannot render yet. It carries the original type and
 * payload verbatim so the diff sees no change and nothing is ever destroyed by
 * simply opening the page.
 */
export const UnsupportedBlock = Node.create({
  name: UNSUPPORTED_NODE,
  group: BLOCK_GROUPS,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ...blockAttributes,
      kumiType: { default: "paragraph" },
      payload: { default: {} },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-kumi="${UNSUPPORTED_NODE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const type = typeof node.attrs["kumiType"] === "string" ? node.attrs["kumiType"] : "block";
    return [
      "div",
      base(UNSUPPORTED_NODE, "kb--unsupported", HTMLAttributes),
      ["span", { class: "kb__badge" }, type.replace(/_/g, " ")],
      ["span", {}, "This block arrives in a later phase. Its content is preserved."],
    ] as DOMOutputSpec;
  },
});

/* ------------------------------------------------------ Phase 3 atom blocks */

/**
 * Display math. The stored payload is the TeX source (`payload.expression`);
 * the rendered output is produced by KaTeX in the node view and never persisted.
 */
export const EquationBlock = Node.create({
  name: "equation",
  group: BLOCK_GROUPS,
  atom: true,
  selectable: true,

  addAttributes() {
    return { ...blockAttributes, expression: { default: "" } };
  },

  parseHTML() {
    return [{ tag: 'div[data-kumi="equation"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const expression = typeof node.attrs["expression"] === "string" ? node.attrs["expression"] : "";
    return ["div", base("equation", "kb--equation", HTMLAttributes), expression] as DOMOutputSpec;
  },

  addNodeView() {
    return equationBlockNodeView;
  },
});

interface MediaConfig {
  name: "image" | "file" | "video" | "audio";
  className: string;
}

/**
 * image / file / video / audio.
 *
 * All four share one shape — an asset reference plus a caption — and differ
 * only in how the node view presents them, so they share one node factory.
 * `width` is a fraction of the content column so a resized image keeps its
 * proportions when the page switches to full width.
 */
function mediaBlock(config: MediaConfig): Node {
  return Node.create({
    name: config.name,
    group: BLOCK_GROUPS,
    atom: true,
    selectable: true,

    addAttributes() {
      return {
        ...blockAttributes,
        assetId: { default: null },
        /** Kumi `RichText`, or null when the block has never had a caption. */
        caption: { default: null },
        /** Fraction of the content width, 0.1–1. */
        width: { default: null },
      };
    },

    parseHTML() {
      return [{ tag: `div[data-kumi="${config.name}"]` }];
    },

    renderHTML({ HTMLAttributes }) {
      return [
        "div",
        base(config.name, config.className, HTMLAttributes),
        MEDIA_PROMPT[config.name] ?? "",
      ] as DOMOutputSpec;
    },

    addNodeView() {
      return mediaNodeView;
    },
  });
}

export const ImageBlock = mediaBlock({ name: "image", className: "kb--image" });
export const FileBlock = mediaBlock({ name: "file", className: "kb--file" });
export const VideoBlock = mediaBlock({ name: "video", className: "kb--video" });
export const AudioBlock = mediaBlock({ name: "audio", className: "kb--audio" });

/** The Notion bookmark card. Metadata is cached in the payload for offline use. */
export const Bookmark = Node.create({
  name: "bookmark",
  group: BLOCK_GROUPS,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      ...blockAttributes,
      url: { default: null },
      title: { default: null },
      description: { default: null },
      favicon: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-kumi="bookmark"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const url = typeof node.attrs["url"] === "string" ? node.attrs["url"] : "";
    return ["div", base("bookmark", "kb--bookmark", HTMLAttributes), url] as DOMOutputSpec;
  },

  addNodeView() {
    return bookmarkNodeView;
  },
});

export const Embed = Node.create({
  name: "embed",
  group: BLOCK_GROUPS,
  atom: true,
  selectable: true,

  addAttributes() {
    return { ...blockAttributes, url: { default: null } };
  },

  parseHTML() {
    return [{ tag: 'div[data-kumi="embed"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const url = typeof node.attrs["url"] === "string" ? node.attrs["url"] : "";
    return ["div", base("embed", "kb--embed", HTMLAttributes), url] as DOMOutputSpec;
  },

  addNodeView() {
    return embedNodeView;
  },
});

/* ---------------------------------------------------------------- columns */

/**
 * The only nested construct in the document. A column holds a *flat* run of
 * ordinary blocks — the same depth-carrying model as the page root — and
 * `colblock` membership is what stops a column layout nesting inside a column.
 */
export const ColumnList = Node.create({
  name: COLUMN_LIST,
  group: "block",
  // One column is transiently legal so a column can be emptied and dissolved;
  // `dissolveColumns` restores the "at least two" invariant in the same tick.
  content: `${COLUMN}+`,
  defining: true,

  addAttributes() {
    return { ...blockAttributes };
  },

  parseHTML() {
    return [{ tag: `div[data-kumi="${COLUMN_LIST}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      base(COLUMN_LIST, "kb--columns", HTMLAttributes),
      ["div", { class: "kcols" }, 0],
    ] as DOMOutputSpec;
  },

  addNodeView() {
    return columnListNodeView;
  },
});

export const Column = Node.create({
  name: COLUMN,
  // `*` rather than `+`: a column that loses its last block must be
  // representable for one tick so `dissolveColumns` can remove it.
  content: "colblock*",
  isolating: true,

  addAttributes() {
    return {
      blockId: blockAttributes.blockId,
      widthRatio: {
        default: null,
        parseHTML: (element: HTMLElement): number | null => {
          const raw = element.getAttribute("data-width-ratio");
          const value = raw === null ? Number.NaN : Number.parseFloat(raw);
          return Number.isFinite(value) ? value : null;
        },
        renderHTML: (attributes: Attrs): Attrs => {
          const ratio = attributes["widthRatio"];
          return typeof ratio === "number" ? { "data-width-ratio": String(ratio) } : {};
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-kumi="${COLUMN}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const ratio = node.attrs["widthRatio"];
    const flex = typeof ratio === "number" && Number.isFinite(ratio) ? ratio : 1;
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-kumi": COLUMN,
        class: "kcol",
        style: `flex-grow:${flex}`,
      }),
      0,
    ] as DOMOutputSpec;
  },
});

/* ------------------------------------------------------------ inline atoms */

export const EquationSpan = Node.create({
  name: EQUATION_SPAN,
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { expression: { default: "" } };
  },

  parseHTML() {
    return [{ tag: "span[data-kumi-equation]" }];
  },

  renderHTML({ node }) {
    const expression = typeof node.attrs["expression"] === "string" ? node.attrs["expression"] : "";
    return ["span", { class: "kt-equation", "data-kumi-equation": expression }, expression] as DOMOutputSpec;
  },

  addNodeView() {
    return equationSpanNodeView;
  },
});

export const MentionSpan = Node.create({
  name: MENTION_SPAN,
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return { mention: { default: null } };
  },

  parseHTML() {
    return [{ tag: "span[data-kumi-mention]" }];
  },

  renderHTML({ node }) {
    const mention = node.attrs["mention"] as { kind?: string; start?: string } | null;
    const label =
      mention?.kind === "date" ? (mention.start ?? "date") : mention?.kind === "page" ? "↗ page" : "mention";
    return ["span", { class: "kt-mention", "data-kumi-mention": "true" }, label] as DOMOutputSpec;
  },

  addNodeView() {
    return mentionSpanNodeView;
  },
});

/* -------------------------------------------------------------------- mark */

/** Notion's colour annotation: one name covering text and `_background` variants. */
export const KumiColor = Mark.create({
  name: COLOR_MARK,

  addAttributes() {
    return { color: { default: "default" } };
  },

  parseHTML() {
    return [{ tag: "span[data-kumi-color]" }];
  },

  renderHTML({ HTMLAttributes }) {
    const color = HTMLAttributes["color"];
    const name = typeof color === "string" && color !== "" ? color : "default";
    return ["span", { class: `kt-${name}`, "data-kumi-color": name }, 0] as DOMOutputSpec;
  },
});
