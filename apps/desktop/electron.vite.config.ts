import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // Second main-process entry: the Notion import worker, launched with
          // `utilityProcess.fork` so a long import never blocks main's loop.
          importChild: resolve(__dirname, "src/main/importChild.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
    resolve: {
      alias: {
        "@renderer": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      // Explicit: electron-vite resolves outDir against `root`, which would
      // otherwise place the renderer bundle outside apps/desktop.
      outDir: resolve(__dirname, "out/renderer"),
      emptyOutDir: true,
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
  },
});
