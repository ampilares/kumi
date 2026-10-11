/**
 * @vitest-environment jsdom
 *
 * Cell commit shapes.
 *
 * The value a cell hands back is what `setPropertyValues` receives verbatim, so
 * these assertions are the renderer's half of the type contract: a mismatched
 * variant is rejected by core rather than coerced, and a wrong shape here would
 * only ever show up as a red toast at runtime.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PropertyDef, PropertyValue } from "@kumi/core";
import { PropertyCell } from "./Cells";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function property(over: Partial<PropertyDef> & Pick<PropertyDef, "id" | "type">): PropertyDef {
  return {
    dataSourceId: "ds",
    name: over.name ?? over.id,
    config: over.config ?? {},
    rank: "a0",
    ...over,
  };
}

function render(
  prop: PropertyDef,
  value: PropertyValue,
  onCommit: (next: PropertyValue | null) => void,
): void {
  act(() => {
    root.render(
      <PropertyCell property={prop} value={value} editable onCommit={onCommit} />,
    );
  });
}

function input(): HTMLInputElement {
  const el = container.querySelector("input");
  if (!el) throw new Error("no input rendered");
  return el;
}

/**
 * Type into the cell the way a user does: focus, change, blur.
 * React delegates focus through `focusin`/`focusout`, not the non-bubbling
 * `focus`/`blur`, so those are the events the synthetic handlers actually see.
 */
function typeAndBlur(text: string): void {
  const el = input();
  act(() => {
    el.focus();
    el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  });
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

describe("PropertyCell commits", () => {
  it("a text cell commits single-span rich text", () => {
    const onCommit = vi.fn();
    render(property({ id: "p", type: "text" }), { type: "text", richText: [] }, onCommit);
    typeAndBlur("hello");
    expect(onCommit).toHaveBeenCalledWith({
      type: "text",
      richText: [{ type: "text", text: "hello" }],
    });
  });

  it("clearing a text cell commits an empty rich text, not null", () => {
    const onCommit = vi.fn();
    render(
      property({ id: "p", type: "text" }),
      { type: "text", richText: [{ type: "text", text: "old" }] },
      onCommit,
    );
    typeAndBlur("");
    expect(onCommit).toHaveBeenCalledWith({ type: "text", richText: [] });
  });

  it("a number cell parses grouped input and clears on nonsense", () => {
    const onCommit = vi.fn();
    const prop = property({ id: "p", type: "number", config: { numberFormat: "dollar" } });
    render(prop, { type: "number", number: null }, onCommit);
    typeAndBlur("1,234");
    expect(onCommit).toHaveBeenCalledWith({ type: "number", number: 1234 });

    onCommit.mockClear();
    render(prop, { type: "number", number: 5 }, onCommit);
    typeAndBlur("oops");
    expect(onCommit).toHaveBeenCalledWith({ type: "number", number: null });
  });

  it("a number cell shows the formatted value while it is not focused", () => {
    render(
      property({ id: "p", type: "number", config: { numberFormat: "dollar" } }),
      { type: "number", number: 1234 },
      vi.fn(),
    );
    expect(input().value).toBe("$1,234");
  });

  it("a url cell commits null when emptied and a string otherwise", () => {
    const onCommit = vi.fn();
    const prop = property({ id: "p", type: "url" });
    render(prop, { type: "url", value: null }, onCommit);
    typeAndBlur("kumi.test");
    expect(onCommit).toHaveBeenCalledWith({ type: "url", value: "kumi.test" });

    onCommit.mockClear();
    render(prop, { type: "url", value: "kumi.test" }, onCommit);
    typeAndBlur("");
    expect(onCommit).toHaveBeenCalledWith({ type: "url", value: null });
  });

  it("a checkbox commits the new checked state", () => {
    const onCommit = vi.fn();
    render(
      property({ id: "p", type: "checkbox" }),
      { type: "checkbox", checked: false },
      onCommit,
    );
    const box = input();
    act(() => {
      box.click();
    });
    expect(onCommit).toHaveBeenCalledWith({ type: "checkbox", checked: true });
  });

  it("an unchanged cell commits nothing on blur", () => {
    const onCommit = vi.fn();
    render(
      property({ id: "p", type: "text" }),
      { type: "text", richText: [{ type: "text", text: "same" }] },
      onCommit,
    );
    typeAndBlur("same");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("a read-only cell never edits", () => {
    const onCommit = vi.fn();
    act(() => {
      root.render(
        <PropertyCell
          property={property({ id: "p", type: "text" })}
          value={{ type: "text", richText: [] }}
          editable={false}
          onCommit={onCommit}
        />,
      );
    });
    expect(input().readOnly).toBe(true);
  });
});
