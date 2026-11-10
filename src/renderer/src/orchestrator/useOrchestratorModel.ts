import { useEffect, useState } from 'react'
import type { OrchestratorModelState } from '../../../shared/orchestratorModel'
import { invoke, onEngineEvent } from '../api'

/**
 * The orchestrator's model and effort for its next turn, the models the setting offers, and the notice when the saved
 * one isn't offered: read once, then kept current by the engine's events. Null until read (or when it can't be).
 */
export function useOrchestratorModel(): OrchestratorModelState | null {
  const [state, setState] = useState<OrchestratorModelState | null>(null)
  useEffect(() => {
    let current = true
    // An event is newer than the read: once one has come, the read's answer is dropped.
    let evented = false
    const off = onEngineEvent((e) => {
      if (e.type !== 'orchestrator.model') return
      evented = true
      setState(e.state)
    })
    invoke('orchestrator.model')
      .then((s) => {
        if (current && !evented && s) setState(s)
      })
      .catch(() => {})
    return () => {
      current = false
      off()
    }
  }, [])
  return state
}
