import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import type { Effort, LineupRole } from '../../shared/domain'
import { describeRequest } from '../permissions/policy'
import { CHANGED_FILES_HEADING, EXTRA_INSTRUCTIONS_HEADING, firstMessage, HANDOFFS_HEADING } from '../roles/prompt'
import { agentRuns } from '../db/schema'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { type RunHandle, type RunSpec } from '../runtime/types'
import { defaultLineup } from '../store/lineups'
import { testRole } from '../store/testDb'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { count, db, emitted, exists, git, installRunnerHooks, keepAlive, makeRunner, permission, repos, thread, ticket, waitForPending, waitForThread } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner through a lineup', () => {
  /** Saves the default Planner → Implementer → Reviewer lineup, the first two with their own model and effort. */
  async function threeRoles(): Promise<LineupRole[]> {
    const [planner, implementer, reviewer] = defaultLineup()
    return repos.lineups.save(ticket.workspaceId, [
      { ...planner!, model: 'opus', effort: 'high' },
      { ...implementer!, model: 'sonnet', effort: 'medium' },
      reviewer!
    ])
  }

  /** Each role records a session named after it, then hands off when it is sent a message. */
  function lineupScript(spec: RunSpec): FakeStep[] {
    const role = /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
    return [
      { emit: { kind: 'session', sessionId: `session-${role}` } },
      { waitForSend: true },
      { callTool: 'handoff', args: { summary: `${role} summary`, notesForNext: `${role} notes` } },
      { emit: { kind: 'turn_end', ok: true } }
    ]
  }

  /** A lineup runtime whose start() can be held, to look at a ticket between two roles. */
  class HeldRuntime extends FakeRuntime {
    private held: Promise<void> | null = null
    release: () => void = () => {}

    constructor() {
      super(lineupScript)
    }

    hold(): void {
      this.held = new Promise((resolve) => (this.release = resolve))
    }

    override async start(spec: RunSpec): Promise<RunHandle> {
      if (this.held) await this.held
      return super.start(spec)
    }
  }

  /** Waits until the `i`th agent the runtime started is the ticket's working agent; returns its spec. */
  async function active(runner: TicketRunner, runtime: FakeRuntime, i: number): Promise<RunSpec> {
    await eventually(async () => {
      expect(runtime.specs[i]).toBeDefined()
      expect(runner.isLaunching(ticket.id)).toBe(false)
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
    })
    return runtime.specs[i]!
  }

  async function runsOfTicket(): Promise<[string, string | null][]> {
    return (await repos.runs.listForTicket(ticket.id)).map((r) => [r.role, r.endReason])
  }

  const plannerHandoff =
    `${HANDOFFS_HEADING}\nFrom <ticket-data field="role">Planner</ticket-data>:\n` +
    '<ticket-data field="handoff-summary">\nPlanner summary\n</ticket-data>\n' +
    '<ticket-data field="notes-for-next">\nPlanner notes\n</ticket-data>'

  it('tells every role which files the branch changes, and the Reviewer the skip-the-tests rule', async () => {
    await repos.lineups.save(ticket.workspaceId, defaultLineup())
    const runtime = new FakeRuntime((spec) => {
      const role = /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
      const work: FakeStep[] =
        role === 'Implementer'
          ? [
              { writeFile: { path: 'docs/guide.md', content: 'A guide\n' } },
              { git: ['add', '-A'] },
              { git: ['commit', '-m', 'Add the guide'] }
            ]
          : []
      return [
        { emit: { kind: 'session', sessionId: `session-${role}` } },
        { waitForSend: true },
        ...work,
        { callTool: 'handoff', args: { summary: 's', notesForNext: 'n' } },
        { emit: { kind: 'turn_end', ok: true } }
      ]
    })
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    const planner = await active(runner, runtime, 0)
    expect(planner.appendSystemPrompt).toContain(CHANGED_FILES_HEADING)
    expect(planner.appendSystemPrompt).toContain('The branch changes no files against')
    await runner.send(ticket.id, 'go')
    await active(runner, runtime, 1)
    await runner.send(ticket.id, 'go')
    const reviewer = await active(runner, runtime, 2)
    expect(reviewer.appendSystemPrompt).toContain(defaultLineup()[2]!.instructions)
    expect(reviewer.appendSystemPrompt).toContain('- added: docs/guide.md')
  })

  it('runs every role in order, each in a fresh session with its own model, effort and tools, then reaches Review', async () => {
    const lineup = await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)

    const planner = await active(runner, runtime, 0)
    expect(planner).toMatchObject({ toolProfile: 'read_only', model: 'opus', effort: 'high', prompt: firstMessage(ticket) })
    expect(planner.resumeSessionId).toBeUndefined()
    expect(planner.appendSystemPrompt).toContain('## Your role: Planner\n')
    expect(planner.appendSystemPrompt).not.toContain(HANDOFFS_HEADING)
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', phase: 'planning' })

    // Editing the lineup mid-run changes nothing for this run.
    const { workspaceId: _w, lineup: _l, position: _p, ...implementerInput } = lineup[1]!
    await repos.lineups.save(ticket.workspaceId, [{ ...implementerInput, name: 'Builder', model: null, handBackTo: null }])

    await runner.send(ticket.id, 'go')
    const implementer = await active(runner, runtime, 1)
    expect(implementer).toMatchObject({
      toolProfile: 'edit',
      model: 'sonnet',
      effort: 'medium',
      prompt: firstMessage(ticket, 'Planner')
    })
    expect(implementer.prompt).toContain('Planner handed off to you')
    expect(implementer.resumeSessionId).toBeUndefined()
    expect(implementer.appendSystemPrompt).toContain('## Your role: Implementer\n')
    expect(implementer.appendSystemPrompt).toContain(plannerHandoff)
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', phase: 'implementing' })

    await runner.send(ticket.id, 'go')
    const reviewer = await active(runner, runtime, 2)
    // The Reviewer has no model or effort of its own: the default table's.
    expect(reviewer).toMatchObject({
      toolProfile: 'read_only',
      prompt: firstMessage(ticket, 'Implementer'),
      model: 'opus',
      effort: 'medium'
    })
    expect(reviewer.appendSystemPrompt).toContain('## Your role: Reviewer\n')
    expect(reviewer.appendSystemPrompt).toContain(
      `${plannerHandoff}\n\nFrom <ticket-data field="role">Implementer</ticket-data>:\n` +
        '<ticket-data field="handoff-summary">\nImplementer summary\n</ticket-data>\n' +
        '<ticket-data field="notes-for-next">\nImplementer notes\n</ticket-data>'
    )
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', phase: 'reviewing' })

    await runner.send(ticket.id, 'go')
    await eventually(async () =>
      expect(await runner.stateOf(ticket.id)).toMatchObject({
        column: 'review',
        phase: 'ready_for_review',
        agentStatus: 'handed_off'
      })
    )
    expect(runtime.specs).toHaveLength(3)
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'handoff'],
      ['Reviewer', 'handoff']
    ])
    const runs = await repos.runs.listForTicket(ticket.id)
    expect(new Set(runs.map((r) => r.ticketRunId)).size).toBe(1)
    expect(await repos.runs.ticketRun(runs[0]!.ticketRunId)).toMatchObject({
      status: 'done',
      roles: [lineup[0], lineup[1], { ...lineup[2], model: 'opus', effort: 'medium' }]
    })
    // Each later role's thread opens with the handoff to it.
    expect((await repos.runs.events(runs[1]!.id))[0]?.event).toEqual({ kind: 'role_handoff', from: 'Planner', to: 'Implementer' })
    expect((await repos.runs.events(runs[2]!.id))[0]?.event).toEqual({ kind: 'role_handoff', from: 'Implementer', to: 'Reviewer' })
  })

  it('announces each thread event with its run, names the next role in each handoff, and Start again is a new ticket run', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    for (let i = 0; i < 3; i++) {
      await active(runner, runtime, i)
      await runner.send(ticket.id, 'go')
    }
    await eventually(async () => expect((await runner.stateOf(ticket.id)).agentStatus).toBe('handed_off'))

    const appended = emitted.flatMap((e) => (e.type === 'thread.appended' ? [e] : []))
    const runs = await repos.runs.listForTicket(ticket.id)
    // Every event comes with its own run: the same ids, role and ticket run as stored.
    for (const e of appended) {
      const run = runs.find((r) => r.id === e.event.runId)!
      expect(e.run).toEqual({ id: run.id, ticketRunId: run.ticketRunId, role: run.role })
    }
    expect([...new Set(appended.map((e) => e.run.role))]).toEqual(['Planner', 'Implementer', 'Reviewer'])
    expect(new Set(appended.map((e) => e.run.ticketRunId)).size).toBe(1)

    const handoffs = appended.flatMap((e) => (e.event.event.kind === 'handoff' ? [[e.run.role, e.event.event.to]] : []))
    // The last role hands off to nobody.
    expect(handoffs).toEqual([
      ['Planner', 'Implementer'],
      ['Implementer', 'Reviewer'],
      ['Reviewer', undefined]
    ])

    emitted.length = 0
    await runner.start(ticket.id)
    await active(runner, runtime, 3)
    // The Reviewer's last turn may still end meanwhile; its events keep their own run.
    const fresh = () => emitted.flatMap((e) => (e.type === 'thread.appended' && !runs.some((r) => r.id === e.run.id) ? [e.run] : []))
    await eventually(() => expect(fresh().length).toBeGreaterThan(0))
    const again = fresh()
    expect(again.every((r) => r.role === 'Planner' && r.ticketRunId !== runs[0]!.ticketRunId)).toBe(true)
  })

  it('with roleIds runs only those roles, in lineup order, and rejects an empty list or an unknown id', async () => {
    const [planner, , reviewer] = await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)

    await expect(runner.start(ticket.id, { roleIds: [] })).rejects.toThrow('Tick at least one role to start')
    await expect(runner.start(ticket.id, { roleIds: [planner!.id, 'nope'] })).rejects.toThrow('There is no role "nope" in this lineup')
    expect(await repos.runs.latest(ticket.id)).toBeNull()
    expect(runtime.specs).toEqual([])

    await runner.start(ticket.id, { roleIds: [reviewer!.id, planner!.id] })
    expect((await active(runner, runtime, 0)).appendSystemPrompt).toContain('## Your role: Planner\n')
    await runner.send(ticket.id, 'go')
    const second = await active(runner, runtime, 1)
    expect(second.appendSystemPrompt).toContain('## Your role: Reviewer\n')
    expect(second.prompt).toBe(firstMessage(ticket, 'Planner'))
    await runner.send(ticket.id, 'go')

    await eventually(async () => expect((await runner.stateOf(ticket.id)).column).toBe('review'))
    expect(runtime.specs).toHaveLength(2)
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Reviewer', 'handoff']
    ])
    const { ticketRunId } = (await repos.runs.latest(ticket.id))!
    expect((await repos.runs.ticketRun(ticketRunId)).roles.map((r) => r.name)).toEqual(['Planner', 'Reviewer'])
  })

  it('a start with no options snapshots the default table for roles with no model or effort of their own', async () => {
    await repos.lineups.save(ticket.workspaceId, defaultLineup().map((r) => ({ ...r, model: null, effort: null })))
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    expect(await active(runner, runtime, 0)).toMatchObject({ model: 'opus', effort: 'high' })

    const run = (await repos.runs.latest(ticket.id))!
    const { roles } = await repos.runs.ticketRun(run.ticketRunId)
    expect(roles.map((r) => [r.name, r.model, r.effort])).toEqual([
      ['Planner', 'opus', 'high'],
      ['Implementer', 'sonnet', 'medium'],
      ['Reviewer', 'opus', 'medium']
    ])
    // The agent run records them too.
    const [row] = await db
      .select({ model: agentRuns.model, effort: agentRuns.effort })
      .from(agentRuns)
      .where(eq(agentRuns.id, run.id))
    expect(row).toEqual({ model: 'opus', effort: 'high' })

    await runner.send(ticket.id, 'go')
    expect(await active(runner, runtime, 1)).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })

  it("the user's choice beats the role's own setting, which beats the default table, each field on its own", async () => {
    const [planner, implementer, reviewer] = await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id, {
      roles: { [planner!.id]: { effort: 'low' }, [reviewer!.id]: { model: 'haiku' } }
    })
    await active(runner, runtime, 0)
    const { roles } = await repos.runs.ticketRun((await repos.runs.latest(ticket.id))!.ticketRunId)
    expect(roles.map((r) => [r.id, r.model, r.effort])).toEqual([
      [planner!.id, 'opus', 'low'],
      [implementer!.id, 'sonnet', 'medium'],
      [reviewer!.id, 'haiku', 'medium']
    ])
    expect(runtime.specs[0]).toMatchObject({ model: 'opus', effort: 'low' })
  })

  it('rejects an unknown model, effort or role in the options, and long extra instructions, starting nothing', async () => {
    const [planner, implementer] = await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await expect(runner.start(ticket.id, { roles: { [planner!.id]: { model: 'gpt-4' } } })).rejects.toThrow(
      'Planner has an unknown model: "gpt-4"'
    )
    await expect(runner.start(ticket.id, { roles: { [planner!.id]: { effort: 'huge' as Effort } } })).rejects.toThrow(
      'Planner has an unknown effort: "huge"'
    )
    // A role that isn't ticked can't be given a model.
    await expect(
      runner.start(ticket.id, { roleIds: [planner!.id], roles: { [implementer!.id]: { model: 'opus' } } })
    ).rejects.toThrow(`There is no role "${implementer!.id}" in this start`)
    await expect(runner.start(ticket.id, { extraInstructions: 'x'.repeat(10_001) })).rejects.toThrow(
      'Extra instructions must be at most 10000 characters'
    )
    expect(await repos.runs.latest(ticket.id)).toBeNull()
    expect(runtime.specs).toEqual([])
  })

  it('extra instructions reach every role of the run, and a resumed one, but not a later Start again', async () => {
    await threeRoles()
    const extra = `${EXTRA_INSTRUCTIONS_HEADING}\n<ticket-data field="extra-instructions">\nKeep the diff small.\n</ticket-data>`
    const first = new FakeRuntime(lineupScript)
    const before = makeRunner(first)
    await before.start(ticket.id, { extraInstructions: '  Keep the diff small.\n' })
    expect((await active(before, first, 0)).appendSystemPrompt).toContain(extra)
    await before.send(ticket.id, 'go')
    expect((await active(before, first, 1)).appendSystemPrompt).toContain(extra)
    await waitForThread((e) => e.kind === 'session')
    await before.shutdown()

    const runtime = new FakeRuntime(lineupScript)
    const after = makeRunner(runtime)
    await after.markAllNotAlive()
    await after.continue(ticket.id)
    expect((await active(after, runtime, 0)).appendSystemPrompt).toContain(extra)
    await after.send(ticket.id, 'go')
    expect((await active(after, runtime, 1)).appendSystemPrompt).toContain(extra)
    await after.send(ticket.id, 'go')
    await eventually(async () => expect((await after.stateOf(ticket.id)).column).toBe('review'))

    await after.start(ticket.id)
    expect((await active(after, runtime, 2)).appendSystemPrompt).not.toContain(EXTRA_INSTRUCTIONS_HEADING)
  })

  it('a ticket run snapshotted with no model or effort still launches with the default table', async () => {
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    // As a run started before models were resolved at start left it.
    await repos.runs.create(ticket.id, [testRole({ name: 'Reviewer' })])
    await runner.markAllNotAlive()
    await runner.continue(ticket.id)
    expect(await active(runner, runtime, 0)).toMatchObject({ model: 'opus', effort: 'medium' })
  })

  it('between roles the ticket stays In progress and working, never in Review', async () => {
    await threeRoles()
    const runtime = new HeldRuntime()
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await active(runner, runtime, 0)

    runtime.hold()
    await runner.send(ticket.id, 'go')
    await waitForThread((e) => e.kind === 'role_handoff')
    expect(await runner.stateOf(ticket.id)).toEqual({
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'working',
      summary: null,
      canContinue: false,
      pausedByUser: false,
      deferredUntil: null
    })
    expect(runner.isLaunching(ticket.id)).toBe(true)

    runtime.release()
    await active(runner, runtime, 1)
    expect(runner.isLaunching(ticket.id)).toBe(false)
  })

  it("counts as working between roles even while the ticket's queue is busy with something else", async () => {
    await threeRoles()
    /** Holds every send(), so a user's message keeps the ticket's queue busy. */
    class SlowSends extends FakeRuntime {
      private held: Promise<void> | null = null
      release: () => void = () => {}
      holdSends(): void {
        this.held = new Promise((resolve) => (this.release = resolve))
      }
      override async send(handle: RunHandle, text: string): Promise<void> {
        if (this.held) await this.held
        return super.send(handle, text)
      }
    }
    const runtime = new SlowSends(keepAlive)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await active(runner, runtime, 0)

    runtime.holdSends()
    const sending = runner.send(ticket.id, 'One more thing')
    await waitForThread((e) => e.kind === 'user_message')
    await runtime.specs[0]!.roleTools.handoff({ summary: 'The plan', notesForNext: '' })

    // The next role's run exists, its launch waits behind the message, and the ticket still counts as working.
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    expect(runner.isLaunching(ticket.id)).toBe(true)

    runtime.release()
    await sending
    expect((await active(runner, runtime, 1)).appendSystemPrompt).toContain('## Your role: Implementer\n')
  })

  it('Stop mid-lineup stops the active role, puts the ticket back in Ready, and starts no later role', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await active(runner, runtime, 0)
    await runner.send(ticket.id, 'go')
    await active(runner, runtime, 1)

    await runner.stop(ticket.id)

    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', phase: 'not_started', agentStatus: null })
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'stopped']
    ])
    const { ticketRunId } = (await repos.runs.latest(ticket.id))!
    expect((await repos.runs.ticketRun(ticketRunId)).status).toBe('stopped')
    await runner.settled()
    expect(runtime.specs).toHaveLength(2)
  })

  it('Stop between roles ends the run before the next role does anything', async () => {
    await threeRoles()
    const runtime = new HeldRuntime()
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await active(runner, runtime, 0)
    runtime.hold()
    await runner.send(ticket.id, 'go')
    await waitForThread((e) => e.kind === 'role_handoff')

    const stopped = runner.stop(ticket.id)
    runtime.release()
    await stopped

    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', agentStatus: null })
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'stopped']
    ])
    expect(runner.isLaunching(ticket.id)).toBe(false)
    expect(count(await thread(), 'stopped')).toBe(1)
  })

  it("Continue after a restart mid-lineup resumes the active role's own session", async () => {
    await threeRoles()
    const first = new FakeRuntime(lineupScript)
    const before = makeRunner(first)
    await before.start(ticket.id)
    await active(before, first, 0)
    await before.send(ticket.id, 'go')
    await active(before, first, 1)
    await waitForThread((e) => e.kind === 'session')
    await before.shutdown()

    const runtime = new FakeRuntime(lineupScript)
    const after = makeRunner(runtime)
    await after.markAllNotAlive()
    expect(await after.stateOf(ticket.id)).toMatchObject({
      column: 'in_progress',
      phase: 'implementing',
      agentStatus: 'paused',
      canContinue: true
    })

    await after.continue(ticket.id)
    const resumed = await active(after, runtime, 0)
    expect(resumed).toMatchObject({
      resumeSessionId: 'session-Implementer',
      prompt: 'Continue where you left off.',
      model: 'sonnet',
      toolProfile: 'edit'
    })
    expect(resumed.appendSystemPrompt).toContain('## Your role: Implementer\n')
    expect(resumed.appendSystemPrompt).toContain(plannerHandoff)

    // The rest of the lineup carries on as before.
    await after.send(ticket.id, 'go')
    const reviewer = await active(after, runtime, 1)
    expect(reviewer.appendSystemPrompt).toContain('## Your role: Reviewer\n')
    expect(reviewer.resumeSessionId).toBeUndefined()
    await after.send(ticket.id, 'go')
    await eventually(async () => expect((await after.stateOf(ticket.id)).column).toBe('review'))
  })

  it('Continue after a restart between roles starts the next role in a fresh session', async () => {
    await threeRoles()
    const held = new HeldRuntime()
    const before = makeRunner(held)
    await before.start(ticket.id)
    await active(before, held, 0)
    held.hold()
    await before.send(ticket.id, 'go')
    await waitForThread((e) => e.kind === 'role_handoff')
    const shutdown = before.shutdown()
    held.release()
    await shutdown

    const runtime = new FakeRuntime(lineupScript)
    const after = makeRunner(runtime)
    await after.markAllNotAlive()
    expect(await after.stateOf(ticket.id)).toMatchObject({ phase: 'implementing', agentStatus: 'paused', canContinue: true })

    await after.continue(ticket.id)
    const implementer = await active(after, runtime, 0)
    expect(implementer.prompt).toBe(firstMessage(ticket, 'Planner'))
    expect(implementer.resumeSessionId).toBeUndefined()
    expect(implementer).toMatchObject({ model: 'sonnet', toolProfile: 'edit' })
    expect(implementer.appendSystemPrompt).toContain(plannerHandoff)
  })

  it('a permission card names the active role', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(lineupScript)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    const planner = await active(runner, runtime, 0)

    void planner.onPermission(permission('pnpm install'))
    const decision = await waitForPending()
    expect(decision.question).toBe(describeRequest(permission('pnpm install'), 'Planner'))
  })
})
