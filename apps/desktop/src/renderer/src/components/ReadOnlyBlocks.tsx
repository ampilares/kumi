/**
 * A non-editable render of a block tree.
 *
 * Two callers need to show blocks that are not "the page you are editing": the
 * version-history preview and the PDF print route. Both reuse the real editor
 * schema and node views — a snapshot must look exactly like the page it came
 * from, so re-implementing the renderer would be the one thing guaranteed to
 * make it lie.
 */
import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Content } from "@tiptap/core";
import type { Block } from "@kumi/core";
import { blocksToDoc, emptyDoc } from "../lib/blockSync";
import { kumiExtensions } from "../editor/extensions";

export function ReadOnlyBlocks({ blocks }: { blocks: Block[] }): JSX.Element | null {
  const editor = useEditor({
    extensions: kumiExtensions({}),
    editable: false,
    content: emptyDoc() as unknown as Content,
    editorProps: { attributes: { class: "kumi-doc" } },
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.commands.setContent(blocksToDoc(blocks) as unknown as Content, { emitUpdate: false });
  }, [editor, blocks]);

  if (!editor) return null;
  return (
    <div className="readonly-doc">
      <EditorContent editor={editor} />
    </div>
  );
}
