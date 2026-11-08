import fs from 'node:fs'
import path from 'node:path'
import type { AgentLauncher } from '../shared/domain'

export interface LauncherContext {
  packaged: boolean
  /** Mainbus.exe in the stable build: %LOCALAPPDATA%\Mainbus\app\<build>\Mainbus.exe. */
  execPath: string
  /** The repo root in dev. */
  appPath: string
  /** The app's data home when MAINBUS_HOME overrides it, already absolute; null for the default home. */
  home: string | null
  exists?: (file: string) => boolean
}

/**
 * How agents run this app's `mainbus`. The stable build answers with the mainbus.cmd that
 * build-stable.ps1 writes to %LOCALAPPDATA%\Mainbus\bin, two folders up from the build's Mainbus.exe;
 * it always runs the current build, so it stays valid across rebuilds. Dev answers with Node on the
 * bundle `pnpm build` writes. A MAINBUS_HOME override goes along,
 * as an absolute path, so the CLI reaches this app from any folder.
 */
export function agentLauncher(ctx: LauncherContext): AgentLauncher {
  const exists = ctx.exists ?? fs.existsSync
  const file = ctx.packaged
    ? path.resolve(path.dirname(ctx.execPath), '..', '..', 'bin', 'mainbus.cmd')
    : path.join(ctx.appPath, 'out', 'cli', 'mainbus.cjs')
  const home = ctx.home
  return {
    kind: ctx.packaged ? 'stable' : 'dev',
    program: ctx.packaged ? [file] : ['node', file],
    env: home ? { MAINBUS_HOME: home } : {},
    exists: exists(file)
  }
}
