import { screen } from '@testing-library/react'
import type { StuckEpisode } from '../../../shared/domain'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from '../ticket/TicketView'
import { StuckChip, StuckEvidence } from './StuckChip'
import { TicketCard } from './TicketCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

function episode(over: Partial<StuckEpisode> = {}): StuckEpisode {
  return {
    id: 'e1',
    agentRunId: 'r1',
    rule: 'repeated_failure',
    evidence: ['Bash failed 5 times in a row: npm test', 'Last error: exit code 1'],
    hitCount: 1,
    needsCloserLook: false,
    openedAt: '2026-11-02T09:00:00.000Z',
    lastHitAt: '2026-11-02T09:00:00.000Z',
    escalatedAt: null,
    redirectedAt: null,
    ...over
  }
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

describe('the Looks stuck chip', () => {
  test('says Looks stuck while an episode is open, and is not there otherwise', () => {
    const { container, unmount } = renderWithMantine(<StuckChip stuck={episode()} />)
    expect(screen.getByText('Looks stuck')).toBeInTheDocument()
    expect(container.querySelector('[data-stuck-chip]')).not.toBeNull()
    unmount()

    const none = renderWithMantine(<StuckChip stuck={null} />)
    expect(none.container.querySelector('[data-stuck-chip]')).toBeNull()
  })

  test('shows on the board card of a stuck ticket, and not on other cards', () => {
    const stuck = makeTicket({ title: 'Stuck one', stuck: episode() }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    const fine = makeTicket({ title: 'Fine one' }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    const a = renderWithMantine(<TicketCard ticket={stuck} onOpen={() => {}} />)
    expect(a.container.querySelector('[data-stuck-chip]')).not.toBeNull()
    a.unmount()
    const b = renderWithMantine(<TicketCard ticket={fine} onOpen={() => {}} />)
    expect(b.container.querySelector('[data-stuck-chip]')).toBeNull()
  })
})

describe('the evidence', () => {
  test('lists each line the detector saw', () => {
    renderWithMantine(<StuckEvidence stuck={episode()} />)
    expect(screen.getByText('Looks stuck')).toBeInTheDocument()
    expect(screen.getByText('Bash failed 5 times in a row: npm test')).toBeInTheDocument()
    expect(screen.getByText('Last error: exit code 1')).toBeInTheDocument()
    expect(screen.queryByText(/Seen \d+ times/)).not.toBeInTheDocument()
  })

  test('from the third hit it asks for a closer look and says how often it was seen', () => {
    renderWithMantine(<StuckEvidence stuck={episode({ hitCount: 3, needsCloserLook: true })} />)
    expect(screen.getByText('Looks stuck: needs a closer look')).toBeInTheDocument()
    expect(screen.getByText('Seen 3 times.')).toBeInTheDocument()
  })

  test('is not there without an episode', () => {
    const { container } = renderWithMantine(<StuckEvidence stuck={null} />)
    expect(container.querySelector('[data-stuck-evidence]')).toBeNull()
  })

  test('the ticket view shows the chip in its header and the evidence below it', () => {
    const ticket = makeTicket({ stuck: episode() }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    const { container } = renderWithMantine(<TicketView />)
    expect(container.querySelector('[data-stuck-chip]')).not.toBeNull()
    expect(screen.getByText('Bash failed 5 times in a row: npm test')).toBeInTheDocument()
  })

  test('the ticket view of a ticket that is not stuck has neither', () => {
    const ticket = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    const { container } = renderWithMantine(<TicketView />)
    expect(container.querySelector('[data-stuck-chip]')).toBeNull()
    expect(container.querySelector('[data-stuck-evidence]')).toBeNull()
  })
})

test('the chip, the card and the evidence have no axe violations', async () => {
  const ticket = makeTicket({ stuck: episode({ needsCloserLook: true, hitCount: 3 }) }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
  useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
  renderWithMantine(<TicketView />)
  await expectNoAxeViolations()
})
