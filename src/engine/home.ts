import path from 'node:path'

export type HomePaths = { root: string; db: string; worktrees: string; backups: string }

/**
 * Resolves the Mainbus data home.
 * MAINBUS_HOME wins; otherwise %LOCALAPPDATA%\Mainbus (stable) or \Mainbus-dev (dev),
 * and off Windows (no LOCALAPPDATA) ~/.mainbus or ~/.mainbus-dev.
 * Worktrees live under `work`, not `worktrees`, so path-based rules in a user's Claude config don't match.
 */
export function resolveHome(
  env: Record<string, string | undefined>,
  mode: 'stable' | 'dev',
  homedir: string
): HomePaths {
  const suffix = mode === 'dev' ? '-dev' : ''
  const override = env.MAINBUS_HOME
  const root = override
    ? override
    : env.LOCALAPPDATA
      ? path.join(env.LOCALAPPDATA, `Mainbus${suffix}`)
      : path.join(homedir, `.mainbus${suffix}`)
  return {
    root,
    db: path.join(root, 'mainbus.db'),
    worktrees: path.join(root, 'work'),
    backups: path.join(root, 'backups')
  }
}
