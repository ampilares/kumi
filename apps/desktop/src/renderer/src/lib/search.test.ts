import { describe, expect, it } from "vitest";
import type { Block, Page, PageTreeNode, SearchResult } from "@kumi/core";
import {
  applyScope,
  bodySnippet,
  breadcrumbLabel,
  calendarDaysAgo,
  flattenGroups,
  groupResultsByDate,
  highlightSegments,
  previewBlocks,
  recentsToResults,
  sanitizeSnippet,
  scopeOptions,
  scopeRootTitle,
  searchBucket,
  stripHighlight,
} from "./search";

/** Local-time timestamp helper — every bucket in this module is local-calendar. */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

function hit(over: Partial<SearchResult> = {}): SearchResult {
  return {
    pageId: "p1",
    title: "Page",
    icon: null,
    snippet: "",
    breadcrumb: [],
    updatedAt: at(2026, 8, 19),
    ...over,
  };
}

function page(over: Partial<Page> = {}): Page {
  return {
    id: "p1",
    parentId: null,
    title: "Page",
    icon: null,
    coverAssetId: null,
    locked: false,
    fullWidth: false,
    smallText: false,
    rank: "a0",
    createdAt: 0,
    updatedAt: at(2026, 8, 19),
    deletedAt: null,
    ...over,
  };
}

function node(id: string, title: string): PageTreeNode {
  return { page: page({ id, title }), hasChildren: false };
}

function block(id: string, parentBlockId: string | null = null): Block {
  return {
    id,
    pageId: "p1",
    parentBlockId,
    rank: "a0",
    type: "paragraph",
    payload: {},
    version: 1,
    archived: false,
    createdAt: 0,
    updatedAt: 0,
  } as Block;
}

/* ------------------------------------------------------------ date buckets */

describe("calendarDaysAgo", () => {
  const now = at(2026, 8, 19, 9);

  it("is zero for any time today", () => {
    expect(calendarDaysAgo(at(2026, 8, 19, 0, 1), now)).toBe(0);
    expect(calendarDaysAgo(at(2026, 8, 19, 23, 59), now)).toBe(0);
  });

  it("counts whole calendar days, not elapsed hours", () => {
    // 11:59pm yesterday is ten minutes before 9am today, but still yesterday.
    expect(calendarDaysAgo(at(2026, 8, 18, 23, 50), now)).toBe(1);
    expect(calendarDaysAgo(at(2026, 8, 12, 12), now)).toBe(7);
  });

  it("is negative for a future timestamp", () => {
    expect(calendarDaysAgo(at(2026, 8, 20), now)).toBe(-1);
  });
});

describe("searchBucket", () => {
  const now = at(2026, 8, 19, 9);

  it("labels today and yesterday", () => {
    expect(searchBucket(at(2026, 8, 19, 1), now)).toEqual({ key: "today", label: "Today" });
    expect(searchBucket(at(2026, 8, 18, 23), now)).toEqual({
      key: "yesterday",
      label: "Yesterday",
    });
  });

  it("collapses days two through seven into Past week", () => {
    expect(searchBucket(at(2026, 8, 17), now).label).toBe("Past week");
    expect(searchBucket(at(2026, 8, 12), now).label).toBe("Past week");
    expect(searchBucket(at(2026, 8, 11), now).label).not.toBe("Past week");
  });

  it("gives older results a dated group with its year", () => {
    expect(searchBucket(at(2026, 7, 4), now)).toEqual({
      key: "2026-07-04",
      label: "July 4, 2026",
    });
  });

  it("keeps the year visible across a year boundary", () => {
    const january = at(2027, 1, 5, 10);
    expect(searchBucket(at(2026, 12, 20), january).label).toBe("December 20, 2026");
    // Straddling New Year is still just "days ago" — no special-casing.
    expect(searchBucket(at(2026, 12, 30), january).label).toBe("Past week");
    expect(searchBucket(at(2027, 1, 4), january).label).toBe("Yesterday");
  });

  it("treats a future timestamp as Today rather than inventing a header", () => {
    expect(searchBucket(at(2026, 8, 25), now).key).toBe("today");
  });
});

describe("groupResultsByDate", () => {
  const now = at(2026, 8, 19, 9);

  it("orders groups newest first and sorts inside each group", () => {
    const groups = groupResultsByDate(
      [
        hit({ pageId: "old", updatedAt: at(2026, 5, 1) }),
        hit({ pageId: "today-early", updatedAt: at(2026, 8, 19, 2) }),
        hit({ pageId: "week", updatedAt: at(2026, 8, 15) }),
        hit({ pageId: "today-late", updatedAt: at(2026, 8, 19, 8) }),
        hit({ pageId: "yday", updatedAt: at(2026, 8, 18) }),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toEqual([
      "Today",
      "Yesterday",
      "Past week",
      "May 1, 2026",
    ]);
    expect(groups[0]!.results.map((r) => r.pageId)).toEqual(["today-late", "today-early"]);
  });

  it("keeps every distinct older day as its own group", () => {
    const groups = groupResultsByDate(
      [hit({ pageId: "a", updatedAt: at(2026, 5, 1) }), hit({ pageId: "b", updatedAt: at(2026, 4, 1) })],
      now,
    );
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.key)).toEqual(["2026-05-01", "2026-04-01"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupResultsByDate([], now)).toEqual([]);
  });

  it("flattens back into the order the arrow keys walk", () => {
    const groups = groupResultsByDate(
      [
        hit({ pageId: "yday", updatedAt: at(2026, 8, 18) }),
        hit({ pageId: "today", updatedAt: at(2026, 8, 19) }),
      ],
      now,
    );
    expect(flattenGroups(groups).map((r) => r.pageId)).toEqual(["today", "yday"]);
  });
});

/* -------------------------------------------------------------------- scope */

describe("scope filtering", () => {
  it("lists top-level pages, naming the untitled ones", () => {
    expect(scopeOptions([node("a", "Projects"), node("b", "  ")])).toEqual([
      { id: "a", title: "Projects" },
      { id: "b", title: "Untitled" },
    ]);
  });

  it("treats a root page as its own scope", () => {
    expect(scopeRootTitle(hit({ title: "Projects", breadcrumb: [] }))).toBe("Projects");
    expect(scopeRootTitle(hit({ title: "TO DO", breadcrumb: ["Projects", "AI Agency"] }))).toBe(
      "Projects",
    );
  });

  it("keeps everything when the scope is Everywhere", () => {
    const results = [hit({ pageId: "a" }), hit({ pageId: "b", breadcrumb: ["Other"] })];
    expect(applyScope(results, null)).toHaveLength(2);
  });

  it("keeps the scope page itself and its descendants", () => {
    const results = [
      hit({ pageId: "root", title: "Projects" }),
      hit({ pageId: "child", title: "TO DO", breadcrumb: ["Projects"] }),
      hit({ pageId: "deep", title: "SOP", breadcrumb: ["Projects", "AI Agency"] }),
      hit({ pageId: "other", title: "Family", breadcrumb: ["Personal"] }),
    ];
    expect(applyScope(results, "Projects").map((r) => r.pageId)).toEqual([
      "root",
      "child",
      "deep",
    ]);
  });

  it("returns nothing when no result lives under the scope", () => {
    expect(applyScope([hit({ breadcrumb: ["Personal"] })], "Projects")).toEqual([]);
  });
});

describe("breadcrumbLabel", () => {
  it("joins the path with slashes", () => {
    expect(breadcrumbLabel(["Projects", "AI Agency"])).toBe("Projects / AI Agency");
  });

  it("falls back to Private at the root", () => {
    expect(breadcrumbLabel([])).toBe("Private");
    expect(breadcrumbLabel(["  "])).toBe("Private");
  });
});

/* ----------------------------------------------------------------- snippets */

describe("snippets", () => {
  it("strips the highlight markers", () => {
    expect(stripHighlight("a <b>match</b> here")).toBe("a match here");
  });

  it("suppresses a snippet that is just the title echoed back", () => {
    expect(bodySnippet(hit({ title: "Sales Scorecards", snippet: "<b>Sales</b> Scorecards" }))).toBe(
      null,
    );
  });

  it("keeps a body snippet", () => {
    const snippet = "…quarterly <b>sales</b> targets…";
    expect(bodySnippet(hit({ title: "Sales Scorecards", snippet }))).toBe(snippet);
  });

  it("suppresses an empty snippet", () => {
    expect(bodySnippet(hit({ snippet: "" }))).toBe(null);
  });

  it("escapes everything except the <b> markers", () => {
    expect(sanitizeSnippet('<b>a</b> <img src=x> & <i>b</i>')).toBe(
      "<b>a</b> &lt;img src=x&gt; &amp; &lt;i&gt;b&lt;/i&gt;",
    );
  });
});

/* ---------------------------------------------------------------- highlight */

describe("highlightSegments", () => {
  it("returns one plain segment when there is no query", () => {
    expect(highlightSegments("Sales", "")).toEqual([{ text: "Sales", hit: false }]);
  });

  it("marks a case-insensitive match while preserving the original casing", () => {
    expect(highlightSegments("Sales Scorecards", "sales")).toEqual([
      { text: "Sales", hit: true },
      { text: " Scorecards", hit: false },
    ]);
  });

  it("matches every term independently", () => {
    expect(highlightSegments("Buy New Car", "car buy")).toEqual([
      { text: "Buy", hit: true },
      { text: " New ", hit: false },
      { text: "Car", hit: true },
    ]);
  });

  it("prefers the longest matching term at a position", () => {
    expect(highlightSegments("Scorecard", "sc scorecard")).toEqual([
      { text: "Scorecard", hit: true },
    ]);
  });

  it("handles an empty title", () => {
    expect(highlightSegments("", "sales")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ recents */

describe("recentsToResults", () => {
  it("follows the recents order, not the page order", () => {
    const results = recentsToResults(
      ["b", "a"],
      [
        { page: page({ id: "a", title: "A" }), breadcrumb: [] },
        { page: page({ id: "b", title: "B" }), breadcrumb: ["Projects"] },
      ],
    );
    expect(results.map((r) => r.pageId)).toEqual(["b", "a"]);
    expect(results[0]!.breadcrumb).toEqual(["Projects"]);
  });

  it("skips ids whose page could not be read", () => {
    expect(recentsToResults(["a", "gone"], [{ page: page({ id: "a" }), breadcrumb: [] }])).toHaveLength(
      1,
    );
  });

  it("carries icon and updatedAt through so the rows group by date", () => {
    const ts = at(2026, 8, 18);
    const [result] = recentsToResults(
      ["a"],
      [{ page: page({ id: "a", icon: "🔥", updatedAt: ts }), breadcrumb: [] }],
    );
    expect(result).toMatchObject({ icon: "🔥", updatedAt: ts, snippet: "" });
  });

  it("groups recents with the same buckets as search hits", () => {
    const now = at(2026, 8, 19, 9);
    const results = recentsToResults(
      ["a", "b"],
      [
        { page: page({ id: "a", updatedAt: at(2026, 8, 19) }), breadcrumb: [] },
        { page: page({ id: "b", updatedAt: at(2026, 8, 18) }), breadcrumb: [] },
      ],
    );
    expect(groupResultsByDate(results, now).map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });
});

/* ------------------------------------------------------------------ preview */

describe("previewBlocks", () => {
  it("caps the number of top-level blocks", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => block(`b${i}`));
    expect(previewBlocks(blocks, 15)).toHaveLength(15);
  });

  it("keeps whole subtrees rather than orphaning children", () => {
    const blocks = [block("a"), block("a1", "a"), block("a1a", "a1"), block("b")];
    expect(previewBlocks(blocks, 1).map((b) => b.id)).toEqual(["a", "a1", "a1a"]);
  });

  it("drops children of blocks past the cut", () => {
    const blocks = [block("a"), block("b"), block("b1", "b")];
    expect(previewBlocks(blocks, 1).map((b) => b.id)).toEqual(["a"]);
  });

  it("handles an empty page", () => {
    expect(previewBlocks([], 15)).toEqual([]);
  });
});
