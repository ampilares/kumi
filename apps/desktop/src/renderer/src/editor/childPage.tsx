/**
 * The `child_page` block — a sub-page embedded in its parent, Notion's `/page`.
 *
 * The node stores only the reference (`pageId`); the title and icon are
 * resolved live through the page cache so a rename elsewhere updates the row
 * without touching the block. Deleting the block does NOT delete the page —
 * it remains reachable through the sidebar tree and search (Notion parity for
 * removing the *link*; the page itself is trashed from the tree or top bar).
 */
import { useSyncExternalStore } from "react";
import { Node } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { cachedPage, ensurePage, onPageCacheChange, type PageStub } from "../lib/pageCache";
import { useUi } from "../store";
import { blockAttributes } from "./schema";

export const CHILD_PAGE = "child_page";

function usePageStub(pageId: string | null): PageStub | undefined {
  const stub = useSyncExternalStore(onPageCacheChange, () =>
    pageId ? cachedPage(pageId) : undefined,
  );
  if (pageId && !stub) void ensurePage(pageId);
  return stub;
}

function ChildPageComponent({ node }: NodeViewProps): JSX.Element {
  const pageId = typeof node.attrs["pageId"] === "string" ? node.attrs["pageId"] : null;
  const openPage = useUi((s) => s.openPage);
  const stub = usePageStub(pageId);

  const creating = pageId === null;
  const missing = stub?.missing === true;
  const title = creating ? "Untitled" : (stub?.title ?? "…");

  return (
    <NodeViewWrapper
      className="kb kb--childpage"
      data-kumi={CHILD_PAGE}
      data-block-id={typeof node.attrs["blockId"] === "string" ? node.attrs["blockId"] : undefined}
      data-depth={String(node.attrs["depth"] ?? 0)}
      contentEditable={false}
    >
      <button
        type="button"
        className={`childpage${missing ? " is-missing" : ""}`}
        disabled={creating || missing}
        onClick={() => {
          if (pageId) openPage(pageId);
        }}
        title={missing ? "This page is in the trash or was deleted" : undefined}
      >
        <span className="childpage__icon">{stub?.icon ?? "📄"}</span>
        <span className="childpage__title">{missing ? "Deleted page" : title || "Untitled"}</span>
      </button>
    </NodeViewWrapper>
  );
}

export const ChildPage = Node.create({
  name: CHILD_PAGE,
  group: "block colblock",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      ...blockAttributes,
      pageId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute("data-page-id"),
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs["pageId"] === "string" ? { "data-page-id": attrs["pageId"] } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-kumi="${CHILD_PAGE}"]` }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", { "data-kumi": CHILD_PAGE, ...HTMLAttributes }];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChildPageComponent);
  },
});
