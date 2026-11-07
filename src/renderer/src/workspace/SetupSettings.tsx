import { Button, Group, NumberInput, Stack, Text, TextInput, Title } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { checkSetupCommand, checkSetupTimeout, SETUP_TIMEOUT_MAX, SETUP_TIMEOUT_MIN } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** Settings section: the command Mainbus runs in each new ticket folder before the first role starts, and how long it may take. */
export function SetupSettings({ opened }: { opened: boolean }): ReactElement {
  // The focused workspace the board already has, as in the report settings.
  const workspace = useMainbus((s) => s.workspace)
  const savedCommand = workspace?.setupCommand ?? ''
  const savedTimeout = workspace?.setupTimeoutMinutes ?? 15
  const [command, setCommand] = useState(savedCommand)
  const [timeout, setTimeoutMinutes] = useState<number | string>(savedTimeout)
  const [saving, setSaving] = useState(false)

  // Each opening starts from what is saved.
  useEffect(() => {
    if (opened) {
      setCommand(savedCommand)
      setTimeoutMinutes(savedTimeout)
    }
  }, [opened, savedCommand, savedTimeout])

  const checkedCommand = checkSetupCommand(command)
  const checkedTimeout = checkSetupTimeout(typeof timeout === 'number' ? timeout : Number.NaN)
  const changed = workspace !== null && ((checkedCommand.ok && checkedCommand.command !== savedCommand) || (checkedTimeout.ok && checkedTimeout.minutes !== savedTimeout))

  async function save(): Promise<void> {
    if (!checkedCommand.ok || !checkedTimeout.ok) return
    setSaving(true)
    try {
      const ws = await invoke('workspace.setSetupSettings', { command: checkedCommand.command, timeoutMinutes: checkedTimeout.minutes })
      setCommand(ws.setupCommand)
      setTimeoutMinutes(ws.setupTimeoutMinutes)
      useMainbus.setState({ workspace: ws })
    } catch (err) {
      showError(err, 'Could not save the settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Stack gap="sm" component="section" aria-label="Ticket folder setup">
      <Title order={3} size="h4">
        Ticket folder setup
      </Title>
      <Text size="sm" c="dimmed">
        Mainbus runs this command itself in each new ticket folder, before the first role starts, so agents don't install dependencies themselves. It
        doesn't run again when a folder is reused. Leave it empty to run nothing.
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (changed) void save()
        }}
      >
        <Stack gap="xs">
          <TextInput
            label="Setup command for new ticket folders"
            placeholder="npm ci"
            value={command}
            onChange={(e) => setCommand(e.currentTarget.value)}
            error={workspace !== null && !checkedCommand.ok ? checkedCommand.reason : undefined}
            disabled={workspace === null}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
          />
          <NumberInput
            label="Timeout (minutes)"
            value={timeout}
            onChange={setTimeoutMinutes}
            min={SETUP_TIMEOUT_MIN}
            max={SETUP_TIMEOUT_MAX}
            allowDecimal={false}
            allowNegative={false}
            clampBehavior="strict"
            error={workspace !== null && !checkedTimeout.ok ? checkedTimeout.reason : undefined}
            disabled={workspace === null}
            w={160}
          />
          <Group>
            <Button type="submit" variant="default" size="compact-sm" loading={saving} disabled={!checkedCommand.ok || !checkedTimeout.ok || !changed}>
              Save setup
            </Button>
          </Group>
        </Stack>
      </form>
    </Stack>
  )
}
