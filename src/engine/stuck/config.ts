const MINUTE = 60_000

/** The stuck detector's defaults, all in one place; there is no settings screen for them yet. */
export const STUCK = {
  /** How often the detector looks at every open run. */
  checkIntervalMs: MINUTE,
  /** The same failing command (normalized) this many times in a row. */
  repeatedFailures: 5,
  /** No file changes and no new tool kinds for this long. */
  noProgressMs: 15 * MINUTE,
  /** No events at all for this long while the agent is working. */
  silenceMs: 10 * MINUTE,
  /** A single turn running longer than this. */
  longTurnMs: 60 * MINUTE,
  /** A file changed this recently counts as "files are still changing": no rule fires. */
  filesChangingMs: 2 * MINUTE,
  /** A repeat hit counts on an open episode only when this long has passed since its last hit, so escalation is not a few minutes' work. */
  hitSpacingMs: 5 * MINUTE,
  /** The hit count at which an episode asks for a closer look. */
  escalateAtHit: 3,
  /** The longest a declared wait may run ahead of now. */
  maxWaitMs: 120 * MINUTE
} as const

/** Folders whose files never count as the agent's work: dependencies, build output and caches. */
export const IGNORED_FOLDERS: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.vite',
  '.turbo',
  '.gradle',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.pytest_cache',
  '.idea',
  '.vscode'
])
