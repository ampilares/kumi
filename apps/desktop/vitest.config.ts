import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Two suites:
 *   - `src/renderer/src/lib/*.test.ts` — the pure sync layer (block ⇄ document
 *     diffing, rich-text mapping, rank arithmetic). Plain JSON, node env.
 *   - `src/renderer/src/editor/*.test.ts` — a headless TipTap instance in jsdom
 *     exercising the keyboard semantics, markdown input rules and slash menu.
 *   - `src/renderer/src/database/*.test.ts(x)` — the database logic in node:
 *     Phase 4's filters, formatting, option reducers and view config, plus
 *     Phase 5's grouping, calendar/timeline arithmetic and relation/rollup
 *     values; and the cell commit shapes rendered into jsdom.
 * None of them needs Electron or a workspace database.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@kumi/core": resolve(__dirname, "../../packages/core/src/types.ts"),
    },
  },
  // The database cell suite renders TSX; the runtime JSX transform keeps the
  // tests free of a React import they would otherwise need only to compile.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    // jsdom suites opt in with a `@vitest-environment` docblock.
    include: [
      "src/renderer/src/*.test.{ts,tsx}",
      "src/renderer/src/lib/**/*.test.ts",
      "src/renderer/src/editor/**/*.test.ts",
      "src/renderer/src/database/**/*.test.{ts,tsx}",
    ],
  },
});
