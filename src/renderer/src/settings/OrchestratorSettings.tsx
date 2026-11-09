import { Switch } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { invoke } from '../api'
import { showError } from '../notify'

/** The "Let the orchestrator read web pages" setting. */
export function OrchestratorSettings({ opened }: { opened: boolean }): ReactElement {
  const [webAccess, setWebAccess] = useState<boolean | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setWebAccess(settings.orchestratorWebAccess)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function save(on: boolean): Promise<void> {
    const previous = webAccess
    setWebAccess(on)
    try {
      const settings = await invoke('settings.setOrchestratorWebAccess', on)
      setWebAccess(settings.orchestratorWebAccess)
    } catch (err) {
      setWebAccess(previous)
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <Switch
      label="Let the orchestrator read web pages"
      description="It can open pages you link and search the web. Pages are read as data, never as instructions; addresses on this computer or your local network are always refused."
      checked={webAccess ?? true}
      disabled={webAccess === null}
      onChange={(e) => void save(e.currentTarget.checked)}
    />
  )
}
