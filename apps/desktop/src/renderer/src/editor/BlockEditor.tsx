/**
 * The page body editor.
 *
 * Owns three things:
 *   1. the TipTap instance and its Kumi schema;
 *   2. the persistence loop — debounced diff → `applyBlockOps`, optimistic
 *      mirror of server state, rebuild only on a real conflict, and never a
 *      `setContent` while the user is typing (the caret must not move);
 *   3. the block chrome that lives outside the document: hover gutter with
 *      `+` and `⠿`, the block menu, drag-reorder with a drop indicator (which
 *      in Phase 3 also creates column layouts), the slash and mention panels,
 *      the formatting toolbar, and the pickers for code, callouts, equations,
 *      media and URLs.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Content, Editor } from "@tiptap/core";
import type { Block } from "@kumi/core";
import { commands, fetchUrlMeta, importAssets, type MediaKind } from "../ipc";
import { useUi } from "../store";
import { cx } from "../utils";
import { EmojiPicker, MenuItem, MenuLabel, MenuSeparator, Popover } from "../components/ui";
import { applyOpsLocally, blocksToDoc, docToOps, emptyDoc } from "../lib/blockSync";
import type { PmDoc } from "../lib/pmjson";
import { BLOCK_TYPE_INFO } from "../lib/blockTypes";
import { kumiExtensions } from "./extensions";
import { SlashMenu } from "./SlashMenu";
import { MentionMenu } from "./MentionMenu";
import { SelectionToolbar } from "./SelectionToolbar";
import { PasteMenu } from "./PasteMenu";
import { EquationEditor } from "./EquationEditor";
import { UrlPrompt } from "./UrlPrompt";
import {
  deleteBlock,
  duplicateBlock,
  insertParagraphAfter,
  insertParagraphAfterBlock,
  moveSubtreeInto,
  setBlockAttrs,
  turnBlockInto,
  type Cmd,
} from "./blockCommands";
import { createColumnsFromDrop } from "./columns";
import { allBlocks, findBlockPos, type LocatedBlock } from "./doc";
import {
  BLOCK_EDIT_EVENT,
  CALLOUT_ICON_EVENT,
  CODE_LANGUAGE_EVENT,
  type BlockAnchorDetail,
  type BlockEditDetail,
} from "./interactions";
import { CODE_LANGUAGES } from "./highlight";

const SAVE_DEBOUNCE_MS = 300;
/** Fraction of a block's width that counts as "drop here to make columns". */
const COLUMN_DROP_ZONE = 0.28;

export interface BlockEditorHandle {
  /** Put the caret in the first block — used by Enter from the page title. */
  focusStart(): void;
  /** Persist anything outstanding right now. */
  flush(): Promise<void>;
}

interface Props {
  pageId: string;
  editable: boolean;
  /** Backspace at the start of the first block hands focus back to the title. */
  onLeaveTop?: () => void;
}

interface HoverState {
  blockId: string;
  top: number;
  left: number;
}

interface DragState {
  /** Horizontal bar before a block, or a vertical bar that makes columns. */
  mode: "before" | "column";
  top: number;
  left: number;
  width: number;
  height: number;
}

interface PickerState {
  kind: "language" | "icon";
  pos: number;
  rect: DOMRect;
}

/** A pending drop, resolved into a command at pointer-up. */
interface DropPlan {
  mode: "before" | "column";
  targetBlockId: string;
  containerPos: number | null;
  index: number;
  side: "left" | "right";
}

export const BlockEditor = forwardRef<BlockEditorHandle, Props>(function BlockEditor(
  { pageId, editable, onLeaveTop },
  ref,
): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const mirror = useRef<Block[]>([]);
  const dirty = useRef(false);
  const saving = useRef(false);
  const queued = useRef(false);
  const timer = useRef<number | null>(null);
  const seenRevision = useRef<number | null>(null);

  const [loading, setLoading] = useState(true);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [menuBlockId, setMenuBlockId] = useState<string | null>(null);
  const [turnIntoOpen, setTurnIntoOpen] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [picker, setPicker] = useState<PickerState | null>(null);
  const [blockEdit, setBlockEdit] = useState<BlockEditDetail | null>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const pickerAnchor = useRef<HTMLSpanElement>(null);
  const editAnchor = useRef<HTMLSpanElement>(null);

  const revision = useUi((s) => s.revision);

  /* ------------------------------------------------------------- loading */

  const load = useCallback(async (): Promise<void> => {
    const blocks = await commands.getBlocks(pageId);
    mirror.current = blocks;
    const editor = editorRef.current;
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(blocksToDoc(blocks) as unknown as Content, { emitUpdate: false });
    }
    setLoading(false);
  }, [pageId]);

  /* --------------------------------------------------------- persistence */

  const flush = useCallback(async (): Promise<void> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const editor = editorRef.current;
    if (!editor || editor.isDestroyed || !editable) {
      dirty.current = false;
      return;
    }
    if (saving.current) {
      queued.current = true;
      return;
    }

    const doc = editor.getJSON() as PmDoc;
    const ops = docToOps(mirror.current, doc, pageId);
    dirty.current = false;
    if (ops.length === 0) return;

    saving.current = true;
    // Optimistic: the mirror advances before the round trip so a keystroke
    // landing mid-flight diffs against the state the server is about to have.
    mirror.current = applyOpsLocally(mirror.current, ops);
    try {
      const result = await commands.applyBlockOps(ops);
      if (result.rejected.length > 0) {
        console.warn("[kumi] block ops rejected — rebuilding page from storage", result.rejected);
        await load();
      }
    } catch (error) {
      console.error("[kumi] applyBlockOps failed — rebuilding page from storage", error);
      await load();
    } finally {
      saving.current = false;
      if (queued.current) {
        queued.current = false;
        void flush();
      }
    }
  }, [editable, load, pageId]);

  const schedule = useCallback((): void => {
    dirty.current = true;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
  }, [flush]);

  /* -------------------------------------------------------------- editor */

  const editor = useEditor(
    {
      extensions: kumiExtensions({ onLeaveTop }),
      editable,
      content: emptyDoc() as unknown as Content,
      editorProps: { attributes: { class: "kumi-doc" } },
      onUpdate: schedule,
      onBlur: () => {
        void flush();
      },
    },
    [pageId],
  );

  useEffect(() => {
    editorRef.current = editor ?? null;
  }, [editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (!editor) return;
    setLoading(true);
    void load();
  }, [editor, load]);

  // External edits (the CLI, another window) land only when the user is idle.
  useEffect(() => {
    if (seenRevision.current === null) {
      seenRevision.current = revision;
      return;
    }
    if (seenRevision.current === revision) return;
    seenRevision.current = revision;
    const active = editorRef.current;
    if (!active || active.isDestroyed) return;
    if (dirty.current || saving.current || active.isFocused) return;
    void load();
  }, [revision, load]);

  // Flush before the editor is torn down (page switch, navigation, unmount).
  useLayoutEffect(
    () => () => {
      void flush();
    },
    [flush],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusStart: () => editorRef.current?.commands.focus("start"),
      flush,
    }),
    [flush],
  );

  /* -------------------------------------------------------------- gutter */

  /** Every hoverable block, paired with the DOM node rendering it. */
  const blockRefs = useCallback((): Array<LocatedBlock & { el: HTMLElement }> => {
    const active = editorRef.current;
    const dom = active?.view.dom;
    if (!active || !dom) return [];
    const out: Array<LocatedBlock & { el: HTMLElement }> = [];
    for (const block of allBlocks(active.state.doc)) {
      const id = block.node.attrs["blockId"];
      if (typeof id !== "string") continue;
      const el = dom.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
      if (el) out.push({ ...block, el });
    }
    return out;
  }, []);

  const updateHover = useCallback(
    (event: React.MouseEvent): void => {
      // While dragging or with the block menu open the gutter must stay put.
      if (drag || menuBlockId !== null) return;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;

      // Columns carry a block id too, but they are never dragged on their own —
      // the layout that owns them is the draggable unit.
      const node = target.closest<HTMLElement>('[data-block-id]:not([data-kumi="column"])');
      const blockId = node?.dataset["blockId"];
      if (!node || blockId === undefined) {
        setHover(null);
        return;
      }
      const rect = node.getBoundingClientRect();
      const box = wrapper.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      setHover({
        blockId,
        top: rect.top - box.top + Number.parseFloat(style.paddingTop || "0"),
        left: rect.left - box.left,
      });
    },
    [drag, menuBlockId],
  );

  const runCommand = useCallback((cmd: Cmd): void => {
    const active = editorRef.current;
    if (!active || active.isDestroyed) return;
    cmd(active.state, active.view.dispatch);
    active.view.focus();
  }, []);

  /** Doc-level index of a block, or -1 when it lives inside a column. */
  const docIndexOf = useCallback((blockId: string): number => {
    const active = editorRef.current;
    if (!active) return -1;
    let index = -1;
    active.state.doc.forEach((node, _offset, i) => {
      if (node.attrs["blockId"] === blockId) index = i;
    });
    return index;
  }, []);

  /* ---------------------------------------------------------------- drag */

  const onHandlePointerDown = useCallback(
    (event: React.PointerEvent): void => {
      if (!editable || hover === null) return;
      const sourceId = hover.blockId;
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      let moved = false;
      let plan: DropPlan | null = null;

      const compute = (clientX: number, clientY: number): DragState | null => {
        const refs = blockRefs();
        if (refs.length === 0) return null;
        const box = wrapper.getBoundingClientRect();

        // The block the pointer is over, or the last one when past the end.
        let target = refs[refs.length - 1];
        for (const ref of refs) {
          const rect = ref.el.getBoundingClientRect();
          if (clientY < rect.bottom) {
            target = ref;
            break;
          }
        }
        if (!target) return null;
        const rect = target.el.getBoundingClientRect();

        // Right edge of a page-level block: make a two-column layout.
        const columnable =
          target.containerPos === null &&
          target.node.type.name !== "column_list" &&
          docIndexOf(sourceId) >= 0 &&
          target.node.attrs["blockId"] !== sourceId;
        if (columnable && clientX > rect.right - rect.width * COLUMN_DROP_ZONE) {
          plan = {
            mode: "column",
            targetBlockId: String(target.node.attrs["blockId"]),
            containerPos: null,
            index: 0,
            side: "right",
          };
          return {
            mode: "column",
            top: rect.top - box.top,
            left: rect.right - box.left - 1,
            width: 3,
            height: rect.height,
          };
        }

        const after = clientY > rect.top + rect.height / 2;
        plan = {
          mode: "before",
          targetBlockId: String(target.node.attrs["blockId"]),
          containerPos: target.containerPos,
          index: target.index + (after ? 1 : 0),
          side: "right",
        };
        return {
          mode: "before",
          top: (after ? rect.bottom : rect.top) - box.top,
          left: rect.left - box.left,
          width: rect.width,
          height: 2,
        };
      };

      const onMove = (moveEvent: PointerEvent): void => {
        moved = true;
        const next = compute(moveEvent.clientX, moveEvent.clientY);
        if (next) setDrag(next);
      };

      const onUp = (upEvent: PointerEvent): void => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDrag(null);
        if (!moved) {
          setMenuBlockId(sourceId);
          setTurnIntoOpen(false);
          return;
        }
        compute(upEvent.clientX, upEvent.clientY);
        const active = editorRef.current;
        if (!plan || !active || plan.targetBlockId === sourceId) return;

        if (plan.mode === "column") {
          const sourceIndex = docIndexOf(sourceId);
          const targetIndex = docIndexOf(plan.targetBlockId);
          if (sourceIndex < 0 || targetIndex < 0) return;
          runCommand(createColumnsFromDrop(sourceIndex, targetIndex, plan.side));
          return;
        }

        const sourcePos = findBlockPos(active.state.doc, sourceId);
        if (sourcePos === null) return;
        runCommand(moveSubtreeInto(sourcePos, plan.containerPos, plan.index));
      };

      event.preventDefault();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [blockRefs, docIndexOf, editable, hover, runCommand],
  );

  /* ------------------------------------------------------ inline pickers */

  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const open = (kind: PickerState["kind"]) => (event: Event): void => {
      const detail = (event as CustomEvent<BlockAnchorDetail>).detail;
      setPicker({ kind, pos: detail.pos, rect: detail.rect });
    };
    const onLanguage = open("language");
    const onIcon = open("icon");
    const onBlockEdit = (event: Event): void => {
      setBlockEdit((event as CustomEvent<BlockEditDetail>).detail);
    };
    dom.addEventListener(CODE_LANGUAGE_EVENT, onLanguage);
    dom.addEventListener(CALLOUT_ICON_EVENT, onIcon);
    dom.addEventListener(BLOCK_EDIT_EVENT, onBlockEdit);
    return () => {
      dom.removeEventListener(CODE_LANGUAGE_EVENT, onLanguage);
      dom.removeEventListener(CALLOUT_ICON_EVENT, onIcon);
      dom.removeEventListener(BLOCK_EDIT_EVENT, onBlockEdit);
    };
  }, [editor]);

  useLayoutEffect(() => {
    const anchor = pickerAnchor.current;
    if (!anchor || !picker) return;
    anchor.style.top = `${picker.rect.top}px`;
    anchor.style.left = `${picker.rect.left}px`;
    anchor.style.width = `${picker.rect.width}px`;
    anchor.style.height = `${picker.rect.height}px`;
  }, [picker]);

  useLayoutEffect(() => {
    const anchor = editAnchor.current;
    if (!anchor || !blockEdit) return;
    anchor.style.top = `${blockEdit.rect.top}px`;
    anchor.style.left = `${blockEdit.rect.left}px`;
    anchor.style.width = `${blockEdit.rect.width}px`;
    anchor.style.height = `${blockEdit.rect.height}px`;
  }, [blockEdit]);

  /* ------------------------------------------------ media / url handlers */

  // Opening the native picker is a side effect of the event, not a surface.
  useEffect(() => {
    if (!blockEdit || blockEdit.kind !== "media") return;
    const detail = blockEdit;
    setBlockEdit(null);
    const run = async (): Promise<void> => {
      const assets = await importAssets([], detail.value as MediaKind);
      const first = assets[0];
      const active = editorRef.current;
      if (!first || !active || active.isDestroyed) return;
      setBlockAttrs(detail.pos, { assetId: first.id })(active.state, active.view.dispatch);
    };
    void run();
  }, [blockEdit]);

  /**
   * A `/table` insert lands as a bare `child_database` node; the data source is
   * created here, where the owning page id is known, and stamped back onto the
   * node. Deleting the block later never deletes the data source.
   */
  useEffect(() => {
    if (!blockEdit || blockEdit.kind !== "database") return;
    const detail = blockEdit;
    setBlockEdit(null);
    const run = async (): Promise<void> => {
      const active = editorRef.current;
      const existing = active?.state.doc.nodeAt(detail.pos);
      if (existing?.attrs["dataSourceId"] != null) return;
      try {
        const created = await commands.createDataSource(pageId);
        const later = editorRef.current;
        if (!later || later.isDestroyed) return;
        const node = later.state.doc.nodeAt(detail.pos);
        if (!node || node.type.name !== "child_database") return;
        setBlockAttrs(detail.pos, {
          dataSourceId: created.dataSource.id,
          activeViewId: created.views[0]?.id ?? null,
        })(later.state, later.view.dispatch);
      } catch (error) {
        console.error("[kumi] createDataSource failed", error);
      }
    };
    void run();
  }, [blockEdit, pageId]);

  /**
   * A `/page` insert lands as a bare `child_page` node; the sub-page is
   * created here (as a child of the page being edited), stamped back onto the
   * node, and opened immediately — Notion's `/page` behaviour. Deleting the
   * block later never deletes the page.
   */
  useEffect(() => {
    if (!blockEdit || blockEdit.kind !== "page") return;
    const detail = blockEdit;
    setBlockEdit(null);
    const run = async (): Promise<void> => {
      const active = editorRef.current;
      const existing = active?.state.doc.nodeAt(detail.pos);
      if (existing?.attrs["pageId"] != null) return;
      try {
        const created = await commands.createPage({ parentId: pageId, title: "" });
        const later = editorRef.current;
        if (!later || later.isDestroyed) return;
        const node = later.state.doc.nodeAt(detail.pos);
        if (!node || node.type.name !== "child_page") return;
        setBlockAttrs(detail.pos, { pageId: created.id })(later.state, later.view.dispatch);
        // Open the new page immediately — Notion's `/page` drops you straight
        // in. The stamped block is safe: pending ops flush on editor teardown.
        useUi.getState().openPage(created.id);
      } catch (error) {
        console.error("[kumi] createPage for /page failed", error);
      }
    };
    void run();
  }, [blockEdit, pageId]);

  const commitUrl = useCallback(async (pos: number, nodeType: string, url: string): Promise<void> => {
    const active = editorRef.current;
    if (!active || active.isDestroyed) return;
    if (nodeType !== "bookmark") {
      setBlockAttrs(pos, { url })(active.state, active.view.dispatch);
      return;
    }
    // Show the card immediately, then fill in the scraped metadata.
    setBlockAttrs(pos, { url })(active.state, active.view.dispatch);
    const meta = await fetchUrlMeta(url);
    const later = editorRef.current;
    if (!later || later.isDestroyed) return;
    const node = later.state.doc.nodeAt(pos);
    if (!node || node.type.name !== "bookmark" || node.attrs["url"] !== url) return;
    setBlockAttrs(pos, {
      title: meta.title,
      description: meta.description,
      favicon: meta.favicon,
    })(later.state, later.view.dispatch);
  }, []);

  /* -------------------------------------------------------------- render */


  return (
    <div
      className={cx("blocks", loading && "blocks--loading")}
      ref={wrapperRef}
      onMouseMove={updateHover}
      onMouseLeave={() => {
        if (menuBlockId === null && !drag) setHover(null);
      }}
    >
      {loading ? (
        <div className="blocks__skeleton" aria-hidden="true">
          <div className="skeleton" style={{ width: "70%", margin: "12px 0" }} />
          <div className="skeleton" style={{ width: "48%", margin: "12px 0" }} />
        </div>
      ) : null}

      <EditorContent editor={editor} />

      {editable ? (
        <div
          className="blocks__tail"
          role="presentation"
          onClick={() => {
            const active = editorRef.current;
            if (!active || active.isDestroyed) return;
            const last = active.state.doc.childCount - 1;
            const node = active.state.doc.child(Math.max(0, last));
            if (node.isTextblock && node.content.size === 0) {
              active.commands.focus("end");
              return;
            }
            runCommand(insertParagraphAfter(Math.max(0, last), "doc"));
          }}
        />
      ) : null}

      {editable && hover && !loading ? (
        <div className="gutter" style={{ top: hover.top, left: hover.left - 52 }}>
          <button
            type="button"
            className="gutter__btn"
            title="Click to add a block below"
            aria-label="Add block below"
            onClick={() => runCommand(insertParagraphAfterBlock(hover.blockId))}
          >
            +
          </button>
          <button
            ref={handleRef}
            type="button"
            className="gutter__btn gutter__handle"
            title="Drag to move, click to open menu"
            aria-label="Block options"
            onPointerDown={onHandlePointerDown}
          >
            ⠿
          </button>
        </div>
      ) : null}

      {drag ? (
        <div
          className={cx("drop-indicator", drag.mode === "column" && "drop-indicator--column")}
          style={{ top: drag.top, left: drag.left, width: drag.width, height: drag.height }}
        />
      ) : null}

      <Popover
        open={menuBlockId !== null}
        anchorRef={handleRef}
        onClose={() => {
          setMenuBlockId(null);
          setTurnIntoOpen(false);
        }}
        label="Block options"
        width={220}
      >
        {menuBlockId === null ? null : (
          <>
            <MenuItem
              label="Delete"
              hint="Del"
              danger
              onSelect={() => {
                runCommand(deleteBlock(menuBlockId));
                setMenuBlockId(null);
              }}
            />
            <MenuItem
              label="Duplicate"
              hint="Ctrl+D"
              onSelect={() => {
                runCommand(duplicateBlock(menuBlockId));
                setMenuBlockId(null);
              }}
            />
            <MenuItem label="Turn into" hint="▸" onSelect={() => setTurnIntoOpen((open) => !open)} />
            {turnIntoOpen ? (
              <>
                <MenuSeparator />
                <MenuLabel>Turn into</MenuLabel>
                {BLOCK_TYPE_INFO.map((info) => (
                  <MenuItem
                    key={info.type}
                    icon={<span aria-hidden="true">{info.glyph}</span>}
                    label={info.label}
                    onSelect={() => {
                      runCommand(turnBlockInto(menuBlockId, info.type));
                      setMenuBlockId(null);
                      setTurnIntoOpen(false);
                    }}
                  />
                ))}
              </>
            ) : null}
          </>
        )}
      </Popover>

      <span ref={pickerAnchor} className="picker-anchor" aria-hidden="true" />
      <Popover
        open={picker !== null}
        anchorRef={pickerAnchor}
        onClose={() => setPicker(null)}
        label={picker?.kind === "icon" ? "Callout icon" : "Code language"}
        width={picker?.kind === "icon" ? 286 : 200}
      >
        {picker === null ? null : picker.kind === "icon" ? (
          <EmojiPicker
            onPick={(emoji) => {
              runCommand(setBlockAttrs(picker.pos, { icon: emoji }));
              setPicker(null);
            }}
          />
        ) : (
          <div className="lang-list">
            {CODE_LANGUAGES.map((language) => (
              <MenuItem
                key={language}
                label={language}
                onSelect={() => {
                  runCommand(setBlockAttrs(picker.pos, { language }));
                  setPicker(null);
                }}
              />
            ))}
          </div>
        )}
      </Popover>

      <span ref={editAnchor} className="picker-anchor" aria-hidden="true" />
      <Popover
        open={blockEdit !== null && blockEdit.kind === "equation"}
        anchorRef={editAnchor}
        onClose={() => setBlockEdit(null)}
        label="Equation"
        width={420}
      >
        {blockEdit === null || blockEdit.kind !== "equation" ? null : (
          <EquationEditor
            initial={blockEdit.value}
            display={blockEdit.nodeType === "equation"}
            onCommit={(expression) => {
              runCommand(setBlockAttrs(blockEdit.pos, { expression }));
              setBlockEdit(null);
            }}
            onCancel={() => setBlockEdit(null)}
          />
        )}
      </Popover>

      <Popover
        open={blockEdit !== null && blockEdit.kind === "url"}
        anchorRef={editAnchor}
        onClose={() => setBlockEdit(null)}
        label={blockEdit?.nodeType === "embed" ? "Embed link" : "Bookmark link"}
        width={360}
      >
        {blockEdit === null || blockEdit.kind !== "url" ? null : (
          <UrlPrompt
            initial={blockEdit.value}
            kind={blockEdit.nodeType === "embed" ? "embed" : "bookmark"}
            onCommit={(url) => {
              const detail = blockEdit;
              setBlockEdit(null);
              void commitUrl(detail.pos, detail.nodeType, url);
            }}
            onCancel={() => setBlockEdit(null)}
          />
        )}
      </Popover>

      <SlashMenu editor={editor} />
      <MentionMenu editor={editor} />
      <SelectionToolbar editor={editor} />
      <PasteMenu editor={editor} onBookmark={commitUrl} />
    </div>
  );
});
