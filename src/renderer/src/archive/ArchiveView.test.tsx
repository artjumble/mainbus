import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ArchivedTicket } from '../../../shared/domain'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { ArchiveView } from './ArchiveView'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

const row = (n: number, archivedAt: string, extra: Partial<ArchivedTicket> = {}): ArchivedTicket => ({
  id: `t${n}`,
  number: n,
  title: `Ticket ${n}`,
  labels: [],
  kind: 'change',
  doneAt: '2026-11-01T12:00:00.000Z',
  archivedAt,
  ...extra
})

let archived: ArchivedTicket[]
const listCalls = (): unknown[][] => mockInvoke.mock.calls.filter(([c]) => c === 'archive.list')

beforeEach(() => {
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, archiveOpen: true, archivedCount: 3 }, true)
  archived = [row(3, '2026-11-15T12:00:00.000Z', { labels: ['perf'] }), row(2, '2026-11-14T12:00:00.000Z'), row(1, '2026-10-15T12:00:00.000Z')]
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command: string, ...args: unknown[]) => {
    if (command === 'archive.list') {
      const { query = '', before, limit = 50 } = args[0] as { query?: string; before?: { archivedAt: string; number: number }; limit?: number }
      const matching = archived.filter((t) => query === '' || t.title.toLowerCase().includes(query.toLowerCase()))
      const after = before ? matching.filter((t) => t.archivedAt < before.archivedAt || (t.archivedAt === before.archivedAt && t.number < before.number)) : matching
      return { tickets: after.slice(0, limit), total: matching.length }
    }
    if (command === 'ticket.unarchive') {
      const ids = args[0] as string[]
      archived = archived.filter((t) => !ids.includes(t.id))
      useMainbus.setState({ archivedCount: archived.length })
      return undefined
    }
    if (command === 'board.get') return { tickets: [], archived: archived.length }
    return undefined
  })
})

const titles = (): string[] =>
  screen.getAllByRole('button', { name: /^#\d+ Ticket/ }).map((b) => b.textContent ?? '')

test('lists archived tickets newest first under month headings, with their dates and labels', async () => {
  renderWithMantine(<ArchiveView />)
  expect(await screen.findByRole('button', { name: '#3 Ticket 3' })).toBeInTheDocument()
  expect(titles()).toEqual(['#3 Ticket 3', '#2 Ticket 2', '#1 Ticket 1'])
  const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)
  expect(headings).toHaveLength(2)
  const [november] = screen.getAllByRole('region')
  expect(within(november!).getByText('perf')).toBeInTheDocument()
  expect(within(november!).getAllByText(/Archived /)).toHaveLength(2)
  expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument()
  await expectNoAxeViolations(document.body)
})

test('says so when nothing is archived, and when a search matches nothing', async () => {
  archived = []
  const view = renderWithMantine(<ArchiveView />)
  expect(await screen.findByText('Nothing is archived yet.')).toBeInTheDocument()
  view.unmount()
  archived = [row(1, '2026-10-15T12:00:00.000Z')]
  renderWithMantine(<ArchiveView />)
  await screen.findByRole('button', { name: '#1 Ticket 1' })
  await userEvent.type(screen.getByRole('textbox', { name: 'Search the archive' }), 'zzz')
  expect(await screen.findByText('No archived tickets match.')).toBeInTheDocument()
})

test('the search box asks for the matches after typing stops, starting from the board search it was opened with', async () => {
  useMainbus.setState({ archiveQuery: 'Ticket 2' })
  renderWithMantine(<ArchiveView />)
  expect(screen.getByRole('textbox', { name: 'Search the archive' })).toHaveValue('Ticket 2')
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('archive.list', { query: 'Ticket 2', limit: 50 }))
  expect(await screen.findByRole('button', { name: '#2 Ticket 2' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '#3 Ticket 3' })).not.toBeInTheDocument()
})

test('Load more asks for the page after the last row and adds it', async () => {
  archived = Array.from({ length: 60 }, (_, i) => row(60 - i, `2026-11-15T12:00:${String(59 - i).padStart(2, '0')}.000Z`))
  useMainbus.setState({ archivedCount: 60 })
  renderWithMantine(<ArchiveView />)
  await screen.findByRole('button', { name: '#60 Ticket 60' })
  expect(screen.getByText('Showing 50 of 60')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Load more (10 left)' }))
  expect(await screen.findByRole('button', { name: '#1 Ticket 1' })).toBeInTheDocument()
  expect(mockInvoke).toHaveBeenCalledWith('archive.list', { query: '', before: { archivedAt: '2026-11-15T12:00:10.000Z', number: 11 }, limit: 50 })
  expect(screen.getByText('Showing 60 of 60')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
})

test('Restore on a row restores that ticket, announces it and moves focus to the next row', async () => {
  renderWithMantine(<ArchiveView />)
  await screen.findByRole('button', { name: '#3 Ticket 3' })
  await userEvent.click(screen.getByRole('button', { name: 'Restore #3 Ticket 3' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.unarchive', ['t3'])
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '#3 Ticket 3' })).not.toBeInTheDocument())
  expect(useMainbus.getState().announcement?.text).toBe('Restored #3 Ticket 3 to Done')
  await vi.waitFor(() => expect(screen.getByRole('button', { name: '#2 Ticket 2' })).toHaveFocus())
})

test('selected rows restore together; Select all shown selects every row; focus never falls to the page', async () => {
  renderWithMantine(<ArchiveView />)
  await screen.findByRole('button', { name: '#3 Ticket 3' })
  const bulk = screen.getByRole('button', { name: 'Restore selected (0)' })
  expect(bulk).toBeDisabled()
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select #3 Ticket 3' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Select #1 Ticket 1' }))
  expect(screen.getByRole('button', { name: 'Restore selected (2)' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Restore selected (2)' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.unarchive', ['t3', 't1'])
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: '#1 Ticket 1' })).not.toBeInTheDocument())
  expect(useMainbus.getState().announcement?.text).toBe('Restored 2 tickets to Done')
  expect(screen.getByRole('button', { name: '#2 Ticket 2' })).toHaveFocus()

  await userEvent.click(screen.getByRole('checkbox', { name: 'Select all shown' }))
  expect(screen.getByRole('checkbox', { name: 'Select #2 Ticket 2' })).toBeChecked()
  await userEvent.click(screen.getByRole('button', { name: 'Restore selected (1)' }))
  await screen.findByText('Nothing is archived yet.')
  expect(screen.getByRole('textbox', { name: 'Search the archive' })).toHaveFocus()
})

test('opening a row opens the ticket; the back link returns to the board', async () => {
  renderWithMantine(<ArchiveView />)
  await userEvent.click(await screen.findByRole('button', { name: '#2 Ticket 2' }))
  expect(useMainbus.getState().currentTicketId).toBe('t2')
  expect(useMainbus.getState().archiveOpen).toBe(true)
  await userEvent.click(screen.getByRole('button', { name: /board$/ }))
  expect(useMainbus.getState().archiveOpen).toBe(false)
  expect(listCalls().length).toBeGreaterThan(0)
})
