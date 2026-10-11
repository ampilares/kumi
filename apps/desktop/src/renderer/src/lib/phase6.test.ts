import { describe, expect, it } from "vitest";
import type { Block, SnapshotMeta, TemplateMeta } from "@kumi/core";
import {
  baseName,
  causeLabel,
  dayKey,
  defaultTemplateName,
  formatDate,
  formatDayLabel,
  formatSnapshotLabel,
  formatTime,
  groupSnapshotsByDay,
  newestSnapshotId,
  normalizeTemplateName,
  printRoutePageId,
  removedByRestore,
  removedStrips,
  restoreWarning,
  sortTemplates,
  summarizeExport,
  withoutTemplate,
} from "./phase6";

/** Local-time timestamp helper — every label in this module is local-calendar. */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function snap(id: string, createdAt: number, cause: SnapshotMeta["cause"] = "auto"): SnapshotMeta {
  return { id, pageId: "p1", cause, createdAt };
}

function block(id: string, archived = false): Block {
  return {
    id,
    pageId: "p1",
    parentBlockId: null,
    rank: "a0",
    type: "paragraph",
    payload: {},
    version: 1,
    archived,
    createdAt: 0,
    updatedAt: 0,
  } as Block;
}

describe("date labels", () => {
  it("keys days by the local calendar", () => {
    expect(dayKey(at(2025, 11, 4, 23, 59))).toBe("2025-11-04");
    expect(dayKey(at(2025, 11, 5, 0, 1))).toBe("2025-11-05");
  });

  it("zero-pads single-digit months and days", () => {
    expect(dayKey(at(2025, 1, 2))).toBe("2025-01-02");
  });

  it("formats the Fig. 6 revision date", () => {
    expect(formatDate(at(2025, 11, 4))).toBe("November 4, 2025");
    expect(formatDate(at(2026, 1, 1))).toBe("January 1, 2026");
  });

  it("formats a 12-hour time", () => {
    expect(formatTime(at(2025, 11, 4, 9, 5))).toBe("9:05 AM");
    expect(formatTime(at(2025, 11, 4, 13, 30))).toBe("1:30 PM");
  });

  it("renders midnight and noon as 12", () => {
    expect(formatTime(at(2025, 11, 4, 0, 0))).toBe("12:00 AM");
    expect(formatTime(at(2025, 11, 4, 12, 0))).toBe("12:00 PM");
  });

  it("collapses recent days to Today and Yesterday", () => {
    const now = at(2025, 11, 4, 15, 0);
    expect(formatDayLabel(at(2025, 11, 4, 9, 0), now)).toBe("Today");
    expect(formatDayLabel(at(2025, 11, 3, 22, 0), now)).toBe("Yesterday");
    expect(formatDayLabel(at(2025, 11, 2, 22, 0), now)).toBe("November 2, 2025");
  });

  it("composes the entry label from date and time", () => {
    expect(formatSnapshotLabel(snap("s1", at(2025, 11, 4, 9, 5)))).toBe(
      "November 4, 2025 · 9:05 AM",
    );
  });

  it("names each snapshot cause", () => {
    expect(causeLabel("auto")).toBe("Auto");
    expect(causeLabel("manual")).toBe("Saved");
    expect(causeLabel("restore")).toBe("Restored");
  });
});

describe("groupSnapshotsByDay", () => {
  const now = at(2025, 11, 4, 18, 0);

  it("returns an empty list for no snapshots", () => {
    expect(groupSnapshotsByDay([], now)).toEqual([]);
  });

  it("buckets snapshots by local day", () => {
    const groups = groupSnapshotsByDay(
      [snap("a", at(2025, 11, 4, 9, 0)), snap("b", at(2025, 11, 3, 9, 0)), snap("c", at(2025, 11, 4, 17, 0))],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["2025-11-04", "2025-11-03"]);
    expect(groups[0]!.snapshots).toHaveLength(2);
    expect(groups[1]!.snapshots).toHaveLength(1);
  });

  it("orders days newest first regardless of input order", () => {
    const groups = groupSnapshotsByDay(
      [snap("old", at(2025, 10, 1)), snap("new", at(2025, 12, 1)), snap("mid", at(2025, 11, 1))],
      now,
    );
    expect(groups.map((g) => g.key)).toEqual(["2025-12-01", "2025-11-01", "2025-10-01"]);
  });

  it("orders snapshots newest first inside a day", () => {
    const groups = groupSnapshotsByDay(
      [snap("early", at(2025, 11, 4, 8, 0)), snap("late", at(2025, 11, 4, 20, 0))],
      now,
    );
    expect(groups[0]!.snapshots.map((s) => s.id)).toEqual(["late", "early"]);
  });

  it("labels the current and previous day relatively", () => {
    const groups = groupSnapshotsByDay(
      [snap("a", at(2025, 11, 4, 9, 0)), snap("b", at(2025, 11, 3, 9, 0)), snap("c", at(2025, 10, 9, 9, 0))],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "October 9, 2025"]);
  });

  it("does not mutate the input array", () => {
    const input = [snap("a", at(2025, 11, 4, 8, 0)), snap("b", at(2025, 11, 4, 20, 0))];
    groupSnapshotsByDay(input, now);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("picks the newest snapshot id for the default selection", () => {
    expect(
      newestSnapshotId([snap("a", at(2025, 11, 1)), snap("b", at(2025, 11, 9)), snap("c", at(2025, 11, 5))]),
    ).toBe("b");
    expect(newestSnapshotId([])).toBeNull();
  });
});

describe("removedByRestore", () => {
  it("reports blocks the snapshot does not contain", () => {
    expect(removedByRestore([block("a"), block("b")], [block("a")])).toEqual(["b"]);
  });

  it("reports nothing when the snapshot is a superset", () => {
    expect(removedByRestore([block("a")], [block("a"), block("b")])).toEqual([]);
  });

  it("ignores archived blocks on both sides", () => {
    expect(removedByRestore([block("a"), block("b", true)], [block("a")])).toEqual([]);
    expect(removedByRestore([block("a")], [block("a", true)])).toEqual(["a"]);
  });

  it("previews removed blocks by their text", () => {
    const withText = (id: string, text: string): Block => ({
      ...block(id),
      payload: { richText: [{ type: "text", text }] },
    } as Block);
    const strips = removedStrips([block("a"), withText("b", "  Second thoughts ")], [block("a")]);
    expect(strips).toEqual([{ id: "b", text: "Second thoughts" }]);
  });

  it("falls back to the block type when there is no text", () => {
    const todo: Block = { ...block("d"), type: "to_do" };
    expect(removedStrips([todo], [])).toEqual([{ id: "d", text: "to do" }]);
  });

  it("caps how many strips it returns", () => {
    const live = ["a", "b", "c", "d"].map((id) => block(id));
    expect(removedStrips(live, [], 2)).toHaveLength(2);
  });

  it("summarizes the cost of restoring", () => {
    expect(restoreWarning(0)).toBeNull();
    expect(restoreWarning(1)).toBe("1 block added since this version would be removed.");
    expect(restoreWarning(3)).toBe("3 blocks added since this version would be removed.");
  });
});

describe("templates", () => {
  const t = (id: string, name: string): TemplateMeta => ({ id, name, icon: null, createdAt: 0 });

  it("sorts by name, case-insensitively", () => {
    expect(sortTemplates([t("1", "beta"), t("2", "Alpha"), t("3", "gamma")]).map((x) => x.name)).toEqual(
      ["Alpha", "beta", "gamma"],
    );
  });

  it("leaves the source array untouched", () => {
    const input = [t("1", "b"), t("2", "a")];
    sortTemplates(input);
    expect(input.map((x) => x.id)).toEqual(["1", "2"]);
  });

  it("drops one template optimistically", () => {
    expect(withoutTemplate([t("1", "a"), t("2", "b")], "1").map((x) => x.id)).toEqual(["2"]);
    expect(withoutTemplate([t("1", "a")], "missing")).toHaveLength(1);
  });

  it("defaults the name to the page title", () => {
    expect(defaultTemplateName("Meeting notes")).toBe("Meeting notes");
    expect(defaultTemplateName("  padded  ")).toBe("padded");
    expect(defaultTemplateName("   ")).toBe("Untitled template");
  });

  it("rejects a blank name and caps the length", () => {
    expect(normalizeTemplateName("  ok  ")).toBe("ok");
    expect(normalizeTemplateName("   ")).toBeNull();
    expect(normalizeTemplateName("x".repeat(200))).toHaveLength(100);
  });
});

describe("export summaries", () => {
  it("takes the last segment of a path on either separator", () => {
    expect(baseName("D:\\Exports\\kumi")).toBe("kumi");
    expect(baseName("/home/allen/exports")).toBe("exports");
    expect(baseName("/home/allen/exports/")).toBe("exports");
    expect(baseName("kumi")).toBe("kumi");
  });

  it("pluralizes the file count", () => {
    expect(summarizeExport("Markdown", ["a.md"], "D:\\Out")).toBe("Markdown export: 1 file in Out");
    expect(summarizeExport("Markdown", ["a.md", "b.md"], "D:\\Out")).toBe(
      "Markdown export: 2 files in Out",
    );
  });

  it("says so when nothing was written", () => {
    expect(summarizeExport("Workspace JSON", [], "D:\\Out")).toBe(
      "Workspace JSON export wrote no files.",
    );
  });
});

describe("printRoutePageId", () => {
  it("reads the page id off the print route", () => {
    expect(printRoutePageId("?print=1&page=abc")).toBe("abc");
    expect(printRoutePageId("?page=abc&print=1")).toBe("abc");
  });

  it("returns null off the print route", () => {
    expect(printRoutePageId("")).toBeNull();
    expect(printRoutePageId("?page=abc")).toBeNull();
    expect(printRoutePageId("?print=0&page=abc")).toBeNull();
  });

  it("returns null when the page id is missing or blank", () => {
    expect(printRoutePageId("?print=1")).toBeNull();
    expect(printRoutePageId("?print=1&page=")).toBeNull();
  });

  it("decodes an escaped page id", () => {
    expect(printRoutePageId("?print=1&page=a%2Fb")).toBe("a/b");
  });
});
