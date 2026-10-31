/**
 * A push-driven async iterable: the streaming input for a long-lived `query()`.
 * Values pushed before iteration starts are kept, and `end()` finishes the iteration.
 * Supports a single consumer.
 */
export class InputQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = []
  private waiting: (() => void) | null = null
  private ended = false

  push(v: T): void {
    if (this.ended) return
    this.items.push(v)
    this.wake()
  }

  end(): void {
    this.ended = true
    this.wake()
  }

  private wake(): void {
    const w = this.waiting
    this.waiting = null
    w?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T
      } else if (this.ended) {
        return
      } else {
        await new Promise<void>((resolve) => (this.waiting = resolve))
      }
    }
  }
}
