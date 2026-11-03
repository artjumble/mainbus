import { describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { FakeRuntime, orchestratorScriptFromFile, scriptFromFile, type FakeStep } from './fakeRuntime'
import { ResumeFailedError, type OrchestratorRunSpec, type RoleToolHandlers, type RunSpec } from './types'

function makeSpec(over: Partial<RunSpec> = {}) {
  const roleTools = {
    askUser: vi.fn(async () => 'answer'),
    handoff: vi.fn(async () => 'recorded'),
    submitReport: vi.fn(async () => 'submitted'),
    reportProblem: vi.fn(async () => 'reported'),
    reportWaiting: vi.fn(async () => 'waiting'),
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
        createTickets: vi.fn(async () => 'created'),
        proposeCreateTickets: vi.fn(async () => 'proposed'),
        proposeStart: vi.fn(async () => 'proposed'),
        proposePause: vi.fn(async () => 'proposed'),
        proposeStop: vi.fn(async () => 'proposed'),
        proposeSkip: vi.fn(async () => 'proposed'),
        proposeHold: vi.fn(async () => 'proposed'),
        proposeAnswer: vi.fn(async () => 'proposed'),
        proposeRedirect: vi.fn(async () => 'proposed'),
        proposeReplace: vi.fn(async () => 'proposed'),
        proposePromote: vi.fn(async () => 'proposed')
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

  test('a captured value from a read tool fills a later step', async () => {
    const rt = new FakeRuntime([], {
      orchestrator: [
        { capture: { tool: 'listPendingDecisions', pattern: 'id ([a-z0-9]+)', as: 'id' } },
        { callTool: 'proposeAnswer', args: { decision: '$id', nested: ['$id', '$other'] } },
        { exit: 0 }
      ]
    })
    const spec = orchestratorSpec()
    vi.mocked(spec.tools.listPendingDecisions).mockResolvedValue('(id abc123)')
    await collect(rt.events(await rt.start(spec)))
    expect(spec.tools.proposeAnswer).toHaveBeenCalledWith({ decision: 'abc123', nested: ['abc123', '$other'] })
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

describe('a replaced role in a script file', () => {
  const steps = (text: string): FakeStep[] => [{ emit: { kind: 'message', text } }]

  test('the nth fresh session plays "<Role> #n"; resumed sessions do not count', () => {
    const pick = scriptFromFile({ Implementer: steps('first'), 'Implementer #2': steps('second'), Reviewer: steps('review') }) as (
      spec: RunSpec
    ) => FakeStep[]
    expect(pick(makeSpec({ role: 'Implementer' }).spec)).toEqual(steps('first'))
    expect(pick(makeSpec({ role: 'Implementer', resumeSessionId: 's1' }).spec)).toEqual(steps('first'))
    expect(pick(makeSpec({ role: 'Implementer' }).spec)).toEqual(steps('second'))
    // Without "#3" the third plays the role's own steps; other roles count separately.
    expect(pick(makeSpec({ role: 'Implementer' }).spec)).toEqual(steps('first'))
    expect(pick(makeSpec({ role: 'Reviewer' }).spec)).toEqual(steps('review'))
  })
})

describe('expectPrompt', () => {
  async function play(script: FakeStep[], prompt: string): Promise<AgentEvent[]> {
    const rt = new FakeRuntime(script)
    const handle = await rt.start(makeSpec({ prompt }).spec)
    const events: AgentEvent[] = []
    for await (const e of rt.events(handle)) events.push(e)
    return events
  }

  test('passes when the launch prompt has the text', async () => {
    const script: FakeStep[] = [{ expectPrompt: 'the summary' }, { emit: { kind: 'message', text: 'ok' } }, { exit: 0 }]
    expect(await play(script, 'start. the summary here')).toEqual([{ kind: 'message', text: 'ok' }])
  })

  test('fails the run with an error when it lacks the text', async () => {
    const script: FakeStep[] = [{ expectPrompt: 'the summary' }, { emit: { kind: 'message', text: 'ok' } }]
    expect(await play(script, 'start')).toEqual([{ kind: 'error', message: 'The launch prompt lacks "the summary"' }])
  })
})

describe('FakeRuntime: sessions kept across processes', () => {
  async function dir() {
    const fsm = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    return { fsm, file: path.join(await fsm.mkdtemp(path.join(os.tmpdir(), 'mainbus-fake-sessions-')), 'sessions.json') }
  }

  test('a session a run emitted resumes in a new runtime over the same file; an unknown one fails', async () => {
    const { fsm, file } = await dir()
    try {
      const first = new FakeRuntime([{ emit: { kind: 'session', sessionId: 'abc' } }, { waitForSend: true }], { sessionsFile: file })
      const h = await first.start(makeSpec().spec)
      await vi.waitFor(async () => expect(JSON.parse(await fsm.readFile(file, 'utf8'))).toEqual(['abc']))
      await first.stop(h)

      const second = new FakeRuntime([], { sessionsFile: file })
      await expect(second.start(makeSpec({ resumeSessionId: 'abc' }).spec)).resolves.toBeDefined()
      await expect(second.start(makeSpec({ resumeSessionId: 'nope' }).spec)).rejects.toBeInstanceOf(ResumeFailedError)
    } finally {
      await fsm.rm(file.replace(/sessions\.json$/, ''), { recursive: true, force: true })
    }
  })
})

describe('FakeRuntime: readFile', () => {
  test('reads inside the extra folders without asking, as the real runtime does, and asks for anything else', async () => {
    const fsm = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const tmp = await fsm.mkdtemp(path.join(os.tmpdir(), 'mainbus-fake-read-'))
    try {
      const scratch = path.join(tmp, 'scratch')
      await fsm.mkdir(scratch)
      const inside = path.join(scratch, 'shot.png')
      const outside = path.join(tmp, 'secret.png')
      await fsm.writeFile(inside, 'abc')
      await fsm.writeFile(outside, 'abcd')
      const rt = new FakeRuntime([
        { readFile: { fromPrompt: 'image: (.+)$' } },
        { waitForSend: true },
        { readFile: { fromMessage: 'look at (.+)$' } },
        { exit: 0 }
      ])
      const { spec, onPermission } = makeSpec({ cwd: path.join(tmp, 'work'), additionalDirectories: [scratch], appendSystemPrompt: `image: ${inside}` })
      onPermission.mockResolvedValue({ allow: false, message: 'Denied by the user' })
      const run = await rt.start(spec)
      const events = collect(rt.events(run))
      await tick()
      await rt.send(run, `look at ${outside}`)
      expect(await events).toEqual([
        { kind: 'tool_call', id: 'read-1', name: 'Read', input: { file_path: inside } },
        { kind: 'tool_result', id: 'read-1', ok: true, summary: 'Read 3 bytes' },
        { kind: 'tool_call', id: 'read-2', name: 'Read', input: { file_path: outside } },
        { kind: 'tool_result', id: 'read-2', ok: false, summary: 'Denied by the user' }
      ])
      expect(onPermission).toHaveBeenCalledTimes(1)
      expect(onPermission.mock.calls[0]![0]).toMatchObject({ toolName: 'Read', input: { file_path: outside } })
    } finally {
      await fsm.rm(tmp, { recursive: true, force: true })
    }
  })
})
