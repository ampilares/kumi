import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openWorkspace, type Workspace } from "../src";

const opened: { ws: Workspace; dir: string }[] = [];

export interface TestWorkspace extends Workspace {
  dir: string;
}

/** Open a throwaway workspace in a temp directory. */
export function tempWorkspace(): TestWorkspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumi-test-"));
  const ws = openWorkspace(dir);
  opened.push({ ws, dir });
  return Object.assign(ws, { dir });
}

/** Close every workspace opened by this file and remove its temp directory. */
export function cleanupWorkspaces(): void {
  while (opened.length > 0) {
    const entry = opened.pop();
    if (entry === undefined) continue;
    entry.ws.close();
    fs.rmSync(entry.dir, { recursive: true, force: true });
  }
}

/** Deterministic PRNG so property-style tests are reproducible. */
export function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
