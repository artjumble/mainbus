import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import { THEME_IDS } from './src/shared/domain'

const NODE_INCLUDE = ['src/engine/**/*.test.ts', 'src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/cli/**/*.test.ts']
// Few enough at once that their git processes don't starve each other (8 and 12 ran the full suite in about the same time).
const HEAVY_WORKERS = 12

/**
 * The test files that start real git or processes (a ticket start alone runs about 20 git processes). Under the full
 * suite's load they starve each other and the light tests, so they run in their own project, first, with limited
 * parallelism.
 */
const HEAVY_TESTS = [
  'src/cli/main.test.ts',
  'src/cli/mcp.test.ts',
  'src/engine/attachments/attachments.engine.test.ts',
  'src/engine/baseTests.engine.test.ts',
  'src/engine/baseline/folder.test.ts',
  'src/engine/blockedBy.engine.test.ts',
  'src/engine/freshness/updateFromMain.engine.test.ts',
  'src/engine/git/changedFiles.test.ts',
  'src/engine/git/folderSetup.test.ts',
  'src/engine/git/freshness.test.ts',
  'src/engine/git/pullRequests.test.ts',
  'src/engine/git/reportFiles.test.ts',
  'src/engine/git/worktrees.test.ts',
  'src/engine/holds/deferred.engine.test.ts',
  'src/engine/holds/holds.engine.test.ts',
  'src/engine/index.test.ts',
  'src/engine/intake/methods.test.ts',
  'src/engine/intake/server.test.ts',
  'src/engine/orchestrator/images.engine.test.ts',
  'src/engine/orchestrator/mentions.engine.test.ts',
  'src/engine/orchestrator/permissions.test.ts',
  'src/engine/orchestrator/presets.engine.test.ts',
  'src/engine/orchestrator/roleControls.test.ts',
  'src/engine/orchestrator/session.test.ts',
  'src/engine/orchestrator/updateTicket.engine.test.ts',
  'src/engine/orchestrator/wakes.engine.test.ts',
  'src/engine/processes/sweep.test.ts',
  'src/engine/proposals/answer.engine.test.ts',
  'src/engine/proposals/redirect.engine.test.ts',
  'src/engine/proposals/replace.engine.test.ts',
  'src/engine/runner/agentsWorking.test.ts',
  'src/engine/runner/fleetLimit.test.ts',
  'src/engine/runner/investigate.test.ts',
  'src/engine/runner/processSweep.test.ts',
  'src/engine/runner/pullRequests.test.ts',
  'src/engine/runner/queue.test.ts',
  'src/engine/runner/recovery.test.ts',
  'src/engine/runner/setup.test.ts',
  'src/engine/runner/ticketRunner.test.ts',
  'src/engine/runner/unattended.test.ts',
  'src/engine/runner/usage.engine.test.ts',
  'src/engine/runtime/resolveClaude.test.ts',
  'src/engine/runtime/sdkRuntime.live.test.ts',
  'src/engine/runtime/sdkRuntime.test.ts',
  'src/engine/setup/setupCommand.test.ts',
  'src/engine/stuck/stuck.engine.test.ts',
  'src/engine/tickets/doneReadOnly.engine.test.ts',
  'src/engine/tickets/presets.engine.test.ts',
  'src/engine/tickets/promote.engine.test.ts',
  'src/engine/tickets/runSettings.engine.test.ts',
  'src/engine/workspaces.engine.test.ts',
  'src/main/mainbusCmd.test.ts'
]

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          globals: true,
          // node:sqlite prints an ExperimentalWarning on import; keep test output clean.
          execArgv: ['--disable-warning=ExperimentalWarning'],
          include: NODE_INCLUDE,
          exclude: [...configDefaults.exclude, ...HEAVY_TESTS],
          // Vitest requires projects with different maxWorkers to run in different groups.
          sequence: { groupOrder: 1 }
        }
      },
      {
        test: {
          name: 'engine',
          environment: 'node',
          globals: true,
          execArgv: ['--disable-warning=ExperimentalWarning'],
          include: HEAVY_TESTS,
          maxWorkers: HEAVY_WORKERS,
          sequence: { groupOrder: 0 },
          // Real git per ticket start, several times slower while other tests run.
          testTimeout: 30_000,
          hookTimeout: 30_000
        }
      },
      {
        plugins: [react()],
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          globals: true,
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
          sequence: { groupOrder: 1 }
        }
      },
      // The component tests again in each other theme, axe checks included (see renderWithMantine).
      ...THEME_IDS.filter((id) => id !== 'light').map((id) => ({
        plugins: [react()],
        test: {
          name: `jsdom-${id}`,
          environment: 'jsdom',
          globals: true,
          include: ['src/renderer/**/*.test.tsx'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
          sequence: { groupOrder: 1 },
          env: { MAINBUS_TEST_THEME: id }
        }
      }))
    ]
  }
})
