// @vitest-environment jsdom
/**
 * Regression: when useAsync's deps change, the stale previous result must
 * never be observable as {data, loading: false} for the new deps. App.tsx
 * treats "data === null && !loading" as "page missing → go Home"; a single
 * stale frame bounced every first navigation out of Home back to Home in the
 * packaged app (fresh installs boot to Home, so the app looked entirely
 * broken).
 */
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAsync } from "./hooks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Frame {
  dep: string | null;
  data: unknown;
  loading: boolean;
}

const frames: Frame[] = [];

function Probe({ dep }: { dep: string | null }): null {
  const state = useAsync(
    () => (dep ? pending(dep) : Promise.resolve(null)),
    [dep],
    false,
  );
  // Record committed frames only — App's Home-fallback is an effect, so a
  // render that React discards (render-phase state adjustment) can never
  // trigger it. Recording in the render body would count discarded frames.
  useEffect(() => {
    frames.push({ dep, data: state.data, loading: state.loading });
  });
  return null;
}

const resolvers = new Map<string, (v: unknown) => void>();
function pending(key: string): Promise<unknown> {
  return new Promise((resolve) => resolvers.set(key, resolve));
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  frames.length = 0;
  resolvers.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useAsync dep changes", () => {
  it("never exposes the previous result as settled for new deps", async () => {
    // Mount with a null dep — resolves to null, settles as {null, loading:false}.
    await act(async () => {
      root.render(<Probe dep={null} />);
    });
    expect(frames.at(-1)).toMatchObject({ dep: null, data: null, loading: false });

    // Navigate: dep becomes "page-1" whose fetch stays pending.
    await act(async () => {
      root.render(<Probe dep="page-1" />);
    });

    // No frame for the new dep may report settled-null before its fetch lands.
    const staleFrames = frames.filter(
      (f) => f.dep === "page-1" && f.data === null && !f.loading,
    );
    expect(staleFrames).toEqual([]);
    expect(frames.at(-1)).toMatchObject({ dep: "page-1", loading: true, data: undefined });

    // Fetch resolves → data arrives, loading ends.
    await act(async () => {
      resolvers.get("page-1")!({ id: "page-1" });
      await Promise.resolve();
    });
    expect(frames.at(-1)).toMatchObject({
      dep: "page-1",
      data: { id: "page-1" },
      loading: false,
    });
  });
});
