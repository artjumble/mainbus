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

/** The app this CLI talks to. `cwd` is where the command was run; a relative MAINBUS_HOME is taken from there. */
export function resolveTarget(env: Env, mode: 'stable' | 'dev', cwd: string): IntakeTarget {
  const root = resolveHome(env, mode, os.homedir(), cwd).root
  return { endpoint: intakeEndpoint(root), homeRoot: root }
}

/**
 * Mainbus sets MAINBUS_AGENT for its own agents, and MAINBUS_AGENT_HOME to the data home of the app that
 * runs them. Such an agent must not file tickets on that board, however it names the home (MAINBUS_HOME
 * pointing at it included), but may still test against a temporary one. Comparing endpoints compares the
 * homes the way the pipe name does. Without MAINBUS_AGENT_HOME (an app from before it existed), only an
 * explicit MAINBUS_HOME is let through. Returns the refusal, or null.
 */
export function refusalUnderAgent(env: Env, target: IntakeTarget): string | null {
  if (!env.MAINBUS_AGENT) return null
  const agentHome = env.MAINBUS_AGENT_HOME
  const own = agentHome ? intakeEndpoint(path.resolve(agentHome)) === target.endpoint : !env.MAINBUS_HOME
  if (!own) return null
  return (
    `Refusing to run: MAINBUS_AGENT is set, so this is a Mainbus agent, and ${target.homeRoot} is the data home ` +
    'of the Mainbus that runs it: it must not file tickets on that board. Set MAINBUS_HOME to a temporary data ' +
    'home to test against that instead.'
  )
}
