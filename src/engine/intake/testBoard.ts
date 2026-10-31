// Test helper: a real engine on a temporary data home with its intake server listening, and a git repo
// to open as the workspace. Never touches the stable or dev home.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runGit } from '../git/git'
import { resolveHome, type HomePaths } from '../home'
import { createEngine, type Engine } from '../index'
import type { ExecFn } from '../runtime/resolveClaude'
import type { AgentRuntime } from '../runtime/types'
import { intakeEndpoint } from './endpoint'
import { startIntakeServer, type IntakeServer } from './server'

const migrationsDir = path.join(import.meta.dirname, '..', 'db', 'migrations')
const exec: ExecFn = async () => ({ code: 1, stdout: '', stderr: 'no claude here' })

export interface TestBoard {
  tmp: string
  paths: HomePaths
  repoPath: string
  engine: Engine
  server: IntakeServer
  /** What a client of this home connects to. */
  target: { endpoint: string; homeRoot: string }
  dispose(): Promise<void>
}

async function git(args: string[], cwd: string): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

export async function makeRepo(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await git(['init', '-b', 'main'], dir)
  await fs.writeFile(path.join(dir, 'README.md'), 'hello\n')
  await git(['add', '.'], dir)
  await git(['commit', '-m', 'initial'], dir)
  return dir
}

export async function makeTestBoard(
  options: { runtime?: AgentRuntime | null; openWorkspace?: boolean } = {}
): Promise<TestBoard> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-intake-'))
  const repoPath = await makeRepo(path.join(tmp, 'repo'))
  const paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const engine = await createEngine({ paths, migrationsDir, runtime: options.runtime ?? null, git: runGit, exec })
  if (options.openWorkspace !== false) await engine.invoke('workspace.open', repoPath)
  const endpoint = intakeEndpoint(paths.root)
  const server = await startIntakeServer(endpoint, (method, params) => engine.intake(method, params), { log: () => {} })
  return {
    tmp,
    paths,
    repoPath,
    engine,
    server,
    target: { endpoint, homeRoot: paths.root },
    async dispose() {
      await server.close()
      await engine.dispose()
      await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}
