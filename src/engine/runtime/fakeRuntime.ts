import type { AgentEvent } from '../../shared/events'
import {
  ResumeFailedError,
  type AgentRuntime,
  type AnyRunSpec,
  type OrchestratorRunSpec,
  type OrchestratorToolHandlers,
  type PermissionRequest,
  type RoleToolHandlers,
  type RunHandle,
  type RunSpec,
  type SpawnedClaude,
  type SummaryRequest
} from './types'

/** What the fake's summarize() does: answer with a text, fail with a message, or never answer (until aborted by its timeout). */
export type FakeSummary = string | { fail: string } | { hang: true }

export const FAKE_SUMMARY = 'A summary the fake runtime wrote.'

/** One scripted step. Plain data only, so a script can be loaded from a JSON file. */
export type FakeStep =
  | { emit: AgentEvent }
  /** A role tool in a role's run, a read or propose tool in the orchestrator's. */
  | { callTool: keyof RoleToolHandlers | keyof OrchestratorToolHandlers; args: unknown }
  /**
   * Calls a read tool and keeps what the first group of `pattern` matches in its text as `as`; a later step's args
   * use it wherever a string is exactly `$as`. For ids a script can't know in advance.
   */
  | { capture: { tool: keyof OrchestratorToolHandlers; args?: unknown; pattern: string; as: string } }
  | { requestPermission: Omit<PermissionRequest, 'signal'> }
  | { waitForSend: true }
  /** Fails the script, with an error event and the run closed, unless the run's launch prompt contains this text. */
  | { expectPrompt: string }
  | { exit: number | null }

/**
 * A script as a JSON file holds it: the steps for every agent, or the steps for each role by name, with `*`
 * for any other role. A role with no script of its own and no `*` gets an empty script (its agent stays open).
 * A resumed session of a role plays `<Role> resumed` when the file has it, so a role handed a problem back,
 * or handed back to, can act differently the second time. A role's nth fresh session (not a resumed one) plays
 * `<Role> #n` when the file has it, for n of 2 or more: a role replaced by a fresh agent acts differently.
 */
export type FakeScriptFile = FakeStep[] | Record<string, FakeStep[]>

export function scriptFromFile(file: FakeScriptFile): FakeStep[] | ((spec: RunSpec) => FakeStep[]) {
  if (Array.isArray(file)) return file
  const fresh = new Map<string, number>()
  return (spec) => {
    const resumed = `${spec.role} resumed`
    if (spec.role !== undefined && spec.resumeSessionId !== undefined && Object.hasOwn(file, resumed)) return file[resumed]!
    if (spec.role !== undefined && spec.resumeSessionId === undefined) {
      const n = (fresh.get(spec.role) ?? 0) + 1
      fresh.set(spec.role, n)
      const nth = `${spec.role} #${n}`
      if (n >= 2 && Object.hasOwn(file, nth)) return file[nth]!
    }
    return spec.role !== undefined && Object.hasOwn(file, spec.role) ? file[spec.role]! : (file['*'] ?? [])
  }
}

/**
 * The orchestrator's script from a script file: its `Orchestrator` steps (`Orchestrator resumed` for a resumed
 * session, when the file has it). A file with no `Orchestrator` steps leaves it open and silent.
 */
export function orchestratorScriptFromFile(file: FakeScriptFile): (spec: OrchestratorRunSpec) => FakeStep[] {
  return (spec) => {
    if (Array.isArray(file)) return []
    if (spec.resumeSessionId !== undefined && Object.hasOwn(file, 'Orchestrator resumed')) return file['Orchestrator resumed']!
    return Object.hasOwn(file, 'Orchestrator') ? file['Orchestrator']! : []
  }
}

/** `args` with each string that is exactly `$name` replaced by what was captured as `name`. */
function fill(args: unknown, captured: Record<string, string>): unknown {
  if (typeof args === 'string') return args.startsWith('$') && Object.hasOwn(captured, args.slice(1)) ? captured[args.slice(1)] : args
  if (Array.isArray(args)) return args.map((a) => fill(a, captured))
  if (typeof args === 'object' && args !== null) return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, fill(v, captured)]))
  return args
}

/** An async queue that can be closed; the consumer side is an AsyncIterable. */
class EventQueue implements AsyncIterable<AgentEvent> {
  private readonly items: AgentEvent[] = []
  private waiting: (() => void) | null = null
  private closed = false

  push(e: AgentEvent): void {
    if (this.closed) return
    this.items.push(e)
    this.wake()
  }

  close(): void {
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const w = this.waiting
    this.waiting = null
    w?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentEvent> {
    for (;;) {
      const next = this.items.shift()
      if (next) {
        yield next
      } else if (this.closed) {
        return
      } else {
        await new Promise<void>((resolve) => (this.waiting = resolve))
      }
    }
  }
}

interface Run {
  queue: EventQueue
  abort: AbortController
  pendingSends: number
  sendWaiter: (() => void) | null
  stopped: boolean
  /** The fake `claude` process, until it has exited. */
  proc: { claude: SpawnedClaude; spec: RunSpec } | null
}

/**
 * A deterministic scripted runtime for tests. It plays a `FakeStep[]` per run:
 * `callTool` and `requestPermission` call into the `RunSpec` handlers, and `waitForSend`
 * blocks until `send()` is called (a send that arrived earlier counts). `events()` ends
 * after an `exit` step or `stop()`; a script with neither stays open like a live process.
 * `EventQueue` supports a single `events()` consumer per run.
 */
export class FakeRuntime implements AgentRuntime {
  /** Every role spec passed to start(), including ones that went on to fail. */
  readonly specs: RunSpec[] = []
  /** Every orchestrator spec passed to start(), including ones that went on to fail. */
  readonly orchestratorSpecs: OrchestratorRunSpec[] = []
  /** Every text passed to send(). */
  readonly sent: string[] = []
  /** Every handle passed to interrupt(). */
  readonly interrupted: string[] = []
  /** Every request passed to summarize(). */
  readonly summaries: SummaryRequest[] = []
  private readonly runs = new Map<string, Run>()
  private nextId = 1

  constructor(
    /** The same steps for every run, or the steps for each run by its spec. */
    private readonly script: FakeStep[] | ((spec: RunSpec) => FakeStep[]),
    private readonly opts: {
      rejectResume?: boolean
      summary?: FakeSummary
      /** The orchestrator's steps; without them it stays open and says nothing. */
      orchestrator?: FakeStep[] | ((spec: OrchestratorRunSpec) => FakeStep[])
      /** interrupt() ends the turn under way with an interrupted turn_end, as the real runtime does. */
      endTurnOnInterrupt?: boolean
      /** Gives each role run a `claude` process with the next id from this, announced through the spec's process hooks. */
      nextPid?: () => number
    } = {}
  ) {}

  async summarize(req: SummaryRequest): Promise<string> {
    this.summaries.push(req)
    const summary = this.opts.summary ?? FAKE_SUMMARY
    if (typeof summary === 'string') return summary
    if ('fail' in summary) throw new Error(summary.fail)
    // Like a hung CLI: only the timeout ends it.
    return new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`No summary within ${req.timeoutMs} ms`)), req.timeoutMs)
    )
  }

  async start(spec: AnyRunSpec): Promise<RunHandle> {
    if (spec.kind === 'orchestrator') this.orchestratorSpecs.push(spec)
    else this.specs.push(spec)
    if (this.opts.rejectResume && spec.resumeSessionId) throw new ResumeFailedError()
    const handle = { id: `fake-${this.nextId++}` }
    const run: Run = {
      queue: new EventQueue(),
      abort: new AbortController(),
      pendingSends: 0,
      sendWaiter: null,
      stopped: false,
      proc: null
    }
    this.runs.set(handle.id, run)
    if (spec.kind !== 'orchestrator' && this.opts.nextPid) {
      const claude = { pid: this.opts.nextPid(), spawnedAt: Date.now() }
      run.proc = { claude, spec }
      spec.onProcessStart?.(claude)
    }
    void this.play(spec, run)
    return handle
  }

  async send(handle: RunHandle, text: string): Promise<void> {
    const run = this.get(handle)
    this.sent.push(text)
    run.pendingSends++
    const w = run.sendWaiter
    run.sendWaiter = null
    w?.()
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.get(handle) // the script is not affected; it has no turns to cut short
    this.interrupted.push(handle.id)
    if (this.opts.endTurnOnInterrupt) run.queue.push({ kind: 'turn_end', ok: false, interrupted: true })
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.get(handle)
    run.stopped = true
    run.abort.abort()
    this.close(run)
    const w = run.sendWaiter
    run.sendWaiter = null
    w?.()
  }

  events(handle: RunHandle): AsyncIterable<AgentEvent> {
    return this.get(handle).queue
  }

  /** Ends the run's events, and its `claude` process (once). */
  private close(run: Run): void {
    run.queue.close()
    const proc = run.proc
    run.proc = null
    proc?.spec.onProcessExit?.(proc.claude)
  }

  private get(handle: RunHandle): Run {
    const run = this.runs.get(handle.id)
    if (!run) throw new Error(`Unknown run ${handle.id}`)
    return run
  }

  private steps(spec: AnyRunSpec): FakeStep[] {
    if (spec.kind === 'orchestrator') {
      const script = this.opts.orchestrator ?? []
      return typeof script === 'function' ? script(spec) : script
    }
    return typeof this.script === 'function' ? this.script(spec) : this.script
  }

  private async play(spec: AnyRunSpec, run: Run): Promise<void> {
    // Yield first so nothing fires until the caller has the handle, as with a real runtime.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const captured: Record<string, string> = {}
    try {
      for (const step of this.steps(spec)) {
        if (run.stopped) return
        if ('emit' in step) {
          run.queue.push(step.emit)
        } else if ('callTool' in step) {
          // The script file is trusted test data, so the args are passed through as-is.
          const tools: object = spec.kind === 'orchestrator' ? spec.tools : spec.roleTools
          const tool = (tools as Record<string, unknown>)[step.callTool]
          if (typeof tool !== 'function') throw new Error(`No tool ${step.callTool} in this run`)
          await (tool as (args: unknown) => Promise<string>).call(tools, fill(step.args, captured))
        } else if ('capture' in step) {
          const c = step.capture
          const tool = (spec.kind === 'orchestrator' ? (spec.tools as unknown as Record<string, unknown>) : {})[c.tool]
          if (typeof tool !== 'function') throw new Error(`No tool ${c.tool} in this run`)
          const out = await (tool as (args: unknown) => Promise<string>).call(spec.kind === 'orchestrator' ? spec.tools : {}, c.args ?? {})
          const m = new RegExp(c.pattern).exec(out)
          if (!m?.[1]) throw new Error(`capture ${c.as}: ${c.pattern} did not match the tool's text`)
          captured[c.as] = m[1]
        } else if ('requestPermission' in step) {
          await spec.onPermission({ ...step.requestPermission, signal: run.abort.signal })
        } else if ('expectPrompt' in step) {
          if (!spec.prompt.includes(step.expectPrompt)) throw new Error(`The launch prompt lacks "${step.expectPrompt}"`)
        } else if ('waitForSend' in step) {
          while (run.pendingSends === 0 && !run.stopped) {
            await new Promise<void>((resolve) => (run.sendWaiter = resolve))
          }
          if (run.stopped) return
          run.pendingSends--
        } else {
          this.close(run)
          return
        }
      }
    } catch (err) {
      run.queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      this.close(run)
    }
  }
}
