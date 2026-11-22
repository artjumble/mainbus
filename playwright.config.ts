import { defineConfig } from '@playwright/test'
import { installLaunchRetry } from './e2e/launchRetry'

// macOS's temp folder (/var/folders/xx/<30 characters>/T/) is about 50 bytes, and a Unix socket path is limited to 104
// bytes there. The specs put the agent endpoint's socket inside a temp folder, so use a short one. This file loads in
// the runner and in every worker, and the app inherits the environment. It is /private/tmp, not its symlink /tmp: the
// app and the CLI resolve real paths, and the specs compare them with the folders they created.
if (process.platform === 'darwin') process.env.TMPDIR = '/private/tmp'

// One retry of a failed Electron launch ("Process failed to launch!") for every spec; see e2e/launchRetry.ts.
installLaunchRetry()

// Specs that depend on hover, focus, the tray, OS notifications, window state
// or animation timing run one at a time, in their own project. Everything else
// runs in parallel. A new spec of that kind goes in this list.
const SERIAL_SPECS = [
  '**/tray.spec.ts', // tray, OS notifications and window visibility
  '**/appWindow.spec.ts', // maximized OS window state
  '**/loadingButtons.spec.ts', // hover-revealed buttons
  '**/doneColumn.spec.ts', // hover, focus and drag opening of Done, with a wait on its collapse timer
  '**/archive.spec.ts', // opens Done by focus to reach its cards and the Archive button
  '**/workspaceRailExpand.spec.ts', // rail hover and focus expansion
  '**/keyboard.spec.ts', // focus rings and Tab order
  '**/needsYouColumn.spec.ts', // Done hover, and widths sampled frame by frame
  '**/fieldLabels.spec.ts', // hover and focus tooltips
  '**/a11y.spec.ts', // rail hover, focus and animation timing
  '**/artboards.spec.ts', // hover, and animation timing before screenshots
  '**/updateFromMain.spec.ts' // hovers Done, and waits on a git freshness probe that is slow under load
]

// MAINBUS_E2E_WORKERS: a whole number or a percentage of logical cores.
// The default, 25%, is about half the physical cores: more workers starve the
// agent-run waits of CPU and make them time out.
function workerCount(): number | string {
  const raw = (process.env.MAINBUS_E2E_WORKERS ?? '25%').trim()
  if (/^\d+%$/.test(raw)) return raw
  if (/^\d+$/.test(raw) && Number(raw) >= 1) return Number(raw)
  throw new Error(
    `MAINBUS_E2E_WORKERS must be a whole number or a percentage like 25%, got "${raw}"`
  )
}

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: workerCount(),
  reporter: 'list',
  projects: [
    // First, so its single-worker chain starts at once and sets the floor.
    { name: 'serial', testMatch: SERIAL_SPECS, workers: 1 },
    { name: 'parallel', testIgnore: SERIAL_SPECS }
  ]
})
