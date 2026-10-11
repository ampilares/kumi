/**
 * Version history (spec Fig. 6).
 *
 * A right-side panel rather than a modal: the page stays where it is and the
 * canvas swaps the live editor for a read-only render of the selected
 * revision, so choosing an entry is an inspection, not a navigation. The two
 * halves talk through `historySnapshotId` in the UI store.
 *
 * Restore is the only write here, and it goes through a confirm dialog because
 * core snapshots the current content first — nothing already in the list is
 * ever destroyed (build plan REC-01).
 */
import { useMemo, useState } from "react";
import type { Page } from "@kumi/core";
import { commands } from "../ipc";
import { useUi } from "../store";
import { useBlocks, useSnapshot, useSnapshots } from "../data";
import { cx, displayTitle } from "../utils";
import {
  causeLabel,
  formatDate,
  formatTime,
  groupSnapshotsByDay,
  newestSnapshotId,
  removedStrips,
  restoreWarning,
} from "../lib/phase6";
import { ConfirmDialog } from "./ui";
import { ReadOnlyBlocks } from "./ReadOnlyBlocks";
import { toastError, toastInfo } from "./Toasts";

/**
 * Selected revision, defaulting to the newest.
 *
 * Deliberately does *not* "heal" a selection that is missing from the current
 * list: after a manual save the store holds the new snapshot's id a beat before
 * the refetch delivers it, and treating that gap as staleness snapped the
 * selection back to the previous newest entry. Core never deletes a snapshot,
 * so an id that is absent is always just early — `openHistory` clears the
 * selection, which is the only reset this needs.
 */
function useSelectedSnapshotId(newest: string | null): string | null {
  const selected = useUi((s) => s.historySnapshotId);
  return selected ?? newest;
}

export function HistoryPanel({ page }: { page: Page }): JSX.Element {
  const closeHistory = useUi((s) => s.closeHistory);
  const select = useUi((s) => s.selectHistorySnapshot);
  const snapshots = useSnapshots(page.id);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [busy, setBusy] = useState(false);

  const list = snapshots.data ?? [];
  const groups = useMemo(() => groupSnapshotsByDay(list), [list]);
  const selectedId = useSelectedSnapshotId(newestSnapshotId(list));

  const snapshot = useSnapshot(selectedId);
  const liveBlocks = useBlocks(page.id);
  const strips = useMemo(
    () => removedStrips(liveBlocks.data ?? [], snapshot.data?.blocks ?? []),
    [liveBlocks.data, snapshot.data],
  );
  const warning = snapshot.data ? restoreWarning(strips.length) : null;

  const saveNow = async (): Promise<void> => {
    setBusy(true);
    try {
      const meta = await commands.snapshotPage(page.id, "manual");
      select(meta.id);
      toastInfo("Version saved.");
    } catch (err) {
      toastError(err, "This version could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (): Promise<void> => {
    if (!selectedId) return;
    setConfirmRestore(false);
    setBusy(true);
    try {
      await commands.restoreSnapshot(selectedId);
      toastInfo("Version restored.");
      closeHistory();
    } catch (err) {
      toastError(err, "This version could not be restored.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <aside className="history" aria-label="Version history">
        <div className="history__head">
          <div className="history__title">Version history</div>
          <button
            type="button"
            className="iconbtn"
            title="Close history"
            aria-label="Close history"
            onClick={closeHistory}
          >
            ✕
          </button>
        </div>

        <div className="history__top">
          <button
            type="button"
            className="btn btn--ghost history__save"
            disabled={busy}
            onClick={() => void saveNow()}
          >
            Save current version
          </button>
        </div>

        <div className="history__list">
          {snapshots.loading && !snapshots.data ? (
            <div className="history__empty">Loading versions…</div>
          ) : snapshots.error ? (
            <div className="history__empty">{snapshots.error.message}</div>
          ) : groups.length === 0 ? (
            <div className="history__empty">
              No versions yet. Kumi saves one as you edit — or save one now.
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="history__day">
                <div className="history__daylabel">{group.label}</div>
                {group.snapshots.map((meta) => (
                  <button
                    key={meta.id}
                    type="button"
                    className={cx("history__entry", meta.id === selectedId && "is-selected")}
                    aria-pressed={meta.id === selectedId}
                    onClick={() => select(meta.id)}
                  >
                    <span className="history__entrytime">
                      {formatDate(meta.createdAt)} · {formatTime(meta.createdAt)}
                    </span>
                    <span className={cx("history__cause", `history__cause--${meta.cause}`)}>
                      {causeLabel(meta.cause)}
                    </span>
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        {strips.length > 0 ? (
          <div className="history__removed">
            <div className="history__removedhead">Deleted content</div>
            {strips.map((strip) => (
              <div key={strip.id} className="history__strip" title={strip.text}>
                {strip.text}
              </div>
            ))}
          </div>
        ) : null}

        <div className="history__foot">
          {warning ? <div className="history__warn">{warning}</div> : null}
          <div className="history__learn">
            Restoring saves your current content as a new version first, so nothing is lost.
          </div>
          <button
            type="button"
            className="btn btn--primary history__restore"
            disabled={busy || page.locked || selectedId === null}
            title={
              page.locked
                ? "This page is locked. Unlock it from the ⋯ menu to restore a version."
                : "Restore this version"
            }
            onClick={() => setConfirmRestore(true)}
          >
            Restore
          </button>
        </div>
      </aside>

      <ConfirmDialog
        open={confirmRestore}
        title="Restore this version?"
        body="Current content is saved as a new version first."
        confirmLabel="Restore"
        onCancel={() => setConfirmRestore(false)}
        onConfirm={() => void restore()}
      />
    </>
  );
}

/**
 * What the canvas shows instead of the editor while history is open: the
 * banner plus a read-only render of the selected revision.
 */
export function HistoryPreview({ page }: { page: Page }): JSX.Element {
  const closeHistory = useUi((s) => s.closeHistory);
  const snapshots = useSnapshots(page.id);
  const list = snapshots.data ?? [];
  const selectedId = useSelectedSnapshotId(newestSnapshotId(list));
  const snapshot = useSnapshot(selectedId);
  const data = snapshot.data;

  return (
    <div className={cx("page", page.fullWidth && "page--wide", page.smallText && "page--small")}>
      <div className="historyview__banner">
        <span>
          {data
            ? `Viewing a version from ${formatDate(data.meta.createdAt)} · ${formatTime(data.meta.createdAt)}`
            : "Viewing version history"}
        </span>
        <button type="button" className="btn btn--ghost" onClick={closeHistory}>
          Close
        </button>
      </div>

      {data ? (
        <>
          {data.icon ? <div className="page__icon">{data.icon}</div> : null}
          <div className="page__title page__title--static">{displayTitle(data.title)}</div>
          <ReadOnlyBlocks blocks={data.blocks} />
        </>
      ) : snapshot.loading ? (
        <div className="skeleton" style={{ width: "60%", height: 24, marginTop: 24 }} />
      ) : (
        <div className="history__empty" style={{ marginTop: 24 }}>
          Select a version on the right to preview it.
        </div>
      )}
    </div>
  );
}
