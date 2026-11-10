import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import type {
  createSdkMcpServer,
  HookCallback,
  Options,
  Query,
  query,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
  tool
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { Effort } from '../../shared/domain'
import type { AgentEvent } from '../../shared/events'
import { EFFORTS, MODEL_OPTIONS } from '../../shared/models'
import { guardReason, type GuardContext } from '../permissions/guard'
import { BACKGROUND_DENIED, isBackgroundShell } from '../permissions/policy'
import { InputQueue } from './inputQueue'
import { Normalizer } from './normalize'
import {
  ResumeFailedError,
  type AgentRuntime,
  type AnyRunSpec,
  type OrchestratorRunSpec,
  type PermissionRequest,
  type PermissionVerdict,
  type PromptImage,
  type RunHandle,
  type RunSpec,
  type SummaryRequest
} from './types'

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
  'mcp__mainbus__report_waiting',
  'mcp__mainbus__check_criterion'
]
/** A role offers either handoff or submit_report, never both. */
function roleTools(endsWithReport: boolean | undefined): string[] {
  return endsWithReport
    ? ROLE_TOOLS.map((t) => (t === 'mcp__mainbus__handoff' ? 'mcp__mainbus__submit_report' : t))
    : ROLE_TOOLS
}
/**
 * The orchestrator's Mainbus tools, pre-approved like the role tools: the read tools, create_tickets, which only
 * creates tickets in a Backlog (where nothing runs), update_ticket, which only edits tickets that have no run open
 * (and has an Undo), and the propose tools, which only store a proposal for the user to decide.
 */
export const ORCHESTRATOR_MAINBUS_TOOLS = [
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
]
const PRESET_DESCRIPTION = "A preset of the workspace, by name, as list_workspaces shows: sets the ticket's run settings (which roles run, and their models)"
const MODEL_VALUES = MODEL_OPTIONS.map((o) => o.value) as [string, ...string[]]
const EFFORT_VALUES = EFFORTS as [Effort, ...Effort[]]

/** The only built-in tools the orchestrator has: it reads files and, unless the user turns it off, web pages. */
export const ORCHESTRATOR_BUILT_IN_TOOLS = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']

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

const SUMMARY_SYSTEM_PROMPT =
  'You write handoff summaries for Mainbus, from the log of an agent that was stopped before it finished. ' +
  'You have no tools. Answer with the summary only.'
/** Every built-in tool is already off (`tools: []`); these are named as well, in case a setting turns one on. */
const SUMMARY_DISALLOWED = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task']

/** A user message: the text alone, or each image as an image block followed by the text, seen in that turn. */
export function userMessage(text: string, images: PromptImage[] = []): SDKUserMessage {
  if (images.length === 0) return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }
  const content = [
    ...images.map((i) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mime, data: i.base64 } })),
    { type: 'text' as const, text }
  ]
  return { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null }
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

const ROLE_BASH_MAX_TIMEOUT_MS = '1800000'

const TEMP_ENV_VARS =new Set(['TEMP', 'TMP', 'TMPDIR'])

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

/**
 * Starts the `claude` binary as the SDK's own spawn does (same command, args, cwd, env and signal; its stderr is
 * drained, as the SDK would), and tells the run's spec when it has started and when it has exited.
 */
function spawnClaude(o: SpawnOptions, spec: RunSpec): SpawnedProcess {
  const spawnedAt = Date.now()
  const child = spawn(o.command, o.args, {
    cwd: o.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    signal: o.signal,
    env: o.env,
    windowsHide: true
  })
  child.stderr.resume()
  if (child.pid !== undefined) {
    const p = { pid: child.pid, spawnedAt }
    child.once('exit', () => {
      try {
        spec.onProcessExit?.(p)
      } catch {
        // A failing observer must not stop the agent.
      }
    })
    try {
      spec.onProcessStart?.(p)
    } catch {
      // Likewise.
    }
  }
  return child
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

  async start(spec: AnyRunSpec): Promise<RunHandle> {
    const input = new InputQueue<SDKUserMessage>()
    const abort = new AbortController()
    const options = spec.kind === 'orchestrator' ? this.orchestratorOptions(spec, abort) : this.options(spec, abort)
    const q = this.sdk.query({ prompt: input, options })
    const run: Run = {
      q,
      input,
      events: new InputQueue<AgentEvent>(),
      abort,
      normalizer: new Normalizer(Date.now, spec.resumeSessionId !== undefined ? spec.usageBaseline : undefined),
      stopped: false,
      pumped: Promise.resolve(null) // replaced just below, once pump() has started
    }
    input.push(userMessage(spec.prompt, spec.kind === 'orchestrator' ? spec.promptImages : undefined))

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

  async send(handle: RunHandle, message: string, images?: PromptImage[]): Promise<void> {
    this.get(handle).input.push(userMessage(message, images))
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

  /**
   * One turn of the user's own `claude`, with its own login (childEnv drops any API key), no tools, no MCP
   * servers and no settings files, and nothing saved as a session. Aborted after `req.timeoutMs`.
   */
  async summarize(req: SummaryRequest): Promise<string> {
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), req.timeoutMs)
    try {
      const q = this.sdk.query({
        prompt: req.prompt,
        options: {
          pathToClaudeCodeExecutable: this.claudePath,
          cwd: req.cwd,
          systemPrompt: SUMMARY_SYSTEM_PROMPT,
          tools: [],
          allowedTools: [],
          disallowedTools: SUMMARY_DISALLOWED,
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          maxTurns: 1,
          persistSession: false,
          canUseTool: async () => ({ behavior: 'deny', message: 'No tools are available here' }),
          env: childEnv(this.agentHome, req.tempDir),
          abortController
        }
      })
      let text: string | null = null
      for await (const msg of q) {
        const m = msg as { type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown }
        if (m.type !== 'result') continue
        if (req.onUsage) {
          for (const ev of new Normalizer().push(msg)) if (ev.kind === 'usage') req.onUsage(ev)
        }
        if (m.subtype !== 'success' || m.is_error === true) {
          throw new Error(`The summary failed: ${typeof m.result === 'string' && m.result ? m.result : String(m.subtype)}`)
        }
        text = typeof m.result === 'string' ? m.result.trim() : ''
      }
      if (abortController.signal.aborted) throw new Error(`No summary within ${req.timeoutMs} ms`)
      if (!text) throw new Error('The summary was empty')
      return text
    } catch (err) {
      if (abortController.signal.aborted) throw new Error(`No summary within ${req.timeoutMs} ms`)
      throw err
    } finally {
      clearTimeout(timer)
    }
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
        spec.endsWithReport
          ? sdk.tool(
              'submit_report',
              "Submit your report when your investigation is finished. It ends your part; the ticket goes to Review. Don't commit anything.",
              { markdown: z.string().describe('Your report, in markdown') },
              async (a) => toolText(await spec.roleTools.submitReport({ markdown: a.markdown }))
            )
          : sdk.tool(
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
          'report_waiting',
          'Declare a wait that is expected to be quiet, such as a long build, a slow test suite or a process you started. Until the time you give, Mainbus does not take your silence for being stuck.',
          {
            reason: z.string().describe('What you are waiting for'),
            until: z.string().describe('When the wait ends: an ISO date-time in the future, at most 2 hours from now')
          },
          async (a) => toolText(await spec.roleTools.reportWaiting({ reason: a.reason, until: a.until }))
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
      // The guard reads $TEMP and the like in shell commands as this folder, since childEnv points them here.
      scratch: spec.tempDir,
      ownBranch: spec.ownBranch
    }
    // The shell's live folder per tool call: the PreToolUse hook sees it, canUseTool (same toolUseID) passes it on.
    const cwdByToolUse = new Map<string, string>()
    const guard: HookCallback = async (hookInput) => {
      const i = hookInput as { tool_name?: unknown; tool_input?: unknown; tool_use_id?: unknown; cwd?: unknown }
      const input =
        typeof i.tool_input === 'object' && i.tool_input !== null ? (i.tool_input as Record<string, unknown>) : {}
      const cwd = typeof i.cwd === 'string' && win32.isAbsolute(i.cwd) ? i.cwd : undefined
      if (cwd !== undefined && typeof i.tool_use_id === 'string') cwdByToolUse.set(i.tool_use_id, cwd)
      const reason =
        typeof i.tool_name === 'string' ? guardReason(i.tool_name, input, { ...guardContext, ...(cwd ? { cwd } : {}) }) : null
      if (typeof i.tool_name === 'string' && isBackgroundShell(i.tool_name, input)) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: BACKGROUND_DENIED
          }
        }
      }
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
      allowedTools: roleTools(spec.endsWithReport),
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
            ...(cwdByToolUse.get(o.toolUseID) ? { cwd: cwdByToolUse.get(o.toolUseID) } : {}),
            signal: o.signal
          })
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          return { behavior: 'deny', message: `Mainbus could not decide this permission: ${why}` }
        } finally {
          cwdByToolUse.delete(o.toolUseID)
        }
        return verdict.allow
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: verdict.message }
      },
      // Lets a foreground command run for up to 30 minutes, so a full test suite fits in one call.
      env: { ...childEnv(this.agentHome, spec.tempDir), BASH_MAX_TIMEOUT_MS: ROLE_BASH_MAX_TIMEOUT_MS },
      spawnClaudeCodeProcess: (o) => spawnClaude(o, spec),
      abortController
    }
  }

  /**
   * The orchestrator reads and changes nothing but a Backlog's new tickets and the fields of tickets that haven't started:
   * only Read, Grep and Glob among the built-in tools, the Mainbus read tools, create_tickets, update_ticket and the propose tools, and no settings files. Every call it makes goes through `spec.onPermission`, which never
   * raises a card.
   */
  private orchestratorOptions(spec: OrchestratorRunSpec, abortController: AbortController): Options {
    const sdk = this.sdk
    const t = spec.tools
    const ticketNumber = z.number().int().describe('The ticket number, as in #12')
    const workspace = z.string().optional().describe('The workspace, by name or id; the focused one when left out')
    const drafts = z
      .array(
        // Strict, like the engine's own check: an intent from the agent is refused, not dropped.
        z.strictObject({
          title: z.string().describe('A short title, one line'),
          spec: z.string().optional().describe('Your draft: the approach, the files involved, the details'),
          criteria: z.array(z.string()).optional().describe('Acceptance criteria, one per item'),
          labels: z.array(z.string()).optional().describe('Labels, one word or short phrase each'),
          blocked_by: z
            .array(z.union([z.number().int(), z.strictObject({ draft: z.number().int() })]))
            .optional()
            .describe('What must be Done before this ticket starts: ticket numbers in the workspace, or { draft: i }, the 0-based index of an earlier ticket in this same call'),
          kind: z
            .enum(['change', 'investigate'])
            .optional()
            .describe('change (the default) to change code, or investigate to look into something and write up a report without changing code'),
          images: z
            .array(z.string())
            .optional()
            .describe("Images to attach to the ticket, by name: only ones the user sent with the request's messages, as Mainbus listed them"),
          preset: z.string().optional().describe(PRESET_DESCRIPTION)
        })
      )
      .describe('The tickets, in the order to create them')
    const requestMessagesBack = z
      .number()
      .int()
      .optional()
      .describe(
        "Which of the user's messages was the request: 0 (the default) is this turn's, 1 the one before, up to 5. The intent is that message and every later one, verbatim"
      )
    const context = z
      .string()
      .optional()
      .describe(
        'A plain summary of the conversation that led to the request (what the user asked, what you found, what was agreed), up to 4,000 characters. Mainbus adds it to each ticket as written by you, not the user'
      )
    const server = sdk.createSdkMcpServer({
      name: 'mainbus',
      alwaysLoad: true,
      tools: [
        sdk.tool('list_workspaces', 'Every workspace: name, id, repo path, base branch, how many tickets need the user, and which one is focused.', {}, async () =>
          toolText(await t.listWorkspaces())
        ),
        sdk.tool(
          'list_tickets',
          "A workspace's tickets: number, title, column, phase, active role and labels.",
          {
            workspace,
            column: z
              .enum(['backlog', 'ready', 'in_progress', 'needs_you', 'review', 'done'])
              .optional()
              .describe('Only the tickets in this column')
          },
          async (a) => toolText(await t.listTickets({ ...(a.workspace !== undefined ? { workspace: a.workspace } : {}), ...(a.column !== undefined ? { column: a.column } : {}) }))
        ),
        sdk.tool(
          'get_ticket',
          "One ticket: the user's words, spec, criteria, labels, pull request, and the latest run's roles.",
          { number: ticketNumber, workspace },
          async (a) => toolText(await t.getTicket({ number: a.number, ...(a.workspace !== undefined ? { workspace: a.workspace } : {}) }))
        ),
        sdk.tool(
          'get_run_status',
          "The latest run of a ticket: its roles in order with status, model and effort, the active role, and pending decisions.",
          { number: ticketNumber, workspace },
          async (a) => toolText(await t.getRunStatus({ number: a.number, ...(a.workspace !== undefined ? { workspace: a.workspace } : {}) }))
        ),
        sdk.tool(
          'get_recent_events',
          "The last events of a ticket's thread, oldest first.",
          {
            number: ticketNumber,
            workspace,
            limit: z.number().int().optional().describe('How many events, 20 by default, at most 50')
          },
          async (a) => toolText(await t.getRecentEvents({ number: a.number, ...(a.workspace !== undefined ? { workspace: a.workspace } : {}), ...(a.limit !== undefined ? { limit: a.limit } : {}) }))
        ),
        sdk.tool(
          'get_time_report',
          "Where time went, from the events Mainbus stored: waiting on the user (permissions, questions), paused, queued, setup, tests, builds, installs, git, reading, editing, web, the model, and gaps. With a ticket number: that ticket's time per run and role, its time to Review and its longest commands. Without one: the workspace's last tickets that reached Review, with totals, averages per category and per role, the median time to Review and the longest commands.",
          {
            workspace,
            ticket: z.number().int().optional().describe('A ticket number, as in #12; leave out for the workspace report'),
            last: z.number().int().optional().describe('For the workspace report, how many tickets that reached Review: 10 by default, at most 50')
          },
          async (a) =>
            toolText(
              await t.getTimeReport({
                ...(a.workspace !== undefined ? { workspace: a.workspace } : {}),
                ...(a.ticket !== undefined ? { ticket: a.ticket } : {}),
                ...(a.last !== undefined ? { last: a.last } : {})
              })
            )
        ),
        sdk.tool('list_pending_decisions', "Every decision waiting for the user in a workspace, with its ticket.", { workspace }, async (a) =>
          toolText(await t.listPendingDecisions(a.workspace !== undefined ? { workspace: a.workspace } : {}))
        ),
        sdk.tool(
          'create_tickets',
          "Create new tickets in a workspace's Backlog now, with no card. Each ticket's intent is the user's request, filled in by Mainbus: put your own drafting in the spec. Then tell the user which workspace they went into.",
          {
            workspace: z
              .string()
              .optional()
              .describe('The workspace to create them in, by name or id. Required when more than one workspace is open; there is no default to the focused one'),
            tickets: drafts,
            request_messages_back: requestMessagesBack,
            context
          },
          // The engine validates it again, strictly: the SDK passes what the agent sent.
          async (a) => toolText(await t.createTickets(a))
        ),
        sdk.tool(
          'update_ticket',
          "Edit a ticket that hasn't started, now, with no card, when the user asks to change it. Give only the fields to change: title, spec, criteria (the full new list; a ticked criterion stays ticked only if its text is unchanged), labels and blocked_by (the full new list of ticket numbers that must be Done first). The user's own words can't be written or changed: with add_user_words true, Mainbus appends the user's message (and any later ones up to this turn's, per request_messages_back) verbatim. A ticket with a run open, or Done, is refused: tell the user to stop the run first, or to let it finish. Then tell the user what changed.",
          {
            workspace: z
              .string()
              .optional()
              .describe("The ticket's workspace, by name or id. Required when more than one workspace is open; there is no default to the focused one"),
            ticket: z.number().int().describe('The ticket number'),
            title: z.string().optional().describe('The new title: one line'),
            spec: z.string().optional().describe('The new spec, replacing the old one'),
            criteria: z.array(z.string()).optional().describe('The full new list of acceptance criteria, replacing the old one'),
            labels: z.array(z.string()).optional().describe('The full new list of labels, replacing the old one'),
            blocked_by: z.array(z.number().int()).optional().describe('The full new list of blockers, as ticket numbers in the workspace, replacing the old one; [] clears it'),
            preset: z.string().optional().describe(PRESET_DESCRIPTION + " (replaces the ticket's saved run settings)"),
            add_user_words: z
              .boolean()
              .optional()
              .describe("true: append the user's own message to the ticket's words, verbatim. You cannot supply the text"),
            request_messages_back: requestMessagesBack
          },
          // The engine validates it again, strictly: the SDK passes what the agent sent.
          async (a) => toolText(await t.updateTicket(a))
        ),
        sdk.tool(
          'propose_create_tickets',
          "Propose new tickets. The user confirms, changes or rejects them; Mainbus creates them only then. Each ticket's intent is the user's request, filled in by Mainbus: put your own drafting in the spec. Then end your turn.",
          {
            workspace: z.string().optional().describe('The workspace to create them in, by name or id; the focused one when left out'),
            tickets: drafts,
            request_messages_back: requestMessagesBack,
            context,
            column: z.enum(['backlog', 'ready']).optional().describe('Where they land: backlog (the default) or ready'),
            evidence: z.string().optional().describe('What you read that led to this proposal, shown to the user')
          },
          // The engine validates it again, strictly: the SDK passes what the agent sent.
          async (a) => toolText(await t.proposeCreateTickets(a))
        ),
        sdk.tool(
          'propose_start',
          "Propose starting a Backlog or Ready ticket that is not running, with some or all of the lineup's roles and a model and effort for each. The user confirms, changes or rejects it; Mainbus starts it only then. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            roles: z
              .array(
                z.strictObject({
                  role: z.string().describe('A role name in the lineup, as get_ticket shows it'),
                  model: z.enum(MODEL_VALUES).optional().describe('The model; left out, Mainbus picks'),
                  effort: z.enum(EFFORT_VALUES).optional().describe('The effort; left out, Mainbus picks')
                })
              )
              .optional()
              .describe('The roles to run; left out, the whole lineup. They run in lineup order'),
            extraInstructions: z.string().optional().describe('Instructions for every role in this run, shown to the user'),
            preset: z
              .string()
              .optional()
              .describe(PRESET_DESCRIPTION + '. It shapes this start only and is not saved on the ticket; not with roles or extraInstructions, nor when the ticket has saved run settings'),
            reason: z.string().optional().describe('Why to start it now, shown to the user')
          },
          // The engine validates it again, against the board: the SDK passes what the agent sent.
          async (a) => toolText(await t.proposeStart(a))
        ),
        sdk.tool(
          'propose_pause',
          "Propose pausing the working role of a ticket; Resume continues it. The user confirms or rejects it; Mainbus pauses only then. Check get_run_status first. Then end your turn.",
          { ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"), reason: z.string().describe('Why to pause it, shown to the user') },
          async (a) => toolText(await t.proposePause(a))
        ),
        sdk.tool(
          'propose_stop',
          "Propose stopping a ticket's run; the ticket goes back to Ready. The user confirms or rejects it; Mainbus stops it only then. Check get_run_status first. Then end your turn.",
          { ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"), reason: z.string().describe('Why to stop it, shown to the user') },
          async (a) => toolText(await t.proposeStop(a))
        ),
        sdk.tool(
          'propose_skip',
          "Propose skipping a ticket's active role: it ends with a summary of its work so far and the next role starts (or the ticket goes to Review). The user confirms or rejects it; Mainbus skips only then. Check get_run_status first. Then end your turn.",
          { ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"), reason: z.string().describe('Why to skip it, shown to the user') },
          async (a) => toolText(await t.proposeSkip(a))
        ),
        sdk.tool(
          'propose_hold',
          "Propose holding a ticket, so that unattended mode and start proposals leave it alone, until a date or until the user releases it. Holding doesn't stop a running agent. The user confirms, changes the date or rejects it; Mainbus holds only then. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            until: z.string().optional().describe('When the hold ends, as an ISO date-time in the future; leave out to hold until the user releases it'),
            reason: z.string().describe('Why to hold it, shown to the user')
          },
          async (a) => toolText(await t.proposeHold(a))
        ),
        sdk.tool(
          'propose_answer',
          "Recommend an answer to a decision an agent is waiting on (list_pending_decisions shows its id). The user confirms, overrides or rejects it; the agent is answered only then. When the answer needs the user's own judgement, give a judgement: the user then chooses an option themselves. Then end your turn.",
          {
            decision: z.string().describe('The decision id from list_pending_decisions'),
            choice: z
              .union([z.number().int(), z.enum(['allow_once', 'always_allow', 'deny'])])
              .optional()
              .describe("A question's option number as list_pending_decisions numbers them (the first is 1), or a permission request's choice. Required unless you give a judgement"),
            note: z.string().optional().describe('A note sent to the agent with the answer'),
            reasoning: z.string().describe("Why this answer, shown to the user; cite the user's own words or earlier decisions it follows from"),
            judgement: z
              .strictObject({
                reason: z.enum(['widens_intent', 'open_question', 'recurring_theme', 'destructive']),
                requirement: z.string().describe("The user's original requirement"),
                proposed: z.string().describe('What the agent proposes'),
                smallest_option: z.string().describe('The smallest option that stays within the intent'),
                consequences: z.array(z.strictObject({ option: z.string(), consequence: z.string() })).describe('The consequence of each option'),
                recommendation: z.string().describe('What you recommend, and why')
              })
              .optional()
              .describe("Give it when the decision needs the user's own judgement; the card then never pre-selects an option")
          },
          async (a) => toolText(await t.proposeAnswer(a))
        ),
        sdk.tool(
          'propose_redirect',
          "Propose interrupting a stuck agent with one corrective message. Only for a ticket whose agent has an open stuck episode (get_run_status shows it), and once per episode. The user confirms, edits the message or rejects it; the agent is interrupted only then, and gets the message as its next one. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            message: z.string().describe('The one corrective message for the agent, concrete and drawn from the evidence'),
            evidence: z.string().describe('What you read that shows why this will help, shown to the user')
          },
          async (a) => toolText(await t.proposeRedirect(a))
        ),
        sdk.tool(
          'propose_replace',
          "Propose replacing a stuck agent with a fresh one of the same role, which starts from a summary of what the first did. Only for a ticket whose agent's open stuck episode was already redirected and has fired again (get_run_status shows it); it is refused otherwise. The user keeps the current agent, overrides the new one's model, effort and extra instructions, or confirms; nothing changes until then. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            reason: z.string().describe('Why a replacement will do better than the agent so far, shown to the user'),
            evidence: z.string().describe('What you read that shows the redirect did not help, shown to the user')
          },
          async (a) => toolText(await t.proposeReplace(a))
        ),
        sdk.tool(
          'propose_promote',
          "Propose promoting an Investigate ticket's report into a Change ticket: a new Change ticket in Ready that carries the report, with the original's intent, while the Investigate ticket moves to Done. Only for an Investigate ticket in Review or Done that has a report (get_ticket shows it); it is refused otherwise. Leave the title and spec out to use the ticket's title and a spec drafted from the report. The user confirms, edits the title and spec, or rejects it; nothing changes until then. Then end your turn.",
          {
            ticket: z.number().int().describe('The Investigate ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            title: z.string().optional().describe("The new Change ticket's title; the Investigate ticket's by default"),
            spec: z.string().optional().describe("The new ticket's spec: what to change and how to verify it, using only what the report says; drafted from the report by default")
          },
          async (a) => toolText(await t.proposePromote(a))
        ),
        sdk.tool(
          'propose_update_from_main',
          "Propose updating a ticket's branch from main: an Implementer-only run merges the newest base into the branch, resolves conflicts, runs the type check and related tests, and commits; the pull request is updated when it hands off. Only for a Change ticket that is behind main (list_tickets and get_ticket show it) and has no role working; a paused or waiting role's run is ended first. Suggest it when a ticket in Review conflicts with main. The user confirms or rejects it; nothing changes until then. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            reason: z.string().describe('Why the branch should be updated now, shown to the user')
          },
          async (a) => toolText(await t.proposeUpdateFromMain(a))
        ),
        sdk.tool(
          'propose_merge',
          "Propose merging a ticket that is in Review: through its pull request on GitHub with the workspace's merge method, or, with no remote or no pull request, into the local base branch (only when the user's checkout is clean and on the base, or the base isn't checked out, and nothing conflicts). Then the ticket moves to Done. The card tells the user exactly what will happen. Never merge on your own: the user confirms or rejects it, and nothing changes until then. Then end your turn.",
          {
            ticket: z.number().int().describe('The ticket number'),
            workspace: z.string().optional().describe("The ticket's workspace, by name or id; the focused one when left out"),
            reason: z.string().describe('Why the ticket is ready to merge, shown to the user')
          },
          async (a) => toolText(await t.proposeMerge(a))
        )
      ]
    })

    const decide = async (req: PermissionRequest): Promise<PermissionVerdict> => {
      try {
        return await spec.onPermission(req)
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err)
        return { allow: false, message: `Mainbus could not decide this permission: ${why}` }
      }
    }
    // Default mode lets Read, Grep and Glob inside cwd and the extra folders run without reaching canUseTool,
    // so the same policy runs here first: a credential file inside the repo is denied, never asked about.
    const policy: HookCallback = async (hookInput, toolUseId, o) => {
      const i = hookInput as { tool_name?: unknown; tool_input?: unknown }
      const input =
        typeof i.tool_input === 'object' && i.tool_input !== null ? (i.tool_input as Record<string, unknown>) : {}
      const toolName = typeof i.tool_name === 'string' ? i.tool_name : ''
      const verdict = await decide({ toolName, input, toolUseId: toolUseId ?? '', signal: o.signal })
      if (verdict.allow) return {}
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.message
        }
      }
    }

    return {
      pathToClaudeCodeExecutable: this.claudePath,
      cwd: spec.cwd,
      model: spec.model,
      effort: spec.effort,
      ...(spec.resumeSessionId !== undefined ? { resume: spec.resumeSessionId } : {}),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt },
      tools: ORCHESTRATOR_BUILT_IN_TOOLS,
      permissionMode: 'default',
      // No settings files at all: its folder has none, and the user's own settings must not apply.
      settingSources: [],
      strictMcpConfig: true,
      includePartialMessages: true,
      disallowedTools: [...spec.disallowedTools],
      allowedTools: ORCHESTRATOR_MAINBUS_TOOLS,
      additionalDirectories: spec.additionalDirectories,
      mcpServers: { mainbus: server },
      hooks: { PreToolUse: [{ hooks: [policy] }] },
      canUseTool: async (toolName, input, o) => {
        const verdict = await decide({
          toolName,
          input,
          reason: o.decisionReason,
          toolUseId: o.toolUseID,
          signal: o.signal
        })
        return verdict.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: verdict.message }
      },
      // It has no shell, so its temp folder is never used; its own folder stands in.
      env: childEnv(this.agentHome, spec.cwd),
      abortController
    }
  }
}
