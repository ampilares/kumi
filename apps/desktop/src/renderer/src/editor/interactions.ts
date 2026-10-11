/**
 * Clicks on the non-editable furniture inside blocks: the to-do checkbox, the
 * toggle caret, and the code block's language and copy buttons.
 *
 * Everything is handled on `mousedown` with `preventDefault` so the caret never
 * moves — Notion's checkboxes do not steal focus. Actions that need a React
 * surface (the language picker, the callout icon picker) are re-emitted as DOM
 * CustomEvents that the editor container listens for.
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { setBlockAttrs } from "./blockCommands";
import { parsePageHref } from "./marks";
import { useUi } from "../store";

export const CODE_LANGUAGE_EVENT = "kumi:code-language";
export const CALLOUT_ICON_EVENT = "kumi:callout-icon";

/**
 * One event for every Phase 3 node view that needs a React surface: the
 * equation editor, the media file picker and the bookmark/embed URL prompt.
 */
export const BLOCK_EDIT_EVENT = "kumi:block-edit";

export type BlockEditKind = "equation" | "media" | "url" | "database" | "page";

export interface BlockEditDetail {
  pos: number;
  kind: BlockEditKind;
  /** Current value: the TeX source, the media kind, or the URL. */
  value: string;
  nodeType: string;
  rect: DOMRect;
}

export interface BlockAnchorDetail {
  pos: number;
  value: string;
  rect: DOMRect;
}

/**
 * Position of the block node containing `element` — at any nesting level, so
 * the code and callout controls work inside a column too.
 */
function blockPosOf(view: EditorView, element: HTMLElement): number | null {
  const wrapper = element.closest(".kb");
  if (!(wrapper instanceof HTMLElement)) return null;
  try {
    const inside = view.posAtDOM(wrapper, 0);
    const resolved = view.state.doc.resolve(Math.min(Math.max(inside, 0), view.state.doc.content.size));
    return resolved.depth >= 1 ? resolved.before(resolved.depth) : null;
  } catch {
    return null;
  }
}

export const KumiInteractions = Extension.create({
  name: "kumiInteractions",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("kumiInteractions"),
        props: {
          handleDOMEvents: {
            /**
             * Ctrl/Cmd-click (or a plain click in a locked page) follows a link:
             * `kumi://page/<id>` navigates in-app, anything else is handed to
             * the OS by the window's open handler.
             */
            click: (view, event) => {
              const target = event.target;
              if (!(target instanceof HTMLElement)) return false;
              const anchor = target.closest("a[href]");
              if (!(anchor instanceof HTMLAnchorElement)) return false;
              if (view.editable && !(event.ctrlKey || event.metaKey)) return false;
              event.preventDefault();
              const href = anchor.getAttribute("href") ?? "";
              const pageId = parsePageHref(href);
              if (pageId !== null) {
                useUi.getState().openPage(pageId);
                return true;
              }
              if (/^https?:/i.test(href)) window.open(href, "_blank", "noopener");
              return true;
            },

            mousedown: (view, event) => {
              const target = event.target;
              if (!(target instanceof HTMLElement)) return false;
              const control = target.closest("[data-kumi-action]");
              if (!(control instanceof HTMLElement)) return false;
              const action = control.dataset["kumiAction"];
              const pos = blockPosOf(view, control);
              if (pos === null) return false;
              const node = view.state.doc.nodeAt(pos);
              if (!node) return false;

              event.preventDefault();
              event.stopPropagation();

              if (action === "check" && view.editable) {
                setBlockAttrs(pos, { checked: node.attrs["checked"] !== true })(
                  view.state,
                  view.dispatch,
                );
                return true;
              }
              if (action === "collapse") {
                setBlockAttrs(pos, { collapsed: node.attrs["collapsed"] !== true })(
                  view.state,
                  view.dispatch,
                );
                return true;
              }
              if (action === "copy") {
                void navigator.clipboard?.writeText(node.textContent);
                control.textContent = "Copied";
                window.setTimeout(() => {
                  control.textContent = "Copy";
                }, 1200);
                return true;
              }
              if (action === "language" || action === "icon") {
                const detail: BlockAnchorDetail = {
                  pos,
                  value: String(node.attrs[action === "language" ? "language" : "icon"] ?? ""),
                  rect: control.getBoundingClientRect(),
                };
                view.dom.dispatchEvent(
                  new CustomEvent<BlockAnchorDetail>(
                    action === "language" ? CODE_LANGUAGE_EVENT : CALLOUT_ICON_EVENT,
                    { detail, bubbles: true },
                  ),
                );
                return true;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
