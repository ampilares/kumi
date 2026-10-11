# Kumi

Local-only, Notion-faithful desktop app. Electron + SQLite, agent-native via a headless CLI.

- Plan: `docs/build-plan.md` (phases, data model, UI fidelity reference). Spec: `docs/specs.pdf`.
- Monorepo (pnpm): `packages/core` (headless data/command layer — ALL business logic lives here), `apps/desktop` (Electron shell + React UI), `apps/cli` (`kumi` CLI wrapping core).

## Hard rules

- `packages/core/src/types.ts` is the binding contract between core, desktop IPC, and CLI. Change it deliberately and update all three consumers in the same change.
- The renderer never touches SQLite; it calls `KumiCommands` over typed IPC. The CLI calls the same interface. Never re-implement a command outside `@kumi/core`.
- Blocks store structured payloads (rich-text spans), never HTML. All multi-step mutations run in a SQLite transaction. Fractional ranks (`rankBetween`) for all ordering.
- UI must match the fidelity reference in `docs/build-plan.md` (tokens: rail `#FBFAF8` ~270px, topbar 44px, text `#2C2C2B`/`#6B6A66`, radii 8–12px, 120–180ms transitions, light+dark via semantic CSS variables).

## Commands

- `pnpm install` (root; native builds allowlisted in root package.json `onlyBuiltDependencies`)
- `pnpm typecheck` / `pnpm test` / `pnpm build` (all packages), `pnpm dev` (desktop)
- Per package: `pnpm --filter @kumi/core test`, etc.

Default workspace folder at runtime: `%USERPROFILE%\Kumi` (contains `kumi.db` + `assets/`), overridable via `KUMI_WORKSPACE` for the CLI.
