import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome } from '../home'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { SetupCommandResult } from '../setup/setupCommand'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

vi.setConfig({ testTimeout: 30_000 })

let tmp: string
let repoPath: string
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let workspaceId: string
let runner: TicketRunner | null

async function git(args: string[]): Promise<void> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repoPath)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-working-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  const paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  workspaceId = ws.id
  await implementerOnly(repos.lineups, ws.id)
  runner = null
})

afterEach(async () => {
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

const newTicket = (): Promise<Ticket> => repos.tickets.create({ workspaceId, title: 'A', intent: 'x', spec: '', criteria: [], labels: [], column: 'ready' })

function makeRunner(script: FakeStep[], setup?: (signal: AbortSignal) => Promise<SetupCommandResult>): TicketRunner {
  runner = new TicketRunner({
    repos,
    worktrees,
    runtime: new FakeRuntime(script),
    now: () => FIXED_NOW,
    emit: () => {},
    ...(setup ? { setup: (req) => setup(req.signal) } : {})
  })
  return runner
}

describe('TicketRunner.agentsWorking', () => {
  it('is false with nothing running', () => {
    expect(makeRunner([]).agentsWorking()).toBe(false)
  })

  it('is true while the setup command runs, and false once it is stopped', async () => {
    await repos.workspaces.setSetupSettings(workspaceId, { command: 'npm ci' })
    const r = makeRunner([{ waitForSend: true }], (signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ exitCode: null, timedOut: false, aborted: true, tail: [] }))))
    const t = await newTicket()
    void r.start(t.id)
    await eventually(() => expect(r.agentsWorking()).toBe(true))
    await r.stop(t.id)
    await eventually(() => expect(r.agentsWorking()).toBe(false))
  })

  it('is false while an agent has asked the user a question and is waiting for the answer', async () => {
    const r = makeRunner([{ emit: { kind: 'session', sessionId: 's' } }, { callTool: 'askUser', args: { question: 'Which way?', options: ['A', 'B'] } }, { emit: { kind: 'turn_end', ok: true } }, { waitForSend: true }])
    const t = await newTicket()
    await r.start(t.id)
    // The turn ends with a question pending; the run stays open, waiting for the user.
    await eventually(async () => expect(await repos.decisions.pending(t.id)).toHaveLength(1))
    await eventually(() => expect(r.agentsWorking()).toBe(false))
    await r.stop(t.id)
  })

  it('is true while a turn has not ended', async () => {
    const r = makeRunner([{ emit: { kind: 'session', sessionId: 's' } }, { waitForSend: true }])
    const t = await newTicket()
    await r.start(t.id)
    expect(r.agentsWorking()).toBe(true)
    await r.stop(t.id)
    expect(r.agentsWorking()).toBe(false)
  })
})
