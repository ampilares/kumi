/**
 * Web dev mode (browser, no Electron): serves the renderer with HMR at
 * http://localhost:5183/web.html and proxies /kumi-dev/* to the command
 * server started by dev-web/server.mjs (which spawns Vite with this config —
 * run `pnpm dev:web`, not `vite` directly).
 */
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(__dirname, "src/renderer/src"),
      // Type-only imports in the renderer; point at the contract source.
      "@kumi/core": resolve(__dirname, "../../packages/core/src/types.ts"),
    },
  },
  server: {
    port: 5183,
    open: "/web.html",
    proxy: {
      "/kumi-dev": {
        target: "http://localhost:8484",
        rewrite: (path) => path.replace(/^\/kumi-dev/, ""),
      },
    },
  },
});
