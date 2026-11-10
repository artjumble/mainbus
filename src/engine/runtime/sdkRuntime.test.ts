import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { z } from 'zod'
import type { AgentEvent } from '../../shared/events'
import { ALIAS_MODEL_OPTIONS, setModelOptions } from '../../shared/models'
import { Normalizer } from './normalize'
import { SdkRuntime, type SdkApi } from './sdkRuntime'
import { orchestratorVerdict } from '../orchestrator/permissions'
import {
  ResumeFailedError,
  type OrchestratorRunSpec,
  type OrchestratorToolHandlers,
  type RoleToolHandlers,
  type RunSpec
} from './types'
import { eventually } from '../testWait'

const CLAUDE_PATH = 'C:\\Users\\x\\.local\\bin\\claude.exe'

function fixture(name: string): unknown[] {
  const file = resolve(import.meta.dirname, '../../../test/fixtures/sdk', `${name}.jsonl`)
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as unknown)
}

interface QueryCall {
  prompt: AsyncIterable<unknown>
  // The fake records whatever the runtime passed; tests read fields off it loosely.
  options: Record<string, any>
}

interface ToolCall {
  name: string
  description: string
  shape: Record<string, unknown>
  handler: (args: any, extra: unknown) => Promise<any>
}

/** A fake SDK: records query options and tools, and plays back the given messages. */
function fakeSdk(
  opts: { messages?: unknown[]; failBeforeInit?: boolean; slowExit?: 'after-abort' | 'never'; models?: unknown[] | 'hang' } = {}
) {
  const state = { finished: false }
  const calls: QueryCall[] = []
  const tools: ToolCall[] = []
  const servers: Record<string, any>[] = []
  const interrupt = vi.fn(async () => undefined)
  const setModel = vi.fn(async (_model?: string) => undefined)
  const applyFlagSettings = vi.fn(async (_settings: Record<string, unknown>) => undefined)
  const supportedModels = vi.fn(() => (opts.models === 'hang' ? new Promise<unknown[]>(() => {}) : Promise.resolve(opts.models ?? [])))
  const sdk = {
    query: (params: QueryCall) => {
      calls.push(params)
      const gen = (async function* () {
        if (opts.failBeforeInit) throw new Error('No conversation found with session ID: nope')
        for (const m of opts.messages ?? []) yield m
        if (opts.slowExit === 'never') await new Promise(() => {})
        if (opts.slowExit === 'after-abort') {
          // Like the real SDK: the stream only ends after the abort, and the child takes a moment to exit.
          const signal = params.options.abortController.signal as AbortSignal
          if (!signal.aborted) {
            await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
          }
          await new Promise((resolve) => setTimeout(resolve, 60))
          state.finished = true
          throw new Error('The operation was aborted')
        }
      })()
      return Object.assign(gen, { interrupt, setModel, applyFlagSettings, supportedModels })
    },
    tool: (name: string, description: string, shape: Record<string, unknown>, handler: ToolCall['handler']) => {
      const def = { name, description, shape, handler }
      tools.push(def)
      return def
    },
    createSdkMcpServer: (o: Record<string, any>) => {
      servers.push(o)
      return { type: 'sdk', name: o.name, instance: {} }
    }
  }
  return { sdk: sdk as unknown as SdkApi, calls, tools, servers, interrupt, setModel, applyFlagSettings, supportedModels, state }
}

function makeSpec(over: Partial<RunSpec> = {}): RunSpec {
  const roleTools: RoleToolHandlers = {
    askUser: vi.fn(async () => 'asked'),
    handoff: vi.fn(async () => 'handed off'),
    submitReport: vi.fn(async () => 'submitted'),
    reportProblem: vi.fn(async () => 'reported'),
    reportWaiting: vi.fn(async () => 'waiting'),
    checkCriterion: vi.fn(async () => 'checked')
  }
  return {
    cwd: 'C:\\work\\ws\\1-fix',
    tempDir: 'C:\\scratch\\ws\\1-fix',
    ownBranch: 'mainbus/1-fix',
    prompt: 'Do the thing',
    appendSystemPrompt: 'You are the Implementer.',
    model: 'sonnet',
    effort: 'high',
    toolProfile: 'edit',
    disallowedTools: ['AskUserQuestion', 'Agent'],
    additionalDirectories: ['C:\\shared'],
    roleTools,
    onPermission: vi.fn(async () => ({ allow: true as const })),
    ...over
  }
}

async function drain(runtime: SdkRuntime, run: { id: string }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of runtime.events(run)) out.push(e)
  return out
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('SdkRuntime', () => {
  test('starts the role claude through its own spawn, which reports the process id and its exit', async () => {
    const f = fakeSdk({ messages: fixture('e1-simple') })
    const started: number[] = []
    const exited: number[] = []
    const spec = makeSpec({ onProcessStart: (p) => started.push(p.pid), onProcessExit: (p) => exited.push(p.pid) })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const spawnClaude = f.calls[0].options.spawnClaudeCodeProcess as (o: unknown) => { pid?: number; kill(): boolean }
    const child = spawnClaude({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: tmpdir(),
      env: { ...process.env },
      signal: new AbortController().signal
    })
    try {
      expect(started).toEqual([child.pid])
    } finally {
      child.kill()
    }
    await eventually(() => expect(exited).toEqual([child.pid]))
  })

  test('passes the official binary path, cwd, model, effort, disallowed tools, additional directories and appended system prompt', async () => {
    const f = fakeSdk({ messages: fixture('e1-simple') })
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const o = f.calls[0].options
    expect(o.pathToClaudeCodeExecutable).toBe(CLAUDE_PATH)
    expect(o.cwd).toBe(spec.cwd)
    expect(o.model).toBe('sonnet')
    expect(o.effort).toBe('high')
    expect(o.permissionMode).toBe('acceptEdits')
    expect(o.allowedTools).toEqual([
      'mcp__mainbus__ask_user',
      'mcp__mainbus__handoff',
      'mcp__mainbus__report_problem',
      'mcp__mainbus__report_waiting',
      'mcp__mainbus__check_criterion'
    ])
    expect(o.disallowedTools).toEqual(spec.disallowedTools)
    expect(o.additionalDirectories).toEqual(spec.additionalDirectories)
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt })
    expect(o.includePartialMessages).toBe(true)
    expect(o.resume).toBeUndefined()
    expect(o.abortController).toBeInstanceOf(AbortController)
  })

  test('leaves model and effort out when the spec has none', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec({ model: undefined, effort: undefined }))
    expect('model' in f.calls[0].options).toBe(false)
    expect('effort' in f.calls[0].options).toBe(false)
  })

  test('loads only project and local settings (M0)', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    expect(f.calls[0].options.settingSources).toEqual(['project', 'local'])
  })

  test('registers the guard as a PreToolUse hook (M0)', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    const matchers = f.calls[0].options.hooks.PreToolUse
    expect(matchers).toHaveLength(1)
    const hook = matchers[0].hooks[0]
    const signal = new AbortController().signal

    const risky = await hook({ tool_name: 'Bash', tool_input: { command: 'git push' } }, 'tu1', { signal })
    expect(risky.hookSpecificOutput).toMatchObject({
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask'
    })
    expect(typeof risky.hookSpecificOutput.permissionDecisionReason).toBe('string')

    const fine = await hook({ tool_name: 'Bash', tool_input: { command: 'git status' } }, 'tu2', { signal })
    expect(fine).toEqual({})
  })

  test('the guard knows the worktree: a write outside it asks, inside it does not', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    const outside = await hook({ tool_name: 'Write', tool_input: { file_path: 'C:\\elsewhere\\x.txt' } }, 't', { signal })
    expect(outside.hookSpecificOutput?.permissionDecision).toBe('ask')
    const inside = await hook({ tool_name: 'Write', tool_input: { file_path: `${spec.cwd}\\x.txt` } }, 't', { signal })
    expect(inside).toEqual({})
  })

  test("the guard reads $TEMP as the run's scratch folder", async () => {
    const f = fakeSdk()
    const spec = makeSpec({ additionalDirectories: ['C:\\scratch\\ws\\1-fix'] })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    const inside = await hook({ tool_name: 'Bash', tool_input: { command: 'echo hi > $TEMP/x' } }, 't', { signal })
    expect(inside).toEqual({})
    const out = await hook({ tool_name: 'Bash', tool_input: { command: 'echo hi > $TEMP/../x' } }, 't', { signal })
    expect(out.hookSpecificOutput?.permissionDecision).toBe('ask')
  })

  test("the guard starts from the hook's cwd, and canUseTool passes that folder on with the request", async () => {
    const f = fakeSdk()
    const onPermission = vi.fn(async () => ({ allow: true as const }))
    const spec = makeSpec({ onPermission })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    const sub = `${spec.cwd}\\src\\engine`
    const command = { command: 'cd ../..' }
    expect(await hook({ tool_name: 'Bash', tool_input: command, tool_use_id: 'tuc', cwd: sub }, 'tuc', { signal })).toEqual({})
    // From the worktree itself, or with a cwd that is not a path, it leaves.
    for (const cwd of [spec.cwd, 'src', undefined]) {
      const out = await hook({ tool_name: 'Bash', tool_input: command, tool_use_id: 'tux', cwd }, 'tux', { signal })
      expect(out.hookSpecificOutput?.permissionDecision, String(cwd)).toBe('ask')
    }
    await f.calls[0].options.canUseTool('Bash', command, { signal, toolUseID: 'tuc', decisionReason: 'r' })
    expect(onPermission).toHaveBeenCalledWith(expect.objectContaining({ toolUseId: 'tuc', cwd: sub }))
    // Used once: a request for a tool call the hook never saw has no folder.
    await f.calls[0].options.canUseTool('Bash', command, { signal, toolUseID: 'tuc', decisionReason: 'r' })
    expect(onPermission).toHaveBeenLastCalledWith(expect.not.objectContaining({ cwd: expect.anything() }))
  })

  test('never returns updatedPermissions (M0)', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const input = { command: 'npm install left-pad' }
    const result = await f.calls[0].options.canUseTool('Bash', input, {
      signal: new AbortController().signal,
      toolUseID: 'tu1',
      decisionReason: 'This command requires approval',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' }]
    })
    expect(result).toEqual({ behavior: 'allow', updatedInput: input })
    expect('updatedPermissions' in result).toBe(false)
  })

  test('canUseTool maps PermissionVerdict to the SDK result and passes the request through', async () => {
    const f = fakeSdk()
    const onPermission = vi.fn(async () => ({ allow: false as const, message: 'no' }))
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec({ onPermission }))
    const signal = new AbortController().signal
    const input = { command: 'git push' }
    const result = await f.calls[0].options.canUseTool('Bash', input, {
      signal,
      toolUseID: 'tu9',
      decisionReason: 'git push is guarded'
    })
    expect(result).toEqual({ behavior: 'deny', message: 'no' })
    expect(onPermission).toHaveBeenCalledWith({
      toolName: 'Bash',
      input,
      reason: 'git push is guarded',
      toolUseId: 'tu9',
      signal
    })
  })

  test('canUseTool denies, with the reason, when onPermission throws', async () => {
    const f = fakeSdk()
    const onPermission = vi.fn(async () => {
      throw new Error('store offline')
    })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec({ onPermission }))
    const result = await f.calls[0].options.canUseTool('Bash', { command: 'x' }, {
      signal: new AbortController().signal,
      toolUseID: 'tu1'
    })
    expect(result).toEqual({
      behavior: 'deny',
      message: 'Mainbus could not decide this permission: store offline'
    })
  })

  test('uses only the in-process mainbus MCP server (strictMcpConfig)', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    expect(f.calls[0].options.strictMcpConfig).toBe(true)
  })

  test('interrupt() and stop() tell the normalizer to expect an interrupt (M0)', async () => {
    const order: string[] = []
    vi.spyOn(Normalizer.prototype, 'expectInterrupt').mockImplementation(() => {
      order.push('expect')
    })
    const f = fakeSdk()
    f.interrupt.mockImplementation(async () => {
      order.push('interrupt')
      return undefined
    })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec())

    await runtime.interrupt(run)
    expect(order).toEqual(['expect', 'interrupt'])

    await runtime.stop(run)
    expect(order).toEqual(['expect', 'interrupt', 'expect'])
    expect(f.calls[0].options.abortController.signal.aborted).toBe(true)
  })

  test('stop() waits for the stream to finish and emits no error event', async () => {
    const f = fakeSdk({ messages: fixture('e1-simple').slice(0, 3), slowExit: 'after-abort' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec())
    const events = drain(runtime, run)
    await runtime.stop(run)
    expect(f.state.finished).toBe(true) // stop() resolved only after the stream had ended
    expect((await events).filter((e) => e.kind === 'error')).toEqual([])
  })

  test('stop() gives up waiting after the stop timeout and is harmless to repeat', async () => {
    const f = fakeSdk({ slowExit: 'never' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, { stopTimeoutMs: 40 })
    const run = await runtime.start(makeSpec())
    const t0 = Date.now()
    await runtime.stop(run)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35)
    await expect(runtime.stop(run)).resolves.toBeUndefined()
  })

  test('a stopped run is forgotten', async () => {
    const runtime = new SdkRuntime(CLAUDE_PATH, fakeSdk().sdk)
    const run = await runtime.start(makeSpec())
    await runtime.stop(run)
    expect(() => runtime.events(run)).toThrow(/Unknown run/)
  })

  test('stop() ends the streaming input', async () => {
    const f = fakeSdk()
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec())
    await runtime.stop(run)
    const it = f.calls[0].prompt[Symbol.asyncIterator]()
    expect((await it.next()).done).toBe(false) // the first prompt was already queued
    expect((await it.next()).done).toBe(true)
  })

  test('start with resumeSessionId waits for system/init and rejects with ResumeFailedError if the stream errors first', async () => {
    const f = fakeSdk({ failBeforeInit: true })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    await expect(runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))).rejects.toBeInstanceOf(ResumeFailedError)
    expect(f.calls[0].options.resume).toBe('sess-1')
  })

  test('start with resumeSessionId rejects with ResumeFailedError if the stream ends without init', async () => {
    const f = fakeSdk({ messages: [] })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    await expect(runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))).rejects.toBeInstanceOf(ResumeFailedError)
  })

  test('start with resumeSessionId gives up when system/init never comes: aborts, waits for the stream, rejects', async () => {
    const f = fakeSdk({ messages: [], slowExit: 'after-abort' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, { stopTimeoutMs: 1000, resumeInitTimeoutMs: 50 })

    const started = runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))

    await expect(started).rejects.toBeInstanceOf(ResumeFailedError)
    await expect(started).rejects.toThrow(/no system\/init within 50 ms/)
    expect(f.calls[0].options.abortController.signal.aborted).toBe(true)
    expect(f.state.finished).toBe(true) // it waited for the stream to end before rejecting
  })

  test('the init timeout still rejects when the stream never ends, after the bounded stop wait', async () => {
    const f = fakeSdk({ messages: [], slowExit: 'never' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, { stopTimeoutMs: 40, resumeInitTimeoutMs: 30 })
    const t0 = Date.now()

    await expect(runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))).rejects.toBeInstanceOf(ResumeFailedError)

    expect(Date.now() - t0).toBeGreaterThanOrEqual(60)
  })

  test('start with resumeSessionId resolves after init and still delivers the init session event', async () => {
    const f = fakeSdk({ messages: fixture('e2-resume') })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))
    const events = await drain(runtime, run)
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ kind: 'turn_end' })
  })

  test('a resumed run starts from the baseline, so its first usage is that turn only', async () => {
    const baseline = { 'claude-haiku-5-5': { inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }
    const run = async (usageBaseline?: typeof baseline) => {
      const runtime = new SdkRuntime(CLAUDE_PATH, fakeSdk({ messages: fixture('e2-resume') }).sdk)
      const events = await drain(runtime, await runtime.start(makeSpec({ resumeSessionId: 'sess-1', ...(usageBaseline ? { usageBaseline } : {}) })))
      return events.find((e) => e.kind === 'usage') as { inputTokens: number }
    }
    expect((await run()).inputTokens - (await run(baseline)).inputTokens).toBe(12)
  })

  test('a start without resume does not wait for the stream', async () => {
    const f = fakeSdk({ failBeforeInit: true })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec())
    expect(await drain(runtime, run)).toEqual([
      { kind: 'error', message: 'No conversation found with session ID: nope' }
    ])
  })

  test('events() normalizes the SDK stream and ends when it ends', async () => {
    const f = fakeSdk({ messages: fixture('e1-simple') })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec())
    const events = await drain(runtime, run)
    expect(events.filter((e) => e.kind === 'session')).toHaveLength(1)
    expect(events.filter((e) => e.kind === 'message').length).toBeGreaterThanOrEqual(1)
    expect(events.at(-1)).toEqual({ kind: 'turn_end', ok: true })
  })

  test('registers the mainbus MCP server with its five role tools, always loaded', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    expect(f.servers).toHaveLength(1)
    expect(f.servers[0].name).toBe('mainbus')
    expect(f.servers[0].alwaysLoad).toBe(true)
    expect(f.tools.map((t) => t.name)).toEqual(['ask_user', 'handoff', 'report_problem', 'report_waiting', 'check_criterion'])
    expect(Object.keys(f.tools[0].shape)).toEqual(['question', 'options', 'recommended'])
    expect(Object.keys(f.tools[1].shape)).toEqual(['summary', 'notes_for_next'])
    expect(Object.keys(f.tools[2].shape)).toEqual(['details'])
    expect(Object.keys(f.tools[3].shape)).toEqual(['reason', 'until'])
    expect(Object.keys(f.tools[4].shape)).toEqual(['index'])
    expect(Object.keys(f.calls[0].options.mcpServers)).toEqual(['mainbus'])
    expect(f.calls[0].options.mcpServers.mainbus.name).toBe('mainbus')
  })

  test('the last role of an Investigate lineup is offered submit_report instead of handoff', async () => {
    const f = fakeSdk()
    const spec = makeSpec({ endsWithReport: true })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    expect(f.tools.map((t) => t.name)).toEqual(['ask_user', 'submit_report', 'report_problem', 'report_waiting', 'check_criterion'])
    expect(Object.keys(f.tools[1].shape)).toEqual(['markdown'])
    expect(f.calls[0].options.allowedTools).toContain('mcp__mainbus__submit_report')
    expect(f.calls[0].options.allowedTools).not.toContain('mcp__mainbus__handoff')
    await f.tools[1].handler({ markdown: '# R' }, {})
    expect(spec.roleTools.submitReport).toHaveBeenCalledWith({ markdown: '# R' })
  })

  test("the handoff tool's zod field notes_for_next is mapped to notesForNext", async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const handoff = f.tools.find((t) => t.name === 'handoff')!
    const result = await handoff.handler({ summary: 'did it', notes_for_next: 'check tests' }, {})
    expect(spec.roleTools.handoff).toHaveBeenCalledWith({ summary: 'did it', notesForNext: 'check tests' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'handed off' }] })
  })

  test('the ask_user tool passes question, options and recommended through', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const askUser = f.tools.find((t) => t.name === 'ask_user')!
    const args = { question: 'Which?', options: ['a', 'b'], recommended: 1 }
    const result = await askUser.handler(args, {})
    expect(spec.roleTools.askUser).toHaveBeenCalledWith(args)
    expect(result).toEqual({ content: [{ type: 'text', text: 'asked' }] })
  })

  test('the report_problem tool passes its details through', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const reportProblem = f.tools.find((t) => t.name === 'report_problem')!
    const result = await reportProblem.handler({ details: 'tests fail' }, {})
    expect(spec.roleTools.reportProblem).toHaveBeenCalledWith({ details: 'tests fail' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'reported' }] })
  })

  test('the report_waiting tool passes its reason and until through', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const reportWaiting = f.tools.find((t) => t.name === 'report_waiting')!
    const result = await reportWaiting.handler({ reason: 'the test suite', until: '2026-11-02T14:30:00Z' }, {})
    expect(spec.roleTools.reportWaiting).toHaveBeenCalledWith({ reason: 'the test suite', until: '2026-11-02T14:30:00Z' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'waiting' }] })
  })

  test('the check_criterion tool passes its index through', async () => {
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const checkCriterion = f.tools.find((t) => t.name === 'check_criterion')!
    const result = await checkCriterion.handler({ index: 2 }, {})
    expect(spec.roleTools.checkCriterion).toHaveBeenCalledWith({ index: 2 })
    expect(result).toEqual({ content: [{ type: 'text', text: 'checked' }] })
  })

  test('strips ANTHROPIC_API_KEY and every other credential or endpoint override from the child environment', async () => {
    const stripped = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_VERTEX_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY'
    ]
    for (const name of stripped) vi.stubEnv(name, 'should-not-leak')
    vi.stubEnv('ANTHROPIC_MODEL', 'kept-model')
    vi.stubEnv('MAINBUS_TEST_KEEP', 'kept')
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    const env = f.calls[0].options.env
    for (const name of stripped) {
      expect(env[name]).toBeUndefined()
      expect(name in env).toBe(false)
    }
    expect(env.MAINBUS_TEST_KEEP).toBe('kept')
    expect(env.ANTHROPIC_MODEL).toBe('kept-model')
    // Marks the agent's process tree, so the stable-build scripts refuse to run inside it.
    expect(env.MAINBUS_AGENT).toBe('1')
    expect(process.env.ANTHROPIC_API_KEY).toBe('should-not-leak') // the parent is untouched
  })

  test("names the app's data home in MAINBUS_AGENT_HOME, never an inherited one", async () => {
    vi.stubEnv('MAINBUS_AGENT_HOME', '/inherited')
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk, { agentHome: '/agent-home' }).start(makeSpec())
    expect(f.calls[0].options.env.MAINBUS_AGENT_HOME).toBe('/agent-home')

    const g = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, g.sdk).start(makeSpec())
    expect('MAINBUS_AGENT_HOME' in g.calls[0].options.env).toBe(false)
  })

  test('lets a role agent run a foreground command for up to 30 minutes', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    expect(f.calls[0].options.env.BASH_MAX_TIMEOUT_MS).toBe('1800000')
  })

  test("points TEMP, TMP and TMPDIR at the run's scratch folder, never an inherited one", async () => {
    vi.stubEnv('TEMP', 'C:\\inherited\\temp')
    vi.stubEnv('TMP', 'C:\\inherited\\tmp')
    vi.stubEnv('TMPDIR', '/inherited/tmpdir')
    // A separate key off Windows; on Windows the same variable as TMP.
    vi.stubEnv('Tmp', 'C:\\inherited\\Tmp')
    const f = fakeSdk()
    const spec = makeSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const env = f.calls[0].options.env as Record<string, string | undefined>
    expect(env.TEMP).toBe(spec.tempDir)
    expect(env.TMP).toBe(spec.tempDir)
    expect(env.TMPDIR).toBe(spec.tempDir)
    // No other spelling is left beside them: Windows names are case-insensitive, so one would be ambiguous.
    const tempKeys = Object.keys(env).filter((k) => ['TEMP', 'TMP', 'TMPDIR'].includes(k.toUpperCase()))
    expect(tempKeys.sort()).toEqual(['TEMP', 'TMP', 'TMPDIR'])
    expect(process.env.TMPDIR).toBe('/inherited/tmpdir') // the parent is untouched
  })

  test('read_only adds the edit tools to disallowedTools', async () => {
    const f = fakeSdk()
    const spec = makeSpec({ toolProfile: 'read_only' })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    const disallowed: string[] = f.calls[0].options.disallowedTools
    expect(disallowed).toEqual(expect.arrayContaining(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']))
    expect(disallowed).toEqual(expect.arrayContaining(spec.disallowedTools))
    expect(new Set(disallowed).size).toBe(disallowed.length)
    expect(spec.disallowedTools).toEqual(['AskUserQuestion', 'Agent']) // the spec is not mutated
  })

  test('send() pushes an SDKUserMessage into the streaming input', async () => {
    const f = fakeSdk()
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const run = await runtime.start(makeSpec({ prompt: 'first prompt' }))
    await runtime.send(run, 'steer left')
    const it = f.calls[0].prompt[Symbol.asyncIterator]()
    expect((await it.next()).value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'first prompt' },
      parent_tool_use_id: null
    })
    expect((await it.next()).value).toEqual({
      type: 'user',
      message: { role: 'user', content: 'steer left' },
      parent_tool_use_id: null
    })
  })

  test('methods on an unknown run throw', async () => {
    const runtime = new SdkRuntime(CLAUDE_PATH, fakeSdk().sdk)
    await expect(runtime.send({ id: 'nope' }, 'x')).rejects.toThrow(/Unknown run/)
  })
})

describe('SdkRuntime.summarize', () => {
  const request = { cwd: 'C:\\work\\ws\\1-fix', tempDir: 'C:\\scratch\\ws\\1-fix', prompt: 'Summarise this log', timeoutMs: 5000 }
  const result = (over: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success', is_error: false, result: ' The plan. ', ...over })

  test("runs one turn of the user's own claude, with its own login, no tools, no MCP servers and no saved session", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'should-not-leak')
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'should-not-leak')
    const f = fakeSdk({ messages: [{ type: 'system', subtype: 'init' }, result()] })

    expect(await new SdkRuntime(CLAUDE_PATH, f.sdk, { agentHome: 'C:\\home' }).summarize(request)).toBe('The plan.')

    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].prompt).toBe('Summarise this log')
    const o = f.calls[0].options
    expect(o.pathToClaudeCodeExecutable).toBe(CLAUDE_PATH)
    expect(o.cwd).toBe(request.cwd)
    expect(o.tools).toEqual([])
    expect(o.allowedTools).toEqual([])
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'Read', 'WebFetch']))
    expect(o.mcpServers).toEqual({})
    expect(o.strictMcpConfig).toBe(true)
    expect(o.settingSources).toEqual([])
    expect(o.maxTurns).toBe(1)
    expect(o.persistSession).toBe(false)
    expect(o).not.toHaveProperty('resume')
    expect(typeof o.systemPrompt).toBe('string')
    expect(await o.canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal })).toMatchObject({ behavior: 'deny' })
    const env = o.env as Record<string, string | undefined>
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env).toMatchObject({ MAINBUS_AGENT: '1', MAINBUS_AGENT_HOME: 'C:\\home', TEMP: request.tempDir })
    expect(f.servers).toEqual([])
    expect(f.tools).toEqual([])
  })

  test('reports what the call used through onUsage, also when it failed', async () => {
    const modelUsage = { 'claude-haiku-5-5': { inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 5, cacheCreationInputTokens: 6, costUSD: 0.01 } }
    for (const over of [{}, { is_error: true, result: 'API Error: 529' }]) {
      const onUsage = vi.fn()
      const f = fakeSdk({ messages: [result({ modelUsage, duration_ms: 900, ...over })] })
      await new SdkRuntime(CLAUDE_PATH, f.sdk).summarize({ ...request, onUsage }).catch(() => {})
      expect(onUsage).toHaveBeenCalledTimes(1)
      expect(onUsage.mock.calls[0][0]).toMatchObject({ kind: 'usage', inputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6, costUsd: 0.01, durationMs: 900 })
    }
  })

  test('rejects once the time limit passes, and aborts the call', async () => {
    const f = fakeSdk({ slowExit: 'after-abort' })
    const started = Date.now()
    await expect(new SdkRuntime(CLAUDE_PATH, f.sdk).summarize({ ...request, timeoutMs: 50 })).rejects.toThrow('No summary within 50 ms')
    expect(Date.now() - started).toBeLessThan(2000)
    expect((f.calls[0].options.abortController as AbortController).signal.aborted).toBe(true)
  })

  test.each([
    ['an error result', [result({ subtype: 'error_during_execution', result: undefined })], /The summary failed/],
    ['an API error', [result({ is_error: true, result: 'API Error: 529 overloaded' })], /API Error: 529/],
    ['an empty answer', [result({ result: '   ' })], 'The summary was empty'],
    ['no result at all', [], 'The summary was empty']
  ])('rejects on %s', async (_name, messages, error) => {
    const f = fakeSdk({ messages })
    await expect(new SdkRuntime(CLAUDE_PATH, f.sdk).summarize(request)).rejects.toThrow(error)
  })

  test('the summary path never calls the API itself: no API SDK, no fetch', () => {
    for (const file of ['sdkRuntime.ts', '../runner/ticketRunner.ts', '../runner/digest.ts']) {
      const source = readFileSync(resolve(import.meta.dirname, file), 'utf8')
      expect(source).not.toMatch(/@anthropic-ai\/sdk\b/)
      expect(source).not.toMatch(/\bfetch\(/)
    }
  })
})

/** Git Bash, as Claude Code finds it: CLAUDE_CODE_GIT_BASH_PATH, else beside the git on PATH. */
function gitBashes(): string[] {
  if (process.platform !== 'win32') return []
  const configured = process.env.CLAUDE_CODE_GIT_BASH_PATH
  if (configured && existsSync(configured)) return [configured]
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
  if (git.status !== 0) return []
  // <Git>\mingw64\libexec\git-core
  const root = path.win32.resolve(git.stdout.trim(), '..', '..', '..')
  return ['bin\\bash.exe', 'usr\\bin\\bash.exe'].map((b) => path.win32.join(root, b)).filter((b) => existsSync(b))
}

const BASHES = gitBashes()

describe('SdkRuntime: the orchestrator model', () => {
  test("reads the binary's model list without sending a message, with its own login and no tools, then ends the session", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'should-not-leak')
    const listed = [
      { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'x', supportsEffort: true },
      { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'y' },
      { value: 'haiku', displayName: 'Haiku', description: 'z' }
    ]
    const f = fakeSdk({ models: listed })
    try {
      const models = await new SdkRuntime(CLAUDE_PATH, f.sdk, { agentHome: 'C:\\home' }).supportedModels('C:\\home\\orchestrator')
      expect(models).toEqual([
        { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5' },
        { value: 'claude-fable-5-2', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2' },
        { value: 'haiku', displayName: 'Haiku' }
      ])
    } finally {
      vi.unstubAllEnvs()
    }
    expect(f.calls).toHaveLength(1)
    const o = f.calls[0].options
    expect(o.pathToClaudeCodeExecutable).toBe(CLAUDE_PATH)
    expect(o.cwd).toBe('C:\\home\\orchestrator')
    expect(o.tools).toEqual([])
    expect(o.mcpServers).toEqual({})
    expect(o.settingSources).toEqual([])
    expect(o.persistSession).toBe(false)
    expect(o.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect((o.abortController as AbortController).signal.aborted).toBe(true)
    // Nothing was sent: the prompt stream ended without a message.
    const sent: unknown[] = []
    for await (const m of f.calls[0].prompt) sent.push(m)
    expect(sent).toEqual([])
  })

  test('gives up on a list that never comes', async () => {
    const f = fakeSdk({ models: 'hang' })
    await expect(new SdkRuntime(CLAUDE_PATH, f.sdk, { modelListTimeoutMs: 30 }).supportedModels('C:\\o')).rejects.toThrow('No model list within 30 ms')
    expect((f.calls[0].options.abortController as AbortController).signal.aborted).toBe(true)
  })

  test("changes a live run's model and effort through the SDK, for its next turns", async () => {
    const f = fakeSdk({ slowExit: 'never' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const handle = await runtime.start(makeSpec())
    await runtime.setModelEffort(handle, 'claude-fable-5-2', 'xhigh')
    expect(f.setModel).toHaveBeenCalledWith('claude-fable-5-2')
    expect(f.applyFlagSettings).toHaveBeenCalledWith({ effortLevel: 'xhigh' })
    await expect(runtime.setModelEffort({ id: 'gone' }, 'opus', 'low')).rejects.toThrow('Unknown run gone')
  })
})

describe('SdkRuntime: the orchestrator spec', () => {
  const ORCH_CWD = 'C:\\home\\orchestrator'
  const REPO = 'C:\\code\\repo'

  function makeOrchestratorSpec(over: Partial<OrchestratorRunSpec> = {}): OrchestratorRunSpec {
    const tools: OrchestratorToolHandlers = {
      listWorkspaces: vi.fn(async () => 'workspaces'),
      listTickets: vi.fn(async () => 'tickets'),
      getTicket: vi.fn(async () => 'ticket'),
      getRunStatus: vi.fn(async () => 'status'),
      getRecentEvents: vi.fn(async () => 'events'),
      listPendingDecisions: vi.fn(async () => 'decisions'),
      getTimeReport: vi.fn(async () => 'time'),
      createTickets: vi.fn(async () => "Created #1 in app's Backlog."),
      updateTicket: vi.fn(async () => 'Updated #1.'),
      proposeCreateTickets: vi.fn(async () => 'Proposed p1.'),
      proposeStart: vi.fn(async () => 'Proposed p2.'),
      proposePause: vi.fn(async () => 'Proposed p3.'),
      proposeStop: vi.fn(async () => 'Proposed p4.'),
      proposeSkip: vi.fn(async () => 'Proposed p5.'),
      proposeHold: vi.fn(async () => 'Proposed p6.'),
      proposeAnswer: vi.fn(async () => 'Proposed p7.'),
      proposeRedirect: vi.fn(async () => 'Proposed p8.'),
      proposeReplace: vi.fn(async () => 'Proposed p9.'),
      proposePromote: vi.fn(async () => 'Proposed p10.'),
      proposeUpdateFromMain: vi.fn(async () => 'Proposed p11.'),
      proposeMerge: vi.fn(async () => 'Proposed p12.')
    }
    return {
      kind: 'orchestrator',
      cwd: ORCH_CWD,
      prompt: 'What needs me?',
      appendSystemPrompt: 'You are the orchestrator.',
      model: 'opus',
      effort: 'medium',
      additionalDirectories: [REPO],
      disallowedTools: ['Bash', 'Edit', 'Agent'],
      tools,
      onPermission: async (r) => orchestratorVerdict(r.toolName, r.input, { cwd: ORCH_CWD, readable: [REPO] }),
      ...over
    }
  }

  test('images go into the user message as image blocks before the text, at launch and with send()', async () => {
    const f = fakeSdk()
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk)
    const png = { mime: 'image/png' as const, base64: 'iVBORw0K' }
    const run = await runtime.start(makeOrchestratorSpec({ promptImages: [png] }))
    await runtime.send(run, 'And this one', [{ mime: 'image/jpeg', base64: '/9j/' }])
    await runtime.send(run, 'Just words')
    const it = f.calls[0].prompt[Symbol.asyncIterator]()
    const first = (await it.next()).value
    expect(first).toEqual({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } },
          { type: 'text', text: 'What needs me?' }
        ]
      }
    })
    expect((await it.next()).value.message.content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
      { type: 'text', text: 'And this one' }
    ])
    // Without images, the message is the text alone, as before.
    expect((await it.next()).value.message.content).toBe('Just words')
    await runtime.stop(run)
  })

  test('limits built-in tools to Read, Grep, Glob, WebFetch and WebSearch, loads no settings, and pre-approves only the Mainbus tools', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
    const f = fakeSdk()
    const spec = makeOrchestratorSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk, { agentHome: 'C:\\home' }).start(spec)
    const o = f.calls[0].options
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'])
    expect(o.disallowedTools).toEqual(['Bash', 'Edit', 'Agent'])
    expect(o.allowedTools).toEqual([
      'mcp__mainbus__list_workspaces',
      'mcp__mainbus__list_tickets',
      'mcp__mainbus__get_ticket',
      'mcp__mainbus__get_run_status',
      'mcp__mainbus__get_recent_events',
      'mcp__mainbus__get_time_report',
      'mcp__mainbus__list_pending_decisions',
      'mcp__mainbus__create_tickets',
      'mcp__mainbus__update_ticket',
      'mcp__mainbus__propose_create_tickets',
      'mcp__mainbus__propose_start',
      'mcp__mainbus__propose_pause',
      'mcp__mainbus__propose_stop',
      'mcp__mainbus__propose_skip',
      'mcp__mainbus__propose_hold',
      'mcp__mainbus__propose_answer',
      'mcp__mainbus__propose_redirect',
      'mcp__mainbus__propose_replace',
      'mcp__mainbus__propose_promote',
      'mcp__mainbus__propose_update_from_main',
      'mcp__mainbus__propose_merge'
    ])
    expect(o.settingSources).toEqual([])
    expect(o.permissionMode).toBe('default')
    expect(o.strictMcpConfig).toBe(true)
    expect(o.model).toBe('opus')
    expect(o.effort).toBe('medium')
    expect(o.cwd).toBe(ORCH_CWD)
    expect(o.additionalDirectories).toEqual([REPO])
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt })
    expect(o.resume).toBeUndefined()
    expect(o.env.MAINBUS_AGENT).toBe('1')
    expect(o.env.MAINBUS_AGENT_HOME).toBe('C:\\home')
    expect(o.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('its MCP server has exactly the six read tools, create_tickets and the propose tools, and they call the handlers', async () => {
    const f = fakeSdk()
    const spec = makeOrchestratorSpec()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(spec)
    expect(f.servers).toHaveLength(1)
    expect(f.servers[0]).toMatchObject({ name: 'mainbus', alwaysLoad: true })
    expect(f.tools.map((t) => t.name)).toEqual([
      'list_workspaces',
      'list_tickets',
      'get_ticket',
      'get_run_status',
      'get_recent_events',
      'get_time_report',
      'list_pending_decisions',
      'create_tickets',
      'update_ticket',
      'propose_create_tickets',
      'propose_start',
      'propose_pause',
      'propose_stop',
      'propose_skip',
      'propose_hold',
      'propose_answer',
      'propose_redirect',
      'propose_replace',
      'propose_promote',
      'propose_update_from_main',
      'propose_merge'
    ])
    const byName = new Map(f.tools.map((t) => [t.name, t]))
    expect(await byName.get('get_recent_events')!.handler({ number: 3, limit: 5 }, {})).toEqual({
      content: [{ type: 'text', text: 'events' }]
    })
    expect(spec.tools.getRecentEvents).toHaveBeenCalledWith({ number: 3, limit: 5 })
    await byName.get('list_tickets')!.handler({}, {})
    expect(spec.tools.listTickets).toHaveBeenCalledWith({})

    // The propose tool passes what the agent sent on whole; the engine validates it.
    const propose = byName.get('propose_create_tickets')!
    const args = { tickets: [{ title: 'Add login' }], column: 'ready' }
    expect(await propose.handler(args, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p1.' }] })
    expect(spec.tools.proposeCreateTickets).toHaveBeenCalledWith(args)
    // Its schema has no intent: a ticket's intent is the user's message, and one from the agent is refused.
    expect(Object.keys(propose.shape)).toEqual(['workspace', 'tickets', 'request_messages_back', 'context', 'column', 'evidence'])
    const tickets = propose.shape.tickets as z.ZodType
    expect(tickets.safeParse([{ title: 'Add login', intent: 'The user said so' }]).success).toBe(false)
    expect(tickets.safeParse([{ title: 'Add login', spec: 'Details' }]).success).toBe(true)
    // Images by name; the engine checks they came with the request.
    expect(tickets.safeParse([{ title: 'Add login', images: ['bug.png'] }]).success).toBe(true)
    expect(tickets.safeParse([{ title: 'Add login', images: 'bug.png' }]).success).toBe(false)

    // create_tickets: the same drafts, and no column, since they always go to Backlog.
    const create = byName.get('create_tickets')!
    const createArgs = { workspace: 'app', tickets: [{ title: 'Add login' }], request_messages_back: 1 }
    expect(await create.handler(createArgs, {})).toEqual({ content: [{ type: 'text', text: "Created #1 in app's Backlog." }] })
    expect(spec.tools.createTickets).toHaveBeenCalledWith(createArgs)
    expect(Object.keys(create.shape)).toEqual(['workspace', 'tickets', 'request_messages_back', 'context'])
    expect((create.shape.tickets as z.ZodType).safeParse([{ title: 'Add login', intent: 'The user said so' }]).success).toBe(false)

    // update_ticket: the fields to change, and no way to supply the user's words: add_user_words is a flag.
    const update = byName.get('update_ticket')!
    const updateArgs = { workspace: 'app', ticket: 7, spec: 'Smaller', criteria: ['one'], add_user_words: true, request_messages_back: 1 }
    expect(await update.handler(updateArgs, {})).toEqual({ content: [{ type: 'text', text: 'Updated #1.' }] })
    expect(spec.tools.updateTicket).toHaveBeenCalledWith(updateArgs)
    expect(Object.keys(update.shape)).toEqual(['workspace', 'ticket', 'title', 'spec', 'criteria', 'labels', 'blocked_by', 'preset', 'add_user_words', 'request_messages_back'])
    expect((update.shape.add_user_words as z.ZodType).safeParse('The user said so').success).toBe(false)

    const start = byName.get('propose_start')!
    const startArgs = { ticket: 4, roles: [{ role: 'Implementer', model: 'opus', effort: 'high' }], reason: 'It is ready' }
    expect(await start.handler(startArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p2.' }] })
    expect(spec.tools.proposeStart).toHaveBeenCalledWith(startArgs)
    expect(Object.keys(start.shape)).toEqual(['ticket', 'workspace', 'roles', 'extraInstructions', 'preset', 'reason'])

    for (const [name, handler, text] of [['propose_pause', 'proposePause', 'p3'], ['propose_stop', 'proposeStop', 'p4'], ['propose_skip', 'proposeSkip', 'p5']] as const) {
      const tool = byName.get(name)!
      expect(Object.keys(tool.shape)).toEqual(['ticket', 'workspace', 'reason'])
      expect(await tool.handler({ ticket: 4, reason: 'Stuck' }, {})).toEqual({ content: [{ type: 'text', text: `Proposed ${text}.` }] })
      expect(spec.tools[handler]).toHaveBeenCalledWith({ ticket: 4, reason: 'Stuck' })
    }
    const hold = byName.get('propose_hold')!
    const holdArgs = { ticket: 4, until: '2026-11-04T00:00:00.000Z', reason: 'Wait for the release' }
    expect(Object.keys(hold.shape)).toEqual(['ticket', 'workspace', 'until', 'reason'])
    expect(await hold.handler(holdArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p6.' }] })
    expect(spec.tools.proposeHold).toHaveBeenCalledWith(holdArgs)
    const answer = byName.get('propose_answer')!
    const answerArgs = { decision: 'd1', choice: 2, reasoning: 'You said so' }
    expect(Object.keys(answer.shape)).toEqual(['decision', 'choice', 'note', 'reasoning', 'judgement'])
    expect(await answer.handler(answerArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p7.' }] })
    expect(spec.tools.proposeAnswer).toHaveBeenCalledWith(answerArgs)
    const redirect = byName.get('propose_redirect')!
    const redirectArgs = { ticket: 4, message: 'Check the fixtures instead.', evidence: 'The same test failed 4 times' }
    expect(Object.keys(redirect.shape)).toEqual(['ticket', 'workspace', 'message', 'evidence'])
    expect(await redirect.handler(redirectArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p8.' }] })
    expect(spec.tools.proposeRedirect).toHaveBeenCalledWith(redirectArgs)
    const replace = byName.get('propose_replace')!
    const replaceArgs = { ticket: 4, reason: 'A fresh agent will not repeat the dead end', evidence: 'The redirect did not help' }
    expect(Object.keys(replace.shape)).toEqual(['ticket', 'workspace', 'reason', 'evidence'])
    expect(await replace.handler(replaceArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p9.' }] })
    expect(spec.tools.proposeReplace).toHaveBeenCalledWith(replaceArgs)
    const promoteTool = byName.get('propose_promote')!
    const promoteArgs = { ticket: 2, title: 'Fix the slow login', spec: 'Cache the lookup.' }
    expect(Object.keys(promoteTool.shape)).toEqual(['ticket', 'workspace', 'title', 'spec'])
    expect(await promoteTool.handler(promoteArgs, {})).toEqual({ content: [{ type: 'text', text: 'Proposed p10.' }] })
    expect(spec.tools.proposePromote).toHaveBeenCalledWith(promoteArgs)
    const roles = start.shape.roles as z.ZodType
    expect(roles.safeParse([{ role: 'Planner', model: 'haiku', effort: 'max' }]).success).toBe(true)
    expect(roles.safeParse([{ role: 'Planner', model: 'gpt' }]).success).toBe(false)
  })

  test("propose_start's models are the ones offered when the orchestrator starts: Fable once the binary offers it", async () => {
    const startRoles = async (): Promise<z.ZodType> => {
      const f = fakeSdk()
      await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeOrchestratorSpec())
      return f.tools.find((t) => t.name === 'propose_start')!.shape.roles as z.ZodType
    }
    const fable = [{ role: 'Implementer', model: 'claude-fable-5-2' }]
    expect((await startRoles()).safeParse(fable).success).toBe(false)
    setModelOptions([{ value: 'claude-fable-5-2', label: 'Fable 5.2' }, ...ALIAS_MODEL_OPTIONS])
    try {
      const roles = await startRoles()
      expect(roles.safeParse(fable).success).toBe(true)
      expect(roles.safeParse([{ role: 'Implementer', model: 'sonnet' }]).success).toBe(true)
    } finally {
      setModelOptions([])
    }
  })

  test('the PreToolUse hook denies a credential file inside the repo and allows other reads there', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeOrchestratorSpec())
    const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0]
    const signal = new AbortController().signal
    const secret = await hook({ tool_name: 'Read', tool_input: { file_path: `${REPO}\\.env` } }, 't1', { signal })
    expect(secret.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'deny' })
    const code = await hook({ tool_name: 'Read', tool_input: { file_path: `${REPO}\\src\\index.ts` } }, 't2', { signal })
    expect(code).toEqual({})
    const bash = await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 't3', { signal })
    expect(bash.hookSpecificOutput.permissionDecision).toBe('deny')
  })

  test('the PreToolUse hook denies a Grep over a repo with a credential file ripgrep would search', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mainbus-orch-grep-'))
    try {
      const repo = path.join(dir, 'repo')
      const clean = path.join(dir, 'clean')
      for (const d of [repo, clean]) {
        mkdirSync(path.join(d, 'src'), { recursive: true })
        writeFileSync(path.join(d, 'src', 'index.ts'), 'export {}\n')
      }
      writeFileSync(path.join(repo, '.npmrc'), '//registry.npmjs.org/:_authToken=FAKE_TOKEN_123\n')
      const f = fakeSdk()
      await new SdkRuntime(CLAUDE_PATH, f.sdk).start(
        makeOrchestratorSpec({
          additionalDirectories: [dir],
          onPermission: async (r) => orchestratorVerdict(r.toolName, r.input, { cwd: ORCH_CWD, readable: [dir] })
        })
      )
      const hook = f.calls[0].options.hooks.PreToolUse[0].hooks[0]
      const signal = new AbortController().signal
      const grep = (input: Record<string, unknown>) => hook({ tool_name: 'Grep', tool_input: { pattern: 'authToken', output_mode: 'content', ...input } }, 't', { signal })
      const secret = await grep({ path: repo })
      expect(secret.hookSpecificOutput).toMatchObject({ permissionDecision: 'deny' })
      expect(secret.hookSpecificOutput.permissionDecisionReason).toContain('.npmrc')
      expect(await grep({ path: repo, glob: '*.ts' })).toEqual({})
      expect(await grep({ path: clean })).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('canUseTool maps a deny, and denies when the policy throws', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeOrchestratorSpec())
    const opts = { signal: new AbortController().signal, toolUseID: 'tu1' }
    const write = await f.calls[0].options.canUseTool('Write', { file_path: `${REPO}\\x` }, opts)
    expect(write).toEqual({ behavior: 'deny', message: 'The orchestrator only reads and proposes; it cannot do this.' })
    const read = await f.calls[0].options.canUseTool('Read', { file_path: `${REPO}\\x` }, opts)
    expect(read).toEqual({ behavior: 'allow', updatedInput: { file_path: `${REPO}\\x` } })

    const g = fakeSdk()
    const onPermission = vi.fn(async () => {
      throw new Error('store offline')
    })
    await new SdkRuntime(CLAUDE_PATH, g.sdk).start(makeOrchestratorSpec({ onPermission }))
    expect(await g.calls[0].options.canUseTool('Read', {}, opts)).toEqual({
      behavior: 'deny',
      message: 'Mainbus could not decide this permission: store offline'
    })
  })

  test('passes resume when resuming', async () => {
    const f = fakeSdk({ messages: fixture('e1-simple') })
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeOrchestratorSpec({ resumeSessionId: 'sess-9' }))
    expect(f.calls[0].options.resume).toBe('sess-9')
  })
})

// The guard reads $TEMP, $TMP and $TMPDIR in Bash commands as the scratch folder: check the agent's shell agrees.
// Claude Code's Bash tool runs Git Bash with `-c`; a login shell (`-l`) is checked too, since its profile could
// rewrite them. Git Bash may show TMPDIR as /tmp when its /tmp mount is the same folder; cygpath resolves it
// through that same mount. /tmp itself is not checked: run under another Git Bash, it is that shell's temp folder.
describe.skipIf(BASHES.length === 0)('TEMP, TMP and TMPDIR in Git Bash with the environment childEnv builds', () => {
  let scratch = ''
  beforeAll(() => {
    scratch = mkdtempSync(path.join(tmpdir(), 'scratch dir-'))
  })
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  test.each(BASHES.flatMap((bash) => [[bash, '-c'], [bash, '-l -c']]))('%s %s', async (bash, mode) => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec({ tempDir: scratch }))
    const env = f.calls[0].options.env as NodeJS.ProcessEnv
    // By full path: a non-login usr\bin\bash started outside Git Bash has no /usr/bin on PATH.
    const script = 'for v in "$TEMP" "$TMP" "$TMPDIR"; do /usr/bin/cygpath -w "$v"; done'
    const r = spawnSync(bash, [...mode.split(' '), script], { env, encoding: 'utf8', timeout: 30_000 })
    expect(r.status, r.stderr).toBe(0)
    const lines = r.stdout.trim().split(/\r?\n/)
    expect(lines).toHaveLength(3)
    const real = realpathSync.native(scratch)
    for (const line of lines) expect(path.win32.relative(real, realpathSync.native(line)), line).toBe('')
  })
})
