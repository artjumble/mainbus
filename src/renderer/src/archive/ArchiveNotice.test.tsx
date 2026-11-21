import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine, workspace } from '../test-utils'
import { ArchiveNotice } from './ArchiveNotice'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), openFolder: vi.fn() }))
vi.mock('../notify', () => ({ showError: vi.fn() }))

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()
const batch = { id: 'b1', workspaceId: 'w1', kind: 'sweep' as const, olderThanDays: 14, count: 12, createdAt: '2026-11-10T00:00:00.000Z' }

beforeEach(() => {
  mockInvoke.mockReset()
  useMainbus.setState({ ...initial, workspace, workspaceLoaded: true, archiveNotice: batch }, true)
})

test('says what was archived, automatically', async () => {
  const { container } = renderWithMantine(<ArchiveNotice />)
  expect(screen.getByText('Archived 12 Done tickets older than 14 days automatically.')).toBeInTheDocument()
  expect(screen.getByRole('status', { name: 'Archived tickets' })).toBeInTheDocument()
  await expectNoAxeViolations(container)
})

test('nothing shows without a notice, and the status region stays', () => {
  useMainbus.setState({ archiveNotice: null })
  renderWithMantine(<ArchiveNotice />)
  expect(screen.getByRole('status', { name: 'Archived tickets' })).toBeEmptyDOMElement()
})

test('Restore all archived by this restores that batch, refreshes and announces', async () => {
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'archive.restoreBatch') return 12
    return { tickets: [], archived: 0, archiveNotice: null }
  })
  renderWithMantine(<ArchiveNotice />)
  await userEvent.click(screen.getByRole('button', { name: 'Restore all archived by this' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('archive.restoreBatch', 'b1'))
  await vi.waitFor(() => expect(useMainbus.getState().announcement?.text).toBe('Restored 12 tickets to Done'))
  await vi.waitFor(() => expect(useMainbus.getState().archiveNotice).toBeNull())
})

test('Close closes the notice for good', async () => {
  mockInvoke.mockResolvedValue(undefined)
  renderWithMantine(<ArchiveNotice />)
  await userEvent.click(screen.getByRole('button', { name: 'Close' }))
  await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('archive.closeNotice', 'b1'))
  expect(useMainbus.getState().archiveNotice).toBeNull()
  expect(screen.queryByTestId('archive-notice')).not.toBeInTheDocument()
})
