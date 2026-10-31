import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveHome } from '../engine/home'
import { intakeEndpoint } from '../engine/intake/endpoint'
import type { IntakeTarget } from './client'

export type Env = Record<string, string | undefined>

/**
 * The stable build ships this bundle in resources\cli, next to the app's app.asar; anywhere else it is a
 * dev build. That decides the default data home, the same way app.isPackaged does for the app.
 */
export function modeOf(bundleDir: string): 'stable' | 'dev' {
  return fs.existsSync(path.join(bundleDir, '..', 'app.asar')) ? 'stable' : 'dev'
}

export function resolveTarget(env: Env, mode: 'stable' | 'dev'): IntakeTarget {
  const root = resolveHome(env, mode, os.homedir()).root
  return { endpoint: intakeEndpoint(root), homeRoot: root }
}

/**
 * Mainbus sets MAINBUS_AGENT for its own agents. Such an agent must not file tickets on the board that
 * is running it, but may still test against a temporary MAINBUS_HOME. Returns the refusal, or null.
 */
export function refusalUnderAgent(env: Env): string | null {
  if (!env.MAINBUS_AGENT || env.MAINBUS_HOME) return null
  return (
    'Refusing to run: MAINBUS_AGENT is set, so this is a Mainbus agent, and it must not file tickets on the ' +
    'board that runs it. Set MAINBUS_HOME to a temporary data home to test against that instead.'
  )
}
