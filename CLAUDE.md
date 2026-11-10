# Mainbus: notes for agents

This file is for agents working in this repository: Mainbus's own roles and anyone's Claude Code sessions. `README.md` is for people. Roles get their workflow from Mainbus; this file only covers the commands and the testing rules.

**Package manager:** this repo uses **pnpm**. Use `pnpm` and `pnpm exec`, never `npm` or `npx`: they would create a `package-lock.json` and install outside pnpm's lockfile. Install with `pnpm install --frozen-lockfile`.

## Commands

- Install: `pnpm install --frozen-lockfile`
- Type check: `pnpm typecheck`
- Unit tests (Vitest): `pnpm test`, or `pnpm exec vitest run <test file>` for one file
- End-to-end tests (Playwright for Electron): `pnpm build`, then `pnpm exec playwright test e2e/<spec>.spec.ts`; `pnpm e2e` builds and runs them all
- Stable build: `pnpm build:stable`, then `pnpm run run:stable`. It installs into the user's `%LOCALAPPDATA%\Mainbus`, so agents don't run it.

## Testing

- **While working, run only the tests related to your change:**
  - `pnpm exec vitest related <the source files you changed> --run`, which runs every test that imports them, directly or not;
  - plus `pnpm exec vitest run <test file>` for test files you wrote or changed.
  - `git diff --name-only main...HEAD` lists what the branch changed; add your uncommitted files (`git status --short`).
- **End-to-end tests:** while working, run only the spec you touched, with `pnpm exec playwright test e2e/<spec>.spec.ts` after `pnpm build`. Never run the whole e2e suite while working.
- **Before handing off as Implementer,** run `pnpm typecheck`.
- **Don't run the full suites as Implementer:** no `pnpm test`, no `pnpm exec vitest run` without paths, no `pnpm e2e`. They take several minutes. The Reviewer runs the full suites.
- **Testing safety:** tests never touch the user's stable board or data home (`%LOCALAPPDATA%\Mainbus`). Unit tests open their database in a temporary `MAINBUS_HOME` (see `openTestDb` in `src/engine/store/testDb.ts`), and e2e tests start the app with the scripted FakeRuntime, a temporary `MAINBUS_HOME` and throwaway git repositories. New tests must do the same.

## Code map

`src/engine` is the app's core, a plain Node module behind a typed command/event API: the runner, the agent runtime, roles and their prompts, git, permissions, the stuck detector and the SQLite store (`src/engine/store`, with Drizzle migrations in `src/engine/db/migrations`). `src/main` is the Electron main process, `src/preload` the bridge, `src/renderer` the React UI (Mantine components), `src/shared` the types and pure rules both sides use, and `src/cli` the `mainbus` CLI and MCP server. See "Project layout" in `README.md` for the full map.

## Design and roadmap

- Design document: `docs/superpowers/specs/2026-10-30-mainbus-design.md`
- Roadmap: `docs/superpowers/plans/2026-10-30-mainbus-roadmap.md`
