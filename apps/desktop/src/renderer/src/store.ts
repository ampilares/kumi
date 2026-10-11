import { create } from "zustand";
import type { UserState } from "@kumi/core";

export type ViewKind = "page" | "trash" | "empty" | "database";
export type SearchMode = "search" | "quick";
/** Left-nav sections of the settings modal (fidelity reference, Figs. 17–18). */
export type SettingsSection = "preferences" | "import" | "export";

const LS_KEY = "kumi.ui";

interface Persisted {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  lastPageId: string | null;
}

const RAIL_MIN = 220;
const RAIL_MAX = 360;
const RAIL_DEFAULT = 270;

function clampWidth(w: number): number {
  return Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(w)));
}

function loadPersisted(): Persisted {
  const fallback: Persisted = {
    sidebarWidth: RAIL_DEFAULT,
    sidebarCollapsed: false,
    lastPageId: null,
  };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      sidebarWidth: clampWidth(Number(parsed.sidebarWidth) || RAIL_DEFAULT),
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      lastPageId: typeof parsed.lastPageId === "string" ? parsed.lastPageId : null,
    };
  } catch {
    return fallback;
  }
}

interface UiState {
  view: ViewKind;
  currentPageId: string | null;
  /** Data source shown maximised by the "expand" toolbar button. */
  currentDataSourceId: string | null;
  sidebarWidth: number;
  sidebarCollapsed: boolean;
  /** Mirror of core's expandedPageIds, kept optimistic for instant chevrons. */
  expanded: Record<string, boolean>;
  theme: UserState["theme"];
  searchMode: SearchMode | null;
  /**
   * Page whose version history is open in the right panel, or null. Not
   * persisted: history is a transient inspection mode, and reopening the app
   * into a read-only past revision would be alarming.
   */
  historyPageId: string | null;
  /**
   * Revision selected in that panel. Lives here rather than in the panel because
   * the canvas renders the preview — one source of truth for "which version am
   * I looking at" keeps the two halves of Fig. 6 from disagreeing.
   */
  historySnapshotId: string | null;
  /** Bumped on every `kumi:changed` broadcast; hooks refetch when it moves. */
  revision: number;
  /**
   * Settings modal. Not persisted — but the *section* is remembered for the
   * session, so a user who was mid-import and closed the modal to look at a
   * page comes back to the import hub rather than to Preferences.
   */
  settingsOpen: boolean;
  settingsSection: SettingsSection;

  openPage(id: string): void;
  /** Full-page presentation of an inline database (the ⤢ toolbar button). */
  openDatabase(dataSourceId: string): void;
  openTrash(): void;
  showEmpty(): void;
  setSidebarWidth(w: number): void;
  toggleSidebar(force?: boolean): void;
  setExpandedLocal(id: string, expanded: boolean): void;
  hydrateExpanded(ids: string[]): void;
  setThemeLocal(theme: UserState["theme"]): void;
  openSearch(mode: SearchMode): void;
  closeSearch(): void;
  openHistory(pageId: string): void;
  closeHistory(): void;
  selectHistorySnapshot(snapshotId: string | null): void;
  bumpRevision(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  setSettingsSection(section: SettingsSection): void;
}

function persist(state: UiState): void {
  const data: Persisted = {
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    lastPageId: state.currentPageId,
  };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — non-fatal */
  }
}

const initial = loadPersisted();

export const useUi = create<UiState>((set, get) => ({
  view: initial.lastPageId ? "page" : "empty",
  currentPageId: initial.lastPageId,
  currentDataSourceId: null,
  sidebarWidth: initial.sidebarWidth,
  sidebarCollapsed: initial.sidebarCollapsed,
  expanded: {},
  theme: "system",
  searchMode: null,
  historyPageId: null,
  historySnapshotId: null,
  revision: 0,
  settingsOpen: false,
  settingsSection: "preferences",

  openPage(id) {
    set({
      view: "page",
      currentPageId: id,
      currentDataSourceId: null,
      searchMode: null,
      // Navigating away from the page whose history is open closes the panel.
      historyPageId: null,
      historySnapshotId: null,
    });
    persist(get());
  },
  openDatabase(dataSourceId) {
    set({
      view: "database",
      currentDataSourceId: dataSourceId,
      searchMode: null,
      historyPageId: null,
      historySnapshotId: null,
    });
  },
  openTrash() {
    set({ view: "trash", searchMode: null, historyPageId: null, historySnapshotId: null });
  },
  showEmpty() {
    set({ view: "empty", currentPageId: null, currentDataSourceId: null, historyPageId: null, historySnapshotId: null });
    persist(get());
  },
  setSidebarWidth(w) {
    set({ sidebarWidth: clampWidth(w) });
    persist(get());
  },
  toggleSidebar(force) {
    set((s) => ({ sidebarCollapsed: force ?? !s.sidebarCollapsed }));
    persist(get());
  },
  setExpandedLocal(id, expanded) {
    set((s) => ({ expanded: { ...s.expanded, [id]: expanded } }));
  },
  hydrateExpanded(ids) {
    set((s) => {
      const next: Record<string, boolean> = { ...s.expanded };
      for (const id of ids) if (next[id] === undefined) next[id] = true;
      return { expanded: next };
    });
  },
  setThemeLocal(theme) {
    set({ theme });
  },
  openSearch(mode) {
    set({ searchMode: mode });
  },
  closeSearch() {
    set({ searchMode: null });
  },
  openHistory(pageId) {
    set({ historyPageId: pageId, historySnapshotId: null });
  },
  closeHistory() {
    set({ historyPageId: null, historySnapshotId: null });
  },
  selectHistorySnapshot(snapshotId) {
    set({ historySnapshotId: snapshotId });
  },
  bumpRevision() {
    set((s) => ({ revision: s.revision + 1 }));
  },
  openSettings(section) {
    set((s) => ({ settingsOpen: true, settingsSection: section ?? s.settingsSection }));
  },
  closeSettings() {
    set({ settingsOpen: false });
  },
  setSettingsSection(section) {
    set({ settingsSection: section });
  },
}));

export const RAIL = { MIN: RAIL_MIN, MAX: RAIL_MAX, DEFAULT: RAIL_DEFAULT };
