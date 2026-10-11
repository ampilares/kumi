import { useEffect, useState } from "react";
import { getStatus, type WorkspaceStatus } from "./ipc";
import { useChangeBroadcast } from "./hooks";
import { useUi } from "./store";
import { createPage, usePage, useRootPages, useUserState } from "./data";
import { displayTitle } from "./utils";
import { Sidebar } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { PageView } from "./components/PageView";
import { TrashPanel } from "./components/TrashPanel";
import { SearchModal } from "./components/SearchModal";
import { SettingsModal } from "./components/SettingsModal";
import { Toasts } from "./components/Toasts";
import { FullPageDatabase } from "./database/FullPageDatabase";
import { HistoryPanel, HistoryPreview } from "./components/HistoryPanel";
import { PrintView } from "./components/PrintView";
import { DocIcon } from "./components/icons";
import { cx } from "./utils";
import { printRoutePageId } from "./lib/phase6";

export function App(): JSX.Element {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);

  useEffect(() => {
    void getStatus().then(setStatus);
  }, []);

  if (!status) return <div className="boot">Opening workspace…</div>;
  if (!status.ready) return <ErrorScreen status={status} />;
  // Main's PDF window loads this same bundle with `?print=1&page=<id>`; it wants
  // the page alone, so the app shell never mounts there.
  const printPageId = printRoutePageId(window.location.search);
  if (printPageId) return <PrintView pageId={printPageId} />;
  return <Workspace />;
}

function ErrorScreen({ status }: { status: WorkspaceStatus }): JSX.Element {
  return (
    <div className="errorscreen">
      <div className="empty__title">Kumi could not open your workspace</div>
      <div className="modal__text">
        The desktop shell started, but the storage engine (<code>@kumi/core</code>) did not.
        Build the core package and restart.
      </div>
      <div className="errorscreen__code">
        {status.error?.code ?? "UNKNOWN"}
        {"\n"}
        {status.error?.message ?? "No details available."}
        {"\n\n"}
        workspace: {status.path}
      </div>
      <div>
        <button type="button" className="btn btn--primary" onClick={() => location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

function Workspace(): JSX.Element {
  useChangeBroadcast();

  const view = useUi((s) => s.view);
  const currentPageId = useUi((s) => s.currentPageId);
  const currentDataSourceId = useUi((s) => s.currentDataSourceId);
  const searchMode = useUi((s) => s.searchMode);
  const openSearch = useUi((s) => s.openSearch);
  const setThemeLocal = useUi((s) => s.setThemeLocal);
  const hydrateExpanded = useUi((s) => s.hydrateExpanded);
  const theme = useUi((s) => s.theme);
  const showEmpty = useUi((s) => s.showEmpty);

  const userState = useUserState();
  const currentPage = usePage(view === "page" ? currentPageId : null);

  // Hydrate persisted user state once it arrives.
  useEffect(() => {
    if (!userState.data) return;
    setThemeLocal(userState.data.theme);
    hydrateExpanded(userState.data.expandedPageIds);
  }, [userState.data, setThemeLocal, hydrateExpanded]);

  // Theme: explicit choice wins, otherwise follow the OS.
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && media.matches);
      document.documentElement.dataset["theme"] = dark ? "dark" : "light";
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  // Global shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        void createPage(null);
      } else if (key === "p" || key === "k") {
        e.preventDefault();
        openSearch("quick");
      } else if (key === "f") {
        e.preventDefault();
        openSearch("search");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  // A trashed or missing current page falls back to Home.
  useEffect(() => {
    if (view === "page" && currentPageId && currentPage.data === null && !currentPage.loading) {
      showEmpty();
    }
  }, [view, currentPageId, currentPage.data, currentPage.loading, showEmpty]);

  const page = view === "page" ? (currentPage.data ?? null) : null;
  const historyPageId = useUi((s) => s.historyPageId);
  const historyPage = page && page.id === historyPageId ? page : null;

  return (
    <div className="app">
      <Sidebar userState={userState.data} />
      <main className={cx("canvas", historyPage && "canvas--history")}>
        <TopBar page={page} favoriteIds={userState.data?.favorites ?? []} />
        <div className="scroller">
          {view === "trash" ? (
            <TrashPanel />
          ) : view === "database" && currentDataSourceId ? (
            <FullPageDatabase key={currentDataSourceId} dataSourceId={currentDataSourceId} />
          ) : historyPage ? (
            <HistoryPreview key={`history-${historyPage.id}`} page={historyPage} />
          ) : page ? (
            <PageView key={page.id} page={page} />
          ) : view === "page" ? (
            <div className="panel">
              <div className="skeleton" style={{ width: "45%", height: 28, marginBottom: 18 }} />
              <div className="skeleton" style={{ width: "70%", marginBottom: 10 }} />
              <div className="skeleton" style={{ width: "55%" }} />
            </div>
          ) : (
            <Home />
          )}
        </div>
      </main>
      {historyPage ? <HistoryPanel key={historyPage.id} page={historyPage} /> : null}
      {searchMode ? <SearchModal mode={searchMode} /> : null}
      <SettingsModal />
      <Toasts />
    </div>
  );
}

function Home(): JSX.Element {
  const roots = useRootPages();
  const openPage = useUi((s) => s.openPage);
  const pages = roots.data ?? [];

  if (roots.loading && !roots.data) {
    return (
      <div className="panel">
        <div className="skeleton" style={{ width: 180, height: 24 }} />
      </div>
    );
  }

  if (pages.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">Your workspace is empty</div>
        <div className="empty__body">
          Pages are where everything in Kumi lives. Create your first one to get started.
        </div>
        <button type="button" className="btn btn--primary" onClick={() => void createPage(null)}>
          New page
        </button>
      </div>
    );
  }

  return (
    <div className="panel">
      <h1 className="panel__title">Home</h1>
      <p className="panel__sub">Jump back in</p>
      {pages.map((node) => (
        <button
          key={node.page.id}
          type="button"
          className="row"
          onClick={() => openPage(node.page.id)}
        >
          <span className="row__icon">{node.page.icon ?? <DocIcon />}</span>
          <span className="row__label">{displayTitle(node.page.title)}</span>
        </button>
      ))}
    </div>
  );
}
