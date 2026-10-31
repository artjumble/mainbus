import type { StoredEvent } from '../../../shared/events'

type Streaming = 'message' | 'thinking'

/** A streaming preview (seq 0, never stored): the final event of its kind replaces it. */
function streamingKind(e: StoredEvent): Streaming | null {
  const ev = e.event
  return e.seq === 0 && (ev.kind === 'message' || ev.kind === 'thinking') && ev.partial ? ev.kind : null
}

/**
 * Adds one event from the engine to a run's thread. Streaming previews carry cumulative text, so a new
 * one replaces the last of its kind in the same run; the final message or thinking stub replaces the
 * preview; the end of a turn or run drops any preview left over. A stored event seen twice (the initial
 * read and the live feed overlap) is kept once.
 */
export function mergeEvent(events: StoredEvent[], incoming: StoredEvent): StoredEvent[] {
  const sameRun = (e: StoredEvent): boolean => e.runId === incoming.runId
  const kind = streamingKind(incoming)
  if (kind) return [...events.filter((e) => !(sameRun(e) && streamingKind(e) === kind)), incoming]

  if (incoming.seq > 0 && events.some((e) => sameRun(e) && e.seq === incoming.seq)) return events

  const ev = incoming.event
  const clears: Streaming[] =
    ev.kind === 'message' || ev.kind === 'thinking'
      ? [ev.kind]
      : ev.kind === 'turn_end' || ev.kind === 'process_exit' || ev.kind === 'stopped' || ev.kind === 'error'
        ? ['message', 'thinking']
        : []
  const kept = clears.length === 0 ? events : events.filter((e) => !(sameRun(e) && clears.includes(streamingKind(e) as Streaming)))
  return [...kept, incoming]
}
