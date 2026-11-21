import path from 'node:path'

export type HomePaths = {
  root: string
  db: string
  worktrees: string
  scratch: string
  backups: string
  attachments: string
  /** The baseline folders: one per workspace, where its tests run on the newest base branch. */
  baselines: string
  /** The downloaded speech models of voice dictation, one folder each. */
  models: string
}

/** The folder the orchestrator works in. */
export function orchestratorFolder(root: string): string {
  return path.join(root, 'orchestrator')
}

/**
 * The directory a command was run from. npm and pnpm run a package script in the package root, and record the
 * directory it was called from in INIT_CWD (they set both variables themselves on every run, so neither leaks
 * in from a parent). Only the named script gets this; anything else uses its own working directory.
 */
export function invocationDir(env: Record<string, string | undefined>, script: string, cwd: string): string {
  return env.npm_lifecycle_event === script && env.INIT_CWD ? env.INIT_CWD : cwd
}

/** The per-OS default data home, used when MAINBUS_HOME is not set. */
function defaultRoot(env: Record<string, string | undefined>, suffix: string, homedir: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, `Mainbus${suffix}`) : path.join(homedir, `.mainbus${suffix}`)
  }
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Application Support', `Mainbus${suffix}`)
  // Linux and the rest: XDG_DATA_HOME (an absolute path, per the spec), else ~/.local/share.
  const xdg = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homedir, '.local', 'share')
  return path.join(xdg, `mainbus${suffix}`)
}

/**
 * Resolves the Mainbus data home.
 * MAINBUS_HOME wins, resolved against `baseDir` when relative (the app and the CLI both pass the directory
 * they were run from, so the same relative MAINBUS_HOME names the same home); otherwise, by OS:
 * Windows %LOCALAPPDATA%\Mainbus (stable) or \Mainbus-dev (dev), or ~/.mainbus[-dev] without LOCALAPPDATA;
 * macOS ~/Library/Application Support/Mainbus[-dev]; Linux $XDG_DATA_HOME/mainbus[-dev], else ~/.local/share/mainbus[-dev].
 * Worktrees live under `work`, not `worktrees`, so path-based rules in a user's Claude config don't match.
 */
export function resolveHome(
  env: Record<string, string | undefined>,
  mode: 'stable' | 'dev',
  homedir: string,
  baseDir: string = process.cwd(),
  platform: NodeJS.Platform = process.platform
): HomePaths {
  const suffix = mode === 'dev' ? '-dev' : ''
  const override = env.MAINBUS_HOME
  const root = override ? path.resolve(baseDir, override) : defaultRoot(env, suffix, homedir, platform)
  return {
    root,
    db: path.join(root, 'mainbus.db'),
    worktrees: path.join(root, 'work'),
    scratch: path.join(root, 'scratch'),
    backups: path.join(root, 'backups'),
    attachments: path.join(root, 'attachments'),
    baselines: path.join(root, 'base'),
    models: path.join(root, 'models')
  }
}

/** The folder holding all of a workspace's ticket attachments: `attachments\<workspace slug>`. */
export function attachmentFoldersFor(paths: HomePaths, slug: string): string {
  return path.join(paths.attachments, slug)
}

/**
 * The ticket's scratch folder, its agents' temp folder: `scratch\<workspace slug>\<worktree folder name>`,
 * beside its worktree (`work\<workspace slug>\<folder name>`) and never inside it. Worked out from the worktree
 * path alone, so a pending cleanup that only knows the worktree path can find it.
 */
export function scratchPathFor(paths: HomePaths, worktreePath: string): string {
  const slug = path.basename(path.dirname(worktreePath))
  const name = path.basename(worktreePath)
  // The layout decides: a worktree in `<root>\work\<slug>\<name>` has its scratch in `<root>\scratch\<slug>\<name>`,
  // whichever root the ticket folders setting names now, so a ticket made before a change keeps its scratch folder.
  const workFolder = path.dirname(path.dirname(worktreePath))
  const isWork = path.basename(workFolder) === 'work' || (process.platform === 'win32' && path.basename(workFolder).toLowerCase() === 'work')
  if (isWork && path.dirname(workFolder) !== workFolder) return path.join(path.dirname(workFolder), 'scratch', slug, name)
  return path.join(paths.scratch, slug, name)
}

/** `paths` with the ticket folders (worktrees, scratch, baselines) under `location`; the data home's own when it is null. */
export function ticketPathsFor(paths: HomePaths, location: string | null): HomePaths {
  if (location === null) return paths
  return { ...paths, worktrees: path.join(location, 'work'), scratch: path.join(location, 'scratch'), baselines: path.join(location, 'base') }
}

/** The folder holding all of a workspace's ticket worktrees: `work\<workspace slug>`. */
export function ticketFoldersFor(paths: HomePaths, slug: string): string {
  return path.join(paths.worktrees, slug)
}

/** The folders of a workspace's baseline: a detached worktree of the newest base, and what its test runs need beside it. */
export interface BaselineFolders {
  /** The workspace's folder under `base`. */
  root: string
  /** The detached worktree (a short name: node_modules paths are long). */
  repo: string
  /** The test commands' TEMP and TMP. */
  temp: string
  /** The results files the test commands write. */
  results: string
  /** The commands' output, one log each. */
  logs: string
}

/** `base\<workspace slug>\{repo,temp,results,logs}`, outside the ticket worktrees and scratch folders. */
export function baselineFoldersFor(paths: HomePaths, slug: string): BaselineFolders {
  const root = path.join(paths.baselines, slug)
  return { root, repo: path.join(root, 'r'), temp: path.join(root, 'tmp'), results: path.join(root, 'results'), logs: path.join(root, 'logs') }
}
