import type { AgentEvent } from '../../shared/events'
import {
  ResumeFailedError,
  type AgentRuntime,
  type PermissionRequest,
  type RunHandle,
  type RunSpec
} from './types'

/** One scripted step. Plain data only, so a script can be loaded from a JSON file. */
export type FakeStep =
  | { emit: AgentEvent }
  | { callTool: 'askUser' | 'handoff'; args: unknown }
  | { requestPermission: Omit<PermissionRequest, 'signal'> }
  | { waitForSend: true }
  | { exit: number | null }

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
}

/**
 * A deterministic scripted runtime for tests. It plays a `FakeStep[]` per run:
 * `callTool` and `requestPermission` call into the `RunSpec` handlers, and `waitForSend`
 * blocks until `send()` is called (a send that arrived earlier counts). `events()` ends
 * after an `exit` step or `stop()`; a script with neither stays open like a live process.
 * `EventQueue` supports a single `events()` consumer per run.
 */
export class FakeRuntime implements AgentRuntime {
  /** Every spec passed to start(), including ones that went on to fail. */
  readonly specs: RunSpec[] = []
  /** Every text passed to send(). */
  readonly sent: string[] = []
  private readonly runs = new Map<string, Run>()
  private nextId = 1

  constructor(
    private readonly script: FakeStep[],
    private readonly opts: { rejectResume?: boolean } = {}
  ) {}

  async start(spec: RunSpec): Promise<RunHandle> {
    this.specs.push(spec)
    if (this.opts.rejectResume && spec.resumeSessionId) throw new ResumeFailedError()
    const handle = { id: `fake-${this.nextId++}` }
    const run: Run = {
      queue: new EventQueue(),
      abort: new AbortController(),
      pendingSends: 0,
      sendWaiter: null,
      stopped: false
    }
    this.runs.set(handle.id, run)
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
    this.get(handle) // the script is not affected; it has no turns to cut short
  }

  async stop(handle: RunHandle): Promise<void> {
    const run = this.get(handle)
    run.stopped = true
    run.abort.abort()
    run.queue.close()
    const w = run.sendWaiter
    run.sendWaiter = null
    w?.()
  }

  events(handle: RunHandle): AsyncIterable<AgentEvent> {
    return this.get(handle).queue
  }

  private get(handle: RunHandle): Run {
    const run = this.runs.get(handle.id)
    if (!run) throw new Error(`Unknown run ${handle.id}`)
    return run
  }

  private async play(spec: RunSpec, run: Run): Promise<void> {
    // Yield first so nothing fires until the caller has the handle, as with a real runtime.
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      for (const step of this.script) {
        if (run.stopped) return
        if ('emit' in step) {
          run.queue.push(step.emit)
        } else if ('callTool' in step) {
          // The script file is trusted test data, so the args are passed through as-is.
          if (step.callTool === 'askUser') {
            await spec.roleTools.askUser(step.args as Parameters<typeof spec.roleTools.askUser>[0])
          } else {
            await spec.roleTools.handoff(step.args as Parameters<typeof spec.roleTools.handoff>[0])
          }
        } else if ('requestPermission' in step) {
          await spec.onPermission({ ...step.requestPermission, signal: run.abort.signal })
        } else if ('waitForSend' in step) {
          while (run.pendingSends === 0 && !run.stopped) {
            await new Promise<void>((resolve) => (run.sendWaiter = resolve))
          }
          if (run.stopped) return
          run.pendingSends--
        } else {
          run.queue.close()
          return
        }
      }
    } catch (err) {
      run.queue.push({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      run.queue.close()
    }
  }
}
