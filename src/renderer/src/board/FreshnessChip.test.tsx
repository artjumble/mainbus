import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { BranchFreshness, TicketState } from '../../../shared/domain'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from '../ticket/TicketView'
import { FreshnessChip } from './FreshnessChip'
import { TicketCard } from './TicketCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function fresh(over: Partial<BranchFreshness> = {}): BranchFreshness {
  return { baseBranch: 'main', base: 'origin/main', behind: 3, conflicts: [], checkedAt: '2026-11-07T10:00:00.000Z', fetchError: null, ...over }
}

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  ;(onEngineEvent as unknown as ReturnType<typeof vi.fn>).mockReturnValue(() => {})
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    if (command === 'board.get') return { tickets: useMainbus.getState().tickets }
    return undefined
  })
})

describe('FreshnessChip', () => {
  test('is a quiet Behind main chip when the branch lacks commits and merges cleanly', () => {
    const { container } = renderWithMantine(<FreshnessChip freshness={fresh()} done={false} />)
    expect(screen.getByText('Behind main')).toBeInTheDocument()
    expect(container.querySelector('[data-freshness-chip="behind"]')).not.toBeNull()
  })

  test('is a Conflicts with main chip when a merge would conflict', () => {
    const { container } = renderWithMantine(<FreshnessChip freshness={fresh({ conflicts: ['a.sql'] })} done={false} />)
    expect(screen.getByText('Conflicts with main')).toBeInTheDocument()
    expect(container.querySelector('[data-freshness-chip="conflicts"]')).not.toBeNull()
  })

  test('names the workspace base branch', () => {
    renderWithMantine(<FreshnessChip freshness={fresh({ baseBranch: 'develop' })} done={false} />)
    expect(screen.getByText('Behind develop')).toBeInTheDocument()
  })

  test('shows nothing when up to date, not checked, or Done', () => {
    const { container } = renderWithMantine(
      <>
        <FreshnessChip freshness={fresh({ behind: 0 })} done={false} />
        <FreshnessChip freshness={null} done={false} />
        <FreshnessChip freshness={fresh({ conflicts: ['a.sql'] })} done />
      </>
    )
    expect(container.querySelector('[data-freshness-chip]')).toBeNull()
  })

  test('is on the ticket card', async () => {
    const ticket = makeTicket({ branch: 'mainbus/1-x', freshness: fresh({ conflicts: ['a.sql'] }) }, { column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' })
    const { container } = renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
    expect(screen.getByText('Conflicts with main')).toBeInTheDocument()
    await expectNoAxeViolations(container)
  })
})

describe('Update from main in the ticket view', () => {
  const withFolder = { worktreePath: 'C:/wt/1', branch: 'mainbus/1-x' }

  function show(state: Partial<TicketState>, over: Record<string, unknown> = {}): ReturnType<typeof makeTicket> {
    const ticket = makeTicket({ ...withFolder, freshness: fresh({ conflicts: ['migrations/journal.txt'] }), ...over }, state)
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    return ticket
  }

  test('lists the conflicting files, and updating from Review asks, then starts the update', async () => {
    const ticket = show({ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' })
    renderWithMantine(<TicketView />)
    expect(await screen.findByText('3 commits behind origin/main.')).toBeInTheDocument()
    expect(screen.getByText('migrations/journal.txt')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Update from main' }))
    expect(screen.getByText(/The Implementer merges main \(3 new commits\)/)).toBeInTheDocument()
    expect(screen.queryByText(/run ends first/)).not.toBeInTheDocument()
    await userEvent.click(screen.getAllByRole('button', { name: 'Update from main' }).at(-1)!)
    expect(mockInvoke).toHaveBeenCalledWith('ticket.updateFromMain', ticket.id)
  })

  test('on a paused run, the dialog says the run ends and the ticket goes to Review', async () => {
    show({ column: 'in_progress', phase: 'implementing', agentStatus: 'paused', canContinue: true }, {})
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Update from main' }))
    expect(screen.getByText(/run ends first \(it counts as stopped\)\. The ticket goes to Review afterwards, and Start again runs the lineup from a summary\./)).toBeInTheDocument()
  })

  test('is offered while a run waits on the user', async () => {
    show({ column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' })
    renderWithMantine(<TicketView />)
    expect(await screen.findByRole('button', { name: 'Update from main' })).toBeInTheDocument()
  })

  test('is not offered while a role works or is queued, when up to date, in Done, or for an Investigate ticket', async () => {
    const cases: Array<[Partial<TicketState>, Record<string, unknown>]> = [
      [{ column: 'in_progress', phase: 'implementing', agentStatus: 'working' }, {}],
      [{ column: 'in_progress', phase: 'implementing', agentStatus: 'queued' }, {}],
      [{ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' }, { freshness: fresh({ behind: 0 }) }],
      [{ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' }, { freshness: null }],
      [{ column: 'done', phase: 'done', agentStatus: null }, { manualColumn: 'done' }],
      [{ column: 'review', phase: 'ready_for_review', agentStatus: 'handed_off' }, { kind: 'investigate' }]
    ]
    for (const [state, over] of cases) {
      show(state, over)
      const { unmount } = renderWithMantine(<TicketView />)
      await screen.findByRole('heading', { level: 2 })
      expect(screen.queryByRole('button', { name: 'Update from main' })).not.toBeInTheDocument()
      unmount()
    }
  })
})
