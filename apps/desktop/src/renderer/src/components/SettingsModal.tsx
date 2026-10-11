/**
 * Settings, as the fidelity reference draws it (Figs. 17–18): a wide modal with
 * a persistent left nav rail and one section rendered beside it. Phase 6's
 * settings popover carried theme and the workspace export in a 220 px menu;
 * Phase 7's import hub needs room to show counts, warnings and a loss table, so
 * the popover grows up into the real thing and the old contents move into
 * Preferences and Export unchanged.
 */
import type { UserState } from "@kumi/core";
import { commands } from "../ipc";
import { useUi, type SettingsSection } from "../store";
import { useWorkspaceInfo } from "../data";
import { cx } from "../utils";
import { Modal, Toggle } from "./ui";
import { ExportIcon, ImportIcon, SlidersIcon } from "./icons";
import { exportWorkspaceJson } from "./exportActions";
import { ImportHub } from "./ImportHub";

const SECTIONS: { key: SettingsSection; label: string; icon: JSX.Element }[] = [
  { key: "preferences", label: "Preferences", icon: <SlidersIcon /> },
  { key: "import", label: "Import", icon: <ImportIcon /> },
  { key: "export", label: "Export", icon: <ExportIcon /> },
];

export function SettingsModal(): JSX.Element | null {
  const open = useUi((s) => s.settingsOpen);
  const section = useUi((s) => s.settingsSection);
  const close = useUi((s) => s.closeSettings);
  const select = useUi((s) => s.setSettingsSection);

  if (!open) return null;

  return (
    <Modal open={open} onClose={close} className="modal--settings" label="Settings">
      <div className="settings">
        <nav className="settings__nav" aria-label="Settings sections">
          <div className="settings__navtitle">Workspace</div>
          {SECTIONS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={cx("settings__navitem", section === item.key && "is-active")}
              aria-current={section === item.key ? "page" : undefined}
              onClick={() => select(item.key)}
            >
              <span className="row__icon">{item.icon}</span>
              <span className="row__label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings__pane">
          {/* Fig. 20 pins an explicit dismiss in the pane's top-right corner. */}
          <button
            type="button"
            className="iconbtn settings__close"
            aria-label="Close settings"
            onClick={close}
          >
            ✕
          </button>
          {section === "import" ? (
            <ImportHub />
          ) : section === "export" ? (
            <ExportSection />
          ) : (
            <PreferencesSection />
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------ preferences */

const THEMES: { key: UserState["theme"]; label: string; hint: string }[] = [
  { key: "system", label: "Use system setting", hint: "Follows Windows' light/dark preference" },
  { key: "light", label: "Light", hint: "Always the warm-white workspace" },
  { key: "dark", label: "Dark", hint: "Always the dark workspace" },
];

function PreferencesSection(): JSX.Element {
  const theme = useUi((s) => s.theme);
  const setThemeLocal = useUi((s) => s.setThemeLocal);
  const info = useWorkspaceInfo();

  const pick = (next: UserState["theme"]): void => {
    setThemeLocal(next);
    void commands.setTheme(next);
  };

  return (
    <div className="settings__section">
      <div className="settings__head">
        <h2 className="settings__title">Preferences</h2>
        <p className="settings__sub">How Kumi looks on this machine.</p>
      </div>

      <div className="settings__group">
        <div className="settings__grouptitle">Appearance</div>
        {THEMES.map((option) => (
          <button
            key={option.key}
            type="button"
            className="settings__row"
            aria-pressed={theme === option.key}
            onClick={() => pick(option.key)}
          >
            <span className="settings__rowmain">
              <span className="settings__rowlabel">{option.label}</span>
              <span className="settings__rowhint">{option.hint}</span>
            </span>
            <Toggle on={theme === option.key} />
          </button>
        ))}
      </div>

      <div className="settings__group">
        <div className="settings__grouptitle">Workspace folder</div>
        <div className="settings__path">{info.data?.path ?? "…"}</div>
        <div className="settings__rowhint">
          Everything lives here: <code>kumi.db</code> and <code>assets/</code>. Copy the folder to
          move your workspace.
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- export */

function ExportSection(): JSX.Element {
  return (
    <div className="settings__section">
      <div className="settings__head">
        <h2 className="settings__title">Export</h2>
        <p className="settings__sub">Take your data out in a format that comes back in.</p>
      </div>

      <div className="card">
        <div className="card__title">Workspace JSON</div>
        <div className="card__body">
          A full-fidelity snapshot of every page, block, database and view — the round-trip format.
          Per-page Markdown and PDF live in the page ⋯ menu.
        </div>
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void exportWorkspaceJson()}
          >
            Export workspace (JSON)
          </button>
        </div>
      </div>
    </div>
  );
}
