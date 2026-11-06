import { NumberInput, Radio, Stack, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { AGENT_CAP_MAX, AGENT_CAP_MIN, type WhenClosed } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'

/**
 * Settings section for what applies to the whole app: how many role agents may run at once, and what closing the
 * window does. (The theme is in the Mainbus settings.)
 */
export function GeneralSettings({ opened }: { opened: boolean }): ReactElement {
  const [maxAgents, setMaxAgents] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [whenClosed, setWhenClosed] = useState<WhenClosed | null>(null)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setMaxAgents(settings.maxAgents)
        setWhenClosed(settings.whenClosed)
      })
      .catch((err) => {
        if (!cancelled) showError(err, 'Could not load the settings')
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function save(value: string | number): Promise<void> {
    // Typing is free; only a whole number in range is saved. Anything else waits for the next keystroke.
    if (typeof value !== 'number' || !Number.isInteger(value) || value < AGENT_CAP_MIN || value > AGENT_CAP_MAX) return
    const previous = maxAgents
    setMaxAgents(value)
    setSaving(true)
    try {
      const settings = await invoke('settings.setMaxAgents', value)
      setMaxAgents(settings.maxAgents)
    } catch (err) {
      setMaxAgents(previous)
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  async function saveWhenClosed(value: string): Promise<void> {
    if (value !== 'tray' && value !== 'quit') return
    const previous = whenClosed
    setWhenClosed(value)
    try {
      const settings = await invoke('settings.setWhenClosed', value)
      setWhenClosed(settings.whenClosed)
    } catch (err) {
      setWhenClosed(previous)
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <Stack gap="sm" component="section" aria-label="General">
      <Title order={3} size="h4">
        General
      </Title>
      <NumberInput
        label="Agents running at once"
        description="More than this wait as Queued and start first in, first out as others finish. The orchestrator doesn't count. Lowering it stops no running agent."
        min={AGENT_CAP_MIN}
        max={AGENT_CAP_MAX}
        allowDecimal={false}
        allowNegative={false}
        clampBehavior="strict"
        value={maxAgents ?? ''}
        disabled={maxAgents === null || saving}
        onChange={(v) => void save(v)}
        w={160}
      />
      <Radio.Group
        label="When I close the window"
        value={whenClosed ?? ''}
        onChange={(v) => void saveWhenClosed(v)}
      >
        <Stack gap="xs" mt="xs">
          <Radio value="tray" label="Keep running in the tray while agents work" disabled={whenClosed === null} />
          <Radio value="quit" label="Always quit" disabled={whenClosed === null} />
        </Stack>
      </Radio.Group>
    </Stack>
  )
}
