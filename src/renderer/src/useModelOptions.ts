import { useEffect } from 'react'
import type { ModelOption } from '../../shared/models'
import { invoke } from './api'
import { useMainbus } from './store'

let read = false

/**
 * The models offered for agents' roles, for a model select: read from the engine the first time a select shows (it
 * answers once it has read the user's `claude`), then kept current by its `models.changed` events. The aliases until then.
 */
export function useModelOptions(): ModelOption[] {
  useEffect(() => {
    if (read) return
    read = true
    void Promise.resolve()
      .then(() => invoke('models.list'))
      .then((options) => {
        if (Array.isArray(options)) useMainbus.getState().setModelOptions(options)
      })
      .catch(() => {
        // Tried again by the next select that shows.
        read = false
      })
  }, [])
  return useMainbus((s) => s.modelOptions)
}
