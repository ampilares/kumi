import { afterAll, describe, expect, it } from "vitest";
import { KumiError, openWorkspace, type KumiCommands } from "../src";
import { cleanupWorkspaces, tempWorkspace } from "./helpers";

afterAll(cleanupWorkspaces);

function ws(): KumiCommands {
  return tempWorkspace().commands;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof KumiError ? error.code : `unexpected:${String(error)}`;
  }
  return "no-throw";
}

describe("user state", () => {
  it("starts empty with the system theme", () => {
    expect(ws().getUserState()).toEqual({
      favorites: [],
      recents: [],
      expandedPageIds: [],
      theme: "system",
    });
  });

  it("adds and removes favorites in insertion order", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    const d = c.createPage({ title: "D" });

    expect(c.setFavorite(a.id, true).favorites).toEqual([a.id]);
    c.setFavorite(b.id, true);
    expect(c.setFavorite(d.id, true).favorites).toEqual([a.id, b.id, d.id]);
    // Re-favoriting is not a duplicate.
    expect(c.setFavorite(b.id, true).favorites).toEqual([a.id, d.id, b.id]);
    expect(c.setFavorite(b.id, false).favorites).toEqual([a.id, d.id]);
    expect(c.setFavorite(b.id, false).favorites).toEqual([a.id, d.id]);
    expect(codeOf(() => c.setFavorite("missing", true))).toBe("not_found");
  });

  it("reorders favorites explicitly", () => {
    const c = ws();
    const ids = ["A", "B", "C"].map((t) => c.createPage({ title: t }).id);
    for (const id of ids) c.setFavorite(id, true);

    expect(c.reorderFavorite(ids[2] ?? "", null).favorites).toEqual([
      ids[2],
      ids[0],
      ids[1],
    ]);
    expect(c.reorderFavorite(ids[2] ?? "", ids[0] ?? "").favorites).toEqual([
      ids[0],
      ids[2],
      ids[1],
    ]);
    expect(codeOf(() => c.reorderFavorite("missing", null))).toBe("invalid");
    expect(codeOf(() => c.reorderFavorite(ids[0] ?? "", "missing"))).toBe("invalid");
  });

  it("hides trashed pages from favorites and restores them on restore", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    c.setFavorite(a.id, true);
    c.setFavorite(b.id, true);

    c.trashPage(a.id);
    expect(c.getUserState().favorites).toEqual([b.id]);
    c.restorePage(a.id);
    expect(c.getUserState().favorites).toEqual([a.id, b.id]);
  });

  it("keeps recents newest-first, deduplicated and capped at 30", () => {
    const c = ws();
    const ids: string[] = [];
    for (let i = 0; i < 35; i++) ids.push(c.createPage({ title: `p${i}` }).id);
    for (const id of ids) c.touchRecent(id);

    const recents = c.getUserState().recents;
    expect(recents).toHaveLength(30);
    expect(recents[0]).toBe(ids[34]);
    expect(recents).toEqual([...ids].reverse().slice(0, 30));

    const oldest = ids[0] ?? "";
    c.touchRecent(oldest);
    const after = c.getUserState().recents;
    expect(after[0]).toBe(oldest);
    expect(after).toHaveLength(30);
    expect(new Set(after).size).toBe(30);
    expect(codeOf(() => c.touchRecent("missing"))).toBe("not_found");
  });

  it("tracks sidebar expansion", () => {
    const c = ws();
    const a = c.createPage({ title: "A" });
    const b = c.createPage({ title: "B" });
    c.setExpanded(a.id, true);
    c.setExpanded(b.id, true);
    c.setExpanded(a.id, true);
    expect(c.getUserState().expandedPageIds).toEqual([b.id, a.id]);
    c.setExpanded(b.id, false);
    expect(c.getUserState().expandedPageIds).toEqual([a.id]);
    expect(codeOf(() => c.setExpanded("missing", true))).toBe("not_found");
  });

  it("validates and persists the theme", () => {
    const { commands, dir, close } = tempWorkspace();
    commands.setTheme("dark");
    expect(commands.getUserState().theme).toBe("dark");
    expect(
      codeOf(() => commands.setTheme("neon" as "dark")),
    ).toBe("invalid");

    close();
    const reopened = openWorkspace(dir);
    try {
      expect(reopened.commands.getUserState().theme).toBe("dark");
    } finally {
      reopened.close();
    }
  });
});
