/**
 * The TeX editor popover.
 *
 * A textarea over a live KaTeX preview — the same shape Notion uses, and the
 * reason the equation node stores its *source* rather than rendered output:
 * what you type is what is persisted, and the render is always derived.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { renderMath } from "./nodeViews";

export function EquationEditor({
  initial,
  display,
  onCommit,
  onCancel,
}: {
  initial: string;
  /** Block equations render centred; inline ones render in text size. */
  display: boolean;
  onCommit(expression: string): void;
  onCancel(): void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useLayoutEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    if (value.trim() === "") {
      preview.textContent = "";
      return;
    }
    renderMath(preview, value, display);
  }, [value, display]);

  return (
    <div className="eqedit">
      <div ref={previewRef} className="eqedit__preview" aria-live="polite" />
      <textarea
        ref={inputRef}
        className="eqedit__input"
        rows={3}
        spellCheck={false}
        placeholder="E = mc^2"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onCommit(value);
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          event.stopPropagation();
        }}
      />
      <div className="eqedit__foot">
        <span className="eqedit__hint">TeX — Enter to save, Shift+Enter for a new line</span>
        <button type="button" className="btn btn--primary" onClick={() => onCommit(value)}>
          Done
        </button>
      </div>
    </div>
  );
}
