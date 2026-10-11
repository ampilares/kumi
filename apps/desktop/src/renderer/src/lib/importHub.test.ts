import { describe, expect, it } from "vitest";
import type { ImportJobInfo, ImportPlanSummary, ImportReport } from "@kumi/core";
import {
  countsLabel,
  findPriorImport,
  importButtonLabel,
  initialProgress,
  jobFailureNote,
  jobRows,
  lossRows,
  lossSummary,
  overallPercent,
  pickDroppedSource,
  planCounts,
  planIsEmpty,
  progressCounter,
  reduceProgress,
  reportFileName,
  reportJson,
  sourceKind,
  sourceName,
  stageIndex,
  stageStatus,
  successSummary,
  unsupportedSummary,
  unsupportedTotal,
  warningSummary,
  type ProgressState,
} from "./importHub";

function plan(patch: Partial<ImportPlanSummary> = {}): ImportPlanSummary {
  return {
    sourcePath: "C:\\exports\\Notion-Export.zip",
    sourceHash: "abc123def456",
    pages: 12,
    dataSources: 2,
    rows: 40,
    assets: 3,
    warnings: [],
    unsupported: [],
    ...patch,
  };
}

function report(patch: Partial<ImportReport> = {}): ImportReport {
  return {
    jobId: "job-1",
    sourceHash: "abc123def456",
    rootPageId: "page-root",
    counts: { pages: 12, blocks: 300, dataSources: 2, rows: 40, assets: 3 },
    losses: [],
    warnings: [],
    ...patch,
  };
}

function job(patch: Partial<ImportJobInfo> = {}): ImportJobInfo {
  return {
    id: "job-1",
    sourcePath: "C:\\exports\\Notion-Export.zip",
    sourceHash: "abc123def456",
    status: "committed",
    createdAt: Date.UTC(2025, 10, 4, 9, 5),
    report: report(),
    ...patch,
  };
}

/* -------------------------------------------------------------- plan view */

describe("plan summarization", () => {
  it("builds a four-cell counts grid with singular/plural labels", () => {
    expect(planCounts(plan()).map((c) => `${c.value} ${c.label}`)).toEqual([
      "12 Pages",
      "2 Databases",
      "40 Rows",
      "3 Assets",
    ]);
    expect(planCounts(plan({ pages: 1, dataSources: 1, rows: 1, assets: 1 })).map((c) => c.label)).toEqual([
      "Page",
      "Database",
      "Row",
      "Asset",
    ]);
  });

  it("recognises an empty export", () => {
    expect(planIsEmpty(plan())).toBe(false);
    expect(planIsEmpty(plan({ pages: 0, dataSources: 0, rows: 0, assets: 0 }))).toBe(true);
  });

  it("labels the confirm button by page count", () => {
    expect(importButtonLabel(plan())).toBe("Import 12 pages");
    expect(importButtonLabel(plan({ pages: 1 }))).toBe("Import 1 page");
    expect(importButtonLabel(plan({ pages: 0 }))).toBe("Import this export");
    expect(importButtonLabel(plan({ pages: 0, dataSources: 0, rows: 0, assets: 0 }))).toBe(
      "Nothing to import",
    );
  });

  it("totals unsupported constructs across buckets", () => {
    const p = plan({
      unsupported: [
        { kind: "block", detail: "synced_block", count: 3 },
        { kind: "property", detail: "person", count: 2 },
      ],
    });
    expect(unsupportedTotal(p)).toBe(5);
    expect(unsupportedSummary(p)).toBe("5 items will not import losslessly");
    expect(unsupportedSummary(plan())).toBeNull();
  });

  it("summarises warnings only when there are any", () => {
    expect(warningSummary(plan())).toBeNull();
    expect(warningSummary(plan({ warnings: ["a"] }))).toBe("1 warning");
    expect(warningSummary(plan({ warnings: ["a", "b", "c"] }))).toBe("3 warnings");
  });
});

/* ------------------------------------------------------ re-import detection */

describe("re-import detection", () => {
  it("matches the newest committed job with the same source hash", () => {
    const older = job({ id: "old", createdAt: 1000 });
    const newer = job({ id: "new", createdAt: 2000 });
    expect(findPriorImport(plan(), [older, newer])?.id).toBe("new");
  });

  it("ignores failed jobs and different hashes", () => {
    expect(findPriorImport(plan(), [job({ status: "failed" })])).toBeNull();
    expect(findPriorImport(plan(), [job({ sourceHash: "other" })])).toBeNull();
  });

  it("never matches without a plan or a hash", () => {
    expect(findPriorImport(null, [job()])).toBeNull();
    expect(findPriorImport(plan({ sourceHash: "" }), [job({ sourceHash: "" })])).toBeNull();
  });

  it("matches the same export moved to a different path", () => {
    const moved = job({ sourcePath: "D:\\backup\\Export.zip" });
    expect(findPriorImport(plan(), [moved])?.id).toBe("job-1");
  });
});

/* ------------------------------------------------------ progress reduction */

function progress(stage: string, done: number, total: number) {
  return {
    type: "progress" as const,
    progress: { stage: stage as never, done, total },
  };
}

describe("progress state machine", () => {
  it("starts at the first stage with nothing done", () => {
    const state = initialProgress();
    expect(state).toMatchObject({ status: "running", stage: "ingest", done: 0, total: 0 });
    expect(overallPercent(state)).toBe(0);
    expect(progressCounter(state)).toBe("Ingest");
  });

  it("advances through stages and fills the bar", () => {
    let state = initialProgress();
    state = reduceProgress(state, progress("ingest", 1, 1));
    state = reduceProgress(state, progress("parse", 5, 10));
    expect(state.stage).toBe("parse");
    expect(progressCounter(state)).toBe("Parse · 5 of 10");
    // Stage 1 of 6 complete plus half of stage 2 → 25%.
    expect(overallPercent(state)).toBe(25);
  });

  it("ignores events from a stage already passed", () => {
    let state = initialProgress();
    state = reduceProgress(state, progress("write", 3, 9));
    const late = reduceProgress(state, progress("parse", 9, 9));
    expect(late).toBe(state);
    expect(late.stage).toBe("write");
  });

  it("never rewinds the counter inside a stage", () => {
    let state = initialProgress();
    state = reduceProgress(state, progress("write", 8, 10));
    state = reduceProgress(state, progress("write", 3, 10));
    expect(state.done).toBe(8);
  });

  it("ignores stage names it does not know", () => {
    const state = reduceProgress(initialProgress(), progress("teleport", 1, 1));
    expect(state.stage).toBe("ingest");
  });

  it("treats done as terminal and full", () => {
    let state = reduceProgress(initialProgress(), progress("write", 4, 10));
    state = reduceProgress(state, { type: "done", report: report() });
    expect(state.status).toBe("done");
    expect(state.stage).toBe("verify");
    expect(overallPercent(state)).toBe(100);
    expect(progressCounter(state)).toBe("Finished");
    expect(state.report?.rootPageId).toBe("page-root");
  });

  it("ignores everything after a terminal event", () => {
    const done = reduceProgress(initialProgress(), { type: "done", report: report() });
    expect(reduceProgress(done, progress("assets", 1, 2))).toBe(done);
    expect(reduceProgress(done, { type: "error", message: "boom" })).toBe(done);

    const failed = reduceProgress(initialProgress(), { type: "error", message: "boom" });
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("boom");
    expect(reduceProgress(failed, { type: "done", report: report() })).toBe(failed);
  });

  it("keeps an error from claiming a report", () => {
    let state = reduceProgress(initialProgress(), progress("verify", 1, 1));
    state = reduceProgress(state, { type: "error", message: "disk full" });
    expect(state.report).toBeNull();
    expect(state.stage).toBe("verify");
  });

  it("marks the checklist consistently", () => {
    const state = reduceProgress(initialProgress(), progress("resolve", 1, 4));
    expect(stageStatus(state, "parse")).toBe("done");
    expect(stageStatus(state, "resolve")).toBe("active");
    expect(stageStatus(state, "verify")).toBe("pending");

    const finished: ProgressState = reduceProgress(state, { type: "done", report: report() });
    expect(stageStatus(finished, "ingest")).toBe("done");
    expect(stageStatus(finished, "verify")).toBe("done");

    const failed = reduceProgress(state, { type: "error", message: "nope" });
    expect(stageStatus(failed, "resolve")).toBe("pending");
  });

  it("clamps nonsense counters", () => {
    const state = reduceProgress(initialProgress(), progress("ingest", -5, 0));
    expect(state.done).toBe(0);
    expect(overallPercent(state)).toBe(0);

    const over = reduceProgress(initialProgress(), progress("ingest", 99, 10));
    expect(overallPercent(over)).toBeLessThanOrEqual(100);
  });

  it("stays inside 0–100 at the last stage", () => {
    const state = reduceProgress(initialProgress(), progress("verify", 10, 10));
    expect(overallPercent(state)).toBe(100);
  });

  it("orders the stage list as the pipeline runs", () => {
    expect(stageIndex("ingest")).toBe(0);
    expect(stageIndex("verify")).toBe(5);
    expect(stageIndex("nope")).toBe(-1);
  });
});

/* -------------------------------------------------------------- job list */

describe("job list formatting", () => {
  it("sorts newest first and formats each row", () => {
    const rows = jobRows([
      job({ id: "a", createdAt: Date.UTC(2025, 0, 1, 12, 0) }),
      job({ id: "b", createdAt: Date.UTC(2026, 0, 1, 12, 0) }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows[0]?.sourceName).toBe("Notion-Export.zip");
    expect(rows[0]?.statusLabel).toBe("Imported");
    expect(rows[0]?.countsLabel).toBe("12 pages · 2 databases · 40 rows · 3 assets");
  });

  it("describes a failed job without a report", () => {
    const rows = jobRows([job({ status: "failed", report: null })]);
    expect(rows[0]?.statusLabel).toBe("Failed");
    expect(rows[0]?.countsLabel).toBe("No report stored");
    expect(rows[0]?.lossCount).toBe(0);
    expect(rows[0]?.failureNote).toBe("No reason was recorded.");
  });

  it("surfaces why a failed job failed", () => {
    const failed = job({
      status: "failed",
      report: report({ rootPageId: null, warnings: ["archive is not a Notion export"] }),
    });
    expect(jobFailureNote(failed)).toBe("archive is not a Notion export");
    expect(jobRows([failed])[0]?.failureNote).toBe("archive is not a Notion export");
  });

  it("leaves committed jobs without a failure note", () => {
    expect(jobFailureNote(job())).toBeNull();
    expect(jobRows([job()])[0]?.failureNote).toBeNull();
  });

  it("omits zero counts", () => {
    expect(countsLabel({ pages: 3, blocks: 9, dataSources: 0, rows: 0, assets: 1 })).toBe(
      "3 pages · 1 asset",
    );
    expect(countsLabel({ pages: 0, blocks: 0, dataSources: 0, rows: 0, assets: 0 })).toBe(
      "Nothing imported",
    );
  });

  it("uses the folder name for an extracted export", () => {
    const rows = jobRows([job({ sourcePath: "C:\\exports\\Workspace Export\\" })]);
    expect(rows[0]?.sourceName).toBe("Workspace Export");
  });
});

/* ------------------------------------------------------------ report view */

describe("report view", () => {
  it("summarises success and losses", () => {
    expect(successSummary(report())).toBe("Imported 12 pages · 2 databases · 40 rows · 3 assets.");
    expect(lossSummary(report())).toBe("Nothing was lost.");
    expect(
      lossSummary(report({ losses: [{ kind: "block", sourceRef: "a.md", detail: "synced" }] })),
    ).toContain("1 item");
  });

  it("keys loss rows uniquely even when they repeat", () => {
    const rows = lossRows(
      report({
        losses: [
          { kind: "block", sourceRef: "a.md", detail: "synced" },
          { kind: "block", sourceRef: "a.md", detail: "synced" },
        ],
      }),
    );
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("names and serializes the saved report", () => {
    expect(reportFileName(report())).toBe("kumi-import-report-abc123de");
    expect(reportFileName(report({ sourceHash: "" }))).toBe("kumi-import-report-unknown");
    expect(JSON.parse(reportJson(report())).jobId).toBe("job-1");
  });
});

/* --------------------------------------------------------------- sources */

describe("source selection", () => {
  it("classifies archives and folders", () => {
    expect(sourceKind("C:\\a\\Export.zip")).toBe("zip");
    expect(sourceKind("C:\\a\\Export.ZIP")).toBe("zip");
    expect(sourceKind("C:\\a\\Export")).toBe("folder");
    expect(sourceName("C:\\a\\Export.zip")).toBe("Export.zip");
  });

  it("accepts exactly one dropped source", () => {
    expect(pickDroppedSource(["C:\\a\\Export.zip"])).toEqual({ path: "C:\\a\\Export.zip" });
    expect(pickDroppedSource([""])).toHaveProperty("error");
    expect(pickDroppedSource([])).toHaveProperty("error");
    expect(pickDroppedSource(["a.zip", "b.zip"])).toHaveProperty("error");
  });
});
