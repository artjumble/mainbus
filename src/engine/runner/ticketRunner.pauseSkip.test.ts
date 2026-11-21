import { beforeEach, describe, expect, it } from 'vitest'
import type { ThreadEvent } from '../../shared/events'
import { scratchPathFor } from '../home'
import { firstMessage } from '../roles/prompt'
import type { PublishInput } from '../git/pullRequests'
import { FAKE_SUMMARY, FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { type RunSpec } from '../runtime/types'
import { defaultLineup } from '../store/lineups'
import { FIXED_NOW } from '../store/testDb'
import { MOVED_ON, TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { SUMMARY_USAGE, StopRecording, count, emitted, installRunnerHooks, makeRunner, paths, repos, runners, thread, ticket, waitForPending, waitForThread, worktrees } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner Pause and Resume', () => {
  const working: FakeStep[] = [{ emit: { kind: 'session', sessionId: 's1' } }, { waitForSend: true }]

  async function workingRun(runtime: FakeRuntime, unattended = false): Promise<TicketRunner> {
    const runner = makeRunner(runtime, worktrees, unattended)
    await runner.start(ticket.id)
    await waitForThread((e) => e.kind === 'session')
    return runner
  }

  it('Pause interrupts the active role and stops its process; the run stays open, Paused, with its session', async () => {
    const runtime = new StopRecording(working)
    const runner = await workingRun(runtime)

    await runner.pause(ticket.id)

    expect(runtime.interrupted).toEqual(['fake-1'])
    expect(runtime.stopped).toContain('fake-1')
    expect(await runner.stateOf(ticket.id)).toEqual({
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'paused',
      summary: null,
      canContinue: false,
      pausedByUser: true,
      deferredUntil: null
    })
    expect(await repos.runs.latest(ticket.id)).toMatchObject({ endReason: null, sessionId: 's1' })
    const events = await thread()
    expect(count(events, 'paused')).toBe(1)
    // The process going down is the pause, not something to report.
    expect(count(events, 'process_exit')).toBe(0)
    // Nothing is left to pause.
    await expect(runner.pause(ticket.id)).rejects.toThrow('No agent is working on this ticket')
  })

  it('Resume continues the same session with "Continue." and the role is working again', async () => {
    const runtime = new FakeRuntime(working)
    const runner = await workingRun(runtime)
    await runner.pause(ticket.id)

    await runner.resumePaused(ticket.id)

    expect(runtime.specs).toHaveLength(2)
    expect(runtime.specs[1]).toMatchObject({ resumeSessionId: 's1', prompt: 'Continue.' })
    expect(count(await thread(), 'resumed')).toBe(1)
    expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working', pausedByUser: false })
    await expect(runner.resumePaused(ticket.id)).rejects.toThrow('There is no paused agent to resume on this ticket')
  })

  it('a role paused before its session started gets its first message on Resume', async () => {
    const runtime = new FakeRuntime([{ waitForSend: true }])
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await eventually(async () => expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working'))
    await runner.pause(ticket.id)

    await runner.resumePaused(ticket.id)
    expect(runtime.specs[1]).toMatchObject({ prompt: firstMessage(ticket) })
    expect(runtime.specs[1]!.resumeSessionId).toBeUndefined()
  })

  it('a message to a paused role resumes it with the message, and the pause is over', async () => {
    const runtime = new FakeRuntime(working)
    const runner = await workingRun(runtime)
    await runner.pause(ticket.id)

    await runner.send(ticket.id, 'Use the new API')

    expect(runtime.specs[1]).toMatchObject({ resumeSessionId: 's1', prompt: 'Use the new API' })
    expect(await runner.stateOf(ticket.id)).toMatchObject({ agentStatus: 'working', pausedByUser: false })
  })
})

describe('TicketRunner Skip to next role', () => {
  function roleOf(spec: RunSpec): string {
    return /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
  }

  /** Each agent records a session named after its role (a resumed one keeps its own), says it is at work, and stays open. */
  function script(spec: RunSpec): FakeStep[] {
    const role = roleOf(spec)
    return [
      { emit: { kind: 'session', sessionId: spec.resumeSessionId ?? `session-${role}` } },
      { emit: { kind: 'message', text: `${role} at work` } },
      { waitForSend: true }
    ]
  }

  let publishes: PublishInput[]

  function skipRunner(runtime: FakeRuntime, summaryTimeoutMs?: number): TicketRunner {
    const runner = new TicketRunner({
      repos,
      worktrees,
      runtime,
      now: () => FIXED_NOW,
      emit: (e) => emitted.push(e),
      pullRequests: {
        publish: async (input) => {
          publishes.push(input)
          return { ok: true, pr: { url: 'https://github.com/example/repo/pull/1', number: 1 }, opened: true }
        }
      },
      ...(summaryTimeoutMs !== undefined ? { summaryTimeoutMs } : {})
    })
    runners.push(runner)
    return runner
  }

  async function threeRoles(): Promise<void> {
    await repos.lineups.save(ticket.workspaceId, defaultLineup())
  }

  /** Waits until the runtime has started agent number `n` (counting from 1) and it is the ticket's working agent. */
  async function nth(runner: TicketRunner, runtime: FakeRuntime, n: number): Promise<RunSpec> {
    await eventually(async () => {
      expect(runtime.specs.length).toBeGreaterThanOrEqual(n)
      expect(runner.isLaunching(ticket.id)).toBe(false)
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
      expect(count(await thread(), 'session')).toBeGreaterThan(0)
    })
    return runtime.specs[n - 1]!
  }

  async function runsOfTicket(): Promise<[string, string | null, boolean][]> {
    return (await repos.runs.listForTicket(ticket.id)).map((r) => [r.role, r.endReason, r.skipped])
  }

  async function handoffOf(role: string): Promise<ThreadEvent | undefined> {
    const run = (await repos.runs.listForTicket(ticket.id)).findLast((r) => r.role === role)!
    return (await repos.runs.events(run.id)).map((e) => e.event).findLast((e) => e.kind === 'handoff')
  }

  beforeEach(async () => {
    publishes = []
    await repos.workspaces.setOpenPrOnReview(ticket.workspaceId, true)
  })

  it('ends the active role as handed off and skipped, and starts the next with a summary marked as generated', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script, { summaryUsage: SUMMARY_USAGE })
    const runner = skipRunner(runtime)
    await runner.start(ticket.id)
    await nth(runner, runtime, 1)
    expect((await runner.boardView(ticket.id, async () => [])).skipTo).toBe('Implementer')

    await runner.skip(ticket.id)

    const implementer = await nth(runner, runtime, 2)
    expect(roleOf(implementer)).toBe('Implementer')
    expect(runtime.interrupted).toEqual(['fake-1'])
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff', true],
      ['Implementer', null, false]
    ])
    expect(await handoffOf('Planner')).toEqual({
      kind: 'handoff',
      summary: FAKE_SUMMARY,
      outcome: 'done',
      notesForNext: '',
      to: 'Implementer',
      skipped: { by: 'user', source: 'summary' }
    })
    expect(implementer.prompt).toBe(firstMessage(ticket, 'Planner'))
    expect(implementer.resumeSessionId).toBeUndefined()
    expect(implementer.appendSystemPrompt).toContain(
      'From <ticket-data field="role">Planner</ticket-data>:\n' +
        'The user skipped the Planner. Mainbus wrote this summary from its log; the Planner did not write it.\n' +
        `<ticket-data field="handoff-summary">\n${FAKE_SUMMARY}\n</ticket-data>`
    )
    expect((await thread())[0]).toEqual({ kind: 'role_handoff', from: 'Planner', to: 'Implementer' })

    // The summary call: one shot, in the worktree, from the Planner's log, limited to 2 minutes.
    const t = await repos.tickets.get(ticket.id)
    expect(runtime.summaries).toHaveLength(1)
    expect(runtime.summaries[0]).toMatchObject({
      cwd: t.worktreePath,
      tempDir: scratchPathFor(paths, t.worktreePath as string),
      timeoutMs: 120_000
    })
    expect(runtime.summaries[0]!.prompt).toContain('<ticket-data field="role-log">\nPlanner: Planner at work\n</ticket-data>')
    expect(runtime.summaries[0]!.prompt).toContain('for the Implementer, who takes over next')
    // The call's usage is recorded on the skipped run, as a Mainbus call.
    const planner = (await repos.runs.listForTicket(ticket.id)).find((r) => r.role === 'Planner')!
    await eventually(async () =>
      expect((await repos.runs.events(planner.id)).map((e) => e.event)).toContainEqual({ ...SUMMARY_USAGE, call: 'summary' })
    )
    expect(publishes).toEqual([])
  })

  it.each([
    ['fails', { fail: 'The summary failed: overloaded' }, undefined],
    ['takes too long', { hang: true } as const, 50]
  ])('when the summary call %s, the digest stands in, marked as built by Mainbus', async (_name, summary, timeoutMs) => {
    await threeRoles()
    const runtime = new FakeRuntime(script, { summary })
    const runner = skipRunner(runtime, timeoutMs)
    await runner.start(ticket.id)
    await nth(runner, runtime, 1)

    await runner.skip(ticket.id)

    const implementer = await nth(runner, runtime, 2)
    expect(await handoffOf('Planner')).toMatchObject({
      summary: 'Planner: Planner at work',
      to: 'Implementer',
      skipped: { by: 'user', source: 'digest' }
    })
    expect(implementer.appendSystemPrompt).toContain(
      'The user skipped the Planner. Mainbus built this digest from its log; the Planner did not write it.'
    )
    if (timeoutMs !== undefined) expect(runtime.summaries[0]!.timeoutMs).toBe(timeoutMs)
  })

  it('skipping the last role puts the ticket in Review and pushes and opens the PR once', async () => {
    const runtime = new FakeRuntime(script)
    const runner = skipRunner(runtime)
    await runner.start(ticket.id)
    const implementer = await nth(runner, runtime, 1)
    expect((await runner.boardView(ticket.id, async () => [])).skipTo).toBeNull()

    await runner.skip(ticket.id)

    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', agentStatus: 'handed_off' })
    expect(await runsOfTicket()).toEqual([['Implementer', 'handoff', true]])
    expect(await handoffOf('Implementer')).toMatchObject({ summary: FAKE_SUMMARY, skipped: { by: 'user', source: 'summary' } })
    expect((await handoffOf('Implementer')) as { to?: string }).not.toHaveProperty('to')
    expect(runtime.summaries[0]!.prompt).toContain('for the user, who reviews the work next')
    expect(publishes).toHaveLength(1)
    expect(publishes[0]!.handoffSummary).toBe(`Generated by Mainbus because the Implementer was skipped.\n\n${FAKE_SUMMARY}`)
    expect(await thread()).toContainEqual(expect.objectContaining({ kind: 'pull_request', number: 1 }))

    // The skipped agent's own handoff comes too late, and pushes nothing more.
    expect(await implementer.roleTools.handoff({ summary: 'Mine', notesForNext: '' })).toBe('This run has ended.')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(publishes).toHaveLength(1)
    expect(runtime.specs).toHaveLength(1)
  })

  it('a role handed a problem back returns to the role waiting on it', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = skipRunner(runtime)
    await runner.start(ticket.id)
    for (const n of [1, 2]) await (await nth(runner, runtime, n)).roleTools.handoff({ summary: 'Done', notesForNext: '' })
    const reviewer = await nth(runner, runtime, 3)
    await reviewer.roleTools.reportProblem({ details: 'The limit is off by one' })
    const fixing = await nth(runner, runtime, 4)
    expect(roleOf(fixing)).toBe('Implementer')
    expect((await runner.boardView(ticket.id, async () => [])).skipTo).toBe('Reviewer')

    await runner.skip(ticket.id)

    const back = await nth(runner, runtime, 5)
    expect(roleOf(back)).toBe('Reviewer')
    expect(back.resumeSessionId).toBe('session-Reviewer')
    expect(back.prompt).toContain('Implementer handed the ticket back to you after your report')
    expect(back.prompt).toContain(FAKE_SUMMARY)
  })

  describe('with the run an action is meant for (a confirmed proposal)', () => {
    it('reports the active role, its status and the role a skip would start', async () => {
      await threeRoles()
      const runtime = new FakeRuntime(script)
      const runner = skipRunner(runtime)
      expect(await runner.activeRole(ticket.id)).toBeNull()
      await runner.start(ticket.id)
      await nth(runner, runtime, 1)
      const run = (await repos.runs.latest(ticket.id))!
      expect(await runner.activeRole(ticket.id)).toEqual({ agentRunId: run.id, role: 'Planner', agentStatus: 'working', model: expect.any(String), effort: expect.any(String), next: 'Implementer' })
      await runner.stop(ticket.id)
      expect(await runner.activeRole(ticket.id)).toBeNull()
    })

    it('skip, pause and stop for a run that is not the latest throw and change nothing', async () => {
      await threeRoles()
      const runtime = new FakeRuntime(script)
      const runner = skipRunner(runtime)
      await runner.start(ticket.id)
      await nth(runner, runtime, 1)
      const before = await thread()
      const stale = { agentRunId: 'a-role-that-handed-off' }

      await expect(runner.skip(ticket.id, stale)).rejects.toThrow(MOVED_ON)
      await expect(runner.pause(ticket.id, stale)).rejects.toThrow(MOVED_ON)
      await expect(runner.stop(ticket.id, stale)).rejects.toThrow(MOVED_ON)

      expect(await thread()).toEqual(before)
      expect(await runsOfTicket()).toEqual([['Planner', null, false]])
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
      expect(runtime.interrupted).toEqual([])
      // The refused stop left no stop pending: the ticket's next launch is not prevented.
      const run = (await repos.runs.latest(ticket.id))!
      await runner.pause(ticket.id, { agentRunId: run.id })
      await runner.skip(ticket.id, { agentRunId: run.id })
      expect(roleOf(await nth(runner, runtime, 2))).toBe('Implementer')
    })

    it('stops the run it was meant for', async () => {
      await threeRoles()
      const runtime = new FakeRuntime(script)
      const runner = skipRunner(runtime)
      await runner.start(ticket.id)
      await nth(runner, runtime, 1)
      const run = (await repos.runs.latest(ticket.id))!
      await runner.stop(ticket.id, { agentRunId: run.id })
      expect(await runsOfTicket()).toEqual([['Planner', 'stopped', false]])
    })
  })

  it('skips a role the user paused, with no process to stop', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = skipRunner(runtime)
    await runner.start(ticket.id)
    await nth(runner, runtime, 1)
    await runner.pause(ticket.id)

    await runner.skip(ticket.id)

    expect(roleOf(await nth(runner, runtime, 2))).toBe('Implementer')
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff', true],
      ['Implementer', null, false]
    ])
  })

  it('expires the skipped role’s pending question', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = skipRunner(runtime)
    await runner.start(ticket.id)
    const planner = await nth(runner, runtime, 1)
    await planner.roleTools.askUser({ question: 'Which API?', options: ['Old', 'New'] })
    const decision = await waitForPending()
    expect((await runner.boardView(ticket.id, async () => [])).skipTo).toBe('Implementer')

    await runner.skip(ticket.id)

    expect(roleOf(await nth(runner, runtime, 2))).toBe('Implementer')
    expect((await repos.decisions.get(decision.id)).status).toBe('expired')
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
  })

  it('counts as working while the summary is written; a Stop meanwhile starts no next role', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script, { summary: { hang: true } })
    const runner = skipRunner(runtime, 300)
    await runner.start(ticket.id)
    await nth(runner, runtime, 1)

    const skipping = runner.skip(ticket.id)
    await eventually(() => expect(runtime.summaries).toHaveLength(1))
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', agentStatus: 'working' })
    const stopping = runner.stop(ticket.id)
    await skipping
    await stopping

    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', agentStatus: null })
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff', true],
      ['Implementer', 'stopped', false]
    ])
    expect(runtime.specs).toHaveLength(1)
    expect(runner.isLaunching(ticket.id)).toBe(false)
  })

  it('refuses a ticket with no open run', async () => {
    const runner = skipRunner(new FakeRuntime(script))
    await expect(runner.skip(ticket.id)).rejects.toThrow('No agent is working on this ticket')
  })
})
