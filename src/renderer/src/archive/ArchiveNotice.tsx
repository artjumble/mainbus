import { Alert, Button, Group } from '@mantine/core'
import type { ReactElement } from 'react'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'

/** "Archived 12 Done tickets older than 14 days (automatically)": what the notice for a batch says. */
export function archiveNoticeText(count: number, days: number, kind: 'sweep' | 'bulk'): string {
  const tickets = count === 1 ? '1 Done ticket' : `${count} Done tickets`
  return `Archived ${tickets} older than ${days} days ${kind === 'sweep' ? 'automatically' : 'from the Done column'}.`
}

/**
 * Under the board's header, once, after a sweep or the bulk action archived something: "Restore all archived by this"
 * undoes exactly that batch. It stays until closed, restored, or replaced by a newer batch; the engine never offers it again.
 */
export function ArchiveNotice(): ReactElement {
  const notice = useMainbus((s) => s.archiveNotice)

  async function restoreAll(): Promise<void> {
    if (!notice) return
    const { announce, refreshBoard } = useMainbus.getState()
    try {
      const n = await invoke('archive.restoreBatch', notice.id)
      await refreshBoard()
      announce(`Restored ${n} ${n === 1 ? 'ticket' : 'tickets'} to Done`)
    } catch (err) {
      showError(err, "Can't restore these tickets")
    }
  }

  async function close(): Promise<void> {
    if (!notice) return
    try {
      await invoke('archive.closeNotice', notice.id)
      useMainbus.setState({ archiveNotice: null })
    } catch (err) {
      showError(err, "Can't close this notice")
    }
  }

  // The status region stays mounted, so a notice that appears is announced once, politely.
  return (
    <div role="status" aria-label="Archived tickets">
      {notice && (
        <Alert color="blue" variant="light" radius={0} py="xs" data-testid="archive-notice">
          <Group justify="space-between" wrap="nowrap">
            <span>{archiveNoticeText(notice.count, notice.olderThanDays, notice.kind)}</span>
            <Group gap="xs" wrap="nowrap">
              <Button size="compact-sm" variant="default" onClick={() => void restoreAll()}>
                Restore all archived by this
              </Button>
              <Button size="compact-sm" variant="subtle" onClick={() => void close()}>
                Close
              </Button>
            </Group>
          </Group>
        </Alert>
      )}
    </div>
  )
}
