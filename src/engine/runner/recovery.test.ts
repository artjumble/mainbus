import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ticket } from '../../shared/domain'
import type { ThreadEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { WorktreeManager } from '../git/worktrees'
import { resolveHome, type HomePaths } from '../home'
import { ProcessSweeper, type ProcessInfo } from '../processes/sweep'
import { firstMessage } from '../roles/prompt'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import type { RunSpec } from '../runtime/types'
import { createRepos, type Repos } from '../store'
import { FIXED_NOW, implementerOnly, openTestDb } from '../store/testDb'
import { RESTART_TEXT, TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

let tmp: string
let repoPath: string
let paths: HomePaths
let closeDb: () => void
let repos: Repos
let worktrees: WorktreeManager
let workspaceId: string
let runners: TicketRunner[]
let tickets: Ticket[]

async function git(args: string[], cwd = repoPath): Promise<string> {
  const r = await runGit(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], cwd)
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

/** An agent that records a session named for its folder and stays open. */
function working(spec: RunSpec): FakeStep[] {
  return [{ emit: { kind: 'session', sessionId: `session-${path.basename(spec.cwd)}` } }, { waitForSend: true }]
}

function makeRunner(runtime: FakeRuntime, extra: { processes?: ProcessSweeper } = {}): TicketRunner {
  const runner = new TicketRunner({ repos, worktrees, runtime, now: () => FIXED_NOW, emit: () => {}, ...extra })
  runners.push(runner)
  return runner
}

async function newTicket(title: string): Promise<Ticket> {
  const t = await repos.tickets.create({ workspaceId, title, intent: title, spec: '', criteria: [], labels: [], column: 'ready' })
  tickets.push(t)
  return t
}

async function events(t: Ticket): Promise<ThreadEvent[]> {
  const run = await repos.runs.latest(t.id)
  return run ? (await repos.runs.events(run.id)).map((e) => e.event) : []
}

/** Starts a ticket with an agent that stays open and has a session, then waits for the session to be stored. */
async function startWorking(runner: TicketRunner, t: Ticket): Promise<void> {
  await runner.start(t.id)
  await eventually(async () => expect((await repos.runs.latest(t.id))?.sessionId).toBeTruthy())
}

/** What a new launch of the app does with the DB and the runner. */
async function relaunch(runtime: FakeRuntime, extra: { processes?: ProcessSweeper } = {}): Promise<TicketRunner> {
  const runner = makeRunner(runtime, extra)
  await runner.markAllNotAlive()
  await runner.recover({ resume: true })
  await runner.queueSettled()
  return runner
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mainbus-recovery-'))
  repoPath = path.join(tmp, 'repo')
  await fs.mkdir(repoPath)
  await git(['init', '-b', 'main'])
  await fs.writeFile(path.join(repoPath, 'README.md'), 'hello\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  paths = resolveHome({ MAINBUS_HOME: path.join(tmp, 'home') }, 'dev', os.homedir())
  const testDb = await openTestDb()
  closeDb = testDb.cleanup
  repos = createRepos(testDb.db, () => FIXED_NOW)
  worktrees = new WorktreeManager(runGit, paths, repos.cleanups)
  const ws = await repos.workspaces.create(repoPath, 'main', 'repo', 'repo')
  workspaceId = ws.id
  await implementerOnly(repos.lineups, ws.id)
  runners = []
  tickets = []
})

afterEach(async () => {
  for (const runner of runners) for (const t of tickets) await runner.stop(t.id).catch(() => {})
  closeDb()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5 })
})

vi.setConfig({ testTimeout: 30_000 })

describe('restart recovery', () => {
  it.each(['graceful quit', 'crash'])('resumes a working agent by session in its folder with the restart message after a %s', async (how) => {
    const t = await newTicket('A')
    const before = makeRunner(new FakeRuntime(working))
    await startWorking(before, t)
    if (how === 'graceful quit') await before.shutdown()
    const wt = (await repos.tickets.get(t.id)).worktreePath!

    const runtime = new FakeRuntime(working)
    const runner = await relaunch(runtime)

    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 'session-1-a', prompt: RESTART_TEXT, cwd: wt })
    expect(await runner.stateOf(t.id)).toMatchObject({ column: 'in_progress', agentStatus: 'working' })
  })

  it('expires a pending permission, then resumes with the restart message', async () => {
    const t = await newTicket('A')
    const before = makeRunner(
      new FakeRuntime([
        { emit: { kind: 'session', sessionId: 's1' } },
        { requestPermission: { toolName: 'Bash', input: { command: 'make' }, toolUseId: 'x' } }
      ])
    )
    await before.start(t.id)
    const pending = await eventually(async () => {
      const [d] = await repos.decisions.pending(t.id)
      expect(d).toBeDefined()
      return d!
    })
    await before.shutdown()

    const runtime = new FakeRuntime(working)
    await relaunch(runtime)

    expect((await repos.decisions.get(pending.id)).status).toBe('expired')
    expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 's1', prompt: RESTART_TEXT })
  })

  it('leaves a run the user paused paused, and Resume still resumes it by session', async () => {
    const t = await newTicket('A')
    const before = makeRunner(new FakeRuntime(working))
    await startWorking(before, t)
    await before.pause(t.id)
    await before.shutdown()

    const runtime = new FakeRuntime(working)
    const runner = await relaunch(runtime)

    expect(runtime.specs).toHaveLength(0)
    expect(await runner.stateOf(t.id)).toMatchObject({ agentStatus: 'paused', pausedByUser: true })
    await runner.resumePaused(t.id)
    expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 'session-1-a' })
  })

  it('leaves a run waiting on a question waiting, and the answer resumes it', async () => {
    const t = await newTicket('A')
    const before = makeRunner(
      new FakeRuntime([
        { emit: { kind: 'session', sessionId: 's1' } },
        { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
        { emit: { kind: 'turn_end', ok: true } },
        { waitForSend: true }
      ])
    )
    await before.start(t.id)
    const [question] = await eventually(async () => {
      const pending = await repos.decisions.pending(t.id)
      expect(pending).toHaveLength(1)
      return pending
    })
    await before.shutdown()

    const runtime = new FakeRuntime(working)
    const runner = await relaunch(runtime)

    expect(runtime.specs).toHaveLength(0)
    expect((await repos.decisions.get(question!.id)).status).toBe('pending')
    expect(await runner.stateOf(t.id)).toMatchObject({ column: 'needs_you' })
    await runner.answer(question!.id, { kind: 'option', index: 1 }, 'thread')
    expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 's1' })
    expect(runtime.specs[0]!.prompt).toContain('New API')
  })

  it('leaves a run waiting only on a deferred decision alone', async () => {
    const t = await newTicket('A')
    const before = makeRunner(
      new FakeRuntime([
        { emit: { kind: 'session', sessionId: 's1' } },
        { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
        { waitForSend: true }
      ])
    )
    await before.start(t.id)
    const [question] = await eventually(async () => {
      const pending = await repos.decisions.pending(t.id)
      expect(pending).toHaveLength(1)
      return pending
    })
    await repos.decisions.defer(question!.id, '2099-01-01T00:00:00.000Z')
    await before.shutdown()

    const runtime = new FakeRuntime(working)
    await relaunch(runtime)
    expect(runtime.specs).toHaveLength(0)
  })

  it('leaves a run stopped by a usage limit to the usage-limit handling', async () => {
    const t = await newTicket('A')
    const before = makeRunner(
      new FakeRuntime([
        { emit: { kind: 'session', sessionId: 's1' } },
        { emit: { kind: 'turn_end', ok: false, error: "You've hit your usage limit. Resets at 5pm." } },
        { exit: 0 }
      ])
    )
    await before.start(t.id)
    await eventually(async () => expect((await events(t)).some((e) => e.kind === 'process_exit')).toBe(true))

    const runtime = new FakeRuntime(working)
    await relaunch(runtime)
    expect(runtime.specs).toHaveLength(0)
  })

  it('starts a role that was handed the ticket but never launched fresh, with its first message', async () => {
    const t = await newTicket('A')
    // A crash right after a handoff: the run exists, was prepared, and never launched.
    const roles = await repos.lineups.get(workspaceId)
    await repos.runs.create(t.id, roles, '')

    const runtime = new FakeRuntime(working)
    await relaunch(runtime)
    expect(runtime.specs[0]!.resumeSessionId).toBeUndefined()
    expect(runtime.specs[0]!.prompt).toBe(firstMessage(await repos.tickets.get(t.id)))
  })

  it('falls back to a fresh session with the previous attempt digest, and says so in the thread', async () => {
    const t = await newTicket('A')
    const before = makeRunner(new FakeRuntime(working))
    await startWorking(before, t)
    await before.shutdown()

    const runtime = new FakeRuntime(working, { rejectResume: true })
    await relaunch(runtime)

    expect(runtime.specs).toHaveLength(2)
    expect(runtime.specs[1]!.resumeSessionId).toBeUndefined()
    expect(runtime.specs[1]!.prompt).toContain('Handoff from the previous attempt')
    expect(runtime.specs[1]!.prompt.endsWith(RESTART_TEXT)).toBe(true)
    expect((await events(t)).some((e) => e.kind === 'notice' && e.text.includes("couldn't resume"))).toBe(true)
  })

  it('ignores an open run that is not its ticket latest, and tickets in Done', async () => {
    const a = await newTicket('A')
    const b = await newTicket('B')
    const before = makeRunner(new FakeRuntime(working))
    await startWorking(before, a)
    await startWorking(before, b)
    await before.shutdown()
    await repos.tickets.setManualColumn(b.id, 'done')

    const runtime = new FakeRuntime(working)
    await relaunch(runtime)
    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]!.resumeSessionId).toBe('session-1-a')
  })

  it('shutdown before the queue drains launches nothing', async () => {
    const t = await newTicket('A')
    const before = makeRunner(new FakeRuntime(working))
    await startWorking(before, t)
    await before.shutdown()

    const runtime = new FakeRuntime(working)
    const runner = makeRunner(runtime)
    await runner.recover({ resume: false })
    await runner.shutdown()
    runner.kickQueue()
    await runner.queueSettled()
    expect(runtime.specs).toHaveLength(0)
  })

  describe('the cap', () => {
    it('resumes oldest first within the cap, ahead of runs that were queued at quit', async () => {
      await repos.settings.setMaxAgents(1)
      const [a, b, c] = [await newTicket('A'), await newTicket('B'), await newTicket('C')]
      // Raise the cap to launch two, queue the third, then quit with the cap lowered.
      await repos.settings.setMaxAgents(2)
      const before = makeRunner(new FakeRuntime(working))
      await startWorking(before, a)
      await startWorking(before, b)
      await before.start(c.id)
      expect((await before.stateOf(c.id)).agentStatus).toBe('queued')
      await before.shutdown()
      await repos.settings.setMaxAgents(1)

      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)

      expect(runtime.specs.map((s) => s.resumeSessionId)).toEqual(['session-1-a'])
      expect(await runner.stateOf(b.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 1 })
      expect(await runner.stateOf(c.id)).toMatchObject({ agentStatus: 'queued', queuePosition: 2 })
      await runner.stop(a.id)
      await runner.queueSettled()
      expect(runtime.specs.map((s) => s.resumeSessionId)).toEqual(['session-1-a', 'session-2-b'])
    })
  })

  describe('leftover processes', () => {
    const CLAUDE_PID = 5000
    const LATER = Date.now() + 60_000

    async function crashedWithProcess(): Promise<Ticket> {
      const t = await newTicket('A')
      const before = makeRunner(new FakeRuntime(working))
      await startWorking(before, t)
      await repos.runs.setProcess((await repos.runs.latest(t.id))!.id, { pid: CLAUDE_PID, startedAt: LATER })
      return t
    }

    it('sweeps them before anything resumes', async () => {
      const t = await crashedWithProcess()
      const log: string[] = []
      const table: ProcessInfo[] = [{ pid: 6000, parentPid: CLAUDE_PID, name: 'python3.exe', createdAt: LATER }]
      const sweeper = new ProcessSweeper(
        async () => table,
        async () => void log.push('sweep')
      )
      const runtime = new (class extends FakeRuntime {
        override async start(...args: Parameters<FakeRuntime['start']>) {
          log.push('start')
          return super.start(...args)
        }
      })(working)

      await relaunch(runtime, { processes: sweeper })

      expect(log).toEqual(['sweep', 'start'])
      expect((await repos.runs.latest(t.id))!.processPid).toBeNull()
      expect((await events(t)).some((e) => e.kind === 'notice' && e.text.startsWith('Mainbus ended'))).toBe(true)
    })

    it("doesn't resume a run whose old process couldn't be checked, and says so", async () => {
      const t = await crashedWithProcess()
      const sweeper = new ProcessSweeper(
        async () => {
          throw new Error('no table')
        },
        async () => {}
      )
      const runtime = new FakeRuntime(working)
      await relaunch(runtime, { processes: sweeper })

      expect(runtime.specs).toHaveLength(0)
      expect((await events(t)).some((e) => e.kind === 'notice' && e.text.includes("couldn't check"))).toBe(true)
    })
  })

  describe('a missing folder', () => {
    async function crashedWithoutFolder(): Promise<{ t: Ticket; wt: string }> {
      const t = await newTicket('A')
      const before = makeRunner(new FakeRuntime(working))
      await startWorking(before, t)
      await before.shutdown()
      const wt = (await repos.tickets.get(t.id)).worktreePath!
      await fs.rm(wt, { recursive: true, force: true })
      return { t, wt }
    }

    async function theDecision(t: Ticket) {
      const pending = await repos.decisions.pending(t.id)
      expect(pending).toHaveLength(1)
      return pending[0]!
    }

    it('becomes a decision, is never restarted, and a second launch opens no second decision', async () => {
      const { t } = await crashedWithoutFolder()
      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)
      await runner.recover({ resume: true })

      expect(runtime.specs).toHaveLength(0)
      const d = await theDecision(t)
      expect(d.options).toEqual([`Recreate the folder from ${(await repos.tickets.get(t.id)).branch} and continue`, 'Stop the run'])
      expect(await runner.stateOf(t.id)).toMatchObject({ column: 'needs_you' })
    })

    it('Recreate brings the folder back on the ticket branch and resumes by session', async () => {
      const { t, wt } = await crashedWithoutFolder()
      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)
      await runner.answer((await theDecision(t)).id, { kind: 'option', index: 0 }, 'thread')

      expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], wt)).trim()).toBe((await repos.tickets.get(t.id)).branch)
      expect(runtime.specs[0]).toMatchObject({ resumeSessionId: 'session-1-a', prompt: RESTART_TEXT, cwd: wt })
    })

    it('Stop ends the run and starts nothing', async () => {
      const { t } = await crashedWithoutFolder()
      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)
      await runner.answer((await theDecision(t)).id, { kind: 'option', index: 1 }, 'thread')

      expect(runtime.specs).toHaveLength(0)
      expect((await repos.runs.latest(t.id))!.endReason).toBe('stopped')
      expect(await runner.stateOf(t.id)).toMatchObject({ column: 'ready' })
    })

    it('Recreate fails the run when the branch is gone, and creates no branch', async () => {
      const { t } = await crashedWithoutFolder()
      const branch = (await repos.tickets.get(t.id)).branch!
      await git(['worktree', 'prune'])
      await git(['branch', '-D', branch])
      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)
      await runner.answer((await theDecision(t)).id, { kind: 'option', index: 0 }, 'thread')

      expect(runtime.specs).toHaveLength(0)
      expect((await repos.runs.latest(t.id))!.endReason).toBe('failed')
      expect((await events(t)).some((e) => e.kind === 'error' && e.message.includes('no longer exists'))).toBe(true)
      expect((await git(['branch', '--list', branch])).trim()).toBe('')
    })

    it('refuses to answer another decision of the run while the folder one is open', async () => {
      const t = await newTicket('A')
      const before = makeRunner(
        new FakeRuntime([
          { emit: { kind: 'session', sessionId: 's1' } },
          { callTool: 'askUser', args: { question: 'Which API?', options: ['Old API', 'New API'] } },
          { waitForSend: true }
        ])
      )
      await before.start(t.id)
      const [question] = await eventually(async () => {
        const pending = await repos.decisions.pending(t.id)
        expect(pending).toHaveLength(1)
        return pending
      })
      await before.shutdown()
      await fs.rm((await repos.tickets.get(t.id)).worktreePath!, { recursive: true, force: true })

      const runtime = new FakeRuntime(working)
      const runner = await relaunch(runtime)
      await expect(runner.answer(question!.id, { kind: 'option', index: 0 }, 'thread')).rejects.toThrow('folder is missing')
      expect((await repos.decisions.get(question!.id)).status).toBe('pending')
      expect(runtime.specs).toHaveLength(0)
    })
  })
})
