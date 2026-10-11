/**
 * The URL prompt shared by bookmark and embed blocks.
 *
 * Deliberately forgiving about what counts as a URL — `normalizeUrl` upgrades
 * `example.com` to `https://example.com`, so pasting from an address bar and
 * typing a bare host both work.
 */

import { useEffect, useRef, useState } from "react";
import { normalizeUrl } from "./marks";

export function UrlPrompt({
  initial,
  kind,
  onCommit,
  onCancel,
}: {
  initial: string;
  kind: "bookmark" | "embed";
  onCommit(url: string): void;
  onCancel(): void;
}): JSX.Element {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const href = normalizeUrl(value);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = (): void => {
    if (href === null) return;
    onCommit(href);
  };

  return (
    <div className="urlprompt">
      <input
        ref={inputRef}
        className="field"
        placeholder={kind === "embed" ? "Paste a YouTube or web link…" : "Paste a link…"}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
          event.stopPropagation();
        }}
      />
      <div className="urlprompt__foot">
        <span className="eqedit__hint">
          {kind === "embed" ? "YouTube links become a player." : "Kumi fetches the title and icon."}
        </span>
        <button type="button" className="btn btn--primary" disabled={href === null} onClick={commit}>
          {kind === "embed" ? "Embed link" : "Create bookmark"}
        </button>
      </div>
    </div>
  );
}
