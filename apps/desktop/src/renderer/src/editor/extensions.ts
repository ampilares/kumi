/**
 * The full extension list for a Kumi page editor.
 *
 * Composed by hand rather than from StarterKit: StarterKit ships ProseMirror's
 * own list/heading/blockquote nodes, which would give the document a second,
 * competing block model.
 */

import { Extension } from "@tiptap/core";
import Bold from "@tiptap/extension-bold";
import Code from "@tiptap/extension-code";
import Italic from "@tiptap/extension-italic";
import Link from "@tiptap/extension-link";
import Strike from "@tiptap/extension-strike";
import Text from "@tiptap/extension-text";
import Underline from "@tiptap/extension-underline";
import { Dropcursor, Gapcursor, Placeholder, UndoRedo } from "@tiptap/extensions";
import {
  AudioBlock,
  Bookmark,
  BulletedListItem,
  Callout,
  CodeBlock,
  Column,
  ColumnList,
  Divider,
  Embed,
  EquationBlock,
  EquationSpan,
  FileBlock,
  Heading1,
  Heading2,
  Heading3,
  ImageBlock,
  KumiColor,
  KumiDocument,
  MentionSpan,
  NumberedListItem,
  Paragraph,
  Quote,
  ToDo,
  Toggle,
  UnsupportedBlock,
  VideoBlock,
} from "./schema";
import { ChildDatabase } from "./childDatabase";
import { ChildPage } from "./childPage";
import { KumiStructure } from "./structure";
import { KumiKeymap, type KumiKeymapOptions } from "./keymap";
import { KumiInputRules, singleTildeStrike } from "./inputRules";
import { KumiSlashMenu } from "./slash";
import { KumiMentionMenu } from "./mention";
import { KumiBlockSelection } from "./selection";
import { KumiInteractions } from "./interactions";
import { KumiPasteDrop } from "./pasteDrop";
import { KumiHighlight } from "./highlight";
import { CODE_MARK } from "../lib/richText";

export const EMPTY_PLACEHOLDER = "Write something, or press '/' for commands";

/** Renamed so it does not collide with the `code` block node. */
const InlineCode = Code.extend({ name: CODE_MARK });

const KumiStrike = Strike.extend({
  addInputRules() {
    const parent = this.parent?.() ?? [];
    return [...parent, singleTildeStrike(this.type)];
  },
});

export function kumiExtensions(options: KumiKeymapOptions): Extension[] {
  return [
    KumiDocument,
    Text,
    Paragraph,
    Heading1,
    Heading2,
    Heading3,
    BulletedListItem,
    NumberedListItem,
    ToDo,
    Toggle,
    Quote,
    Callout,
    CodeBlock,
    Divider,
    EquationBlock,
    ImageBlock,
    FileBlock,
    VideoBlock,
    AudioBlock,
    Bookmark,
    Embed,
    ColumnList,
    Column,
    ChildDatabase,
    ChildPage,
    UnsupportedBlock,
    EquationSpan,
    MentionSpan,

    Bold,
    Italic,
    Underline,
    KumiStrike,
    InlineCode,
    KumiColor,
    Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: "kt-link" } }),

    UndoRedo,
    Dropcursor.configure({ color: "var(--accent)", width: 2 }),
    Gapcursor,
    Placeholder.configure({
      placeholder: ({ node }) => (node.type.name === "paragraph" ? EMPTY_PLACEHOLDER : ""),
      showOnlyCurrent: true,
      emptyEditorClass: "is-editor-empty",
      emptyNodeClass: "is-empty",
    }),

    KumiStructure,
    KumiSlashMenu,
    KumiMentionMenu,
    KumiBlockSelection,
    KumiInputRules,
    KumiInteractions,
    KumiPasteDrop,
    KumiHighlight,
    KumiKeymap.configure(options),
  ] as unknown as Extension[];
}
