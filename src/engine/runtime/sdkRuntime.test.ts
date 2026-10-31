import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentEvent } from '../../shared/events'
import { Normalizer } from './normalize'
import { SdkRuntime, type SdkApi } from './sdkRuntime'
import { ResumeFailedError, type RoleToolHandlers, type RunSpec } from './types'

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
  opts: { messages?: unknown[]; failBeforeInit?: boolean; slowExit?: 'after-abort' | 'never' } = {}
) {
  const state = { finished: false }
  const calls: QueryCall[] = []
  const tools: ToolCall[] = []
  const servers: Record<string, any>[] = []
  const interrupt = vi.fn(async () => undefined)
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
      return Object.assign(gen, { interrupt })
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
  return { sdk: sdk as unknown as SdkApi, calls, tools, servers, interrupt, state }
}

function makeSpec(over: Partial<RunSpec> = {}): RunSpec {
  const roleTools: RoleToolHandlers = {
    askUser: vi.fn(async () => 'asked'),
    handoff: vi.fn(async () => 'handed off')
  }
  return {
    cwd: 'C:\\work\\ws\\1-fix',
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
    expect(o.allowedTools).toEqual(['mcp__mainbus__ask_user', 'mcp__mainbus__handoff'])
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
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, 40)
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
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, 1000, 50)

    const started = runtime.start(makeSpec({ resumeSessionId: 'sess-1' }))

    await expect(started).rejects.toBeInstanceOf(ResumeFailedError)
    await expect(started).rejects.toThrow(/no system\/init within 50 ms/)
    expect(f.calls[0].options.abortController.signal.aborted).toBe(true)
    expect(f.state.finished).toBe(true) // it waited for the stream to end before rejecting
  })

  test('the init timeout still rejects when the stream never ends, after the bounded stop wait', async () => {
    const f = fakeSdk({ messages: [], slowExit: 'never' })
    const runtime = new SdkRuntime(CLAUDE_PATH, f.sdk, 40, 30)
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

  test('registers the mainbus MCP server with ask_user and handoff, always loaded', async () => {
    const f = fakeSdk()
    await new SdkRuntime(CLAUDE_PATH, f.sdk).start(makeSpec())
    expect(f.servers).toHaveLength(1)
    expect(f.servers[0].name).toBe('mainbus')
    expect(f.servers[0].alwaysLoad).toBe(true)
    expect(f.tools.map((t) => t.name)).toEqual(['ask_user', 'handoff'])
    expect(Object.keys(f.tools[0].shape)).toEqual(['question', 'options', 'recommended'])
    expect(Object.keys(f.tools[1].shape)).toEqual(['summary', 'notes_for_next'])
    expect(Object.keys(f.calls[0].options.mcpServers)).toEqual(['mainbus'])
    expect(f.calls[0].options.mcpServers.mainbus.name).toBe('mainbus')
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
