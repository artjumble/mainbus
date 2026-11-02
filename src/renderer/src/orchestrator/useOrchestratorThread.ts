import { useEffect, useState } from 'react'
import type { EngineEvent } from '../../../shared/api'
import type { OrchestratorStatus, StoredEvent, ThreadRun } from '../../../shared/events'
import { invoke, onEngineEvent } from '../api'
import { showError } from '../notify'
import { mergeEvent } from '../thread/merge'

export interface OrchestratorThreadState {
  events: StoredEvent[]
  status: OrchestratorStatus
  /** Every orchestrator session, by id, as the thread names runs. */
  runs: Record<string, ThreadRun>
}

/**
 * All the sessions are one conversation: they share a ticket run, so the thread draws no "New run" between them
 * (a fresh session after a failed resume says so with a notice of its own).
 */
function threadRun(id: string): ThreadRun {
  return { id, ticketRunId: 'orchestrator', role: 'Orchestrator' }
}

function apply(state: OrchestratorThreadState, e: EngineEvent): OrchestratorThreadState {
  if (e.type === 'orchestrator.appended') {
    const { runId } = e.event
    const runs = runId in state.runs ? state.runs : { ...state.runs, [runId]: threadRun(runId) }
    return { ...state, events: mergeEvent(state.events, e.event), runs }
  }
  if (e.type === 'orchestrator.status') return { ...state, status: e.status }
  return state
}

/**
 * The orchestrator's thread: the stored history from `orchestrator.get`, kept current by the engine's live events
 * (including streaming previews) and its status. Events that arrive while the history loads are held and applied
 * after it. Null until loaded.
 */
export function useOrchestratorThread(): OrchestratorThreadState | null {
  const [state, setState] = useState<OrchestratorThreadState | null>(null)

  useEffect(() => {
    let loaded = false
    let cancelled = false
    const held: EngineEvent[] = []
    const off = onEngineEvent((e) => {
      if (!loaded) held.push(e)
      else setState((s) => (s ? apply(s, e) : s))
    })
    invoke('orchestrator.get').then(
      (history) => {
        if (cancelled) return
        loaded = true
        const events = history.events.reduce<StoredEvent[]>(mergeEvent, [])
        const runs = Object.fromEntries(history.runs.map((r) => [r.id, threadRun(r.id)]))
        setState(held.reduce(apply, { events, status: history.status, runs }))
      },
      (err: unknown) => {
        if (cancelled) return
        loaded = true
        showError(err, 'Could not load the orchestrator')
        setState({ events: [], status: 'idle', runs: {} })
      }
    )
    return () => {
      cancelled = true
      off()
    }
  }, [])

  return state
}
