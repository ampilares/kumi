import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, useDismiss, useFocusTrap } from "../hooks";
import { cx } from "../utils";
import { EMOJI_CHOICES } from "../utils";

/* ------------------------------------------------------------------ popover */

interface PopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose(): void;
  align?: "start" | "end";
  width?: number;
  children: ReactNode;
  label?: string;
}

/** Anchored floating surface. Closes on Escape and outside pointerdown. */
export function Popover({
  open,
  anchorRef,
  onClose,
  align = "start",
  width,
  children,
  label,
}: PopoverProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchorRef, ref, open, align);
  useDismiss(open, [ref, anchorRef], onClose);

  if (!open) return null;
  return createPortal(
    <div
      ref={ref}
      className="popover"
      role="dialog"
      aria-label={label ?? "Menu"}
      style={{ top: pos.top, left: pos.left, width }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* -------------------------------------------------------------- menu pieces */

export function MenuItem({
  icon,
  label,
  hint,
  danger,
  onSelect,
  trailing,
}: {
  icon?: ReactNode;
  label: string;
  hint?: string;
  danger?: boolean;
  onSelect(): void;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className={cx("menuitem", danger && "menuitem--danger")}
      onClick={onSelect}
    >
      {icon ? <span className="row__icon">{icon}</span> : null}
      <span className="menuitem__label">{label}</span>
      {hint ? <span className="menuitem__hint">{hint}</span> : null}
      {trailing}
    </button>
  );
}

export function MenuSeparator(): JSX.Element {
  return <div className="menu__sep" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }): JSX.Element {
  return <div className="menu__label">{children}</div>;
}

export function Toggle({ on }: { on: boolean }): JSX.Element {
  return <span className={cx("switch", on && "is-on")} aria-hidden="true" />;
}

/* -------------------------------------------------------------------- modal */

export function Modal({
  open,
  onClose,
  children,
  className,
  label,
  dismissIgnoreSelector,
}: {
  open: boolean;
  onClose(): void;
  children: ReactNode;
  className?: string;
  label: string;
  /** Portalled surfaces that count as "inside" — see `useDismiss`. */
  dismissIgnoreSelector?: string;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, [ref], onClose, dismissIgnoreSelector);
  useFocusTrap(ref, open);

  if (!open) return null;
  return createPortal(
    <div className="overlay">
      <div ref={ref} className={cx("modal", className)} role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): void;
  onCancel(): void;
}): JSX.Element | null {
  return (
    <Modal open={open} onClose={onCancel} className="modal--confirm" label={title}>
      <div className="modal__title">{title}</div>
      <div className="modal__text">{body}</div>
      <div className="modal__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className={cx("btn", danger ? "btn--danger" : "btn--primary")}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * One-field prompt. Used by "Save as template", where `window.prompt` is not
 * an option (Electron renders it as a bare Chromium dialog outside the theme).
 */
export function NamePrompt({
  open,
  title,
  initial,
  confirmLabel,
  onSubmit,
  onCancel,
}: {
  open: boolean;
  title: string;
  initial: string;
  confirmLabel: string;
  onSubmit(value: string): void;
  onCancel(): void;
}): JSX.Element | null {
  const [value, setValue] = useState(initial);

  // The prompt is remounted per opening by its `open` gate below, but the
  // default has to follow whatever page the user opened it from.
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  if (!open) return null;
  const submit = (): void => {
    if (value.trim() !== "") onSubmit(value);
  };

  return (
    <Modal open={open} onClose={onCancel} className="modal--confirm" label={title}>
      <div className="modal__title">{title}</div>
      <input
        className="field"
        autoFocus
        maxLength={100}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="modal__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          disabled={value.trim() === ""}
          onClick={submit}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------- emoji picker */

export function EmojiPicker({
  onPick,
  onRemove,
}: {
  onPick(emoji: string): void;
  onRemove?: () => void;
}): JSX.Element {
  return (
    <div>
      <MenuLabel>Emoji</MenuLabel>
      <div className="emoji-grid">
        {EMOJI_CHOICES.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className="emoji"
            title={emoji}
            onClick={() => onPick(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {onRemove ? (
        <>
          <MenuSeparator />
          <MenuItem label="Remove" onSelect={onRemove} />
        </>
      ) : null}
    </div>
  );
}
