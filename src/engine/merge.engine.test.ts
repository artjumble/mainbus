import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardTicket } from '../shared/api'
import type { MergePlan } from '../shared/merge'
import { createEngine, type Engine } from './index'
import { runCommand, type CommandRunner } from './git/command'
import { FakeGh } from './git/fakeGh'
import { runGit } from './git/git'
import { resolveHome } from './home'
import { FakeRuntime } from './runtime/fakeRuntime'
import { eventually } from './testWait'

vi.setConfig({ testTimeout: 60_000 })
const WAIT = { timeout: 20_000, interval: 50 }
const migrationsDir = path.join(process.cwd(), 'src', 'engine', 'db', 'migrations')

let tmp: string
let repo: string
let engines: Engine[]
let gh: FakeGh
let runtime: FakeRuntime
let engine: Engine
let implementer: string
let calls: { file: string; args: string[] }[]

async function git(args: string[], cwd = repo): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

async function commit(file: string, content: string, cwd: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true })
  await fs.writeFile(path.join(cwd, file), content)
  await git(['add', '.'], cwd)
  await git(['commit', '-m', `change ${file}`], cwd)
}

async function makeEngine(): Promise<Engine> {
  gh = new FakeGh()
  runtime = new FakeRuntime([{ waitForSend: true }])
  const recording: CommandRunner = (file, args, opts) => {
    calls.push({ file, args })
    return runCommand(file, args, opts)
  }
  const e = await createEngine({
    paths: resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir()),
    migrationsDir,
    runtime,
    git: runGit,
    exec: async () => ({ code: 1, stdout: '', stderr: 'no claude here' }),
    commands: gh.runner(recording)
  })
  engines.push(e)
  await e.invoke('workspace.open', repo)
  implementer = (await e.invoke('lineup.get')).find((r) => r.name === 'Implementer')!.id
  return e
}

const board = async (): Promise<BoardTicket[]> => (await engine.invoke('board.get')).tickets
const ticketNow = async (id: string): Promise<BoardTicket> => (await board()).find((t) => t.id === id)!

/** A ticket that added hello.txt and handed off: in Review. */
async function ticketInReview(): Promise<{ t: BoardTicket; cwd: string }> {
  const created = await engine.invoke('ticket.create', { title: 'Add hello', intent: 'Add hello.txt', spec: '', criteria: [], labels: [], column: 'ready' } as never)
  await engine.invoke('agent.start', created.id, { roleIds: [implementer] })
  const spec = await eventually(() => {
    expect(runtime.specs[0]).toBeDefined()
    return runtime.specs[0]!
  }, WAIT)
  await commit('hello.txt', 'hello\n', spec.cwd)
  await spec.roleTools.handoff({ summary: 'Added hello.txt', notesForNext: '' })
  await eventually(async () => expect((await ticketNow(created.id)).state.column).toBe('review'), WAIT)
  return { t: await ticketNow(created.id), cwd: spec.cwd }
}

async function planOf(id: string): Promise<MergePlan> {
  const preview = await engine.invoke('ticket.mergePreview', id)
  if (!preview.ok) throw new Error(`refused: ${preview.reason}`)
  return preview.plan
}

beforeEach(async () => {
  engines = []
  calls = []
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-merge-engine-'))
  repo = path.join(tmp, 'repo')
  await fs.mkdir(repo)
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.com'])
  await commit('readme.txt', 'hi\n', repo)
})

afterEach(async () => {
  for (const e of engines) await e.dispose().catch(() => {})
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

describe('Merge… with no remote', () => {
  beforeEach(async () => {
    engine = await makeEngine()
  })

  it('fast-forwards the checked-out main, moves the ticket to Done, and records it in the Activity', async () => {
    const { t, cwd } = await ticketInReview()
    const plan = await planOf(t.id)
    expect(plan).toMatchObject({ kind: 'local', how: 'fast_forward', base: 'main', branch: t.branch })

    const outcome = await engine.invoke('ticket.merge', t.id, { expect: plan })

    expect(outcome).toMatchObject({ moved: 'moved', fetchError: null, commit: await git(['rev-parse', 'main']) })
    expect(await git(['rev-parse', 'main'])).toBe(await git(['rev-parse', `refs/heads/${t.branch}`]))
    await expect(fs.readFile(path.join(repo, 'hello.txt'), 'utf8')).resolves.toBe('hello\n')
    expect(await git(['status', '--porcelain'])).toBe('')
    expect((await ticketNow(t.id)).state.column).toBe('done')
    await expect(fs.access(cwd)).rejects.toThrow()
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.find((e) => e.event.kind === 'merged')?.event).toMatchObject({
      kind: 'merged',
      base: 'main',
      via: 'local',
      how: 'fast_forward',
      commit: outcome.commit
    })
  })

  it('leaves the ticket in Review when asked not to move it to Done', async () => {
    const { t } = await ticketInReview()
    const outcome = await engine.invoke('ticket.merge', t.id, { expect: await planOf(t.id), moveToDone: false })
    expect(outcome.moved).toBe('not_asked')
    expect((await ticketNow(t.id)).state.column).toBe('review')
  })

  it('refuses, changing nothing, when the checkout has changes', async () => {
    const { t } = await ticketInReview()
    const plan = await planOf(t.id)
    await fs.writeFile(path.join(repo, 'wip.txt'), 'mine\n')
    await expect(engine.invoke('ticket.merge', t.id, { expect: plan })).rejects.toThrow(/uncommitted changes: wip\.txt\. Commit or stash/)
    expect(await git(['rev-parse', 'main'])).not.toBe(await git(['rev-parse', `refs/heads/${t.branch}`]))
    expect((await ticketNow(t.id)).state.column).toBe('review')
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.some((e) => e.event.kind === 'merged')).toBe(false)
  })

  it('refuses a plan that differs from the one the user saw', async () => {
    const { t } = await ticketInReview()
    const plan = await planOf(t.id)
    await expect(engine.invoke('ticket.merge', t.id, { expect: { ...plan, head: 'deadbeef' } as MergePlan })).rejects.toThrow(/Something changed/)
    expect((await ticketNow(t.id)).state.column).toBe('review')
  })

  it('is refused for a ticket that is not in Review, and the preview says why', async () => {
    const created = await engine.invoke('ticket.create', { title: 'Later', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' } as never)
    expect(await engine.invoke('ticket.mergePreview', created.id)).toMatchObject({ ok: false, reason: expect.stringContaining('not in Review') })
  })

  it('never pushes, resets, rebases or stashes', async () => {
    const { t } = await ticketInReview()
    await engine.invoke('ticket.merge', t.id, { expect: await planOf(t.id) })
    const words = calls.flatMap((c) => c.args)
    for (const bad of ['push', 'reset', 'rebase', 'stash', '--force']) expect(words).not.toContain(bad)
    expect(gh.calls).toEqual([])
  })
})

describe('Merge… of a pull request', () => {
  beforeEach(async () => {
    const origin = path.join(tmp, 'origin.git')
    await git(['init', '--bare', '-b', 'main', origin], tmp)
    await git(['remote', 'add', 'origin', origin])
    await git(['push', '-q', '-u', 'origin', 'main'])
    engine = await makeEngine()
    await engine.invoke('workspace.setOpenPrOnReview', true)
  })

  async function prTicket(): Promise<BoardTicket> {
    const { t } = await ticketInReview()
    await eventually(async () => expect((await ticketNow(t.id)).pr).not.toBeNull(), WAIT)
    return ticketNow(t.id)
  }

  it('merges through gh with the workspace\'s method, fetches the base, and leaves the checkout alone', async () => {
    await engine.invoke('workspace.setMergeMethod', 'squash')
    const t = await prTicket()
    const mainBefore = await git(['rev-parse', 'main'])
    const plan = await planOf(t.id)
    expect(plan).toMatchObject({ kind: 'pull_request', method: 'squash', pr: { number: 1 } })

    const outcome = await engine.invoke('ticket.merge', t.id, { expect: plan, deleteBranch: true })

    expect(outcome).toMatchObject({ moved: 'moved', commit: null })
    const merge = gh.calls.find((c) => c[1] === 'merge')!
    expect(merge).toContain('--squash')
    expect(merge).toContain('--delete-branch')
    expect(merge).toContain('--repo=github.com/example/repo')
    expect(await git(['rev-parse', 'main'])).toBe(mainBefore)
    expect(await git(['status', '--porcelain'])).toBe('')
    expect((await ticketNow(t.id)).state.column).toBe('done')
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.find((e) => e.event.kind === 'merged')?.event).toMatchObject({ via: 'pull_request', how: 'squash', number: 1 })
  })

  it('reports GitHub\'s refusal and leaves the ticket in Review with nothing recorded', async () => {
    const t = await prTicket()
    gh.mergeRefusal = 'Pull request #1 is not mergeable: review required'
    await expect(engine.invoke('ticket.merge', t.id, { expect: await planOf(t.id) })).rejects.toThrow(
      'GitHub refused the merge: Pull request #1 is not mergeable: review required'
    )
    expect((await ticketNow(t.id)).state.column).toBe('review')
    const { events } = await engine.invoke('thread.get', t.id)
    expect(events.some((e) => e.event.kind === 'merged')).toBe(false)
  })

  it('only takes a known merge method', async () => {
    await expect(engine.invoke('workspace.setMergeMethod', 'fast' as never)).rejects.toThrow()
    expect((await engine.invoke('workspace.get'))?.mergeMethod).toBe('merge')
  })
})
