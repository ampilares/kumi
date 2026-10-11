import { join } from "node:path";
import { app, BrowserWindow, Menu, nativeTheme, shell } from "electron";
import { registerIpc } from "./ipc";
import { registerAssetProtocol, registerAssetSchemePrivileges } from "./assets";
import { closeWorkspace, openWorkspaceSafely } from "./workspace";
import { stopImport } from "./importRunner";

const isDev = !app.isPackaged;

// Scheme privileges must be declared before the app is ready.
registerAssetSchemePrivileges();

function backgroundColor(): string {
  // Matches --bg-rail in the renderer token set so there is no white flash.
  return nativeTheme.shouldUseDarkColors ? "#191918" : "#FBFAF8";
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: backgroundColor(),
    autoHideMenuBar: true,
    title: "Kumi",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  win.once("ready-to-show", () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (isDev && devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return win;
}

app.whenReady().then(() => {
  if (!isDev) Menu.setApplicationMenu(null);

  const status = openWorkspaceSafely();
  if (!status.ready) {
    // Non-fatal: the renderer renders an error screen from kumi:status.
    console.error("[kumi] workspace not ready:", status.error);
  }

  registerAssetProtocol();
  registerIpc();
  createWindow();

  nativeTheme.on("updated", () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.setBackgroundColor(backgroundColor());
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // An import child outliving the window would keep the write lock held.
  stopImport();
  closeWorkspace();
});
