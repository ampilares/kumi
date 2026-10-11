/**
 * The import hub (build plan Fig. 17), living inside the settings modal.
 *
 * One linear flow with four faces — choose a source → inspect the plan → watch
 * the pipeline → read the report — plus a Completed tab holding the same report
 * view for every past job. The flow is deliberately confirm-before-commit: the
 * plan view exists so nobody discovers what an import does by running it.
 *
 * All the decisions (what the plan means, how progress events fold together,
 * whether this export has been imported before) live in `lib/importHub.ts`;
 * this file is presentation plus the IPC choreography.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImportJobInfo, ImportPlanSummary, ImportReport } from "@kumi/core";
import {
  commands,
  importJobs,
  importPlan,
  importRun,
  onImportDone,
  onImportProgress,
  pathForFile,
  pickImportSource,
  saveJson,
  showInFolder,
} from "../ipc";
import { useAsync } from "../hooks";
import { useUi } from "../store";
import { cx } from "../utils";
import {
  IMPORT_STAGES,
  REIMPORT_NOTE,
  findPriorImport,
  importButtonLabel,
  initialProgress,
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
  sourceName,
  stageHint,
  stageLabel,
  stageStatus,
  successSummary,
  unsupportedSummary,
  warningSummary,
  type ProgressState,
} from "../lib/importHub";
import { AlertIcon, ArchiveIcon, CheckIcon, FolderIcon, ImportIcon } from "./icons";
import { toastAction, toastError } from "./Toasts";

type Phase = "idle" | "planning" | "plan" | "running" | "report" | "error";
type Tab = "discover" | "completed";

export function ImportHub(): JSX.Element {
  const [tab, setTab] = useState<Tab>("discover");
  const [phase, setPhase] = useState<Phase>("idle");
  const [source, setSource] = useState<string | null>(null);
  const [plan, setPlan] = useState<ImportPlanSummary | null>(null);
  const [progress, setProgress] = useState<ProgressState>(initialProgress);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Set when the report on screen came from history rather than this session. */
  const [historic, setHistoric] = useState(false);
  /** A stored report from a run core recorded as failed — shown, not hidden. */
  const [failedJob, setFailedJob] = useState(false);

  const jobs = useAsync(() => importJobs().catch(() => [] as ImportJobInfo[]), []);
  const jobList = jobs.data ?? [];
  const prior = useMemo(() => findPriorImport(plan, jobList), [plan, jobList]);

  /** The run whose events we are listening for; stale jobs are ignored. */
  const jobIdRef = useRef<string | null>(null);

  // Progress + terminal events for the active run. Subscribed for the lifetime
  // of the hub rather than only while running: a `done` that lands during the
  // React commit between "started" and "listening" would otherwise be lost.
  useEffect(() => {
    const offProgress = onImportProgress((event) => {
      if (event.jobId !== jobIdRef.current) return;
      setProgress((state) =>
        reduceProgress(state, {
          type: "progress",
          progress: { stage: event.stage, done: event.done, total: event.total },
        }),
      );
    });
    const offDone = onImportDone((event) => {
      if (event.jobId !== jobIdRef.current) return;
      jobIdRef.current = null;
      if (event.report) {
        setProgress((state) => reduceProgress(state, { type: "done", report: event.report as ImportReport }));
        setReport(event.report);
        setHistoric(false);
        setFailedJob(false);
        setPhase("report");
      } else {
        const message = event.error?.message ?? "The import failed.";
        setProgress((state) => reduceProgress(state, { type: "error", message }));
        setFailure(message);
        setPhase("error");
      }
      jobs.reload();
    });
    return () => {
      offProgress();
      offDone();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = useCallback((): void => {
    setPhase("idle");
    setSource(null);
    setPlan(null);
    setReport(null);
    setFailure(null);
    setHistoric(false);
    setFailedJob(false);
    setProgress(initialProgress());
  }, []);

  const choose = useCallback(async (path: string): Promise<void> => {
    setSource(path);
    setPlan(null);
    setReport(null);
    setFailure(null);
    setHistoric(false);
    setFailedJob(false);
    setPhase("planning");
    try {
      const summary = await importPlan(path);
      setPlan(summary);
      setPhase("plan");
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "That export could not be read.");
      setPhase("error");
    }
  }, []);

  const browse = useCallback(
    async (kind: "zip" | "folder"): Promise<void> => {
      const path = await pickImportSource(kind);
      if (path) await choose(path);
    },
    [choose],
  );

  const start = useCallback(async (): Promise<void> => {
    if (!source) return;
    setProgress(initialProgress());
    setFailure(null);
    setPhase("running");
    try {
      jobIdRef.current = await importRun(source);
    } catch (err) {
      jobIdRef.current = null;
      setFailure(err instanceof Error ? err.message : "The import could not be started.");
      setPhase("error");
    }
  }, [source]);

  const showHistoricReport = useCallback((stored: ImportReport, jobFailed: boolean): void => {
    setReport(stored);
    setHistoric(true);
    setFailedJob(jobFailed);
    setPhase("report");
    setTab("discover");
  }, []);

  return (
    <div className="settings__section">
      <div className="settings__head">
        <h2 className="settings__title">Import</h2>
        <p className="settings__sub">
          Bring a Notion export into this workspace. Nothing is written until you confirm the plan.
        </p>
      </div>

      <div className="tabs" role="tablist" aria-label="Import">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "discover"}
          className={cx("tabs__tab", tab === "discover" && "is-active")}
          onClick={() => setTab("discover")}
        >
          Discover
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "completed"}
          className={cx("tabs__tab", tab === "completed" && "is-active")}
          onClick={() => setTab("completed")}
        >
          Completed
          {jobList.length > 0 ? <span className="tabs__count">{jobList.length}</span> : null}
        </button>
      </div>

      {tab === "completed" ? (
        <CompletedTab
          jobs={jobList}
          loading={jobs.loading && !jobs.data}
          onImportSomething={() => {
            setTab("discover");
            reset();
          }}
          onViewReport={showHistoricReport}
        />
      ) : phase === "report" && report ? (
        <ReportView report={report} historic={historic} failed={failedJob} onDone={reset} />
      ) : phase === "error" ? (
        <FailureCard
          message={failure ?? "Something went wrong."}
          onRetry={() => {
            if (source) void choose(source);
            else reset();
          }}
          onCancel={reset}
        />
      ) : phase === "running" ? (
        <ProgressView state={progress} sourcePath={source ?? ""} />
      ) : phase === "planning" ? (
        <PlanningCard sourcePath={source ?? ""} />
      ) : phase === "plan" && plan ? (
        <PlanView
          plan={plan}
          prior={prior}
          onCancel={reset}
          onConfirm={() => void start()}
        />
      ) : (
        <DropZone onPath={(path) => void choose(path)} onBrowse={(kind) => void browse(kind)} />
      )}
    </div>
  );
}

/* --------------------------------------------------------------- drop zone */

function DropZone({
  onPath,
  onBrowse,
}: {
  onPath(path: string): void;
  onBrowse(kind: "zip" | "folder"): void;
}): JSX.Element {
  const [over, setOver] = useState(false);

  return (
    <div
      className={cx("dropzone", over && "is-over")}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        // `File.path` is gone in modern Electron; preload's webUtils bridge is
        // the only way back to a real path.
        const paths = Array.from(e.dataTransfer.files).map((file) => pathForFile(file));
        const picked = pickDroppedSource(paths);
        if ("error" in picked) toastError(new Error(picked.error), picked.error);
        else onPath(picked.path);
      }}
    >
      <div className="dropzone__icon" aria-hidden="true">
        <ImportIcon width={22} height={22} />
      </div>
      <div className="dropzone__title">
        Drag a Notion export (.zip or folder) here, or choose a file
      </div>
      <div className="dropzone__hint">
        Markdown &amp; CSV exports — the format Notion produces from Settings → Export.
      </div>
      <div className="dropzone__actions">
        <button type="button" className="btn btn--primary" onClick={() => onBrowse("zip")}>
          <ArchiveIcon />
          Choose .zip
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => onBrowse("folder")}>
          <FolderIcon />
          Choose folder
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- plan states */

function PlanningCard({ sourcePath }: { sourcePath: string }): JSX.Element {
  return (
    <div className="card card--center">
      <div className="spinner" aria-hidden="true" />
      <div className="card__title">Reading {sourceName(sourcePath)}</div>
      <div className="card__body">
        Kumi is inspecting the export without changing anything in your workspace.
      </div>
    </div>
  );
}

function PlanView({
  plan,
  prior,
  onCancel,
  onConfirm,
}: {
  plan: ImportPlanSummary;
  prior: ImportJobInfo | null;
  onCancel(): void;
  onConfirm(): void;
}): JSX.Element {
  // Open by default: the warnings are where "your relations arrive as text"
  // lives, and that is exactly the sentence somebody must read before saying
  // yes. Collapsible, so a noisy export can still be folded away.
  const [showWarnings, setShowWarnings] = useState(true);
  const warnings = warningSummary(plan);
  const unsupported = unsupportedSummary(plan);

  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">{sourceName(plan.sourcePath)}</div>
        <div className="card__body">Everything below lands under one new page in this workspace.</div>
      </div>

      <div className="countgrid">
        {planCounts(plan).map((count) => (
          <div key={count.key} className="countgrid__cell">
            <div className="countgrid__value">{count.value.toLocaleString()}</div>
            <div className="countgrid__label">{count.label}</div>
          </div>
        ))}
      </div>

      {prior ? (
        <div className="note note--warn">
          <AlertIcon />
          <span>{REIMPORT_NOTE}</span>
        </div>
      ) : null}

      {warnings ? (
        <div className="disclosure">
          <button
            type="button"
            className="disclosure__head"
            aria-expanded={showWarnings}
            onClick={() => setShowWarnings((v) => !v)}
          >
            <span className={cx("disclosure__caret", showWarnings && "is-open")} aria-hidden="true" />
            {warnings}
          </button>
          {showWarnings ? (
            <ul className="disclosure__list">
              {plan.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {unsupported ? (
        <div className="unsupported">
          <div className="unsupported__head">{unsupported}</div>
          {plan.unsupported.map((item, index) => (
            <div key={`${index}-${item.kind}-${item.detail}`} className="unsupported__row">
              <span className="unsupported__kind">{item.kind}</span>
              <span className="unsupported__detail">{item.detail}</span>
              <span className="unsupported__count">{item.count}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="card__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={planIsEmpty(plan)}
          onClick={onConfirm}
        >
          {importButtonLabel(plan)}
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- progress */

function ProgressView({
  state,
  sourcePath,
}: {
  state: ProgressState;
  sourcePath: string;
}): JSX.Element {
  const percent = overallPercent(state);
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">Importing {sourceName(sourcePath)}</div>
        <div className="card__body">
          This runs in the background — the window stays usable, but avoid editing the imported
          pages until it finishes.
        </div>
      </div>

      <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress__fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="progress__counter">
        {progressCounter(state)}
        <span className="progress__percent">{percent}%</span>
      </div>

      <ol className="checklist">
        {IMPORT_STAGES.map((stage) => {
          const status = stageStatus(state, stage);
          return (
            <li key={stage} className={cx("checklist__row", `is-${status}`)}>
              <span className="checklist__mark" aria-hidden="true">
                {status === "done" ? <CheckIcon width={12} height={12} /> : null}
              </span>
              <span className="checklist__label">{stageLabel(stage)}</span>
              <span className="checklist__hint">{stageHint(stage)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------ report */

function ReportView({
  report,
  historic,
  failed,
  onDone,
}: {
  report: ImportReport;
  historic: boolean;
  /** The stored job was recorded as failed; its reason lives in the warnings. */
  failed: boolean;
  onDone(): void;
}): JSX.Element {
  const openPage = useUi((s) => s.openPage);
  const closeSettings = useUi((s) => s.closeSettings);
  const losses = lossRows(report);

  const save = async (): Promise<void> => {
    try {
      const result = await saveJson(reportFileName(report), reportJson(report));
      if (!result.path) return;
      const path = result.path;
      toastAction("Import report saved.", "Show in folder", () => void showInFolder(path));
    } catch (err) {
      toastError(err, "The report could not be saved.");
    }
  };

  const openRoot = (): void => {
    if (!report.rootPageId) return;
    openPage(report.rootPageId);
    void commands.touchRecent(report.rootPageId);
    closeSettings();
  };

  return (
    <div className="card">
      <div className="card__head">
        {failed ? (
          <div className="note note--error">
            <AlertIcon />
            <span>
              <strong>This import failed.</strong> Anything it had written was rolled back — the
              reason is listed below.
            </span>
          </div>
        ) : (
          <div className={cx("note", report.losses.length === 0 ? "note--ok" : "note--warn")}>
            {report.losses.length === 0 ? <CheckIcon /> : <AlertIcon />}
            <span>
              <strong>{successSummary(report)}</strong> {lossSummary(report)}
            </span>
          </div>
        )}
      </div>

      <div className="countgrid">
        <Cell label="Pages" value={report.counts.pages} />
        <Cell label="Databases" value={report.counts.dataSources} />
        <Cell label="Rows" value={report.counts.rows} />
        <Cell label="Assets" value={report.counts.assets} />
      </div>

      {report.warnings.length > 0 ? (
        <ul className="disclosure__list">
          {report.warnings.map((warning, index) => (
            <li key={`${index}-${warning}`}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {losses.length > 0 ? (
        <div className="losstable">
          <div className="losstable__head">
            <span>Kind</span>
            <span>Source</span>
            <span>Detail</span>
          </div>
          <div className="losstable__body">
            {losses.map((loss) => (
              <div key={loss.key} className="losstable__row">
                <span className="losstable__kind">{loss.kind}</span>
                <span className="losstable__ref" title={loss.sourceRef}>
                  {loss.sourceRef}
                </span>
                <span className="losstable__detail">{loss.detail}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="card__actions">
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          {historic ? "Back" : "Import another"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={() => void save()}>
          Save loss report
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!report.rootPageId}
          onClick={openRoot}
        >
          Open imported root
        </button>
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="countgrid__cell">
      <div className="countgrid__value">{value.toLocaleString()}</div>
      <div className="countgrid__label">{label}</div>
    </div>
  );
}

function FailureCard({
  message,
  onRetry,
  onCancel,
}: {
  message: string;
  onRetry(): void;
  onCancel(): void;
}): JSX.Element {
  return (
    <div className="card">
      <div className="note note--error">
        <AlertIcon />
        <span>
          <strong>The import did not finish.</strong> Nothing was committed to your workspace.
        </span>
      </div>
      <pre className="card__code">{message}</pre>
      <div className="card__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Choose another export
        </button>
        <button type="button" className="btn btn--primary" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- completed */

function CompletedTab({
  jobs,
  loading,
  onImportSomething,
  onViewReport,
}: {
  jobs: ImportJobInfo[];
  loading: boolean;
  onImportSomething(): void;
  onViewReport(report: ImportReport, failed: boolean): void;
}): JSX.Element {
  if (loading) {
    return (
      <div className="card">
        <div className="skeleton" style={{ width: "60%", marginBottom: 10 }} />
        <div className="skeleton" style={{ width: "40%" }} />
      </div>
    );
  }

  if (jobs.length === 0) {
    return (
      <div className="card card--center">
        <div className="card__title">No imports yet</div>
        <div className="card__body">Finished imports are kept here with their full report.</div>
        <button type="button" className="btn btn--primary" onClick={onImportSomething}>
          Import a Notion export
        </button>
      </div>
    );
  }

  return (
    <div className="joblist">
      {jobRows(jobs).map((row) => (
        <div key={row.id} className="jobrow">
          <div className="jobrow__main">
            <div className="jobrow__title">
              {row.sourceName}
              <span
                className={cx("statuschip", row.status === "committed" ? "is-ok" : "is-failed")}
              >
                {row.statusLabel}
              </span>
            </div>
            <div className="jobrow__meta">
              {row.dateLabel} · {row.countsLabel}
              {row.lossCount > 0 ? ` · ${row.lossCount} noted losses` : ""}
            </div>
            {row.failureNote ? <div className="jobrow__fail">{row.failureNote}</div> : null}
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            disabled={!row.report}
            onClick={() => {
              if (row.report) onViewReport(row.report, row.status === "failed");
            }}
          >
            View report
          </button>
        </div>
      ))}
    </div>
  );
}
