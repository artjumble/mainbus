import { describe, expect, it } from 'vitest'
import type { LineupRole, LineupRoleInput } from '../../shared/domain'
import { FakeRuntime, type FakeStep } from '../runtime/fakeRuntime'
import { type RunSpec } from '../runtime/types'
import { defaultLineup } from '../store/lineups'
import { TicketRunner } from './ticketRunner'
import { eventually } from '../testWait'

import { count, emitted, git, installRunnerHooks, keepAlive, makeRunner, repos, thread, ticket, waitForPending } from './ticketRunnerHarness'

installRunnerHooks()

describe('TicketRunner hand-backs', () => {
  /** Saves the default Planner → Implementer → Reviewer lineup, with `edit` applied to each role. */
  async function threeRoles(edit: (r: LineupRoleInput) => LineupRoleInput = (r) => r): Promise<LineupRole[]> {
    return repos.lineups.save(ticket.workspaceId, defaultLineup().map(edit))
  }

  function roleOf(spec: RunSpec): string {
    return /## Your role: (.+)/.exec(spec.appendSystemPrompt)![1]!
  }

  /**
   * Each agent records a session named after its role (a resumed one keeps its session), says it is at work
   * the first time, and stays open; the tests call its tools themselves.
   */
  function script(spec: RunSpec): FakeStep[] {
    const role = roleOf(spec)
    const fresh = spec.resumeSessionId === undefined
    return [
      { emit: { kind: 'session', sessionId: spec.resumeSessionId ?? `session-${role}` } },
      ...(fresh ? [{ emit: { kind: 'message', text: `${role} at work` } } satisfies FakeStep] : []),
      { waitForSend: true }
    ]
  }

  /** Waits until the runtime has started agent number `n` (counting from 1) and it is the ticket's working agent. */
  async function nth(runner: TicketRunner, runtime: FakeRuntime, n: number): Promise<RunSpec> {
    await eventually(async () => {
      expect(runtime.specs.length).toBeGreaterThanOrEqual(n)
      expect(runner.isLaunching(ticket.id)).toBe(false)
      expect((await runner.stateOf(ticket.id)).agentStatus).toBe('working')
    })
    return runtime.specs[n - 1]!
  }

  async function runsOfTicket(): Promise<[string, string | null][]> {
    return (await repos.runs.listForTicket(ticket.id)).map((r) => [r.role, r.endReason])
  }

  async function handOff(spec: RunSpec): Promise<string> {
    return spec.roleTools.handoff({ summary: `${roleOf(spec)} summary`, notesForNext: `${roleOf(spec)} notes` })
  }

  /** Starts the lineup and hands off until the Reviewer is working; returns its spec. */
  async function upToReviewer(runner: TicketRunner, runtime: FakeRuntime): Promise<RunSpec> {
    await runner.start(ticket.id)
    await handOff(await nth(runner, runtime, 1))
    await handOff(await nth(runner, runtime, 2))
    return nth(runner, runtime, 3)
  }

  it("hands a problem back to the Implementer's session, whose handoff goes straight back to the Reviewer's", async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)

    const reply = await reviewer.roleTools.reportProblem({ details: 'The limiter is never applied' })
    expect(reply).toBe(
      'Handed back to Implementer. End your turn now; when Implementer hands off, its summary arrives as your next message.'
    )
    const implementer = await nth(runner, runtime, 4)
    expect(roleOf(implementer)).toBe('Implementer')
    expect(implementer.resumeSessionId).toBe('session-Implementer')
    expect(implementer.prompt).toBe(
      'Reviewer reports a problem:\n<ticket-data field="problem">\nThe limiter is never applied\n</ticket-data>'
    )
    // Its instructions hold the Planner's handoff, not its own earlier one.
    expect(implementer.appendSystemPrompt).toContain('Planner summary')
    expect(implementer.appendSystemPrompt).not.toContain('Implementer summary')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'handoff'],
      ['Reviewer', 'handed_back'],
      ['Implementer', null]
    ])
    const runs = await repos.runs.listForTicket(ticket.id)
    const handBack = (await repos.runs.events(runs[2]!.id)).map((e) => e.event).find((e) => e.kind === 'hand_back')
    expect(handBack).toEqual({
      kind: 'hand_back',
      from: 'Reviewer',
      to: 'Implementer',
      fromRoleId: runs[2]!.roleId,
      toRoleId: runs[1]!.roleId,
      details: 'The limiter is never applied'
    })
    expect((await repos.runs.events(runs[3]!.id))[0]?.event).toEqual({ kind: 'role_hand_back', from: 'Reviewer', to: 'Implementer' })

    // The Implementer's handoff skips nothing it shouldn't: straight back to the Reviewer's own session.
    expect(await implementer.roleTools.handoff({ summary: 'Applied it', notesForNext: 'See login.ts' })).toBe(
      'Handed off. Your part is done; end your turn now.'
    )
    const back = await nth(runner, runtime, 5)
    expect(roleOf(back)).toBe('Reviewer')
    expect(back.resumeSessionId).toBe('session-Reviewer')
    expect(back.prompt).toBe(
      'Implementer handed the ticket back to you after your report. Its summary:\n' +
        '<ticket-data field="handoff-summary">\nApplied it\n</ticket-data>\n' +
        '<ticket-data field="notes-for-next">\nSee login.ts\n</ticket-data>'
    )

    await handOff(back)
    await eventually(async () =>
      expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'review', phase: 'ready_for_review' })
    )
    // The Planner never ran again.
    expect(runtime.specs.map(roleOf)).toEqual(['Planner', 'Implementer', 'Reviewer', 'Implementer', 'Reviewer'])
    expect((await repos.runs.ticketRun(runs[0]!.ticketRunId)).status).toBe('done')
  })

  it('skips the roles in between: a hand-back to the Planner returns straight to the Reviewer', async () => {
    const planner = defaultLineup()[0]!
    await threeRoles((r) => (r.name === 'Reviewer' ? { ...r, handBackTo: planner.id } : r))
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)

    await reviewer.roleTools.reportProblem({ details: 'The plan is wrong' })
    const replanned = await nth(runner, runtime, 4)
    expect(roleOf(replanned)).toBe('Planner')
    expect(replanned.resumeSessionId).toBe('session-Planner')
    await handOff(replanned)
    const back = await nth(runner, runtime, 5)
    expect(roleOf(back)).toBe('Reviewer')
    expect(back.prompt).toContain('Planner handed the ticket back to you after your report')
  })

  it('a hand-back chain unwinds in order: Reviewer → Implementer → Planner → Implementer → Reviewer', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)
    await reviewer.roleTools.reportProblem({ details: 'Broken' })
    const implementer = await nth(runner, runtime, 4)
    await implementer.roleTools.reportProblem({ details: 'The plan can not work' })
    await handOff(await nth(runner, runtime, 5))
    const again = await nth(runner, runtime, 6)
    expect(roleOf(again)).toBe('Implementer')
    expect(again.prompt).toContain('Planner handed the ticket back to you after your report')
    await handOff(again)
    expect(roleOf(await nth(runner, runtime, 7))).toBe('Reviewer')
  })

  it('asks instead when the role to hand back to was unticked at start, and the answer can do the hand-back', async () => {
    const [planner, , reviewer] = await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id, { roleIds: [planner!.id, reviewer!.id] })
    await handOff(await nth(runner, runtime, 1))
    const review = await nth(runner, runtime, 2)

    expect(await review.roleTools.reportProblem({ details: 'Nothing was built' })).toBe(
      'Recorded. End your turn now; the answer will arrive as your next message.'
    )
    const decision = await waitForPending()
    expect(decision).toMatchObject({
      kind: 'question',
      question: 'Reviewer reports a problem: Nothing was built',
      options: ['Hand back to Planner', 'Keep going']
    })
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'needs_you' })

    await runner.answer(decision.id, { kind: 'option', index: 0, note: 'Plan the build too' }, 'thread')
    const replanned = await nth(runner, runtime, 3)
    expect(roleOf(replanned)).toBe('Planner')
    expect(replanned.resumeSessionId).toBe('session-Planner')
    expect(replanned.prompt).toBe(
      'Reviewer reports a problem:\n<ticket-data field="problem">\nNothing was built\n</ticket-data>\n\n' +
        "The user's note:\n<ticket-data field=\"note\">\nPlan the build too\n</ticket-data>"
    )
    const runs = await repos.runs.listForTicket(ticket.id)
    const handBack = (await repos.runs.events(runs[1]!.id)).map((e) => e.event).find((e) => e.kind === 'hand_back')
    expect(handBack).toMatchObject({ from: 'Reviewer', to: 'Planner', byUser: true })
    // The answer is not passed to the Reviewer as a message.
    expect(runtime.sent).toEqual([])

    await handOff(replanned)
    expect(roleOf(await nth(runner, runtime, 4))).toBe('Reviewer')
  })

  it('asks with only Keep going when the first role reports a problem, and passes the answer on', async () => {
    await threeRoles((r) => (r.name === 'Planner' ? { ...r, onProblem: 'hand_back' } : r))
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    const planner = await nth(runner, runtime, 1)

    await planner.roleTools.reportProblem({ details: 'The spec is unclear' })
    const decision = await waitForPending()
    expect(decision).toMatchObject({ question: 'Planner reports a problem: The spec is unclear', options: ['Keep going'] })
    await runner.answer(decision.id, { kind: 'option', index: 0 }, 'thread')
    expect(runtime.sent).toEqual(['Answer: Keep going'])
    expect(await runsOfTicket()).toEqual([['Planner', null]])
  })

  it('a message does not settle a problem question Mainbus acts on itself', async () => {
    await threeRoles((r) => (r.name === 'Planner' ? { ...r, onProblem: 'hand_back' } : r))
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    const planner = await nth(runner, runtime, 1)
    await planner.roleTools.reportProblem({ details: 'The spec is unclear' })
    const decision = await waitForPending()

    await runner.send(ticket.id, 'Carry on')

    expect((await repos.decisions.get(decision.id)).status).toBe('pending')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'needs_you' })
  })

  it('an action decision answered from the board runs its hand-back like one answered in the thread', async () => {
    await threeRoles((r) => (r.name === 'Reviewer' ? { ...r, onProblem: 'ask_me' } : r))
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)

    await reviewer.roleTools.reportProblem({ details: 'A test is flaky' })
    const decision = await waitForPending()
    expect(decision.options).toEqual(['Hand back to Implementer', 'Keep going'])
    await runner.answer(decision.id, { kind: 'option', index: 0 }, 'board')

    const implementer = await nth(runner, runtime, 4)
    expect(roleOf(implementer)).toBe('Implementer')
    expect(implementer.prompt).toContain('A test is flaky')
    expect(await repos.decisions.get(decision.id)).toMatchObject({ answeredVia: 'board' })
    // The hand-back ran once: a second answer from the thread changes nothing.
    await expect(runner.answer(decision.id, { kind: 'option', index: 1 }, 'thread')).rejects.toThrow('Already answered from the board')
    expect(runtime.specs).toHaveLength(4)
  })

  it('with ask_me, Keep going reaches the agent and Hand back hands back', async () => {
    await threeRoles((r) => (r.name === 'Reviewer' ? { ...r, onProblem: 'ask_me' } : r))
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)

    await reviewer.roleTools.reportProblem({ details: 'A test is flaky' })
    const first = await waitForPending()
    expect(first.options).toEqual(['Hand back to Implementer', 'Keep going'])
    await runner.answer(first.id, { kind: 'option', index: 1, note: 'Ignore it' }, 'thread')
    expect(runtime.sent).toEqual(['Answer: Keep going\nNote: Ignore it'])
    expect(await runsOfTicket()).toEqual([
      ['Planner', 'handoff'],
      ['Implementer', 'handoff'],
      ['Reviewer', null]
    ])

    await reviewer.roleTools.reportProblem({ details: 'Still flaky' })
    const second = await waitForPending()
    await runner.answer(second.id, { kind: 'option', index: 0 }, 'thread')
    const implementer = await nth(runner, runtime, 4)
    expect(roleOf(implementer)).toBe('Implementer')
    expect(implementer.prompt).toContain('Still flaky')
  })

  it('the 4th hand-back in a pair asks; Keep going does it and allows 3 more; Take over ends the run as Stop does', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    let reviewer = await upToReviewer(runner, runtime)

    /** The Reviewer hands back and the Implementer hands off again; returns the Reviewer's new spec. */
    async function roundTrip(): Promise<RunSpec> {
      const n = runtime.specs.length
      expect(await reviewer.roleTools.reportProblem({ details: `Problem ${n}` })).toMatch(/^Handed back to Implementer/)
      await handOff(await nth(runner, runtime, n + 1))
      return nth(runner, runtime, n + 2)
    }
    for (let i = 0; i < 3; i++) reviewer = await roundTrip()

    expect(await reviewer.roleTools.reportProblem({ details: 'Again' })).toBe(
      'Recorded. End your turn now; the answer will arrive as your next message.'
    )
    const cap = await waitForPending()
    expect(cap).toMatchObject({
      question: 'Reviewer and Implementer have gone back and forth 3 times: keep going, or take over?',
      options: ['Keep going', 'Take over']
    })
    const specs = runtime.specs.length
    await runner.answer(cap.id, { kind: 'option', index: 0 }, 'thread')
    const implementer = await nth(runner, runtime, specs + 1)
    expect(roleOf(implementer)).toBe('Implementer')
    expect(implementer.prompt).toContain('Again')
    await handOff(implementer)
    reviewer = await nth(runner, runtime, specs + 2)

    // Three more go through without asking; the next asks again.
    for (let i = 0; i < 3; i++) reviewer = await roundTrip()
    await reviewer.roleTools.reportProblem({ details: 'Once more' })
    const capAgain = await waitForPending()
    expect(capAgain.question).toContain('gone back and forth 3 times')

    await runner.answer(capAgain.id, { kind: 'option', index: 1 }, 'thread')
    expect(await runner.stateOf(ticket.id)).toMatchObject({ column: 'ready', phase: 'not_started', agentStatus: null })
    const latest = (await repos.runs.latest(ticket.id))!
    expect(latest).toMatchObject({ role: 'Reviewer', endReason: 'stopped' })
    expect((await repos.runs.ticketRun(latest.ticketRunId)).status).toBe('stopped')
    // History and the branch are kept.
    expect(count(await thread(), 'stopped')).toBe(1)
    expect((await repos.runs.listForTicket(ticket.id)).length).toBe(17)
    const t = await repos.tickets.get(ticket.id)
    expect(await git(['branch', '--list', t.branch!])).toContain(t.branch!)
  })

  it("a role that can't resume its session after a hand-back starts fresh with a digest of all its runs", async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script, { rejectResume: true })
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)

    await reviewer.roleTools.reportProblem({ details: 'Missing tests' })
    await runtime.started(5)
    expect(runtime.specs).toHaveLength(5)
    const implementer = await nth(runner, runtime, 5)
    expect(runtime.specs[3]!.resumeSessionId).toBe('session-Implementer')
    expect(implementer.resumeSessionId).toBeUndefined()
    expect(implementer.prompt).toContain('Implementer: Implementer at work')
    expect(implementer.prompt).toContain('Handoff: Implementer summary')
    expect(implementer.prompt).toContain('Reviewer reports a problem:\n<ticket-data field="problem">\nMissing tests\n</ticket-data>')
  })

  it('report_problem after the run has ended changes nothing', async () => {
    await threeRoles()
    const runtime = new FakeRuntime(script)
    const runner = makeRunner(runtime)
    const reviewer = await upToReviewer(runner, runtime)
    await runner.stop(ticket.id)
    expect(await reviewer.roleTools.reportProblem({ details: 'Late' })).toBe('This run has ended.')
    expect(await repos.decisions.pending(ticket.id)).toEqual([])
    expect((await runsOfTicket()).at(-1)).toEqual(['Reviewer', 'stopped'])
  })
})

describe('TicketRunner check_criterion', () => {
  it('ticks the criterion at an index once, rejects one out of range, and announces the change', async () => {
    await repos.tickets.update(ticket.id, {
      criteria: [
        { position: 0, text: 'Six attempts are refused', checked: false },
        { position: 1, text: 'The limit resets', checked: false }
      ]
    })
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await runtime.started(1)
    expect(runtime.specs).toHaveLength(1)
    const { checkCriterion } = runtime.specs[0]!.roleTools
    expect(runtime.specs[0]!.appendSystemPrompt).toContain('- [ ] 0: Six attempts are refused\n- [ ] 1: The limit resets')

    emitted.length = 0
    expect(await checkCriterion({ index: 1 })).toBe('Checked 1: The limit resets')
    expect((await repos.tickets.get(ticket.id)).criteria.map((c) => c.checked)).toEqual([false, true])
    expect(await thread()).toContainEqual({ kind: 'criterion_checked', index: 1, text: 'The limit resets' })
    expect(emitted).toContainEqual({ type: 'board.changed', workspaceId: ticket.workspaceId })

    expect(await checkCriterion({ index: 1 })).toBe('Criterion 1 was already checked.')
    expect(count(await thread(), 'criterion_checked')).toBe(1)
    for (const index of [2, -1, 0.5]) {
      expect(await checkCriterion({ index })).toBe(
        `Not checked: there is no criterion ${index}. This ticket's criteria are numbered 0 to 1.`
      )
    }
    expect((await repos.tickets.get(ticket.id)).criteria.map((c) => c.checked)).toEqual([false, true])

    await runner.stop(ticket.id)
    expect(await checkCriterion({ index: 0 })).toBe('This run has ended.')
    expect((await repos.tickets.get(ticket.id)).criteria.map((c) => c.checked)).toEqual([false, true])
  })

  it('says so when the ticket has no criteria', async () => {
    const runtime = new FakeRuntime(keepAlive)
    const runner = makeRunner(runtime)
    await runner.start(ticket.id)
    await runtime.started(1)
    expect(runtime.specs).toHaveLength(1)
    expect(await runtime.specs[0]!.roleTools.checkCriterion({ index: 0 })).toBe(
      'Not checked: this ticket has no acceptance criteria.'
    )
  })
})
