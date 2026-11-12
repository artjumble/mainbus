import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine, type Engine } from './index'
import { runGit } from './git/git'
import { resolveHome } from './home'
import { FakeRuntime } from './runtime/fakeRuntime'
import { eventually } from './testWait'

vi.setConfig({ testTimeout: 60_000 })
const WAIT = { timeout: 20_000, interval: 50 }
const migrationsDir = path.join(process.cwd(), 'src', 'engine', 'db', 'migrations')

let tmp: string
let repo: string
let origin: string
let engines: Engine[]

async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, content: string, cwd = repo): Promise<void> {
  await fs.writeFile(path.join(cwd, file), content)
  await git(['add', '.'], cwd)
  await git(['commit', '-m', `change ${file}`], cwd)
}

async function makeEngine(runtime = new FakeRuntime([])): Promise<{ engine: Engine; runtime: FakeRuntime }> {
  const engine = await createEngine({
    paths: resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir()),
    migrationsDir,
    runtime,
    git: runGit,
    exec: async () => ({ code: 1, stdout: '', stderr: 'no claude here' })
  })
  engines.push(engine)
  return { engine, runtime }
}

const ticket = { title: 'A ticket', intent: 'Do it', spec: '', criteria: [], labels: [], column: 'ready' as const }

beforeEach(async () => {
  engines = []
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-base-engine-'))
  repo = path.join(tmp, 'repo')
  origin = path.join(tmp, 'origin.git')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await commit('readme.txt', 'hi\n')
})

afterEach(async () => {
  for (const e of engines) await e.dispose().catch(() => {})
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

async function addOrigin(): Promise<void> {
  await git(['init', '--bare', '-b', 'main', origin], tmp)
  await git(['remote', 'add', 'origin', origin])
  await git(['push', '-u', 'origin', 'main'])
}

describe('adding a workspace', () => {
  beforeEach(async () => {
    await git(['checkout', '-b', 'feature'])
    await commit('feature.txt', 'f\n')
  })

  it("defaults to the repo's default branch, and check says what differs", async () => {
    const { engine } = await makeEngine()
    const checked = await engine.invoke('workspace.check', repo)
    expect(checked.base).toEqual({
      current: 'feature',
      suggested: 'main',
      branches: [
        { name: 'feature', onRemote: false },
        { name: 'main', onRemote: false }
      ],
      removed: null
    })
    expect((await engine.invoke('workspace.open', repo)).baseBranch).toBe('main')
  })

  it('takes the branch chosen, and refuses one that does not exist', async () => {
    const { engine } = await makeEngine()
    await expect(engine.invoke('workspace.open', repo, { baseBranch: 'nope' })).rejects.toThrow("There's no branch nope")
    expect(await engine.invoke('workspace.list')).toEqual([])
    expect((await engine.invoke('workspace.open', repo, { baseBranch: 'feature' })).baseBranch).toBe('feature')
  })

  it('prefers origin/HEAD over main', async () => {
    await addOrigin()
    await git(['branch', 'trunk', 'main'])
    await git(['push', 'origin', 'trunk'])
    await git(['remote', 'set-head', 'origin', 'trunk'])
    const { engine } = await makeEngine()
    expect((await engine.invoke('workspace.open', repo)).baseBranch).toBe('trunk')
  })
})

describe('adding a workspace that was removed', () => {
  it('reports the stored base when it still exists', async () => {
    const { engine } = await makeEngine()
    const ws = await engine.invoke('workspace.open', repo)
    await engine.invoke('workspace.remove', ws.id)
    expect((await engine.invoke('workspace.check', repo)).base?.removed).toEqual({ baseBranch: 'main', exists: true })
  })

  it('reports a stored base that was deleted, and a different base can be chosen, keeping the board', async () => {
    const { engine } = await makeEngine()
    await git(['checkout', '-b', 'old'])
    const ws = await engine.invoke('workspace.open', repo, { baseBranch: 'old' })
    await engine.invoke('ticket.create', ticket)
    await engine.invoke('workspace.remove', ws.id)
    await git(['checkout', 'main'])
    await git(['branch', '-D', 'old'])

    const base = (await engine.invoke('workspace.check', repo)).base!
    expect(base.removed).toEqual({ baseBranch: 'old', exists: false })
    expect(base.suggested).toBe('main')

    const back = await engine.invoke('workspace.open', repo, { baseBranch: 'main' })
    expect(back.id).toBe(ws.id)
    expect(back.baseBranch).toBe('main')
    expect((await engine.invoke('board.get')).tickets).toHaveLength(1)
  })
})

describe('workspace.branches', () => {
  it('has no warning without a remote', async () => {
    const { engine } = await makeEngine()
    await engine.invoke('workspace.open', repo)
    expect(await engine.invoke('workspace.branches')).toMatchObject({ baseBranch: 'main', hasRemote: false, baseOnRemote: false })
  })

  it('warns when the base is not on origin, and clears once it is pushed', async () => {
    await addOrigin()
    await git(['checkout', '-b', 'feature'])
    await commit('f.txt', 'f\n')
    const { engine } = await makeEngine()
    await engine.invoke('workspace.open', repo)
    await engine.invoke('workspace.setBaseBranch', 'feature')
    expect(await engine.invoke('workspace.branches')).toMatchObject({ baseBranch: 'feature', hasRemote: true, baseOnRemote: false })
    await git(['push', 'origin', 'feature'])
    expect(await engine.invoke('workspace.branches')).toMatchObject({ hasRemote: true, baseOnRemote: true })
  })
})

describe('workspace.setBaseBranch', () => {
  it('refuses a branch that does not exist locally, leaving the base as it is', async () => {
    const { engine } = await makeEngine()
    await engine.invoke('workspace.open', repo)
    await expect(engine.invoke('workspace.setBaseBranch', 'nope')).rejects.toThrow("There's no branch nope")
    await expect(engine.invoke('workspace.setBaseBranch', '--force')).rejects.toThrow()
    expect((await engine.invoke('workspace.get'))!.baseBranch).toBe('main')
  })

  it('starts new tickets from the new base while existing tickets keep their branches', async () => {
    const { engine, runtime } = await makeEngine(new FakeRuntime([{ waitForSend: true }, { waitForSend: true }]))
    await engine.invoke('workspace.open', repo)
    const first = await engine.invoke('ticket.create', ticket)
    await engine.invoke('agent.start', first.id)
    const firstSpec = await eventually(() => {
      expect(runtime.specs[0]).toBeDefined()
      return runtime.specs[0]!
    }, WAIT)
    const firstBefore = (await engine.invoke('board.get')).tickets.find((t) => t.id === first.id)!

    await git(['checkout', '-b', 'develop'])
    await commit('develop.txt', 'd\n')
    const developTip = await git(['rev-parse', 'develop'])
    await git(['checkout', 'main'])
    expect((await engine.invoke('workspace.setBaseBranch', 'develop')).baseBranch).toBe('develop')

    const second = await engine.invoke('ticket.create', { ...ticket, title: 'Second' })
    await engine.invoke('agent.start', second.id)
    const secondSpec = await eventually(() => {
      expect(runtime.specs[1]).toBeDefined()
      return runtime.specs[1]!
    }, WAIT)
    await git(['merge-base', '--is-ancestor', developTip, 'HEAD'], secondSpec.cwd)
    await expect(git(['merge-base', '--is-ancestor', developTip, 'HEAD'], firstSpec.cwd)).rejects.toThrow()

    const firstAfter = (await engine.invoke('board.get')).tickets.find((t) => t.id === first.id)!
    expect(firstAfter.branch).toBe(firstBefore.branch)
    expect(firstAfter.worktreePath).toBe(firstBefore.worktreePath)
  })
})
