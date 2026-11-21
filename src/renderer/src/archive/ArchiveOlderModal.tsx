import { Button, Group, Modal, SegmentedControl, Stack, Text } from '@mantine/core'
import { useEffect, useState, type ReactElement } from 'react'
import { ARCHIVE_AGE_DAYS, type ArchiveAgeDays } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** "Archive all Done older than…": pick an age, see how many tickets that is, confirm. */
export function ArchiveOlderModal({ opened, onClose }: { opened: boolean; onClose: () => void }): ReactElement {
  const [days, setDays] = useState<ArchiveAgeDays>(14)
  const [count, setCount] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!opened) return
    let cancelled = false
    setCount(null)
    invoke('archive.countOlder', days)
      .then((n) => {
        if (!cancelled) setCount(n)
      })
      .catch((err: unknown) => {
        if (!cancelled) showError(err, "Can't count the Done tickets")
      })
    return () => {
      cancelled = true
    }
  }, [opened, days])

  async function confirm(): Promise<void> {
    setBusy(true)
    try {
      const batch = await invoke('archive.olderThan', days)
      const { announce, refreshBoard } = useMainbus.getState()
      await refreshBoard()
      announce(batch ? `Archived ${batch.count} Done ${batch.count === 1 ? 'ticket' : 'tickets'}` : 'No Done tickets to archive')
      onClose()
      // The strip's button is gone with the modal's trigger: focus goes back to the Done lane.
      setTimeout(() => document.querySelector<HTMLElement>('[data-done-lane]')?.focus(), 0)
    } catch (err) {
      showError(err, "Can't archive these tickets")
    } finally {
      setBusy(false)
    }
  }

  const summary =
    count === null
      ? 'Counting…'
      : count === 0
        ? `No Done tickets reached Done more than ${days} days ago.`
        : `${count} Done ${count === 1 ? 'ticket' : 'tickets'} reached Done more than ${days} days ago.`

  return (
    <Modal opened={opened} onClose={onClose} title="Archive all Done older than…" trapFocus returnFocus={false}>
      <Stack gap="sm">
        <SegmentedControl
          aria-label="Older than"
          value={String(days)}
          onChange={(v) => setDays(Number(v) as ArchiveAgeDays)}
          data={ARCHIVE_AGE_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))}
        />
        <Text size="sm" role="status">
          {summary}
        </Text>
        <Text size="xs" c="dimmed">
          They stay Done and searchable in the Archive, and you can restore them right after.
        </Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={count === null || count === 0 || busy} loading={busy} onClick={() => void confirm()}>
            {count ? `Archive ${count} ${count === 1 ? 'ticket' : 'tickets'}` : 'Archive'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
