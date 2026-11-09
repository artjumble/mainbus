import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import { ProcessSweeper, type ProcessInfo } from '../processes/sweep'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

const CLAUDE_PID = 5000
const LATER = Date.now() + 60_000

let tmp: string
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let paths: HomePaths
let ticket: Ticket
let runners: TicketRunner[]
/** The fake process table; ending a process removes it from here. */
let table: ProcessInfo[]
let ended: number[]
let log: string[]

function leftover(pid: number, name: string, parentPid = CLAUDE_PID): ProcessInfo {
  return { pid, parentPid, name, createdAt: LATER }
}

function sweeper(): ProcessSweeper {
  return new ProcessSweeper(
    async () => [...table],
    async (processes) => {
      log.push('sweep')
      for (const p of processes) ended.push(p.pid)
      table = table.filter((t) => !processes.some((p) => p.pid === t.pid))
    }
  )
}

class LoggingWorktrees extends WorktreeManager {
  override async remove(...args: Parameters<WorktreeManager['remove']>): ReturnType<WorktreeManager['remove']> {
    log.push('remove')
    return super.remove(...args)
  }
}

function makeRunner(runtime: FakeRuntime): TicketRunner {
  const runner = new TicketRunner({
    repos,
    worktrees,
    runtime,
    now: () => FIXED_NOW,
    emit: () => {},
    processes: sweeper()
  })
  runners.push(runner)
  return runner
}

function fake(script: FakeStep[]): FakeRuntime {
  return new FakeRuntime(script, { nextPid: () => CLAUDE_PID })
}

async function thread(): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(ticket.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

async function notices(): Promise<string[]> {
  return (await thread()).flatMap((e) => (e.kind === 'notice' && e.text.startsWith('Mainbus ended') ? [e.text] : []))
}

const NOTICE = 'Mainbus ended 3 processes the Implementer left running: python3.exe, bash.exe (2).'

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-sweep-'))
  const repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  const git = async (args: string[]): Promise<void> => {
    const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], repoPath)
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  }
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])

  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new LoggingWorktrees(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  await implementerOnly(repos.lineups, ws.id)
  ticket = await repos.tickets.create({
    workspaceId: ws.id,
    title: 'Rate-limit login',
    intent: 'Limit login attempts',
    spec: '',
    criteria: [],
    labels: [],
    column: 'ready'
  })
  runners = []
  ended = []
  log = []
  // The agent's own process is gone from the table; its leftovers (and an unrelated process) remain.
  table = [leftover(6001, 'python3.exe'), leftover(6002, 'bash.exe'), leftover(6003, 'bash.exe', 6001), leftover(7000, 'node.exe', 1234)]
})

afterEach(async () => {
  for (const runner of runners) await runner.stop(ticket.id).catch(() => {})
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

const working: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's1' } }, { waitForSend: true }]

describe('sweeping what an agent left running', () => {
  async function expectSwept(): Promise<void> {
    await eventually(async () => expect(await notices()).toEqual([NOTICE]))
    expect(ended.sort()).toEqual([6001, 6002, 6003])
    // Nothing outside the agent's tree was touched.
    expect(table.map((p) => p.pid)).toEqual([7000])
    expect(await repos.runs.latest(ticket.id)).toMatchObject({ processPid: null, processStartedAt: null })
  }

  it('records the claude process on the run while it works', async () => {
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await eventually(async () =>
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ processPid: CLAUDE_PID, processStartedAt: expect.any(Number) })
    )
  })

  it('sweeps after a handoff', async () => {
    const runner = makeRunner(
      fake([{ callTool: 'handoff', args: { summary: 'Done', notesForNext: '' } }, { emit: { kind: 'turn_end', ok: true } }, { waitForSend: true }])
    )
    await runner.start(ticket.id)
    await expectSwept()
  })

  it('sweeps after Stop', async () => {
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await runner.stop(ticket.id)
    await expectSwept()
  })

  it('sweeps after Skip', async () => {
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await runner.skip(ticket.id)
    await eventually(async () => expect(ended.sort()).toEqual([6001, 6002, 6003]))
    expect(await notices()).toEqual([NOTICE])
  })

  it('sweeps after a crash', async () => {
    const runner = makeRunner(fake([{ emit: { kind: 'session', sessionId: 's1' } }, { exit: 1 }]))
    await runner.start(ticket.id)
    await expectSwept()
  })

  it('sweeps when the app quits, and the run stays open', async () => {
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await runner.shutdown()
    await expectSwept()
    expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: null })
  })

  it('sweeps on Pause', async () => {
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await eventually(async () => expect(await repos.runs.latest(ticket.id)).toMatchObject({ sessionId: 's1' }))
    await runner.pause(ticket.id)
    await expectSwept()
  })

  it('says nothing when there was nothing to end', async () => {
    table = [leftover(7000, 'node.exe', 1234)]
    const runner = makeRunner(fake(working))
    await runner.start(ticket.id)
    await runner.stop(ticket.id)
    await eventually(async () => expect(await repos.runs.latest(ticket.id)).toMatchObject({ processPid: null }))
    expect(await notices()).toEqual([])
    expect(ended).toEqual([])
  })

  it('does not sweep the new process of a resumed run when the old one exits late', async () => {
    const runtime = fake(working)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await eventually(async () => expect(await repos.runs.latest(ticket.id)).toMatchObject({ sessionId: 's1' }))
    await runner.pause(ticket.id)
    await expectSwept()
    table = [leftover(6100, 'node.exe')]
    await runner.resumePaused(ticket.id)
    await eventually(async () => expect(await repos.runs.latest(ticket.id)).toMatchObject({ processPid: CLAUDE_PID }))
    expect(table.map((p) => p.pid)).toEqual([6100])
  })

  it('does nothing without a sweeper', async () => {
    const runner = new TicketRunner({ repos, worktrees, runtime: fake(working), now: () => FIXED_NOW, emit: () => {} })
    runners.push(runner)
    await runner.start(ticket.id)
    await runner.stop(ticket.id)
    expect(ended).toEqual([])
  })
})

describe('Move to Done', () => {
  it('ends what an earlier session left running, before the worktree is removed', async () => {
    // A run from before a restart: its process is only on the run row.
    const before = makeRunner(new FakeRuntime([{ callTool: 'handoff', args: { summary: 'Done', notesForNext: '' } }, { waitForSend: true }]))
    await before.start(ticket.id)
    const run = await eventually(async () => {
      const r = await repos.runs.latest(ticket.id)
      expect(r).toMatchObject({ endReason: 'handoff' })
      return r!
    })
    await repos.runs.setProcess(run.id, { pid: CLAUDE_PID, startedAt: LATER - 120_000 })
    log = []

    const runner = makeRunner(new FakeRuntime([]))
    expect(await runner.moveToDone(ticket.id)).toBe('done')

    expect(log).toEqual(['sweep', 'remove'])
    expect(ended.sort()).toEqual([6001, 6002, 6003])
    expect(await notices()).toEqual([NOTICE])
    expect(await repos.runs.latest(ticket.id)).toMatchObject({ processPid: null })
  })

  it('removes the worktree even when the processes could not be listed', async () => {
    const before = makeRunner(new FakeRuntime([{ callTool: 'handoff', args: { summary: 'Done', notesForNext: '' } }, { waitForSend: true }]))
    await before.start(ticket.id)
    const run = await eventually(async () => {
      const r = await repos.runs.latest(ticket.id)
      expect(r).toMatchObject({ endReason: 'handoff' })
      return r!
    })
    await repos.runs.setProcess(run.id, { pid: CLAUDE_PID, startedAt: LATER })
    const broken = new TicketRunner({
      repos,
      worktrees,
      runtime: new FakeRuntime([]),
      now: () => FIXED_NOW,
      emit: () => {},
      processes: new ProcessSweeper(
        async () => {
          throw new Error('no table')
        },
        async () => {}
      )
    })
    runners.push(broken)
    expect(await broken.moveToDone(ticket.id)).toBe('done')
  })
})
