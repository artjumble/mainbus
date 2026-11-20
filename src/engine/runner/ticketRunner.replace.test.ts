import { describe, expect, it } from 'vitest'
import type { Effort } from '../../shared/domain'
import { EXTRA_INSTRUCTIONS_HEADING, firstMessage, HANDOFFS_HEADING } from '../roles/prompt'
import { FAKE_SUMMARY, FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { type RunSpec } from '../runtime/types'
import { defaultLineup } from '../store/lineups'
import { FIXED_NOW } from '../store/testDb'
import { MOVED_ON, TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { SUMMARY_USAGE, emitted, failures, installRunnerHooks, repos, runners, ticket, worktrees } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner Replace', () => {
  function roleOf(spec: RunSpec): string {
    return /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
  }

  /** Each agent records a session named after its role, says it is at work, and stays open. */
  function script(spec: RunSpec): FakeStep[] {
    const role = roleOf(spec)
    return [
      { emit: { kind: 'session', sessionId: spec.resumeSessionId ?? `session-${role}` } },
      { emit: { kind: 'message', text: `${role} at work` } },
      { waitForSend: true }
    ]
  }

  const SAME = { model: 'opus', effort: 'high' as Effort, extraInstructions: null }

  function replaceRunner(runtime: FakeRuntime): TicketRunner {
    const runner = new TicketRunner({ repos, worktrees, runtime, now: () => FIXED_NOW, emit: (e) => emitted.push(e), summaryTimeoutMs: 300, onFailed: (f) => void failures.push(f) })
    runners.push(runner)
    return runner
  }

  /** Waits until the runtime has started agent number `n` (counting from 1) and it is the ticket's working agent. */
  async function nth(runner: TicketRunner, runtime: FakeRuntime, n: number): Promise<RunSpec> {
    await eventually(async () => {
      expect(runtime.specs.length).toBeGreaterThanOrEqual(n)
      expect(runner.isLaunching(ticket.id)).toBe(false)
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
      // The agent has said something, so there is a log to summarise.
      const events = await repos.runs.events((await repos.runs.latest(ticket.id))!.id)
      expect(events.some((e) => e.event.kind === 'message')).toBe(true)
    })
    return runtime.specs[n - 1]!
  }

  /** Starts the whole lineup and skips the Planner, so the Implementer is the active role. */
  async function atImplementer(runtime: FakeRuntime): Promise<TicketRunner> {
    await repos.lineups.save(ticket.workspaceId, defaultLineup())
    const runner = replaceRunner(runtime)
    await runner.start(ticket.id)
    await nth(runner, runtime, 1)
    await runner.skip(ticket.id)
    await nth(runner, runtime, 2)
    return runner
  }

  const latest = async () => (await repos.runs.latest(ticket.id))!
  const runs = async () => (await repos.runs.listForTicket(ticket.id)).map((r) => [r.role, r.endReason])

  it('ends the run as replaced, pointing at the new one, with a summary generated from its log', async () => {
    const runtime = new FakeRuntime(script, { summaryUsage: SUMMARY_USAGE })
    const runner = await atImplementer(runtime)
    const old = await latest()

    await runner.replace(ticket.id, { agentRunId: old.id }, SAME)
    await nth(runner, runtime, 3)

    const fresh = await latest()
    expect(fresh.id).not.toBe(old.id)
    expect(await runs()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'replaced'],
      ['Implementer', null]
    ])
    const ended = (await repos.runs.listForTicket(ticket.id)).find((r) => r.id === old.id)!
    expect(ended).toMatchObject({ endReason: 'replaced', replacedBy: fresh.id, handoffSummary: FAKE_SUMMARY })
    expect(fresh).toMatchObject({ roleId: old.roleId, ticketRunId: old.ticketRunId, endReason: null, replacedBy: null })

    // The summary was asked for from the replaced agent's log, with a replace prompt (the skip asked for one first).
    expect(runtime.summaries).toHaveLength(2)
    expect(runtime.summaries[1]!.prompt).toContain('replaced')
    expect(runtime.summaries[1]!.prompt).toContain('Implementer at work')
    await eventually(async () =>
      expect((await repos.runs.events(old.id)).filter((e) => e.event.kind === 'usage' && e.event.call === 'summary')).toHaveLength(1)
    )
    const logged = (await repos.runs.events(old.id)).map((e) => e.event).find((e) => e.kind === 'replaced')
    expect(logged).toEqual({ kind: 'replaced', role: 'Implementer', summary: FAKE_SUMMARY, source: 'summary' })
  })

  it('starts the same role fresh, with its usual context and the handoff from the previous run', async () => {
    const runtime = new FakeRuntime(script)
    const runner = await atImplementer(runtime)
    await runner.replace(ticket.id, { agentRunId: (await latest()).id }, SAME)
    const spec = await nth(runner, runtime, 3)

    expect(roleOf(spec)).toBe('Implementer')
    expect(spec.resumeSessionId).toBeUndefined()
    expect(spec.cwd).toBe(runtime.specs[1]!.cwd)
    expect(spec.prompt).toContain(firstMessage(ticket))
    expect(spec.prompt).toContain('Handoff from the previous run')
    expect(spec.prompt).toContain(FAKE_SUMMARY)
    // The usual role context, including what the Planner handed off.
    expect(spec.appendSystemPrompt).toContain(HANDOFFS_HEADING)
    expect(spec.model).toBe('opus')
  })

  it('leaves other roles, the ticket run and its snapshot untouched', async () => {
    const runtime = new FakeRuntime(script)
    const runner = await atImplementer(runtime)
    const old = await latest()
    const planner = (await repos.runs.listForTicket(ticket.id))[0]!
    const before = await repos.runs.ticketRun(old.ticketRunId)

    await runner.replace(ticket.id, { agentRunId: old.id }, { model: 'haiku', effort: 'low', extraInstructions: 'Try the other approach' })
    await nth(runner, runtime, 3)

    expect((await repos.runs.listForTicket(ticket.id))[0]).toEqual(planner)
    const after = await repos.runs.ticketRun(old.ticketRunId)
    expect(after).toEqual(before)
    expect(after.status).toBe('running')
    expect(await repos.tickets.get(ticket.id)).toMatchObject({ title: ticket.title, spec: ticket.spec, criteria: ticket.criteria })
  })

  it("the new run takes the user's model, effort and extra instructions, on top of the ticket run's", async () => {
    const runtime = new FakeRuntime(script)
    const runner = await atImplementer(runtime)
    await runner.replace(ticket.id, { agentRunId: (await latest()).id }, { model: 'haiku', effort: 'low', extraInstructions: 'Try the other approach' })
    const spec = await nth(runner, runtime, 3)

    expect(spec.model).toBe('haiku')
    expect(spec.effort).toBe('low')
    expect(spec.appendSystemPrompt).toContain(EXTRA_INSTRUCTIONS_HEADING)
    expect(spec.appendSystemPrompt).toContain('Try the other approach')
    expect(await latest()).toMatchObject({ model: 'haiku', effort: 'low', extraInstructions: 'Try the other approach' })
  })

  it.each([
    ['fails', { fail: 'boom' }],
    ['is empty', '   '],
    ['takes too long', { hang: true as const }]
  ])('when the summary call %s, the digest of its log stands in', async (_name, summary) => {
    const runtime = new FakeRuntime(script, { summary })
    const runner = await atImplementer(runtime)
    const old = await latest()
    await runner.replace(ticket.id, { agentRunId: old.id }, SAME)
    const spec = await nth(runner, runtime, 3)

    const ended = (await repos.runs.listForTicket(ticket.id)).find((r) => r.id === old.id)!
    expect(ended.handoffSummary).toContain('Implementer at work')
    expect(ended.handoffSummary).not.toBe(FAKE_SUMMARY)
    expect((await repos.runs.events(old.id)).map((e) => e.event)).toContainEqual(expect.objectContaining({ kind: 'replaced', source: 'digest' }))
    expect(spec.prompt).toContain('Implementer at work')
  })

  it('counts as working while the summary is written', async () => {
    const runtime = new FakeRuntime(script, { summary: { hang: true } })
    const runner = await atImplementer(runtime)
    const replacing = runner.replace(ticket.id, { agentRunId: (await latest()).id }, SAME)
    await eventually(() => expect(runtime.summaries.length).toBeGreaterThanOrEqual(2))
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', agentStatus: 'working' })
    await replacing
  })

  it('refuses when the run has moved on, changing nothing', async () => {
    const runtime = new FakeRuntime(script)
    const runner = await atImplementer(runtime)
    const old = await latest()
    await expect(runner.replace(ticket.id, { agentRunId: 'another-run' }, SAME)).rejects.toThrow(MOVED_ON)
    await runner.stop(ticket.id)
    await expect(runner.replace(ticket.id, { agentRunId: old.id }, SAME)).rejects.toThrow()
    expect(await runs()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'stopped']
    ])
  })

  describe('after two replacements', () => {
    async function replaceTimes(runner: TicketRunner, runtime: FakeRuntime, n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        await runner.replace(ticket.id, { agentRunId: (await latest()).id }, SAME)
        await nth(runner, runtime, 3 + i)
      }
    }

    it('does nothing for a role replaced fewer times', async () => {
      const runtime = new FakeRuntime(script)
      const runner = await atImplementer(runtime)
      await replaceTimes(runner, runtime, 1)
      expect(await runner.failIfExhausted(ticket.id, (await latest()).id)).toBe(false)
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
    })

    it('marks the run Failed, with a plain account of what was tried, and the ticket needs you', async () => {
      const runtime = new FakeRuntime(script)
      const runner = await atImplementer(runtime)
      const first = await latest()
      // The first agent got stuck and was redirected, then replaced; so was the second.
      await repos.stuck.hit(first.id, { rule: 'repeated_failure', evidence: ['Bash failed 5 times: npm test'] })
      const episode = (await repos.stuck.open(first.id))!
      await repos.stuck.markRedirected(episode.id)
      await repos.runs.append(first.id, { kind: 'redirected', role: 'Implementer', text: 'Check the fixtures instead' })
      await replaceTimes(runner, runtime, 2)

      const third = await latest()
      await repos.stuck.hit(third.id, { rule: 'silence', evidence: ['No events for 10 minutes'] })
      expect(await runner.failIfExhausted(ticket.id, third.id)).toBe(true)

      expect(await runs()).toEqual([
        ['Planner', 'handoff'],
        ['Implementer', 'replaced'],
        ['Implementer', 'replaced'],
        ['Implementer', 'failed']
      ])
      const state = await runner.stateOf(ticket.id)
      expect(state).toMatchObject({ column: 'needs_you', agentStatus: 'failed' })
      const account = (await repos.runs.events(third.id)).map((e) => e.event).findLast((e) => e.kind === 'error')
      expect(account).toMatchObject({ kind: 'error' })
      const text = (account as { message: string }).message
      expect(text).toContain('replaced 2 times')
      expect(text).toContain('Bash failed 5 times: npm test')
      expect(text).toContain('redirected with: "Check the fixtures instead"')
      expect(text).toContain('No events for 10 minutes')
      expect(text).toContain('It was then replaced by a fresh agent.')
      expect(text).toContain('It is stuck again now.')
      expect(state.summary).toContain('replaced 2 times')
      // Its process is stopped, and nothing more is offered: the run is over.
      expect(await runner.activeRole(ticket.id)).toBeNull()
      expect(await runner.failIfExhausted(ticket.id, third.id)).toBe(false)
      // Told once, when it failed; the second call changed nothing.
      expect(failures).toEqual([{ workspaceId: ticket.workspaceId, ticketId: ticket.id, runId: third.id }])
    })

    it('counts replacements per role, and per ticket run', async () => {
      const runtime = new FakeRuntime(script)
      const runner = await atImplementer(runtime)
      await replaceTimes(runner, runtime, 2)
      const run = await latest()
      expect(await repos.runs.replacedCount(run.ticketRunId, run.roleId)).toBe(2)
      expect(await repos.runs.replacedCount(run.ticketRunId, 'reviewer')).toBe(0)
      expect(await repos.runs.replacedCount('another-ticket-run', run.roleId)).toBe(0)
    })
  })
})
