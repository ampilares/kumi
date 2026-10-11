/**
 * The "@" mention menu (and Notion's `[[` alias).
 *
 * Structurally identical to the slash menu: the ProseMirror plugin owns open /
 * query / highlighted-row state so keyboard handling happens ahead of the block
 * keymap, and React only renders it. The *results* are asynchronous, though, so
 * the search itself lives in the React component and the plugin only needs to
 * know how many rows are currently on screen — reported back through a meta.
 */

import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { MENTION_SPAN } from "../lib/richText";
import { primePage } from "../lib/pageCache";

/** How the menu was opened — it decides how much text to replace on accept. */
export type MentionTrigger = "@" | "[[";

export interface MentionState {
  active: boolean;
  /** Position of the trigger's first character. */
  from: number;
  trigger: MentionTrigger;
  query: string;
  index: number;
  /** Row count reported by the React list, so arrow keys can wrap correctly. */
  count: number;
}

const CLOSED: MentionState = {
  active: false,
  from: 0,
  trigger: "@",
  query: "",
  index: 0,
  count: 0,
};

export const mentionKey = new PluginKey<MentionState>("kumiMention");

export function getMentionState(state: EditorState): MentionState {
  return mentionKey.getState(state) ?? CLOSED;
}

const MAX_QUERY = 48;

interface MentionMeta {
  close?: boolean;
  index?: number;
  count?: number;
}

function meta(tr: Transaction): MentionMeta | undefined {
  return tr.getMeta(mentionKey) as MentionMeta | undefined;
}

/** The trigger immediately before `head`, if the caret just completed one. */
function triggerAt(state: EditorState, head: number): { from: number; trigger: MentionTrigger } | null {
  const two = state.doc.textBetween(Math.max(0, head - 2), head, "\n", "\n");
  if (two === "[[") return { from: head - 2, trigger: "[[" };

  const one = state.doc.textBetween(Math.max(0, head - 1), head, "\n", "\n");
  if (one !== "@") return null;
  const resolved = state.doc.resolve(head);
  const before = state.doc.textBetween(Math.max(0, head - 2), head - 1, "\n", "\n");
  // Notion only opens the menu at a word boundary, so an email never triggers it.
  if (resolved.parentOffset > 1 && !/\s/.test(before)) return null;
  return { from: head - 1, trigger: "@" };
}

/** Replace the trigger + query with a page mention chip. */
export function applyMention(
  editor: Editor,
  page: { id: string; title: string; icon: string | null },
): void {
  const state = editor.state;
  const mention = getMentionState(state);
  const type = state.schema.nodes[MENTION_SPAN];
  if (!type) return;

  primePage(page);
  const tr = state.tr;
  const from = mention.active ? mention.from : state.selection.from;
  const to = Math.max(from, state.selection.head);
  tr.replaceWith(from, to, [
    type.create({ mention: { kind: "page", pageId: page.id } }),
    state.schema.text(" "),
  ]);
  tr.setMeta(mentionKey, { close: true });
  editor.view.dispatch(tr);
  editor.view.focus();
}

export function closeMentionMenu(editor: Editor): void {
  editor.view.dispatch(editor.state.tr.setMeta(mentionKey, { close: true }));
}

export const KumiMentionMenu = Extension.create({
  name: "kumiMentionMenu",
  // Same band as the slash menu: ahead of the block keymap.
  priority: 199,

  addProseMirrorPlugins() {
    return [
      new Plugin<MentionState>({
        key: mentionKey,

        state: {
          init: () => CLOSED,
          apply(tr, previous, _oldState, newState) {
            const info = meta(tr);
            if (info?.close === true) return CLOSED;

            if (previous.active) {
              const from = tr.mapping.map(previous.from, -1);
              const head = newState.selection.head;
              const triggerLength = previous.trigger.length;
              if (!newState.selection.empty || head < from + triggerLength) return CLOSED;
              const typed = newState.doc.textBetween(from, from + triggerLength, "\n", "\n");
              if (typed !== previous.trigger) return CLOSED;
              const query = newState.doc.textBetween(from + triggerLength, head, "\n", "\n");
              if (query.includes("\n") || query.length > MAX_QUERY) return CLOSED;
              const count = info?.count ?? previous.count;
              const index = Math.max(0, Math.min(info?.index ?? previous.index, Math.max(0, count - 1)));
              return { ...previous, from, query, index, count };
            }

            if (!tr.docChanged || !newState.selection.empty) return CLOSED;
            const head = newState.selection.head;
            if (newState.doc.resolve(head).parent.type.spec.code === true) return CLOSED;
            const found = triggerAt(newState, head);
            if (!found) return CLOSED;
            return {
              active: true,
              from: found.from,
              trigger: found.trigger,
              query: "",
              index: 0,
              count: 0,
            };
          },
        },

        props: {
          handleKeyDown: (view, event) => {
            const mention = getMentionState(view.state);
            if (!mention.active) return false;

            if (event.key === "Escape") {
              view.dispatch(view.state.tr.setMeta(mentionKey, { close: true }));
              return true;
            }
            if (mention.count === 0) return false;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              const delta = event.key === "ArrowDown" ? 1 : -1;
              const index = (mention.index + delta + mention.count) % mention.count;
              view.dispatch(view.state.tr.setMeta(mentionKey, { index }));
              return true;
            }
            // Enter/Tab are accepted by the React list, which owns the results.
            if (event.key === "Enter" || event.key === "Tab") {
              view.dom.dispatchEvent(new CustomEvent("kumi:mention-accept", { bubbles: true }));
              return true;
            }
            return false;
          },
        },
      }),
    ];
  },
});

export const MENTION_ACCEPT_EVENT = "kumi:mention-accept";
