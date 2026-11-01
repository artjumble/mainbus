import { randomUUID } from 'node:crypto'
import type {
  createSdkMcpServer,
  HookCallback,
  Options,
  Query,
  query,
  SDKUserMessage,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { AgentEvent } from '../../shared/events'
import { guardReason, type GuardContext } from '../permissions/guard'
import { InputQueue } from './inputQueue'
import { Normalizer } from './normalize'
import { ResumeFailedError, type AgentRuntime, type RunHandle, type RunSpec } from './types'

/** The parts of the Agent SDK that the runtime uses; tests pass a fake. */
export interface SdkApi {
  query: typeof query
  createSdkMcpServer: typeof createSdkMcpServer
  tool: typeof tool
}

const READ_ONLY_DISALLOWED = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
/** Mainbus's own role tools: outside auto mode they would otherwise raise a permission card per call. */
const ROLE_TOOLS = [
  'mcp__mainbus__ask_user',
  'mcp__mainbus__handoff',
  'mcp__mainbus__report_problem',
  'mcp__mainbus__check_criterion'
]

interface Run {
  q: Query
  input: InputQueue<SDKUserMessage>
  events: InputQueue<AgentEvent>
  abort: AbortController
  normalizer: Normalizer
  stopped: boolean
  /** Settles when the query's message stream has ended (the child process is gone). */
  pumped: Promise<Error | null>
}

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
}

// Anything that would send the binary to a different credential or endpoint than its own login.
const AUTH_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY'
])

const TEMP_ENV_VARS = new Set(['TEMP', 'TMP', 'TMPDIR'])

/**
 * The agent's environment: ours, minus credential and endpoint overrides, so the binary uses its own
 * subscription login. MAINBUS_AGENT marks the agent's process tree; the stable-build scripts refuse to
 * run under it, so an agent can't replace the user's stable build. MAINBUS_AGENT_HOME names the data
 * home of the app running the agent; the `mainbus` CLI refuses to file tickets there. TEMP, TMP and TMPDIR
 * name the ticket's scratch folder; ours are dropped in every spelling, since Windows names are case-insensitive.
 */
function childEnv(agentHome: string | null, tempDir: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(process.env)) {
    const key = k.toUpperCase()
    if (!AUTH_ENV_VARS.has(key) && key !== 'MAINBUS_AGENT_HOME' && !TEMP_ENV_VARS.has(key)) env[k] = v
  }
  env.MAINBUS_AGENT = '1'
  if (agentHome !== null) env.MAINBUS_AGENT_HOME = agentHome
  env.TEMP = env.TMP = env.TMPDIR = tempDir
  return env
}

function toolText(result: string) {
  return { content: [{ type: 'text' as const, text: result }] }
}

/**
 * Runs agents through the Claude Agent SDK, driving the user's own `claude` binary.
 * One long-lived streaming `query()` per run; `send()` pushes more user messages into it.
 */
export class SdkRuntime implements AgentRuntime {
  private readonly runs = new Map<string, Run>()

  /** How long stop() waits for the child process to finish before giving up. */
  private readonly stopTimeoutMs: number
  /** How long a resume waits for the CLI's `system/init` before it counts as failed. */
  private readonly resumeInitTimeoutMs: number
  /** The data home of the app running the agents, passed to them as MAINBUS_AGENT_HOME. */
  private readonly agentHome: string | null

  constructor(
    private readonly claudePath: string,
    private readonly sdk: SdkApi,
    options: { stopTimeoutMs?: number; resumeInitTimeoutMs?: number; agentHome?: string } = {}
  ) {
    this.stopTimeoutMs = options.stopTimeoutMs ?? 7000
    this.resumeInitTimeoutMs = options.resumeInitTimeoutMs ?? 60_000
    this.agentHome = options.agentHome ?? null
  }

  async start(spec: RunSpec): Promise<RunHandle> {
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    const q = this.sdk.query({ prompt: input, options: this.options(spec, abort) })
    const run: Run = {
      q,
      input,
      events: new InputQueue<AgentEvent>(),
      abort,
      normalizer: new Normalizer(),
      stopped: false,
      pumped: Promise.resolve(null) // replaced just below, once pump() has started
    }
    input.push(userMessage(spec.prompt))

    if (spec.resumeSessionId === undefined) {
      run.pumped = this.pump(run)
      return this.register(run)
    }

    // Resuming: nothing is known to work until the CLI reports `system/init`.
    let initSeen: () => void = () => {}
    const init = new Promise<void>((resolve) => (initSeen = resolve))
    run.pumped = this.pump(run, initSeen)
    let timer: NodeJS.Timeout | undefined
    const timedOut = new Promise<Error>(
      (resolve) =>
        (timer = setTimeout(
          () => resolve(new Error(`no system/init within ${this.resumeInitTimeoutMs} ms`)),
          this.resumeInitTimeoutMs
        ))
    )
    const failure = await Promise.race([init.then(() => null), run.pumped, timedOut])
    clearTimeout(timer)
    if (failure !== null) {
      this.shutdown(run)
      // A hung CLI must not outlive the failed start.
      await this.waitForExit(run)
      throw new ResumeFailedError(`Could not resume the previous session: ${failure.message}`)
    }
    return this.register(run)
  }

  async send(handle: RunHandle, message: string): Promise<void> {
    this.get(handle).input.push(userMessage(message))
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.get(handle)
    run.normalizer.expectInterrupt()
    await run.q.interrupt()
  }

  /** Resolves once the child process has finished, or after the stop timeout. Stopping twice is harmless. */
  async stop(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.id)
    if (!run) return
    this.runs.delete(handle.id)
    this.shutdown(run)
    await this.waitForExit(run)
  }

  /** Waits for the run's stream to end (the child process is gone), but no longer than the stop timeout. */
  private async waitForExit(run: Run): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const gaveUp = new Promise<void>((resolve) => (timer = setTimeout(resolve, this.stopTimeoutMs)))
    await Promise.race([run.pumped, gaveUp])
    clearTimeout(timer)
  }

  events(handle: RunHandle): AsyncIterable<AgentEvent> {
    return this.get(handle).events
  }

  private register(run: Run): RunHandle {
    const handle = { id: randomUUID() }
    this.runs.set(handle.id, run)
    return handle
  }

  private get(handle: RunHandle): Run {
    const run = this.runs.get(handle.id)
    if (!run) throw new Error(`Unknown run ${handle.id}`)
    return run
  }

  private shutdown(run: Run): void {
    run.stopped = true
    run.normalizer.expectInterrupt()
    run.input.end()
    run.abort.abort()
  }

  /**
   * Feeds the query's messages through the normalizer into the run's event queue, then closes it.
   * Never rejects. It resolves with the error that ended the stream, or, when `onInit` is given and
   * the stream ended without a `system/init`, with an error saying so; otherwise with null.
   */
  private async pump(run: Run, onInit?: () => void): Promise<Error | null> {
    let sawInit = false
    let failure: Error | null = null
    try {
      for await (const msg of run.q) {
        const m = msg as { type?: unknown; subtype?: unknown }
        if (m.type === 'system' && m.subtype === 'init' && !sawInit) {
          sawInit = true
          onInit?.()
        }
        for (const e of run.normalizer.push(msg)) run.events.push(e)
      }
    } catch (err) {
      if (!run.stopped) {
        failure = err instanceof Error ? err : new Error(String(err))
        run.events.push({ kind: 'error', message: failure.message })
      }
    } finally {
      run.events.end()
    }
    if (failure) return failure
    return onInit && !sawInit ? new Error('the session ended before it started') : null
  }

  private options(spec: RunSpec, abortController: AbortController): Options {
    const sdk = this.sdk
    const server = sdk.createSdkMcpServer({
      name: 'mainbus',
      // M0 E4: otherwise the agent spends a step on ToolSearch to load these tools.
      alwaysLoad: true,
      tools: [
        sdk.tool(
          'ask_user',
          'Ask the user a question and wait for the answer. Call it, then end your turn.',
          {
            question: z.string().describe('The question, in plain words'),
            options: z.array(z.string()).describe('The choices on offer'),
            recommended: z.number().int().optional().describe('Zero-based index of the option you recommend')
          },
          async (a) => {
            const answer = await spec.roleTools.askUser({
              question: a.question,
              options: a.options,
              ...(a.recommended !== undefined ? { recommended: a.recommended } : {})
            })
            return toolText(answer)
          }
        ),
        sdk.tool(
          'handoff',
          'Hand the ticket on when your part is finished. Commit all work first.',
          {
            summary: z.string().describe('What you did and what you verified'),
            notes_for_next: z.string().describe('What the next role needs to know')
          },
          async (a) => toolText(await spec.roleTools.handoff({ summary: a.summary, notesForNext: a.notes_for_next }))
        ),
        sdk.tool(
          'report_problem',
          'Report a problem that stops you, such as one an earlier role must fix. Call it, then end your turn.',
          {
            details: z.string().describe('What is wrong and what needs to change')
          },
          async (a) => toolText(await spec.roleTools.reportProblem({ details: a.details }))
        ),
        sdk.tool(
          'check_criterion',
          "Tick one of the ticket's acceptance criteria once you have verified it.",
          {
            index: z.number().int().describe('Zero-based index of the criterion, as numbered in your instructions')
          },
          async (a) => toolText(await spec.roleTools.checkCriterion({ index: a.index }))
        )
      ]
    })

    const guardContext: GuardContext = {
      worktree: spec.cwd,
      additionalDirectories: spec.additionalDirectories,
      ownBranch: spec.ownBranch
    }
    const guard: HookCallback = async (hookInput) => {
      const i = hookInput as { tool_name?: unknown; tool_input?: unknown }
      const input =
        typeof i.tool_input === 'object' && i.tool_input !== null ? (i.tool_input as Record<string, unknown>) : {}
      const reason = typeof i.tool_name === 'string' ? guardReason(i.tool_name, input, guardContext) : null
      if (reason === null) return {}
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: reason.message
        }
      }
    }

    const disallowedTools =
      spec.toolProfile === 'read_only'
        ? [...new Set([...spec.disallowedTools, ...READ_ONLY_DISALLOWED])]
        : [...spec.disallowedTools]

    return {
      pathToClaudeCodeExecutable: this.claudePath,
      cwd: spec.cwd,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      ...(spec.resumeSessionId !== undefined ? { resume: spec.resumeSessionId } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt },
      // Edits and simple file commands inside cwd and additionalDirectories run without asking;
      // every other non-read-only call reaches canUseTool, so the allow list decides, not a classifier.
      permissionMode: 'acceptEdits',
      // Skips the user's global and managed settings files. The live test logs what system/init
      // still reports (plugins, MCP servers, skills) so the remainder is visible.
      settingSources: ['project', 'local'],
      // Only the mainbus server above: no user, plugin, project or claude.ai MCP servers.
      strictMcpConfig: true,
      includePartialMessages: true,
      disallowedTools,
      allowedTools: ROLE_TOOLS,
      additionalDirectories: spec.additionalDirectories,
      mcpServers: { mainbus: server },
      hooks: { PreToolUse: [{ hooks: [guard] }] },
      // Never returns updatedPermissions: that would write .claude/settings.local.json into the worktree.
      canUseTool: async (toolName, input, o) => {
        let verdict
        try {
          verdict = await spec.onPermission({
            toolName,
            input,
            reason: o.decisionReason,
            toolUseId: o.toolUseID,
            signal: o.signal
          })
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          return { behavior: 'deny', message: `Mainbus could not decide this permission: ${why}` }
        }
        return verdict.allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: verdict.message }
      },
      env: childEnv(this.agentHome, spec.tempDir),
      abortController
    }
  }
}
