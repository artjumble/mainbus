import fs from 'node:fs'
import path from 'node:path'
import type { AgentLauncher } from '../shared/domain'

export interface LauncherContext {
  packaged: boolean
  /** The app's executable in the stable build: Mainbus.exe on Windows, Mainbus.app/Contents/MacOS/Mainbus on macOS. */
  execPath: string
  /** The repo root in dev. */
  appPath: string
  /** The app's data home when MAINBUS_HOME overrides it, already absolute; null for the default home. */
  home: string | null
  exists?: (file: string) => boolean
  /** The OS whose path rules apply; the running one by default. */
  platform?: NodeJS.Platform
}

/**
 * How agents run this app's `mainbus`. The stable build answers with the launcher that the stable
 * build script writes to <data home>/bin: mainbus.cmd on Windows (two folders up from the build's
 * Mainbus.exe), mainbus on macOS (five folders up from the folder holding the executable: Contents, Mainbus.app, the
 * build, app). It always runs the current build, so it stays valid across rebuilds. Dev answers with Node on
 * the bundle `pnpm build` writes. A MAINBUS_HOME override goes along, as an absolute path, so the CLI
 * reaches this app from any folder.
 */
export function agentLauncher(ctx: LauncherContext): AgentLauncher {
  const exists = ctx.exists ?? fs.existsSync
  const platform = ctx.platform ?? process.platform
  const p = platform === 'win32' ? path.win32 : path.posix
  let file: string
  if (!ctx.packaged) file = p.join(ctx.appPath, 'out', 'cli', 'mainbus.cjs')
  else if (platform === 'win32') file = p.resolve(p.dirname(ctx.execPath), '..', '..', 'bin', 'mainbus.cmd')
  else if (platform === 'darwin') file = p.resolve(p.dirname(ctx.execPath), '..', '..', '..', '..', '..', 'bin', 'mainbus')
  else file = p.resolve(p.dirname(ctx.execPath), '..', '..', 'bin', 'mainbus')
  const home = ctx.home
  return {
    kind: ctx.packaged ? 'stable' : 'dev',
    program: ctx.packaged ? [file] : ['node', file],
    env: home ? { MAINBUS_HOME: home } : {},
    exists: exists(file)
  }
}
