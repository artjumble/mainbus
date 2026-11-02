import { describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { FakeRuntime, orchestratorScriptFromFile, scriptFromFile, type FakeStep } from './fakeRuntime'
import { ResumeFailedError, type OrchestratorRunSpec, type RoleToolHandlers, type RunSpec } from './types'

function makeSpec(over: Partial<RunSpec> = {}) {
  const roleTools = {
    askUser: vi.fn(async () => 'answer'),
    handoff: vi.fn(async () => 'recorded'),
    reportProblem: vi.fn(async () => 'reported'),
    checkCriterion: vi.fn(async () => 'checked')
  } satisfies RoleToolHandlers
  const onPermission = vi.fn<RunSpec['onPermission']>(async () => ({ allow: true }))
  const spec: RunSpec = {
    cwd: '/work/1-x',
    tempDir: '/scratch/1-x',
    ownBranch: 'mainbus/1-x',
    prompt: 'do it',
    appendSystemPrompt: '',
    toolProfile: 'edit',
    disallowedTools: [],
    additionalDirectories: [],
    roleTools,
    onPermission,
    ...over
  }
  return { spec, roleTools, onPermission }
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe('FakeRuntime', () => {
  test('runs a script in order', async () => {
    const script: FakeStep[] = [
      { emit: { kind: 'message', text: 'first' } },
      { callTool: 'askUser', args: { question: 'Hi or Hello?', options: ['Hi', 'Hello'], recommended: 1 } },
      { waitForSend: true },
      { emit: { kind: 'message', text: 'second' } },
      { callTool: 'checkCriterion', args: { index: 0 } },
      { callTool: 'reportProblem', args: { details: 'broken' } },
      { callTool: 'handoff', args: { summary: 'done', notesForNext: 'none' } },
      { exit: 0 }
    ]
    const rt = new FakeRuntime(script)
    const { spec, roleTools } = makeSpec()
    const run = await rt.start(spec)
    const collected = collect(rt.events(run))

    await tick()
    expect(roleTools.askUser).toHaveBeenCalledWith({ question: 'Hi or Hello?', options: ['Hi', 'Hello'], recommended: 1 })
    expect(roleTools.handoff).not.toHaveBeenCalled() // blocked on waitForSend

    await rt.send(run, 'Hello')
    const events = await collected
    expect(roleTools.checkCriterion).toHaveBeenCalledWith({ index: 0 })
    expect(roleTools.reportProblem).toHaveBeenCalledWith({ details: 'broken' })
    expect(roleTools.handoff).toHaveBeenCalledWith({ summary: 'done', notesForNext: 'none' })
    expect(events).toEqual([
      { kind: 'message', text: 'first' },
      { kind: 'message', text: 'second' }
    ])
    expect(rt.specs).toEqual([spec])
    expect(rt.sent).toEqual(['Hello'])
  })

  test('nothing fires until start() has resolved', async () => {
    const rt = new FakeRuntime([
      { callTool: 'askUser', args: { question: 'q', options: [] } },
      { exit: 0 }
    ])
    const { spec, roleTools } = makeSpec()
    let started = false
    let startedWhenCalled: boolean | null = null
    roleTools.askUser.mockImplementation(async () => {
      startedWhenCalled = started
      return 'a'
    })
    const run = await rt.start(spec)
    started = true
    await collect(rt.events(run))
    expect(roleTools.askUser).toHaveBeenCalledTimes(1)
    expect(startedWhenCalled).toBe(true)
  })

  test('a send that arrives before waitForSend is not lost', async () => {
    const rt = new FakeRuntime([{ waitForSend: true }, { emit: { kind: 'message', text: 'after' } }, { exit: 0 }])
    const run = await rt.start(makeSpec().spec)
    await rt.send(run, 'early')
    expect(await collect(rt.events(run))).toEqual([{ kind: 'message', text: 'after' }])
  })

  test('requestPermission goes through spec.onPermission with a signal', async () => {
    const rt = new FakeRuntime([
      { requestPermission: { toolName: 'Bash', input: { command: 'git push' }, reason: 'push', toolUseId: 'tu1' } },
      { exit: 0 }
    ])
    const { spec, onPermission } = makeSpec()
    const run = await rt.start(spec)
    await collect(rt.events(run))
    expect(onPermission).toHaveBeenCalledTimes(1)
    const req = onPermission.mock.calls[0][0]
    expect(req).toMatchObject({ toolName: 'Bash', input: { command: 'git push' }, reason: 'push', toolUseId: 'tu1' })
    expect(req.signal).toBeInstanceOf(AbortSignal)
  })

  test('events() stays open without an exit step, and stop() ends it', async () => {
    const rt = new FakeRuntime([{ emit: { kind: 'message', text: 'hi' } }])
    const run = await rt.start(makeSpec().spec)
    const collected = collect(rt.events(run))
    let done = false
    void collected.then(() => (done = true))
    await tick()
    expect(done).toBe(false)
    await rt.stop(run)
    expect(await collected).toEqual([{ kind: 'message', text: 'hi' }])
  })

  test('stop() unblocks a script waiting for a send', async () => {
    const rt = new FakeRuntime([{ waitForSend: true }, { emit: { kind: 'message', text: 'never' } }])
    const run = await rt.start(makeSpec().spec)
    const collected = collect(rt.events(run))
    await tick()
    await rt.stop(run)
    expect(await collected).toEqual([])
  })

  test('rejectResume: start() with resumeSessionId rejects with ResumeFailedError', async () => {
    const rt = new FakeRuntime([], { rejectResume: true })
    await expect(rt.start(makeSpec({ resumeSessionId: 's-1' }).spec)).rejects.toBeInstanceOf(ResumeFailedError)
    // a fresh start still works
    await expect(rt.start(makeSpec().spec)).resolves.toMatchObject({ id: expect.any(String) })
  })

  test('without rejectResume, resumeSessionId is accepted and recorded', async () => {
    const rt = new FakeRuntime([{ exit: 0 }])
    const { spec } = makeSpec({ resumeSessionId: 's-1' })
    const run = await rt.start(spec)
    await collect(rt.events(run))
    expect(rt.specs[0].resumeSessionId).toBe('s-1')
  })

  test('a throwing role tool surfaces as an error event and ends the run', async () => {
    const rt = new FakeRuntime([{ callTool: 'askUser', args: { question: 'q', options: [] } }, { exit: 0 }])
    const { spec, roleTools } = makeSpec()
    roleTools.askUser.mockRejectedValueOnce(new Error('boom'))
    const run = await rt.start(spec)
    expect(await collect(rt.events(run))).toEqual([{ kind: 'error', message: 'boom' }])
  })

  test('a script survives a JSON round trip', () => {
    const script: FakeStep[] = [
      { emit: { kind: 'turn_end', ok: true } },
      { callTool: 'handoff', args: { summary: 's', notesForNext: 'n' } },
      { requestPermission: { toolName: 'Bash', input: {}, toolUseId: 'x' } },
      { waitForSend: true },
      { exit: null }
    ]
    expect(JSON.parse(JSON.stringify(script))).toEqual(script)
  })
})

describe('scriptFromFile', () => {
  const steps = (text: string): FakeStep[] => [{ emit: { kind: 'message', text } }]

  test('plays a list of steps for every agent', () => {
    expect(scriptFromFile(steps('all'))).toEqual(steps('all'))
  })

  test("picks a role's own steps, else the * steps, else none", () => {
    const pick = scriptFromFile({ Planner: steps('plan'), '*': steps('other') }) as (spec: RunSpec) => FakeStep[]
    expect(pick(makeSpec({ role: 'Planner' }).spec)).toEqual(steps('plan'))
    expect(pick(makeSpec({ role: 'Reviewer' }).spec)).toEqual(steps('other'))
    expect(pick(makeSpec({ role: 'toString' }).spec)).toEqual(steps('other'))
    const only = scriptFromFile({ Planner: steps('plan') }) as (spec: RunSpec) => FakeStep[]
    expect(only(makeSpec({ role: 'Reviewer' }).spec)).toEqual([])
  })

  test('a resumed session plays "<Role> resumed" when the file has it', () => {
    const pick = scriptFromFile({ Reviewer: steps('review'), 'Reviewer resumed': steps('again') }) as (
      spec: RunSpec
    ) => FakeStep[]
    expect(pick(makeSpec({ role: 'Reviewer' }).spec)).toEqual(steps('review'))
    expect(pick(makeSpec({ role: 'Reviewer', resumeSessionId: 's1' }).spec)).toEqual(steps('again'))
    // A role with no resumed steps plays its own steps when resumed.
    const only = scriptFromFile({ Reviewer: steps('review') }) as (spec: RunSpec) => FakeStep[]
    expect(only(makeSpec({ role: 'Reviewer', resumeSessionId: 's1' }).spec)).toEqual(steps('review'))
  })
})

describe('FakeRuntime: the orchestrator', () => {
  function orchestratorSpec(over: Partial<OrchestratorRunSpec> = {}): OrchestratorRunSpec {
    return {
      kind: 'orchestrator',
      cwd: '/home/orchestrator',
      prompt: 'hi',
      appendSystemPrompt: '',
      model: 'opus',
      effort: 'medium',
      additionalDirectories: ['/repo'],
      disallowedTools: [],
      tools: {
        listWorkspaces: vi.fn(async () => 'ws'),
        listTickets: vi.fn(async () => 'tickets'),
        getTicket: vi.fn(async () => 'ticket'),
        getRunStatus: vi.fn(async () => 'status'),
        getRecentEvents: vi.fn(async () => 'events'),
        listPendingDecisions: vi.fn(async () => 'decisions'),
        proposeCreateTickets: vi.fn(async () => 'proposed'),
        proposeStart: vi.fn(async () => 'proposed'),
        proposePause: vi.fn(async () => 'proposed'),
        proposeStop: vi.fn(async () => 'proposed'),
        proposeSkip: vi.fn(async () => 'proposed'),
        proposeHold: vi.fn(async () => 'proposed')
      },
      onPermission: async () => ({ allow: true }),
      ...over
    }
  }

  test('plays its own script, keeps its specs apart from role specs, and calls its read tools', async () => {
    const rt = new FakeRuntime([{ emit: { kind: 'message', text: 'role' } }, { exit: 0 }], {
      orchestrator: [{ callTool: 'getTicket', args: { number: 2 } }, { emit: { kind: 'message', text: 'orchestrator' } }, { exit: 0 }]
    })
    const spec = orchestratorSpec()
    const run = await rt.start(spec)
    expect(await collect(rt.events(run))).toEqual([{ kind: 'message', text: 'orchestrator' }])
    expect(spec.tools.getTicket).toHaveBeenCalledWith({ number: 2 })
    expect(rt.orchestratorSpecs).toEqual([spec])
    expect(rt.specs).toEqual([])
  })

  test('without a script it stays open and silent; a role tool is not one of its tools', async () => {
    const quiet = new FakeRuntime([{ exit: 0 }])
    const run = await quiet.start(orchestratorSpec())
    await tick()
    await quiet.stop(run)
    expect(await collect(quiet.events(run))).toEqual([])

    const wrong = new FakeRuntime([], { orchestrator: [{ callTool: 'handoff', args: {} }] })
    const r = await wrong.start(orchestratorSpec())
    expect(await collect(wrong.events(r))).toEqual([{ kind: 'error', message: 'No tool handoff in this run' }])
  })

  test('rejects a resume when asked to', async () => {
    const rt = new FakeRuntime([], { rejectResume: true })
    await expect(rt.start(orchestratorSpec({ resumeSessionId: 's1' }))).rejects.toBeInstanceOf(ResumeFailedError)
  })

  test('orchestratorScriptFromFile picks the Orchestrator steps, resumed ones when resuming', () => {
    const say = (text: string): FakeStep[] => [{ emit: { kind: 'message', text } }]
    const pick = orchestratorScriptFromFile({ '*': say('any'), Orchestrator: say('o'), 'Orchestrator resumed': say('r') })
    expect(pick(orchestratorSpec())).toEqual(say('o'))
    expect(pick(orchestratorSpec({ resumeSessionId: 's1' }))).toEqual(say('r'))
    expect(orchestratorScriptFromFile({ '*': say('any') })(orchestratorSpec())).toEqual([])
    expect(orchestratorScriptFromFile(say('all'))(orchestratorSpec())).toEqual([])
  })
})
