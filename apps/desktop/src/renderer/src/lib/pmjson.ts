/**
 * The plain-JSON shape of a ProseMirror document.
 *
 * The sync layer works on JSON rather than live `Node` instances so that it is
 * pure, testable without a DOM, and independent of the TipTap schema module.
 */

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  marks?: PmMark[];
  text?: string;
}

export interface PmDoc {
  type: "doc";
  content?: PmNode[];
}

/** Order-insensitive structural equality for JSON-ish values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && deepEqual(ra[k], rb[k]));
}

/** Reads a string attribute, falling back when absent or of the wrong type. */
export function strAttr(node: PmNode, key: string, fallback: string | null = null): string | null {
  const value = node.attrs?.[key];
  return typeof value === "string" ? value : fallback;
}

/** Reads a numeric attribute, falling back when absent or of the wrong type. */
export function numAttr(node: PmNode, key: string, fallback = 0): number {
  const value = node.attrs?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Reads a boolean attribute, falling back when absent or of the wrong type. */
export function boolAttr(node: PmNode, key: string, fallback = false): boolean {
  const value = node.attrs?.[key];
  return typeof value === "boolean" ? value : fallback;
}
