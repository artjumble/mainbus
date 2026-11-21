import { Anchor, Badge, Button, Checkbox, Group, Loader, Stack, Text, TextInput, Title } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { ArchivedTicket } from '../../../shared/domain'
import { invoke } from '../api'
import { showError } from '../notify'
import { useMainbus } from '../store'
import { groupByMonth } from './groupByMonth'

const PAGE = 50

const day = (iso: string | null): string =>
  iso === null ? '' : new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** Where focus goes once a restored row is gone: the row after it (or before it), else the search box. */
type FocusTarget = { row: string } | 'search'

/**
 * The tickets archived from the focused workspace: newest archived first, in pages, grouped by month, searchable,
 * with Restore for one or many. An archived ticket is still Done: opening one shows the ticket view, read-only.
 */
export function ArchiveView(): ReactElement {
  const workspace = useMainbus((s) => s.workspace)
  const archivedCount = useMainbus((s) => s.archivedCount)
  const initialQuery = useMainbus((s) => s.archiveQuery)
  const closeArchive = useMainbus((s) => s.closeArchive)
  const openTicket = useMainbus((s) => s.openTicket)

  const [query, setQuery] = useState(initialQuery)
  const [debounced] = useDebouncedValue(query.trim(), 200)
  const [rows, setRows] = useState<ArchivedTicket[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const headingRef = useRef<HTMLHeadingElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pendingFocus = useRef<FocusTarget | null>(null)
  // The count the store held when the list was read: a change to it we didn't make (a ticket archived meanwhile) re-reads.
  const knownCount = useRef(archivedCount)
  const generation = useRef(0)

  const read = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    try {
      const page = await invoke('archive.list', { query: debounced, limit: PAGE })
      if (mine !== generation.current) return
      knownCount.current = useMainbus.getState().archivedCount
      setRows(page.tickets)
      setTotal(page.total)
      setSelected((s) => new Set(page.tickets.filter((t) => s.has(t.id)).map((t) => t.id)))
      setLoaded(true)
    } catch (err) {
      if (mine === generation.current) {
        setLoaded(true)
        showError(err, 'Could not read the Archive')
      }
    }
  }, [debounced])

  useEffect(() => {
    void read()
  }, [read])

  useEffect(() => {
    if (archivedCount !== knownCount.current) void read()
  }, [archivedCount, read])

  // Arrived from the board or back from a ticket: say where we are.
  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  // After a restore the row is gone; focus must not fall to the page.
  useEffect(() => {
    const target = pendingFocus.current
    if (target === null) return
    pendingFocus.current = null
    const el =
      target === 'search'
        ? searchRef.current
        : document.querySelector<HTMLElement>(`[data-archive-open="${CSS.escape(target.row)}"]`)
    ;(el ?? searchRef.current)?.focus()
  }, [rows])

  const groups = useMemo(() => groupByMonth(rows), [rows])
  const allSelected = rows.length > 0 && rows.every((t) => selected.has(t.id))
  const someSelected = rows.some((t) => selected.has(t.id))

  async function loadMore(): Promise<void> {
    const last = rows[rows.length - 1]
    if (!last || loadingMore) return
    setLoadingMore(true)
    const mine = generation.current
    try {
      const page = await invoke('archive.list', {
        query: debounced,
        before: { archivedAt: last.archivedAt, number: last.number },
        limit: PAGE
      })
      if (mine !== generation.current) return
      setRows((r) => [...r, ...page.tickets.filter((t) => !r.some((x) => x.id === t.id))])
      setTotal(page.total)
    } catch (err) {
      showError(err, 'Could not read more of the Archive')
    } finally {
      setLoadingMore(false)
    }
  }

  async function restore(ids: string[]): Promise<void> {
    if (ids.length === 0 || restoring) return
    setRestoring(true)
    const gone = new Set(ids)
    const names = rows.filter((t) => gone.has(t.id))
    // The row to focus afterwards: the next one still standing, else the one before, else the search box.
    const lastIndex = Math.max(...names.map((t) => rows.indexOf(t)))
    const next = rows.slice(lastIndex + 1).find((t) => !gone.has(t.id)) ?? [...rows].reverse().find((t) => !gone.has(t.id))
    try {
      await invoke('ticket.unarchive', ids)
    } catch (err) {
      showError(err, ids.length === 1 ? "Can't restore this ticket" : "Can't restore these tickets")
      setRestoring(false)
      return
    }
    pendingFocus.current = next ? { row: next.id } : 'search'
    // The count the board is about to report: this list already shows it, so it needn't be read again.
    knownCount.current = Math.max(0, useMainbus.getState().archivedCount - ids.length)
    setRows((r) => r.filter((t) => !gone.has(t.id)))
    setTotal((n) => Math.max(0, n - ids.length))
    setSelected((s) => new Set([...s].filter((id) => !gone.has(id))))
    const first = names[0]
    useMainbus
      .getState()
      .announce(ids.length === 1 && first ? `Restored #${first.number} ${first.title} to Done` : `Restored ${ids.length} tickets to Done`)
    setRestoring(false)
    await useMainbus.getState().refreshBoard()
  }

  function toggle(id: string, on: boolean): void {
    setSelected((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const searching = debounced !== ''

  return (
    <Stack gap="md" px="md" py="md">
      <Anchor component="button" type="button" size="sm" onClick={closeArchive} style={{ alignSelf: 'flex-start' }}>
        {`← ${workspace?.name ?? 'Workspace'} board`}
      </Anchor>
      <Group justify="space-between" align="flex-end">
        <Stack gap={0}>
          <Title order={2} tabIndex={-1} ref={headingRef} style={{ outline: 'none' }}>
            Archive
          </Title>
          <Text size="sm" c="dimmed">
            Done tickets kept off the board. They stay Done: blockers, reports and usage still count them.
          </Text>
        </Stack>
        <TextInput
          ref={searchRef}
          aria-label="Search the archive"
          placeholder="Search the archive"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
          }}
          miw={280}
        />
      </Group>

      <Group justify="space-between" gap="sm">
        <Checkbox
          label="Select all shown"
          checked={allSelected}
          indeterminate={someSelected && !allSelected}
          disabled={rows.length === 0}
          onChange={(e) => setSelected(e.currentTarget.checked ? new Set(rows.map((t) => t.id)) : new Set())}
        />
        <Button
          size="compact-sm"
          disabled={selected.size === 0 || restoring}
          onClick={() => void restore([...selected])}
        >
          {`Restore selected (${selected.size})`}
        </Button>
      </Group>

      <Text size="sm" c="dimmed" role="status">
        {loaded ? (total === 0 ? '' : `Showing ${rows.length} of ${total}`) : ''}
      </Text>

      {!loaded ? (
        <Loader size="sm" aria-label="Loading the Archive" />
      ) : rows.length === 0 ? (
        <Text>{searching ? 'No archived tickets match.' : 'Nothing is archived yet.'}</Text>
      ) : (
        groups.map((g) => (
          <Stack key={g.key} gap="xs" component="section" aria-labelledby={`archive-month-${g.key}`}>
            <Title order={3} size="h5" id={`archive-month-${g.key}`}>
              {g.heading}
            </Title>
            <Stack gap={6} component="ul" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {g.tickets.map((t) => (
                <Group key={t.id} component="li" gap="sm" wrap="nowrap" align="center">
                  <Checkbox
                    aria-label={`Select #${t.number} ${t.title}`}
                    checked={selected.has(t.id)}
                    onChange={(e) => toggle(t.id, e.currentTarget.checked)}
                  />
                  <Anchor
                    component="button"
                    type="button"
                    size="sm"
                    data-archive-open={t.id}
                    onClick={() => openTicket(t.id)}
                    style={{ textAlign: 'start' }}
                  >
                    {`#${t.number} ${t.title}`}
                  </Anchor>
                  {t.labels.map((label) => (
                    <Badge key={label} variant="light" color="gray" radius="sm" tt="none">
                      {label}
                    </Badge>
                  ))}
                  <Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: 'nowrap' }}>
                    {t.doneAt ? `Done ${day(t.doneAt)} · ` : ''}
                    {`Archived ${day(t.archivedAt)}`}
                  </Text>
                  <Button
                    size="compact-sm"
                    variant="default"
                    disabled={restoring}
                    aria-label={`Restore #${t.number} ${t.title}`}
                    onClick={() => void restore([t.id])}
                  >
                    Restore
                  </Button>
                </Group>
              ))}
            </Stack>
          </Stack>
        ))
      )}

      {loaded && rows.length < total && (
        <Button variant="default" w="fit-content" loading={loadingMore} onClick={() => void loadMore()}>
          {`Load more (${total - rows.length} left)`}
        </Button>
      )}
    </Stack>
  )
}
