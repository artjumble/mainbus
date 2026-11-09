import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Effort } from '../../shared/domain'
import type { AgentEvent, UsageEvent } from '../../shared/events'
import {
  ResumeFailedError,
  type AgentRuntime,
  type AnyRunSpec,
  type OrchestratorRunSpec,
  type OrchestratorToolHandlers,
  type PermissionRequest,
  type PromptImage,
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
   * use it wherever a string is exactly `$as`. For ids a script can't know in advance. With `fromMessage` instead of
   * `tool`, the pattern is matched in the user message the script has reached (its header included).
   */
  | { capture: { tool: keyof OrchestratorToolHandlers; args?: unknown; pattern: string; as: string } }
  | { capture: { fromMessage: true; pattern: string; as: string } }
  | { requestPermission: Omit<PermissionRequest, 'signal'> }
  | { waitForSend: true }
  /** Fails the script, with an error event and the run closed, unless the run's launch prompt contains this text. */
  | { expectPrompt: string }
  /** Fails the script, with an error event and the run closed, unless the run's system prompt (its role instructions and context) contains this text. */
  | { expectSystemPrompt: string }
  /**
   * Fails the script, with an error event and the run closed, unless this file exists in the run's folder (a path
   * relative to it) when the step is reached: put it first to prove something happened before the run's first event.
   */
  | { expectFile: string }
  /** Fails the script, with an error event and the run closed, unless the run was launched with this model and effort. */
  | { expectModel: { model: string; effort: Effort } }
  /**
   * Reads a file whose path is the first group of a pattern, matched in the run's system prompt (`fromPrompt`) or in
   * the last message sent to it (`fromMessage`), as the Read tool would: inside the run's folder or an additional
   * directory it runs without reaching onPermission, as with the real runtime; anywhere else it asks first. Emits the
   * tool call and its result; fails the script when nothing matches or the file can't be read.
   */
  | { readFile: { fromPrompt?: string; fromMessage?: string } }
  /**
   * Fails the script unless the user message it has reached (its launch prompt, or the one the last waitForSend waited
   * for) carried this many images, and its text contains each of `named`. Emits a message saying what it saw.
   */
  | { expectImages: { count: number; named?: string[] } }
  /** Writes a file in the run's folder (a path inside it), as an agent editing would; the folder's parents are made. */
  | { writeFile: { path: string; content: string } }
  /**
   * Runs real git in the run's folder, with a test identity, as an agent's shell would. A non-zero exit fails the script,
   * with an error event and the run closed, unless `allowFail` (a merge that stops on conflicts, say).
   */
  | { git: string[]; allowFail?: boolean }
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

/** True when `file` is inside the folder `dir` (ignoring case on Windows). */
function within(dir: string, file: string): boolean {
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const rel = path.relative(fold(path.resolve(dir)), fold(path.resolve(file)))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
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
  /** The last text sent to the run. */
  lastSent: string | null
  /** Every user message the run got, with its images: its launch prompt, then each one sent. */
  received: { text: string; images: PromptImage[] }[]
  /** The one the script has reached: each waitForSend moves on to the next. */
  reached: number
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
  /** The images passed with each send(), in the same order as `sent`. */
  readonly sentImages: PromptImage[][] = []
  /** Every handle passed to interrupt(). */
  readonly interrupted: string[] = []
  /** Every request passed to summarize(). */
  readonly summaries: SummaryRequest[] = []
  private readonly runs = new Map<string, Run>()
  private nextId = 1
  private startWaiters: { count: number; resolve: () => void }[] = []

  /** Resolves once start() has been called for `n` role runs in all (at once if it already has): a test's event to await instead of polling `specs`. */
  started(n = 1): Promise<void> {
    if (this.specs.length >= n) return Promise.resolve()
    return new Promise((resolve) => this.startWaiters.push({ count: n, resolve }))
  }

  constructor(
    /** The same steps for every run, or the steps for each run by its spec. */
    private readonly script: FakeStep[] | ((spec: RunSpec) => FakeStep[]),
    private readonly opts: {
      rejectResume?: boolean
      summary?: FakeSummary
      /** What summarize() reports as its usage through `onUsage`. */
      summaryUsage?: Omit<UsageEvent, 'call'>
      /** The orchestrator's steps; without them it stays open and says nothing. */
      orchestrator?: FakeStep[] | ((spec: OrchestratorRunSpec) => FakeStep[])
      /** interrupt() ends the turn under way with an interrupted turn_end, as the real runtime does. */
      endTurnOnInterrupt?: boolean
      /** Gives each role run a `claude` process with the next id from this, announced through the spec's process hooks. */
      nextPid?: () => number
      /**
       * A JSON file of the session ids this runtime has handed out, kept across processes: resuming an id that is in it
       * works, one that isn't fails like a lost session. Without it every id resumes.
       */
      sessionsFile?: string
    } = {}
  ) {}

  async summarize(req: SummaryRequest): Promise<string> {
    this.summaries.push(req)
    if (this.opts.summaryUsage) req.onUsage?.(this.opts.summaryUsage)
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
    else {
      this.specs.push(spec)
      for (const waiter of this.startWaiters.filter((w) => this.specs.length >= w.count)) waiter.resolve()
      this.startWaiters = this.startWaiters.filter((w) => this.specs.length < w.count)
    }
    if (this.opts.rejectResume && spec.resumeSessionId) throw new ResumeFailedError()
    if (spec.resumeSessionId && this.opts.sessionsFile && !this.knownSessions().includes(spec.resumeSessionId)) throw new ResumeFailedError()
    const handle = { id: `fake-${this.nextId++}` }
    const run: Run = {
      queue: new EventQueue(),
      abort: new AbortController(),
      pendingSends: 0,
      lastSent: null,
      received: [{ text: spec.prompt, images: spec.kind === 'orchestrator' ? (spec.promptImages ?? []) : [] }],
      reached: 0,
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

  async send(handle: RunHandle, text: string, images: PromptImage[] = []): Promise<void> {
    const run = this.get(handle)
    this.sent.push(text)
    this.sentImages.push(images)
    run.lastSent = text
    run.received.push({ text, images })
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

  private knownSessions(): string[] {
    try {
      return JSON.parse(fs.readFileSync(this.opts.sessionsFile!, 'utf8')) as string[]
    } catch {
      return []
    }
  }

  private rememberSession(id: string): void {
    if (!this.opts.sessionsFile) return
    const known = this.knownSessions()
    if (!known.includes(id)) fs.writeFileSync(this.opts.sessionsFile, JSON.stringify([...known, id]))
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

  /** The `readFile` step: see FakeStep. */
  private async readFile(spec: AnyRunSpec, run: Run, from: { fromPrompt?: string; fromMessage?: string }, n: number): Promise<void> {
    const [pattern, text] = from.fromPrompt !== undefined ? [from.fromPrompt, spec.appendSystemPrompt] : [from.fromMessage ?? '', run.lastSent ?? '']
    const file = new RegExp(pattern).exec(text)?.[1]
    if (!file) throw new Error(`readFile: ${pattern} matched no path`)
    const id = `read-${n}`
    const input = { file_path: file }
    run.queue.push({ kind: 'tool_call', id, name: 'Read', input })
    const inside = [spec.cwd, ...spec.additionalDirectories].some((dir) => within(dir, file))
    if (!inside) {
      const verdict = await spec.onPermission({ toolName: 'Read', input, toolUseId: id, signal: run.abort.signal })
      if (!verdict.allow) {
        run.queue.push({ kind: 'tool_result', id, ok: false, summary: verdict.message })
        return
      }
    }
    const bytes = fs.readFileSync(file).length
    run.queue.push({ kind: 'tool_result', id, ok: true, summary: `Read ${bytes} bytes` })
  }

  private async play(spec: AnyRunSpec, run: Run): Promise<void> {
    // Yield first so nothing fires until the caller has the handle, as with a real runtime.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const captured: Record<string, string> = {}
    let reads = 0
    try {
      for (const step of this.steps(spec)) {
        if (run.stopped) return
        if ('emit' in step) {
          if (step.emit.kind === 'session') this.rememberSession(step.emit.sessionId)
          run.queue.push(step.emit)
        } else if ('callTool' in step) {
          // The script file is trusted test data, so the args are passed through as-is.
          const tools: object = spec.kind === 'orchestrator' ? spec.tools : spec.roleTools
          const tool = (tools as Record<string, unknown>)[step.callTool]
          if (typeof tool !== 'function') throw new Error(`No tool ${step.callTool} in this run`)
          await (tool as (args: unknown) => Promise<string>).call(tools, fill(step.args, captured))
        } else if ('capture' in step) {
          const c = step.capture
          let out: string
          if ('fromMessage' in c) out = run.received[run.reached]!.text
          else {
            const tool = (spec.kind === 'orchestrator' ? (spec.tools as unknown as Record<string, unknown>) : {})[c.tool]
            if (typeof tool !== 'function') throw new Error(`No tool ${c.tool} in this run`)
            out = await (tool as (args: unknown) => Promise<string>).call(spec.kind === 'orchestrator' ? spec.tools : {}, c.args ?? {})
          }
          const m = new RegExp(c.pattern).exec(out)
          if (!m?.[1]) throw new Error(`capture ${c.as}: ${c.pattern} did not match ${'fromMessage' in c ? "the user's message" : "the tool's text"}`)
          captured[c.as] = m[1]
        } else if ('requestPermission' in step) {
          await spec.onPermission({ ...step.requestPermission, signal: run.abort.signal })
        } else if ('readFile' in step) {
          await this.readFile(spec, run, step.readFile, ++reads)
        } else if ('expectImages' in step) {
          const { text, images } = run.received[run.reached]!
          const { count, named = [] } = step.expectImages
          if (images.length !== count) throw new Error(`Expected ${count} images with the message, got ${images.length}`)
          const missing = named.find((n) => !text.includes(n))
          if (missing !== undefined) throw new Error(`The message doesn't name the image ${missing}`)
          run.queue.push({ kind: 'message', text: `I see ${count} ${count === 1 ? 'image' : 'images'} (${images.map((i) => i.mime).join(', ')}).`, partial: false })
        } else if ('writeFile' in step) {
          const file = path.resolve(spec.cwd, step.writeFile.path)
          if (!within(spec.cwd, file)) throw new Error(`writeFile: ${step.writeFile.path} is outside the run's folder`)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, step.writeFile.content)
        } else if ('git' in step) {
          try {
            execFileSync('git', ['-c', 'user.name=Fake Agent', '-c', 'user.email=fake@mainbus.test', ...step.git], {
              cwd: spec.cwd,
              windowsHide: true,
              stdio: 'pipe'
            })
          } catch (err) {
            if (!step.allowFail) throw new Error(`git ${step.git.join(' ')} failed: ${String((err as { stderr?: Buffer }).stderr ?? err)}`)
          }
        } else if ('expectPrompt' in step) {
          if (!spec.prompt.includes(step.expectPrompt)) throw new Error(`The launch prompt lacks "${step.expectPrompt}"`)
        } else if ('expectSystemPrompt' in step) {
          if (!spec.appendSystemPrompt.includes(step.expectSystemPrompt)) throw new Error(`The system prompt lacks "${step.expectSystemPrompt}"`)
        } else if ('expectFile' in step) {
          if (!fs.existsSync(path.resolve(spec.cwd, step.expectFile))) throw new Error(`The run's folder lacks "${step.expectFile}"`)
        } else if ('expectModel' in step) {
          const launched = spec.kind === 'orchestrator' ? {} : { model: spec.model, effort: spec.effort }
          if (launched.model !== step.expectModel.model || launched.effort !== step.expectModel.effort) {
            throw new Error(`The launch has model ${launched.model ?? 'none'}, effort ${launched.effort ?? 'none'}`)
          }
        } else if ('waitForSend' in step) {
          while (run.pendingSends === 0 && !run.stopped) {
            await new Promise<void>((resolve) => (run.sendWaiter = resolve))
          }
          if (run.stopped) return
          run.pendingSends--
          run.reached++
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
