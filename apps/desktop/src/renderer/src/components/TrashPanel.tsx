import { useState } from "react";
import type { Page } from "@kumi/core";
import { commands } from "../ipc";
import { useTrash } from "../data";
import { useUi } from "../store";
import { displayTitle, formatDate } from "../utils";
import { ConfirmDialog } from "./ui";
import { DocIcon } from "./icons";

export function TrashPanel(): JSX.Element {
  const trash = useTrash(true);
  const openPage = useUi((s) => s.openPage);
  const [pending, setPending] = useState<Page | null>(null);
  const pages = trash.data ?? [];

  return (
    <div className="panel">
      <h1 className="panel__title">Trash</h1>
      <p className="panel__sub">
        Pages you delete land here. Restore them, or delete them forever.
      </p>

      {trash.error ? (
        <div className="empty-hint">Could not load trash: {trash.error.message}</div>
      ) : trash.loading && !trash.data ? (
        <div className="skeleton" style={{ width: 220 }} />
      ) : pages.length === 0 ? (
        <div className="empty-hint">Trash is empty.</div>
      ) : (
        pages.map((page) => (
          <div key={page.id} className="trash-row">
            <span className="row__icon">{page.icon ?? <DocIcon />}</span>
            <button
              type="button"
              className="trash-row__title"
              style={{ textAlign: "left" }}
              onClick={() => openPage(page.id)}
            >
              {displayTitle(page.title)}
            </button>
            <span className="trash-row__date">
              {page.deletedAt ? formatDate(page.deletedAt) : ""}
            </span>
            <button
              type="button"
              className="linkbtn"
              onClick={() => void commands.restorePage(page.id)}
            >
              Restore
            </button>
            <button
              type="button"
              className="linkbtn linkbtn--danger"
              onClick={() => setPending(page)}
            >
              Delete forever
            </button>
          </div>
        ))
      )}

      <ConfirmDialog
        open={pending !== null}
        title="Delete forever?"
        body={`“${displayTitle(pending?.title)}” and everything inside it will be permanently deleted. This cannot be undone.`}
        confirmLabel="Delete forever"
        danger
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (pending) void commands.deletePagePermanently(pending.id);
          setPending(null);
        }}
      />
    </div>
  );
}
