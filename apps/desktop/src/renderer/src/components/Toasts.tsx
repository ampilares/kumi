/**
 * Transient bottom-left notices.
 *
 * Phase 4 needs somewhere for a rejected write to land: a cell reverts to the
 * server value and the reason shows here rather than in a blocking dialog, so
 * the table stays usable. Deliberately tiny — one store, one renderer.
 */

import { create } from "zustand";
import { cx } from "../utils";

export interface Toast {
  id: string;
  message: string;
  tone: "error" | "info";
  /** Optional trailing button — Phase 6's "Show in folder" after an export. */
  action?: { label: string; run(): void };
}

interface ToastState {
  toasts: Toast[];
  push(message: string, tone?: Toast["tone"], action?: Toast["action"]): void;
  dismiss(id: string): void;
}

/** Longer for actionable notices — the user has to decide, not just read. */
const TOAST_MS = 4200;
const TOAST_ACTION_MS = 9000;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (message, tone = "error", action) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts, { id, message, tone, ...(action ? { action } : {}) }] }));
    window.setTimeout(
      () => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },
      action ? TOAST_ACTION_MS : TOAST_MS,
    );
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Imperative entry point — callable from non-React code (cell commits). */
export function toastError(error: unknown, fallback = "That change could not be saved."): void {
  const message = error instanceof Error && error.message !== "" ? error.message : fallback;
  useToasts.getState().push(message, "error");
}

export function toastInfo(message: string): void {
  useToasts.getState().push(message, "info");
}

/** Info toast with one trailing button (e.g. "Show in folder" after an export). */
export function toastAction(message: string, label: string, run: () => void): void {
  useToasts.getState().push(message, "info", { label, run });
}

export function Toasts(): JSX.Element | null {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) =>
        toast.action ? (
          <div
            key={toast.id}
            className={cx("toast", "toast--rich", toast.tone === "error" && "toast--error")}
          >
            <span className="toast__text">{toast.message}</span>
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                toast.action?.run();
                dismiss(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          </div>
        ) : (
          <button
            key={toast.id}
            type="button"
            className={cx("toast", toast.tone === "error" && "toast--error")}
            onClick={() => dismiss(toast.id)}
            title="Dismiss"
          >
            {toast.message}
          </button>
        ),
      )}
    </div>
  );
}
