import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Hold } from '../../../shared/domain'
import { nextMonday, tomorrow } from '../../../shared/hold'
import { invoke, onEngineEvent } from '../api'
import { HoldChip } from '../board/HoldChip'
import { TicketCard } from '../board/TicketCard'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeTicket, renderWithMantine, workspace } from '../test-utils'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

// Wednesday 4 November 2026, 15:30 local.
const NOW = new Date(2026, 10, 4, 15, 30)

function hold(until: Date | null): Hold {
  return {
    id: 'h1',
    targetKind: 'ticket',
    targetId: 't',
    reason: null,
    until: until?.toISOString() ?? null,
    createdBy: 'user',
    createdAt: NOW.toISOString(),
    releasedAt: null
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

describe('the hold chip', () => {
  test.each([
    [null, 'Held by you'],
    [new Date(2026, 10, 5), 'Held until Thu'],
    [new Date(2026, 10, 10), 'Held until Tue'],
    [new Date(2026, 10, 12), 'Held until Nov 12']
  ])('a hold until %s reads "%s"', (until, label) => {
    renderWithMantine(<HoldChip hold={hold(until)} now={NOW} />)
    expect(screen.getByText(label)).toBeInTheDocument()
  })

  test('is not there for a ticket that is not held', () => {
    const { container } = renderWithMantine(<HoldChip hold={null} />)
    expect(container.querySelector('[data-hold-chip]')).toBeNull()
  })

  test('shows on the board card of a held ticket, and not on others', () => {
    const held = makeTicket({ title: 'Held one', hold: hold(null) })
    const { unmount } = renderWithMantine(<TicketCard ticket={held} onOpen={() => {}} />)
    expect(screen.getByText('Held by you')).toBeInTheDocument()
    unmount()
    renderWithMantine(<TicketCard ticket={makeTicket({ title: 'Free one' })} onOpen={() => {}} />)
    expect(screen.queryByText(/^Held/)).not.toBeInTheDocument()
  })
})

describe('Hold… in the ticket view', () => {
  function show(over: Parameters<typeof makeTicket>[0] = {}) {
    const ticket = makeTicket({ title: 'Add dark mode', number: 12, manualColumn: 'ready', ...over }, { column: 'ready' })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    renderWithMantine(<TicketView />)
    return ticket
  }

  async function pick(item: string) {
    await userEvent.click(screen.getByRole('button', { name: 'Hold…' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: item }))
  }

  test('offers No date, Tomorrow, Monday and Pick a date', async () => {
    show()
    await userEvent.click(screen.getByRole('button', { name: 'Hold…' }))
    const items = (await screen.findAllByRole('menuitem')).map((i) => i.textContent)
    expect(items).toEqual(['No date', 'Tomorrow', 'Monday', 'Pick a date'])
  })

  test('No date holds the ticket with no date', async () => {
    const t = show()
    await pick('No date')
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.hold', t.id, {}))
  })

  test('Tomorrow and Monday hold until the start of that day', async () => {
    const t = show()
    await pick('Tomorrow')
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.hold', t.id, { until: tomorrow(new Date()).toISOString() }))
    await pick('Monday')
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.hold', t.id, { until: nextMonday(new Date()).toISOString() }))
  })

  test('Pick a date asks for a day after today, then holds until it', async () => {
    const t = show()
    await pick('Pick a date')
    const dialog = await screen.findByRole('dialog', { name: 'Hold until a date' })
    const input = dialog.querySelector('input[type="date"]') as HTMLInputElement
    const target = new Date()
    target.setDate(target.getDate() + 10)
    const value = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`

    // A day that has passed can't be held until.
    await userEvent.clear(input)
    await userEvent.type(input, '2020-01-01')
    expect(screen.getByRole('button', { name: 'Hold' })).toBeDisabled()
    expect(screen.getByText('Pick a day after today')).toBeInTheDocument()

    await userEvent.clear(input)
    await userEvent.type(input, value)
    await userEvent.click(screen.getByRole('button', { name: 'Hold' }))
    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('ticket.hold', t.id, {
        until: new Date(target.getFullYear(), target.getMonth(), target.getDate()).toISOString()
      })
    )
  })

  test('a held ticket shows its chip in the header and Unhold, which releases it', async () => {
    const t = show({ hold: hold(null) })
    expect(screen.getByText('Held by you')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Unhold' }))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.unhold', t.id))
  })

  test('a ticket that is not held has no Unhold', () => {
    show()
    expect(screen.queryByRole('button', { name: 'Unhold' })).not.toBeInTheDocument()
  })

  test('a Done ticket cannot be held', () => {
    const ticket = makeTicket({ manualColumn: 'done' }, { column: 'done', phase: 'done' })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    renderWithMantine(<TicketView />)
    expect(screen.queryByRole('button', { name: 'Hold…' })).not.toBeInTheDocument()
  })
})

describe('accessibility', () => {
  test('the Hold… menu and a held ticket have no axe violations', async () => {
    const ticket = makeTicket({ title: 'Add dark mode', number: 12, manualColumn: 'ready' }, { column: 'ready' })
    useMainbus.setState({ workspace, tickets: [ticket], currentTicketId: ticket.id })
    renderWithMantine(<TicketView />)
    await userEvent.click(screen.getByRole('button', { name: 'Hold…' }))
    await screen.findByRole('menuitem', { name: 'Tomorrow' })
    await expectNoAxeViolations()
  })
})
