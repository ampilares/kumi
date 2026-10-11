/**
 * Node views for the Phase 3 blocks.
 *
 * These are plain ProseMirror node views rather than React ones: a media block
 * has to survive ProseMirror re-rendering it mid-drag (the resize handles keep
 * pointer capture) and has to keep a `contenteditable` caption whose caret must
 * not be reset by an unrelated document change. Owning the DOM directly makes
 * both of those a matter of *not* touching a node, which is far harder to
 * express through a React reconciler.
 *
 * Anything needing a React surface (the equation editor, the URL prompt, the
 * file picker) is re-emitted as a DOM CustomEvent that `BlockEditor` listens
 * for — the same pattern the code-language and callout-icon pickers already use.
 */

import katex from "katex";
import type { Editor } from "@tiptap/core";
import type { Node as PmNode } from "@tiptap/pm/model";
import type { Decoration, NodeView } from "@tiptap/pm/view";
import type { RichText } from "@kumi/core";
import { assetUrl, commands, openAsset } from "../ipc";
import { plainText } from "../lib/richText";
import { MEDIA_PROMPT } from "../lib/blockTypes";
import { cachedPage, ensurePage, onPageCacheChange } from "../lib/pageCache";
import { displayTitle } from "../utils";
import { useUi } from "../store";
import { COLUMN_LIST as COLUMN_LIST_NAME } from "../lib/blockSync";
import { setColumnRatios } from "./columns";
import { BLOCK_EDIT_EVENT, type BlockEditDetail, type BlockEditKind } from "./interactions";

/** What TipTap hands a node view factory. Narrowed to what we actually use. */
export interface NodeViewProps {
  editor: Editor;
  node: PmNode;
  getPos: (() => number | undefined) | boolean;
  decorations?: readonly Decoration[];
}

/* ----------------------------------------------------------------- helpers */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function resolvePos(getPos: NodeViewProps["getPos"]): number | null {
  if (typeof getPos !== "function") return null;
  const pos = getPos();
  return typeof pos === "number" ? pos : null;
}

/** Patch the node's own attributes through a transaction, never in place. */
function setAttrs(props: NodeViewProps, attrs: Record<string, unknown>): void {
  const pos = resolvePos(props.getPos);
  if (pos === null) return;
  const { state, dispatch } = props.editor.view;
  const node = state.doc.nodeAt(pos);
  if (!node) return;
  dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
}

function emitEdit(props: NodeViewProps, kind: BlockEditKind, value: string, anchor: Element): void {
  const pos = resolvePos(props.getPos);
  if (pos === null) return;
  const detail: BlockEditDetail = {
    pos,
    kind,
    value,
    nodeType: props.node.type.name,
    rect: anchor.getBoundingClientRect(),
  };
  props.editor.view.dom.dispatchEvent(
    new CustomEvent<BlockEditDetail>(BLOCK_EDIT_EVENT, { detail, bubbles: true }),
  );
}

function stringAttr(node: PmNode, key: string): string {
  const value = node.attrs[key];
  return typeof value === "string" ? value : "";
}

/** Keep the wrapper's block chrome (gutter hit-testing, indent, decorations). */
function syncBlockAttrs(dom: HTMLElement, node: PmNode): void {
  const id = node.attrs["blockId"];
  if (typeof id === "string") dom.dataset["blockId"] = id;
  else delete dom.dataset["blockId"];
  dom.dataset["depth"] = String(node.attrs["depth"] ?? 0);
}

/* ---------------------------------------------------------------- KaTeX */

export function renderMath(target: HTMLElement, expression: string, displayMode: boolean): void {
  if (expression.trim() === "") {
    target.textContent = "";
    return;
  }
  try {
    katex.render(expression, target, {
      displayMode,
      throwOnError: false,
      errorColor: "var(--danger)",
      output: "html",
      strict: false,
    });
  } catch {
    // KaTeX only throws for a genuinely broken environment; show the source.
    target.textContent = expression;
  }
}

/* ------------------------------------------------------------- equations */

export function equationBlockNodeView(props: NodeViewProps): NodeView {
  const dom = el("div", "kb kb--equation");
  dom.dataset["kumi"] = "equation";
  const math = el("div", "kb__math");
  math.contentEditable = "false";
  dom.append(math);

  const render = (node: PmNode): void => {
    syncBlockAttrs(dom, node);
    const expression = stringAttr(node, "expression");
    dom.classList.toggle("is-empty-math", expression.trim() === "");
    if (expression.trim() === "") {
      math.textContent = "Add a TeX equation";
      return;
    }
    renderMath(math, expression, true);
  };

  dom.addEventListener("mousedown", (event) => {
    if (!props.editor.isEditable) return;
    event.preventDefault();
    emitEdit(props, "equation", stringAttr(props.node, "expression"), dom);
  });

  render(props.node);
  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: () => true,
    update(node) {
      if (node.type.name !== "equation") return false;
      props.node = node;
      render(node);
      return true;
    },
  };
}

export function equationSpanNodeView(props: NodeViewProps): NodeView {
  const dom = el("span", "kt-equation");
  dom.dataset["kumiEquation"] = "true";
  dom.contentEditable = "false";

  const render = (node: PmNode): void => {
    const expression = stringAttr(node, "expression");
    if (expression.trim() === "") {
      dom.textContent = "𝑥";
      dom.classList.add("is-empty-math");
      return;
    }
    dom.classList.remove("is-empty-math");
    renderMath(dom, expression, false);
  };

  dom.addEventListener("mousedown", (event) => {
    if (!props.editor.isEditable) return;
    event.preventDefault();
    event.stopPropagation();
    emitEdit(props, "equation", stringAttr(props.node, "expression"), dom);
  });

  render(props.node);
  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: () => true,
    update(node) {
      if (node.type.name !== props.node.type.name) return false;
      props.node = node;
      render(node);
      return true;
    },
  };
}

/* -------------------------------------------------------------- mentions */

interface MentionValue {
  kind?: string;
  pageId?: string;
  start?: string;
  end?: string;
}

export function mentionSpanNodeView(props: NodeViewProps): NodeView {
  const dom = el("span", "kt-mention");
  dom.dataset["kumiMention"] = "true";
  dom.contentEditable = "false";
  dom.setAttribute("role", "link");
  dom.tabIndex = 0;

  const icon = el("span", "kt-mention__icon");
  const label = el("span", "kt-mention__label");
  dom.append(icon, label);

  let unsubscribe: (() => void) | null = null;

  const render = (node: PmNode): void => {
    const mention = (node.attrs["mention"] ?? null) as MentionValue | null;
    if (mention?.kind === "date") {
      dom.dataset["mentionKind"] = "date";
      icon.textContent = "📅";
      label.textContent = mention.end ? `${mention.start} → ${mention.end}` : (mention.start ?? "");
      return;
    }
    if (mention?.kind !== "page" || typeof mention.pageId !== "string") {
      dom.dataset["mentionKind"] = "unknown";
      icon.textContent = "";
      label.textContent = "mention";
      return;
    }

    dom.dataset["mentionKind"] = "page";
    const pageId = mention.pageId;
    const stub = cachedPage(pageId);
    icon.textContent = stub?.icon ?? "📄";
    label.textContent = stub ? displayTitle(stub.title) : "…";
    dom.classList.toggle("is-missing", stub?.missing === true);
    if (!stub) void ensurePage(pageId);
  };

  dom.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  dom.addEventListener("click", (event) => {
    event.preventDefault();
    const mention = (props.node.attrs["mention"] ?? null) as MentionValue | null;
    if (mention?.kind === "page" && typeof mention.pageId === "string") {
      useUi.getState().openPage(mention.pageId);
    }
  });

  render(props.node);
  unsubscribe = onPageCacheChange(() => render(props.node));

  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: () => true,
    update(node) {
      if (node.type.name !== props.node.type.name) return false;
      props.node = node;
      render(node);
      return true;
    },
    destroy() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

/* ----------------------------------------------------------------- media */

const CAPTION_DEBOUNCE_MS = 400;

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function captionText(node: PmNode): string {
  const caption = node.attrs["caption"];
  return Array.isArray(caption) ? plainText(caption as RichText) : "";
}

export function mediaNodeView(props: NodeViewProps): NodeView {
  const kind = props.node.type.name as "image" | "file" | "video" | "audio";
  const dom = el("div", `kb kb--media kb--${kind}`);
  dom.dataset["kumi"] = kind;

  const frame = el("div", "media__frame");
  const caption = el("div", "media__caption");
  caption.contentEditable = "true";
  caption.dataset["placeholder"] = "Write a caption…";
  caption.dataset["kumiUi"] = "caption";
  dom.append(frame, caption);

  let captionTimer: number | null = null;
  let renderedAsset: string | null = null;
  let destroyed = false;

  /* ------------------------------------------------------------- resize */

  const attachHandles = (target: HTMLElement): void => {
    for (const side of ["left", "right"] as const) {
      const handle = el("div", `media__handle media__handle--${side}`);
      handle.dataset["kumiUi"] = "resize";
      handle.addEventListener("pointerdown", (event) => {
        if (!props.editor.isEditable) return;
        event.preventDefault();
        event.stopPropagation();
        const container = dom.clientWidth || 1;
        const startWidth = target.getBoundingClientRect().width;
        const startX = event.clientX;
        dom.classList.add("is-resizing");

        const onMove = (move: PointerEvent): void => {
          const delta = (move.clientX - startX) * (side === "left" ? -1 : 1);
          // Notion resizes symmetrically around the centre of a centred image.
          const next = Math.min(container, Math.max(80, startWidth + delta * 2));
          target.style.width = `${(next / container) * 100}%`;
        };
        const onUp = (): void => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          dom.classList.remove("is-resizing");
          const ratio = target.getBoundingClientRect().width / container;
          setAttrs(props, { width: Math.min(1, Math.max(0.1, Number(ratio.toFixed(3)))) });
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
      });
      target.append(handle);
    }
  };

  const applyWidth = (target: HTMLElement, node: PmNode): void => {
    const width = node.attrs["width"];
    target.style.width =
      typeof width === "number" && Number.isFinite(width) ? `${Math.min(1, width) * 100}%` : "";
  };

  /* ------------------------------------------------------------ content */

  const placeholder = (): HTMLElement => {
    const card = el("button", "media__placeholder");
    card.type = "button";
    card.dataset["kumiUi"] = "placeholder";
    card.append(
      el("span", "media__placeholder-glyph", kind === "image" ? "🖼" : kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "📎"),
      el("span", "media__placeholder-label", MEDIA_PROMPT[kind] ?? "Add a file"),
    );
    card.addEventListener("click", (event) => {
      event.preventDefault();
      if (!props.editor.isEditable) return;
      emitEdit(props, "media", kind, card);
    });
    return card;
  };

  const fileCard = (assetId: string): HTMLElement => {
    const card = el("button", "media__file");
    card.type = "button";
    card.dataset["kumiUi"] = "file";
    const name = el("span", "media__file-name", "Loading…");
    const meta = el("span", "media__file-meta");
    card.append(el("span", "media__file-glyph", "📎"), name, meta);
    void commands
      .getAsset(assetId)
      .then((asset) => {
        if (destroyed || !asset) return;
        // `path` is relative to the workspace assets/ directory.
        name.textContent = asset.path.split(/[\\/]/).pop() ?? "File";
        meta.textContent = formatSize(asset.size);
      })
      .catch(() => {
        name.textContent = "Missing file";
      });
    card.addEventListener("click", (event) => {
      event.preventDefault();
      void openAsset(assetId);
    });
    return card;
  };

  const buildContent = (node: PmNode): void => {
    frame.replaceChildren();
    const assetId = stringAttr(node, "assetId");
    if (assetId === "") {
      frame.style.width = "";
      frame.append(placeholder());
      return;
    }

    const src = assetUrl(assetId);
    if (kind === "image") {
      const img = el("img", "media__img");
      img.src = src;
      img.alt = captionText(node);
      img.draggable = false;
      frame.append(img);
      applyWidth(frame, node);
      attachHandles(frame);
      return;
    }
    if (kind === "video") {
      const video = el("video", "media__video");
      video.src = src;
      video.controls = true;
      video.preload = "metadata";
      video.dataset["kumiUi"] = "player";
      frame.append(video);
      applyWidth(frame, node);
      attachHandles(frame);
      return;
    }
    if (kind === "audio") {
      const audio = el("audio", "media__audio");
      audio.src = src;
      audio.controls = true;
      audio.preload = "metadata";
      audio.dataset["kumiUi"] = "player";
      frame.append(audio);
      return;
    }
    frame.style.width = "";
    frame.append(fileCard(assetId));
  };

  const render = (node: PmNode, previous: PmNode | null): void => {
    syncBlockAttrs(dom, node);
    const assetId = stringAttr(node, "assetId");
    dom.classList.toggle("is-empty-media", assetId === "");

    if (previous === null || assetId !== renderedAsset) {
      renderedAsset = assetId;
      buildContent(node);
    } else if (frame.firstElementChild) {
      applyWidth(frame, node);
    }

    const text = captionText(node);
    dom.classList.toggle("has-caption", text !== "");
    // Never rewrite the caption the user is typing in — that would move the caret.
    if (document.activeElement !== caption && caption.textContent !== text) {
      caption.textContent = text;
    }
  };

  const commitCaption = (): void => {
    const text = caption.textContent ?? "";
    const value: RichText | null = text === "" ? null : [{ type: "text", text }];
    setAttrs(props, { caption: value });
  };

  caption.addEventListener("input", () => {
    if (captionTimer !== null) window.clearTimeout(captionTimer);
    captionTimer = window.setTimeout(() => {
      captionTimer = null;
      commitCaption();
    }, CAPTION_DEBOUNCE_MS);
  });
  caption.addEventListener("blur", () => {
    if (captionTimer !== null) {
      window.clearTimeout(captionTimer);
      captionTimer = null;
    }
    commitCaption();
  });
  caption.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      caption.blur();
    }
    event.stopPropagation();
  });

  render(props.node, null);
  caption.contentEditable = props.editor.isEditable ? "true" : "false";

  return {
    dom,
    ignoreMutation: () => true,
    /**
     * Only our own chrome swallows events — a bare click on the frame still
     * reaches ProseMirror so the block can be selected and dragged.
     */
    stopEvent: (event) => {
      const target = event.target;
      return target instanceof Element && target.closest("[data-kumi-ui]") !== null;
    },
    update(node) {
      if (node.type.name !== kind) return false;
      const previous = props.node;
      props.node = node;
      caption.contentEditable = props.editor.isEditable ? "true" : "false";
      render(node, previous);
      return true;
    },
    destroy() {
      destroyed = true;
      if (captionTimer !== null) window.clearTimeout(captionTimer);
    },
  };
}

/* --------------------------------------------------------------- columns */

/** Notion's gutter between columns; also the grab area for the divider. */
const COLUMN_GUTTER = 46;

export function columnListNodeView(props: NodeViewProps): NodeView {
  const dom = el("div", "kb kb--columns");
  dom.dataset["kumi"] = "column_list";
  const content = el("div", "kcols");
  const dividers = el("div", "kcols__dividers");
  dividers.contentEditable = "false";
  dividers.dataset["kumiUi"] = "dividers";
  dom.append(content, dividers);

  let frame = 0;
  let observer: ResizeObserver | null = null;

  const columnElements = (): HTMLElement[] =>
    Array.from(content.children).filter((child): child is HTMLElement => child instanceof HTMLElement);

  /** Live flex ratios read off the DOM, so a drag starts from what is on screen. */
  const currentRatios = (columns: HTMLElement[]): number[] => {
    const widths = columns.map((column) => column.getBoundingClientRect().width);
    const total = widths.reduce((sum, width) => sum + width, 0);
    if (total <= 0) return columns.map(() => 1 / Math.max(1, columns.length));
    return widths.map((width) => width / total);
  };

  const startDrag = (index: number, event: PointerEvent): void => {
    if (!props.editor.isEditable) return;
    event.preventDefault();
    event.stopPropagation();
    const columns = columnElements();
    const left = columns[index];
    const right = columns[index + 1];
    if (!left || !right) return;

    const ratios = currentRatios(columns);
    const startX = event.clientX;
    const total = content.getBoundingClientRect().width || 1;
    const pairShare = (ratios[index] ?? 0) + (ratios[index + 1] ?? 0);
    const startLeft = ratios[index] ?? 0;
    dom.classList.add("is-resizing");

    const onMove = (move: PointerEvent): void => {
      const delta = (move.clientX - startX) / total;
      // Neither side may collapse: Notion clamps a column to 10% of the row.
      const nextLeft = Math.min(pairShare - 0.1, Math.max(0.1, startLeft + delta));
      left.style.flexGrow = String(nextLeft);
      right.style.flexGrow = String(pairShare - nextLeft);
      place();
    };
    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      dom.classList.remove("is-resizing");
      const pos = resolvePos(props.getPos);
      if (pos === null) return;
      const { state, dispatch } = props.editor.view;
      setColumnRatios(pos, currentRatios(columnElements()))(state, dispatch);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  /** Re-measure the divider positions; cheap, and always one frame behind. */
  const place = (): void => {
    const columns = columnElements();
    const wanted = Math.max(0, columns.length - 1);
    while (dividers.childElementCount > wanted) dividers.lastElementChild?.remove();
    while (dividers.childElementCount < wanted) {
      const handle = el("div", "kcols__divider");
      handle.dataset["kumiUi"] = "divider";
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      const index = dividers.childElementCount;
      handle.addEventListener("pointerdown", (event) => startDrag(index, event));
      dividers.append(handle);
    }
    const box = dom.getBoundingClientRect();
    Array.from(dividers.children).forEach((handle, index) => {
      const next = columns[index + 1];
      if (!(handle instanceof HTMLElement) || !next) return;
      const rect = next.getBoundingClientRect();
      handle.style.left = `${rect.left - box.left - COLUMN_GUTTER / 2}px`;
    });
  };

  const schedule = (): void => {
    if (frame !== 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };

  syncBlockAttrs(dom, props.node);
  schedule();
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(schedule);
    observer.observe(content);
  }

  return {
    dom,
    contentDOM: content,
    ignoreMutation: (mutation) =>
      mutation.target === dividers || dividers.contains(mutation.target as globalThis.Node),
    stopEvent: (event) => {
      const target = event.target;
      return target instanceof Element && target.closest('[data-kumi-ui="divider"]') !== null;
    },
    update(node) {
      if (node.type.name !== COLUMN_LIST_NAME) return false;
      props.node = node;
      syncBlockAttrs(dom, node);
      schedule();
      return true;
    },
    destroy() {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      observer = null;
    },
  };
}

/* -------------------------------------------------------------- bookmark */

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function bookmarkNodeView(props: NodeViewProps): NodeView {
  const dom = el("div", "kb kb--bookmark");
  dom.dataset["kumi"] = "bookmark";
  const card = el("div", "bookmark");
  card.dataset["kumiUi"] = "bookmark";
  const text = el("div", "bookmark__text");
  const title = el("div", "bookmark__title");
  const description = el("div", "bookmark__desc");
  const source = el("div", "bookmark__source");
  const favicon = el("img", "bookmark__favicon");
  const host = el("span", "bookmark__host");
  source.append(favicon, host);
  text.append(title, description, source);
  card.append(text);
  dom.append(card);

  favicon.addEventListener("error", () => {
    favicon.style.display = "none";
  });

  const render = (node: PmNode): void => {
    syncBlockAttrs(dom, node);
    const url = stringAttr(node, "url");
    dom.classList.toggle("is-empty-bookmark", url === "");
    if (url === "") {
      title.textContent = "Add a web bookmark";
      description.textContent = "";
      source.style.display = "none";
      return;
    }
    source.style.display = "";
    title.textContent = stringAttr(node, "title") || hostOf(url);
    const desc = stringAttr(node, "description");
    description.textContent = desc;
    description.style.display = desc === "" ? "none" : "";
    host.textContent = hostOf(url);
    const icon = stringAttr(node, "favicon");
    if (icon === "") {
      favicon.style.display = "none";
    } else {
      favicon.style.display = "";
      favicon.src = icon;
    }
  };

  card.addEventListener("click", (event) => {
    event.preventDefault();
    const url = stringAttr(props.node, "url");
    if (url === "") {
      if (props.editor.isEditable) emitEdit(props, "url", "", card);
      return;
    }
    window.open(url, "_blank", "noopener");
  });

  render(props.node);
  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: (event) => {
      const target = event.target;
      return target instanceof Element && target.closest("[data-kumi-ui]") !== null;
    },
    update(node) {
      if (node.type.name !== "bookmark") return false;
      props.node = node;
      render(node);
      return true;
    },
  };
}

/* ----------------------------------------------------------------- embed */

/** YouTube watch/short/share URLs → the privacy-preserving embed player. */
export function embedSrc(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const host = url.hostname.replace(/^www\./, "");
  let videoId: string | null = null;
  if (host === "youtu.be") videoId = url.pathname.slice(1);
  else if (host.endsWith("youtube.com")) {
    if (url.pathname === "/watch") videoId = url.searchParams.get("v");
    else if (url.pathname.startsWith("/embed/")) videoId = url.pathname.slice("/embed/".length);
    else if (url.pathname.startsWith("/shorts/")) videoId = url.pathname.slice("/shorts/".length);
  }
  if (videoId !== null && videoId !== "") {
    const start = url.searchParams.get("t");
    const suffix = start !== null ? `?start=${Number.parseInt(start, 10) || 0}` : "";
    return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}${suffix}`;
  }
  return url.toString();
}

export function embedNodeView(props: NodeViewProps): NodeView {
  const dom = el("div", "kb kb--embed");
  dom.dataset["kumi"] = "embed";
  const frame = el("div", "embed__frame");
  dom.append(frame);

  const render = (node: PmNode): void => {
    syncBlockAttrs(dom, node);
    const url = stringAttr(node, "url");
    const src = url === "" ? null : embedSrc(url);
    dom.classList.toggle("is-empty-embed", src === null);
    frame.replaceChildren();
    if (src === null) {
      const prompt = el("button", "media__placeholder");
      prompt.type = "button";
      prompt.dataset["kumiUi"] = "placeholder";
      prompt.append(
        el("span", "media__placeholder-glyph", "▶"),
        el("span", "media__placeholder-label", "Add an embed link"),
      );
      prompt.addEventListener("click", (event) => {
        event.preventDefault();
        if (props.editor.isEditable) emitEdit(props, "url", url, prompt);
      });
      frame.append(prompt);
      return;
    }
    const iframe = el("iframe", "embed__iframe");
    iframe.src = src;
    iframe.allow = "accelerometer; encrypted-media; picture-in-picture; fullscreen";
    iframe.referrerPolicy = "no-referrer";
    iframe.dataset["kumiUi"] = "iframe";
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
    frame.append(iframe);
  };

  render(props.node);
  return {
    dom,
    ignoreMutation: () => true,
    stopEvent: (event) => {
      const target = event.target;
      return target instanceof Element && target.closest("[data-kumi-ui]") !== null;
    },
    update(node) {
      if (node.type.name !== "embed") return false;
      props.node = node;
      render(node);
      return true;
    },
  };
}
