import { Button, Group, Stack, Text, TextInput } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { fieldInfo } from '../FieldLabel'
import { invoke, openFolder } from '../api'
import { errorMessage } from '../notify'

const HELP =
  'Where new tickets get their folders: the worktree, the scratch (TEMP) folder and the base-branch test folder. Empty means the Mainbus data home. ' +
  'A fast drive such as a Windows Dev Drive suits it, since agents install, build and test here. Keep the path short, such as D:\\mb: Windows limits a path to 260 characters. ' +
  'It applies to new tickets only. A ticket that already has a folder keeps it until it finishes, and the base-test folder moves on its next run. ' +
  'You can change it while tickets run. The database, attachments and settings stay in the data home. ' +
  'pnpm links packages from its store only when the store is on the same drive: run `pnpm store path` from a folder there, and set `store-dir` if it is on another drive.'

/** "Ticket folders location": the root for new tickets' worktrees, scratch folders and base-test folders. */
export function TicketFoldersSettings({ opened }: { opened: boolean }): ReactElement {
  const [saved, setSaved] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    invoke('settings.get')
      .then((settings) => {
        if (cancelled || !settings) return
        setSaved(settings.ticketFoldersLocation ?? null)
        setText(settings.ticketFoldersLocation ?? '')
        setLoaded(true)
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err))
      })
    return () => {
      cancelled = true
    }
  }, [opened])

  async function save(location: string | null): Promise<void> {
    setBusy(true)
    try {
      const result = await invoke('settings.setTicketFoldersLocation', location)
      setSaved(result.settings.ticketFoldersLocation)
      setText(result.settings.ticketFoldersLocation ?? '')
      setError(null)
      setWarning(result.warning)
    } catch (err) {
      setError(errorMessage(err))
      setWarning(null)
    } finally {
      setBusy(false)
    }
  }

  async function choose(): Promise<void> {
    const folder = await openFolder().catch(() => null)
    if (folder) await save(folder)
  }

  return (
    <Stack gap="xs">
      <TextInput
        {...fieldInfo('Ticket folders location', HELP)}
        placeholder="The data home (default)"
        value={text}
        disabled={!loaded}
        error={error}
        onChange={(e) => setText(e.currentTarget.value)}
      />
      {warning && (
        <Text size="xs" c="needs" role="status" data-ticket-folders-warning>
          {warning}
        </Text>
      )}
      <Group gap="xs">
        <Button variant="default" size="xs" disabled={!loaded || busy} onClick={() => void choose()}>
          Choose folder…
        </Button>
        <Button size="xs" disabled={!loaded || busy || text.trim() === (saved ?? '')} onClick={() => void save(text.trim() === '' ? null : text.trim())}>
          Save
        </Button>
        <Button variant="subtle" size="xs" disabled={!loaded || busy || saved === null} onClick={() => void save(null)}>
          Use the data home
        </Button>
      </Group>
    </Stack>
  )
}
