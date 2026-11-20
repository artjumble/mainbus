import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { runGit } from '../git/git'
import { FakeRuntime } from '../runtime/fakeRuntime'
import { type RunHandle } from '../runtime/types'
import { FIXED_NOW } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { SlowRuntime, SlowWorktrees, count, emitted, exists, git, installRunnerHooks, keepAlive, makeRunner, paths, pausedRun, permission, repos, runners, thread, ticket, waitForPending, worktrees } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner', () => {
  describe("a ticket's folder that git no longer lists", () => {
    const handoff = () =>
      new FakeRuntime([
        { callTool: 'handoff', args: { summary: 'Added the limiter', notesForNext: '' } },
        { emit: { kind: 'turn_end', ok: true } }
      ])

    /** The ticket in Review, its folder unregistered with files in it, as an interrupted removal leaves it. */
    async function leftover(runtime: FakeRuntime, moved: string[] = []) {
      const runner = new TicketRunner({
        repos,
        worktrees,
        runtime,
        now: () => FIXED_NOW,
        emit: (e) => emitted.push(e),
        onMovedToDone: async (id) => void moved.push(id)
      })
      runners.push(runner)
      await runner.start(ticket.id)
      await eventually(async () => expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' }))
      const { worktreePath, branch } = await repos.tickets.get(ticket.id)
      const wt = worktreePath as string
      await git(['worktree', 'remove', '--force', wt])
      await fs.mkdir(path.join(wt, 'node_modules', 'a'), { recursive: true })
      await fs.writeFile(path.join(wt, 'node_modules', 'a', 'one.js'), 'x')
      await fs.writeFile(path.join(wt, 'package.json'), '{}')
      return { runner, wt, branch: branch as string }
    }

    it('asks instead of refusing, reuses the question, and Delete finishes the move to Done', async () => {
      const moved: string[] = []
      const { runner, wt, branch } = await leftover(handoff(), moved)

      expect(await runner.moveToDone(ticket.id)).toBe('asked')
      const [decision] = await repos.decisions.pending(ticket.id)
      expect(decision!.question).toContain('still holds 2 files')
      expect(decision!.question).toContain('node_modules (1 file)')
      expect(decision!.question).toContain('package.json (1 file)')
      expect(decision!.question).toContain(`the branch ${branch}, which still exists`)
      expect(decision!.options).toEqual(['Delete the folder and move to Done', 'Keep it'])
      expect(await repos.tickets.get(ticket.id)).toMatchObject({ manualColumn: 'ready', worktreePath: wt })
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' })

      expect(await runner.moveToDone(ticket.id)).toBe('asked')
      expect(await repos.decisions.pending(ticket.id)).toHaveLength(1)

      await runner.answer(decision!.id, { kind: 'option', index: 0 }, 'thread')
      expect(await exists(wt)).toBe(false)
      expect(await repos.tickets.get(ticket.id)).toMatchObject({ manualColumn: 'done', worktreePath: null, branch })
      expect(await git(['branch', '--list', branch])).toContain(branch)
      expect(moved).toEqual([ticket.id])
    })

    it('Keep it leaves the folder and the column alone', async () => {
      const { runner, wt } = await leftover(handoff())
      expect(await runner.moveToDone(ticket.id)).toBe('asked')
      const [decision] = await repos.decisions.pending(ticket.id)

      await runner.answer(decision!.id, { kind: 'option', index: 1 }, 'thread')

      expect(await exists(path.join(wt, 'package.json'))).toBe(true)
      expect(await repos.tickets.get(ticket.id)).toMatchObject({ manualColumn: 'ready', worktreePath: wt })
    })
  })

  it('stateOf a Done ticket does not load its runs or their events', async () => {
    const runtime = new FakeRuntime([
      { callTool: 'handoff', args: { summary: 'Added the limiter', notesForNext: '' } },
      { emit: { kind: 'turn_end', ok: true } }
    ])
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await eventually(async () => expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' }))
    expect(await runner.moveToDone(ticket.id)).toBe('done')
    const events = vi.spyOn(repos.runs, 'events')
    const latest = vi.spyOn(repos.runs, 'latest')

    expect(await runner.stateOf(ticket.id)).toEqual({
      column: 'done',
      phase: 'done',
      agentStatus: null,
      summary: null,
      canContinue: false,
      pausedByUser: false,
      deferredUntil: null
    })
    expect(events).not.toHaveBeenCalled()
    expect(latest).not.toHaveBeenCalled()
  })

  describe('lifecycle races', () => {
    it('an answer given during a slow resume is delivered once the launch completes', async () => {
      await pausedRun({ ask: true })
      const decision = await waitForPending()
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)

      const resuming = runner.continue(ticket.id)
      await slow.firstStart
      const answering = runner.answer(decision.id, { kind: 'option', index: 1 }, 'thread')
      // Long enough for an unserialized answer to be saved and its delivery attempted mid-launch.
      await new Promise((resolve) => setTimeout(resolve, 100))
      slow.open()
      await resuming
      await answering

      expect(slow.specs).toHaveLength(1)
      expect(slow.specs[0].resumeSessionId).toBe('session-1')
      expect(slow.sent).toEqual(['Answer: New API'])
      expect(await repos.decisions.get(decision.id)).toMatchObject({ status: 'answered' })
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', agentStatus: 'working' })
    })

    it('stop during a slow launch stops the process as soon as start resolves', async () => {
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)

      const starting = runner.start(ticket.id)
      await slow.firstStart
      const stopping = runner.stop(ticket.id)
      slow.open()
      await starting
      await stopping

      expect(slow.specs).toHaveLength(1)
      expect(slow.stoppedHandles).toHaveLength(1)
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'stopped' })
      expect(count(await thread(), 'stopped')).toBe(1)
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', phase: 'not_started', agentStatus: null })
    })

    it('shutdown during a slow launch stops the new process and leaves the run open', async () => {
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)

      const starting = runner.start(ticket.id)
      await slow.firstStart
      const shuttingDown = runner.shutdown()
      slow.open()
      await starting
      await shuttingDown

      expect(slow.stoppedHandles).toHaveLength(1)
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: null })
      expect(count(await thread(), 'stopped')).toBe(0)
      expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'paused', canContinue: true })
    })

    it('a start after shutdown has begun spawns nothing', async () => {
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)
      const other = await repos.tickets.create({
        workspaceId: ticket.workspaceId,
        title: 'Other',
        intent: 'x',
        spec: '',
        criteria: [],
        labels: [],
        column: 'ready'
      })

      const starting = runner.start(ticket.id)
      await slow.firstStart
      const shuttingDown = runner.shutdown()
      await expect(runner.start(other.id)).rejects.toThrow(/shutting down/i)
      slow.open()
      await starting
      await shuttingDown

      expect(slow.startCalls).toBe(1)
      expect(await repos.runs.latest(other.id)).toBeNull()
    })

    it('a turn that ends while shutting down records no nudge', async () => {
      // Like a real process: the last turn reports its end as the process goes down.
      class TurnEndsOnStop extends FakeRuntime {
        override async *events(run: RunHandle): AsyncGenerator<AgentEvent> {
          yield* super.events(run)
          yield { kind: 'turn_end', ok: true }
        }
      }
      const runtime = new TurnEndsOnStop(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)

      await runner.shutdown()

      const kinds = (await thread()).map((e) => e.kind)
      expect(kinds).toContain('turn_end')
      expect(kinds).not.toContain('nudge')
      expect(kinds).not.toContain('error')
      expect(runtime.sent).toEqual([])
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: null })
    })

    it('a move to Backlog queued behind a start sees the run the start creates', async () => {
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)

      const starting = runner.start(ticket.id)
      await slow.firstStart
      const moving = runner.moveToColumn(ticket.id, 'backlog')
      slow.open()
      await starting

      await expect(moving).rejects.toThrow(/stop the agent/i)
      expect((await repos.tickets.get(ticket.id)).manualColumn).toBe('ready')
    })

    it('stateOf during a launch is working, not paused', async () => {
      const slow = new SlowRuntime(keepAlive)
      const runner = makeRunner(slow)

      const starting = runner.start(ticket.id)
      await slow.firstStart

      expect(await runner.stateOf(ticket.id)).toMatchObject({
        column: 'in_progress',
        agentStatus: 'working',
        canContinue: false
      })
      slow.open()
      await starting
    })

    it('send racing stop on a paused ticket never launches a process on the stopped run', async () => {
      await pausedRun()
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)

      await Promise.allSettled([runner.send(ticket.id, 'Try again'), runner.stop(ticket.id)])

      expect(runtime.specs).toEqual([])
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'stopped' })
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', agentStatus: null })
      await expect(runner.send(ticket.id, 'Hello?')).rejects.toThrow()
      expect(runtime.specs).toEqual([])
    })

    it('handoff racing stop: whichever ends the run first wins, and it is never overwritten', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)

      const [reply] = await Promise.all([
        runtime.specs[0].roleTools.handoff({ summary: 'Added the limiter', notesForNext: '' }),
        runner.stop(ticket.id)
      ])

      const endReason = (await repos.runs.latest(ticket.id))?.endReason
      const events = await thread()
      if (endReason === 'handoff') {
        expect(reply).toMatch(/Handed off/)
        expect([count(events, 'handoff'), count(events, 'stopped')]).toEqual([1, 0])
      } else {
        expect(endReason).toBe('stopped')
        expect(reply).toBe('This run has ended.')
        expect([count(events, 'handoff'), count(events, 'stopped')]).toEqual([0, 1])
      }
    })

    it('a handoff after stop is refused and leaves the run stopped', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      await runner.stop(ticket.id)
      const spec = runtime.specs[0]

      expect(await spec.roleTools.handoff({ summary: 'Late', notesForNext: '' })).toBe('This run has ended.')
      expect(await spec.roleTools.askUser({ question: 'Late?', options: ['Yes'] })).toBe('This run has ended.')
      expect(await spec.onPermission(permission('npm run build'))).toEqual({ allow: false, message: 'This run has ended.' })
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'stopped' })
      expect(count(await thread(), 'handoff')).toBe(0)
      expect(await repos.decisions.pending(ticket.id)).toEqual([])
    })

    it('a stop after handoff does not overwrite the handoff', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      await runtime.specs[0].roleTools.handoff({ summary: 'Added the limiter', notesForNext: '' })

      await runner.stop(ticket.id)

      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'handoff' })
      expect(count(await thread(), 'stopped')).toBe(0)
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' })
    })

    it('a successful handoff expires a question still pending on that run', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      await runtime.specs[0].roleTools.askUser({ question: 'Which API?', options: ['Old API', 'New API'] })
      const question = await waitForPending()

      await runtime.specs[0].roleTools.handoff({ summary: 'Added the limiter', notesForNext: '' })

      expect(await repos.decisions.get(question.id)).toMatchObject({ status: 'expired' })
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review' })
    })

    it('two concurrent stops record exactly one stopped event', async () => {
      const runner = makeRunner(new FakeRuntime(keepAlive))
      await runner.start(ticket.id)

      await Promise.all([runner.stop(ticket.id), runner.stop(ticket.id)])

      expect(count(await thread(), 'stopped')).toBe(1)
    })

    it('stop with a pending permission expires it and the waiting verdict is a deny', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)
      await runner.start(ticket.id)
      const verdict = runtime.specs[0].onPermission(permission('npm run build'))
      const decision = await waitForPending()

      await runner.stop(ticket.id)

      expect(await verdict).toMatchObject({ allow: false })
      expect(await repos.decisions.get(decision.id)).toMatchObject({ status: 'expired' })
      expect((await thread()).at(-1)).toEqual({ kind: 'stopped' })
    })

    it('a double start creates one run', async () => {
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)

      const results = await Promise.allSettled([runner.start(ticket.id), runner.start(ticket.id)])

      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
      expect(runtime.specs).toHaveLength(1)
    })

    it('moveToDone on a paused ticket ends the run first, so a later send cannot revive it', async () => {
      await pausedRun()
      const runtime = new FakeRuntime(keepAlive)
      const runner = makeRunner(runtime)

      expect(await runner.moveToDone(ticket.id)).toBe('done')

      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'stopped' })
      await expect(runner.send(ticket.id, 'Hello?')).rejects.toThrow()
      expect(runtime.specs).toEqual([])
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'done' })
    })

    it('moveToDone on a paused ticket with uncommitted work returns dirty and keeps the session', async () => {
      await pausedRun()
      const { worktreePath } = await repos.tickets.get(ticket.id)
      await fs.writeFile(path.join(worktreePath as string, 'half-done.ts'), 'export {}\n')
      const runner = makeRunner(new FakeRuntime(keepAlive))

      expect(await runner.moveToDone(ticket.id)).toBe('dirty')

      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: null, sessionId: 'session-1' })
      expect(count(await thread(), 'stopped')).toBe(0)
      expect(await repos.tickets.get(ticket.id)).toMatchObject({ manualColumn: 'ready', worktreePath })
      expect(await runner.stateOf(ticket.id)).toMatchObject({
        column: 'in_progress',
        agentStatus: 'paused',
        canContinue: true
      })
    })

    it('a stop queued behind a resume that times out completes, and the fallback never starts a fresh agent', async () => {
      await pausedRun()
      const slow = new SlowRuntime(keepAlive, true)
      const runner = makeRunner(slow)

      const resuming = runner.continue(ticket.id)
      await slow.firstStart
      const stopping = runner.stop(ticket.id)
      slow.open()
      await resuming
      await stopping

      expect(slow.startCalls).toBe(1) // the resume only: no fresh start after it failed
      expect(slow.specs).toEqual([])
      expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: 'stopped' })
      expect(count(await thread(), 'stopped')).toBe(1)
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', agentStatus: null })
    })

    it('stateOf is working while the worktree is being set up for a resume', async () => {
      await pausedRun()
      const slowWorktrees = new SlowWorktrees(runGit, paths, repos.cleanups)
      const runner = makeRunner(new FakeRuntime(keepAlive), slowWorktrees)

      const resuming = runner.continue(ticket.id)
      await eventually(() => expect(slowWorktrees.ensureCalls).toBe(1))

      try {
        expect(await runner.stateOf(ticket.id)).toMatchObject({
          column: 'in_progress',
          agentStatus: 'working',
          canContinue: false
        })
      } finally {
        slowWorktrees.open()
        await resuming
      }
      expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working' })
    })
  })
})
