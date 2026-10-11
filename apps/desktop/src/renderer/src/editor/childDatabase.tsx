/**
 * The `child_database` block — an inline database on a page.
 *
 * Unlike the Phase 3 atoms this one *is* a React node view: the surface it
 * renders is an entire application panel (tabs, menus, a peek modal), so
 * handing it to React is the cheap option, whereas the media blocks own their
 * DOM precisely because React would fight their pointer capture.
 *
 * The node stores only a reference (`dataSourceId` + `activeViewId`). Deleting
 * the block therefore deletes nothing: the data source stays in the workspace
 * and can be re-embedded, exactly as Notion behaves.
 */

import { Node, mergeAttributes } from "@tiptap/core";
import type { DOMOutputSpec } from "@tiptap/pm/model";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { DatabaseView } from "../database/DatabaseView";
import { useUi } from "../store";
import { blockAttributes } from "./schema";

export const CHILD_DATABASE = "child_database";

function ChildDatabaseComponent({ node, editor, getPos, deleteNode }: NodeViewProps): JSX.Element {
  const dataSourceId = typeof node.attrs["dataSourceId"] === "string" ? node.attrs["dataSourceId"] : null;
  const activeViewId = typeof node.attrs["activeViewId"] === "string" ? node.attrs["activeViewId"] : null;
  const openDatabase = useUi((s) => s.openDatabase);

  const setActiveView = (viewId: string): void => {
    const pos = getPos();
    if (typeof pos !== "number") return;
    const { state, view } = editor;
    const current = state.doc.nodeAt(pos);
    if (!current) return;
    view.dispatch(
      state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, activeViewId: viewId }),
    );
  };

  return (
    <NodeViewWrapper
      className="kb kb--database"
      data-kumi={CHILD_DATABASE}
      data-block-id={typeof node.attrs["blockId"] === "string" ? node.attrs["blockId"] : undefined}
      data-depth={String(node.attrs["depth"] ?? 0)}
      contentEditable={false}
    >
      {dataSourceId === null ? (
        <div className="db db--loading">
          <div className="skeleton" style={{ width: 160, height: 20, marginBottom: 12 }} />
          <div className="skeleton" style={{ width: "100%", height: 72 }} />
        </div>
      ) : (
        <DatabaseView
          dataSourceId={dataSourceId}
          activeViewId={activeViewId}
          onActiveViewChange={setActiveView}
          presentation="inline"
          onExpand={() => openDatabase(dataSourceId)}
          onRemoveBlock={() => deleteNode()}
        />
      )}
    </NodeViewWrapper>
  );
}

export const ChildDatabase = Node.create({
  name: CHILD_DATABASE,
  group: "block colblock",
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      ...blockAttributes,
      dataSourceId: { default: null },
      activeViewId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: `div[data-kumi="${CHILD_DATABASE}"]` }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = node.attrs["dataSourceId"];
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-kumi": CHILD_DATABASE, class: "kb kb--database" }),
      typeof id === "string" ? id : "",
    ] as DOMOutputSpec;
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChildDatabaseComponent);
  },
});
