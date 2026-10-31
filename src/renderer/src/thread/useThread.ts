import { useEffect, useState } from 'react'
import type { EngineEvent } from '../../../shared/api'
import type { Decision } from '../../../shared/domain'
import type { StoredEvent } from '../../../shared/events'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'
import { mergeEvent } from './merge'

export interface ThreadState {
  events: StoredEvent[]
  decisions: Decision[]
}

function apply(state: ThreadState, e: EngineEvent, ticketId: string): ThreadState {
  if (e.type === 'thread.appended' && e.ticketId === ticketId) {
    return { ...state, events: mergeEvent(state.events, e.event) }
  }
  if (e.type === 'decision.changed' && e.decision.ticketId === ticketId) {
    const known = state.decisions.some((d) => d.id === e.decision.id)
    const decisions = known
      ? state.decisions.map((d) => (d.id === e.decision.id ? e.decision : d))
      : [...state.decisions, e.decision]
    return { ...state, decisions }
  }
  return state
}

/**
 * A ticket thread: the stored history from `thread.get`, kept current by the engine's live events
 * (including streaming previews, which are never stored). Events that arrive while the history loads
 * are held and applied after it. Null until loaded.
 */
export function useThread(ticketId: string): ThreadState | null {
  const [state, setState] = useState<ThreadState | null>(null)

  useEffect(() => {
    let loaded = false
    let cancelled = false
    const held: EngineEvent[] = []
    const off = onEngineEvent((e) => {
      if (!loaded) held.push(e)
      else setState((s) => (s ? apply(s, e, ticketId) : s))
    })
    invoke('thread.get', ticketId).then(
      (history) => {
        if (cancelled) return
        loaded = true
        const stored = history.events.reduce<StoredEvent[]>(mergeEvent, [])
        setState(held.reduce((s, e) => apply(s, e, ticketId), { events: stored, decisions: history.decisions }))
      },
      (err: unknown) => {
        if (cancelled) return
        loaded = true
        showError(err, 'Could not load the thread')
        setState({ events: [], decisions: [] })
      }
    )
    return () => {
      cancelled = true
      off()
    }
  }, [ticketId])

  return state
}
