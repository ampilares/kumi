/**
 * Phase 7 pure logic: everything the import hub decides that is not React.
 *
 * The interesting risk in an import UI is not layout — it is state. Progress
 * events arrive from a child process over IPC, which means they can arrive
 * late, out of order, or after the run has already finished; a plan has to be
 * summarized into a sentence a person can act on; and "have I imported this
 * export before?" is a comparison the hub must never get wrong, because the
 * answer changes whether the previous copy gets trashed. All of that lives
 * here so it can be tested without an Electron window.
 */
import type {
  ImportJobInfo,
  ImportPlanSummary,
  ImportProgress,
  ImportReport,
} from "@kumi/core";
import { baseName, formatDate, formatTime } from "./phase6";

/* ----------------------------------------------------------------- stages */

/** The pipeline, in the order Phase 7 runs it (spec §7). */
export const IMPORT_STAGES = [
  "ingest",
  "parse",
  "write",
  "resolve",
  "assets",
  "verify",
] as const;

export type ImportStage = (typeof IMPORT_STAGES)[number];

const STAGE_LABELS: Record<ImportStage, string> = {
  ingest: "Ingest",
  parse: "Parse",
  write: "Write",
  resolve: "Resolve",
  assets: "Assets",
  verify: "Verify",
};

const STAGE_HINTS: Record<ImportStage, string> = {
  ingest: "Reading the export",
  parse: "Turning files into records",
  write: "Creating pages and rows",
  resolve: "Reconnecting links and relations",
  assets: "Copying images and files",
  verify: "Checking nothing was lost",
};

export function stageLabel(stage: ImportStage): string {
  return STAGE_LABELS[stage];
}

export function stageHint(stage: ImportStage): string {
  return STAGE_HINTS[stage];
}

/** Position in the pipeline, or -1 for a stage name this build does not know. */
export function stageIndex(stage: string): number {
  return (IMPORT_STAGES as readonly string[]).indexOf(stage);
}

/* --------------------------------------------------------------- plan view */

export interface PlanCount {
  key: string;
  label: string;
  value: number;
}

/** The Fig. 17 counts grid. Always four cells, zeros included — a zero is information. */
export function planCounts(plan: ImportPlanSummary): PlanCount[] {
  return [
    { key: "pages", label: plan.pages === 1 ? "Page" : "Pages", value: plan.pages },
    {
      key: "dataSources",
      label: plan.dataSources === 1 ? "Database" : "Databases",
      value: plan.dataSources,
    },
    { key: "rows", label: plan.rows === 1 ? "Row" : "Rows", value: plan.rows },
    { key: "assets", label: plan.assets === 1 ? "Asset" : "Assets", value: plan.assets },
  ];
}

/** Nothing at all to bring in — the confirm button has to say so, not lie. */
export function planIsEmpty(plan: ImportPlanSummary): boolean {
  return plan.pages === 0 && plan.dataSources === 0 && plan.rows === 0 && plan.assets === 0;
}

/** Primary button copy: "Import 12 pages". */
export function importButtonLabel(plan: ImportPlanSummary): string {
  if (planIsEmpty(plan)) return "Nothing to import";
  if (plan.pages === 0) return "Import this export";
  return plan.pages === 1 ? "Import 1 page" : `Import ${plan.pages} pages`;
}

/** Total of the aggregated unsupported buckets — the count, not the bucket count. */
export function unsupportedTotal(plan: ImportPlanSummary): number {
  return plan.unsupported.reduce((sum, item) => sum + item.count, 0);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Collapsible header copy, or null when there is nothing to warn about. */
export function warningSummary(plan: ImportPlanSummary): string | null {
  if (plan.warnings.length === 0) return null;
  return pluralize(plan.warnings.length, "warning");
}

export function unsupportedSummary(plan: ImportPlanSummary): string | null {
  const total = unsupportedTotal(plan);
  if (total === 0) return null;
  return `${pluralize(total, "item")} will not import losslessly`;
}

/* ------------------------------------------------------- re-import awareness */

export const REIMPORT_NOTE =
  "This export was imported before — importing again will move the previous copy to Trash and re-import.";

/**
 * The newest committed job that used the same source bytes. Hash equality is
 * the only test: the same export re-downloaded to a different folder is still
 * the same export, and a changed export at the same path is not.
 */
export function findPriorImport(
  plan: ImportPlanSummary | null,
  jobs: ImportJobInfo[],
): ImportJobInfo | null {
  if (!plan || plan.sourceHash === "") return null;
  let best: ImportJobInfo | null = null;
  for (const job of jobs) {
    if (job.status !== "committed" || job.sourceHash !== plan.sourceHash) continue;
    if (!best || job.createdAt > best.createdAt) best = job;
  }
  return best;
}

/* ------------------------------------------------------- progress reduction */

export interface ProgressState {
  status: "running" | "done" | "error";
  /** Furthest stage reached. Never moves backwards. */
  stage: ImportStage;
  done: number;
  total: number;
  report: ImportReport | null;
  error: string | null;
}

export type ProgressEvent =
  | { type: "progress"; progress: ImportProgress }
  | { type: "done"; report: ImportReport }
  | { type: "error"; message: string };

const LAST_STAGE = IMPORT_STAGES[IMPORT_STAGES.length - 1] as ImportStage;

export function initialProgress(): ProgressState {
  return { status: "running", stage: "ingest", done: 0, total: 0, report: null, error: null };
}

/**
 * Folds one event into the run state.
 *
 * Three rules, all of them about not trusting the wire: a terminal state is
 * final (a straggling progress event must never resurrect a finished run), the
 * stage only ever advances (events can cross), and counters only climb within
 * a stage (a re-delivered earlier tick must not rewind the bar).
 */
export function reduceProgress(state: ProgressState, event: ProgressEvent): ProgressState {
  if (state.status !== "running") return state;

  if (event.type === "done") {
    return {
      status: "done",
      stage: LAST_STAGE,
      done: state.total > 0 ? state.total : 1,
      total: state.total > 0 ? state.total : 1,
      report: event.report,
      error: null,
    };
  }

  if (event.type === "error") {
    return { ...state, status: "error", report: null, error: event.message };
  }

  const index = stageIndex(event.progress.stage);
  if (index < 0) return state; // Unknown stage from a newer core — ignore.

  const current = stageIndex(state.stage);
  if (index < current) return state; // Late event from a stage already past.

  const done = Math.max(0, Math.round(event.progress.done));
  const total = Math.max(0, Math.round(event.progress.total));

  if (index > current) {
    return { ...state, stage: IMPORT_STAGES[index] as ImportStage, done, total };
  }

  return { ...state, done: Math.max(state.done, done), total };
}

export type StageStatus = "done" | "active" | "pending";

/** Checklist state for one row of the Ingest → … → Verify list. */
export function stageStatus(state: ProgressState, stage: ImportStage): StageStatus {
  if (state.status === "done") return "done";
  const index = stageIndex(stage);
  const current = stageIndex(state.stage);
  if (index < current) return "done";
  if (index > current) return "pending";
  return state.status === "error" ? "pending" : "active";
}

/**
 * Overall completion 0–100. Each stage owns an equal slice; within a stage the
 * counter fills it. Coarse on purpose — a bar that jumps around because one
 * stage reports millions of ticks reads as broken.
 */
export function overallPercent(state: ProgressState): number {
  if (state.status === "done") return 100;
  const index = Math.max(0, stageIndex(state.stage));
  const fraction = state.total > 0 ? Math.min(1, state.done / state.total) : 0;
  const percent = ((index + fraction) / IMPORT_STAGES.length) * 100;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Live counter line: "Parse · 12 of 40" (or just the stage when untotalled). */
export function progressCounter(state: ProgressState): string {
  const label = stageLabel(state.stage);
  if (state.status === "done") return "Finished";
  if (state.total <= 0) return label;
  return `${label} · ${state.done} of ${state.total}`;
}

/* --------------------------------------------------------------- job list */

export interface JobRow {
  id: string;
  /** "November 4, 2025 · 9:05 AM" */
  dateLabel: string;
  sourceName: string;
  sourcePath: string;
  status: ImportJobInfo["status"];
  statusLabel: string;
  countsLabel: string;
  lossCount: number;
  /** Why a failed run failed: core stores the reason in the report's warnings. */
  failureNote: string | null;
  report: ImportReport | null;
}

/**
 * The line the Completed tab shows under a failed job. Core records the reason
 * a run aborted in `report.warnings`, so a failed row is never just "Failed".
 */
export function jobFailureNote(job: ImportJobInfo): string | null {
  if (job.status !== "failed") return null;
  const first = job.report?.warnings[0];
  return first !== undefined && first !== "" ? first : "No reason was recorded.";
}

/** "12 pages · 2 databases · 40 rows · 3 assets", zeros omitted. */
export function countsLabel(counts: ImportReport["counts"] | null): string {
  if (!counts) return "No report stored";
  const parts: string[] = [];
  if (counts.pages) parts.push(pluralize(counts.pages, "page"));
  if (counts.dataSources) parts.push(pluralize(counts.dataSources, "database"));
  if (counts.rows) parts.push(pluralize(counts.rows, "row"));
  if (counts.assets) parts.push(pluralize(counts.assets, "asset"));
  return parts.length === 0 ? "Nothing imported" : parts.join(" · ");
}

/** History rows, newest first — core's order is not the hub's contract. */
export function jobRows(jobs: ImportJobInfo[]): JobRow[] {
  return [...jobs]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({
      id: job.id,
      dateLabel: `${formatDate(job.createdAt)} · ${formatTime(job.createdAt)}`,
      sourceName: baseName(job.sourcePath),
      sourcePath: job.sourcePath,
      status: job.status,
      statusLabel: job.status === "committed" ? "Imported" : "Failed",
      countsLabel: countsLabel(job.report?.counts ?? null),
      lossCount: job.report?.losses.length ?? 0,
      failureNote: jobFailureNote(job),
      report: job.report,
    }));
}

/* ------------------------------------------------------------ report view */

export interface LossRow {
  key: string;
  kind: string;
  sourceRef: string;
  detail: string;
}

export function lossRows(report: ImportReport): LossRow[] {
  return report.losses.map((loss, index) => ({
    key: `${index}-${loss.kind}-${loss.sourceRef}`,
    kind: loss.kind,
    sourceRef: loss.sourceRef,
    detail: loss.detail,
  }));
}

/** Headline sentence of the success card. */
export function successSummary(report: ImportReport): string {
  const counts = countsLabel(report.counts);
  return counts === "Nothing imported" ? "The import finished, but nothing was created." : `Imported ${counts}.`;
}

/** Sub-line: how honest the import had to be about what it could not keep. */
export function lossSummary(report: ImportReport): string {
  if (report.losses.length === 0) return "Nothing was lost.";
  return `${pluralize(report.losses.length, "item")} could not be imported exactly — every one is listed below.`;
}

/** Stable, sortable file name for the saved loss report. */
export function reportFileName(report: ImportReport): string {
  const hash = report.sourceHash.slice(0, 8) || "unknown";
  return `kumi-import-report-${hash}`;
}

export function reportJson(report: ImportReport): string {
  return JSON.stringify(report, null, 2);
}

/* --------------------------------------------------------------- sources */

/** `.zip` archive or extracted folder, inferred from the path alone. */
export function sourceKind(path: string): "zip" | "folder" {
  return /\.zip$/i.test(path) ? "zip" : "folder";
}

/** Display name for a chosen source: the archive or folder name, never the path. */
export function sourceName(path: string): string {
  return baseName(path);
}

/**
 * The path to import from a drop. Electron hands us one path per dropped file;
 * a Notion export is a single archive or a single folder, so extra items are a
 * mistake worth refusing rather than silently importing the first one.
 */
export function pickDroppedSource(paths: string[]): { path: string } | { error: string } {
  const usable = paths.filter((p) => p !== "");
  if (usable.length === 0) return { error: "That drop did not contain a file Kumi can read." };
  if (usable.length > 1) {
    return { error: "Drop one Notion export at a time — a single .zip or a single folder." };
  }
  return { path: usable[0] as string };
}
