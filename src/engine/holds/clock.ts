/** The time and one timer, which tests (and the end-to-end tests' fake clock) replace. */
export interface Clock {
  now(): Date
  setTimeout(fn: () => void | Promise<void>, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** The longest a Node timer can wait; a longer wait is made in steps. */
export const MAX_TIMER_MS = 2 ** 31 - 1

export const realClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(() => void fn(), ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout)
}

interface Timer {
  id: number
  at: number
  fn: () => void | Promise<void>
}

/** A clock that moves only when told to: `advance` runs the timers that come due, earliest first. */
export class FakeClock implements Clock {
  private time: number
  private timers: Timer[] = []
  private nextId = 1

  constructor(start: Date) {
    this.time = start.getTime()
  }

  now(): Date {
    return new Date(this.time)
  }

  setTimeout(fn: () => void | Promise<void>, ms: number): unknown {
    const id = this.nextId++
    this.timers.push({ id, at: this.time + Math.max(0, ms), fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }

  /** Timers waiting. */
  get pending(): number {
    return this.timers.length
  }

  /** Moves the time on, running each timer that comes due at its own time and waiting for it to finish. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter((t) => t !== due)
      this.time = Math.max(this.time, due.at)
      await due.fn()
    }
    this.time = target
  }
}
