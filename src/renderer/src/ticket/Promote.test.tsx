import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke, onEngineEvent } from '../api'
import { useMainbus } from '../store'
import { makeTicket, renderWithMantine, workspace } from '../test-utils'
import { ContextPane } from './ContextPane'
import { PromoteModal } from './PromoteModal'
import { TicketView } from './TicketView'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

let draft = { title: 'Why is login slow', spec: 'Cache the lookup.', drafted: true }

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  draft = { title: 'Why is login slow', spec: 'Cache the lookup.', drafted: true }
  mockInvoke.mockImplementation(async (command: string) => {
    if (command === 'ticket.draftPromotion') return draft
    if (command === 'thread.get') return { events: [], decisions: [], runs: [] }
    return undefined
  })
  vi.mocked(onEngineEvent).mockImplementation(() => () => {})
})

describe('PromoteModal', () => {
  function open(onClose = vi.fn()) {
    renderWithMantine(<PromoteModal opened ticketId="t1" onClose={onClose} />)
    return onClose
  }

  test('shows it is drafting, then the title and spec prefilled and editable', async () => {
    open()
    expect(screen.getByText('Drafting the spec from the report…')).toBeInTheDocument()
    expect(await screen.findByLabelText('Title')).toHaveValue('Why is login slow')
    expect(screen.getByLabelText('Spec')).toHaveValue('Cache the lookup.')
    expect(screen.queryByText(/Couldn't draft a spec/)).not.toBeInTheDocument()
    expect(mockInvoke).toHaveBeenCalledWith('ticket.draftPromotion', 't1')
  })

  test('Promote sends the edited title and spec, then closes', async () => {
    const onClose = open()
    const title = await screen.findByLabelText('Title')
    await userEvent.clear(title)
    await userEvent.type(title, 'Speed up login')
    const spec = screen.getByLabelText('Spec')
    await userEvent.clear(spec)
    await userEvent.type(spec, 'Edited spec')
    await userEvent.click(screen.getByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.promote', 't1', { title: 'Speed up login', spec: 'Edited spec' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  test('Cancel sends nothing', async () => {
    const onClose = open()
    await screen.findByLabelText('Title')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalledWith('ticket.promote', expect.anything(), expect.anything())
  })

  test('says when the spec could not be drafted and holds the report', async () => {
    draft = { title: 'Why', spec: '## From the investigation\n\n# R', drafted: false }
    open()
    expect(await screen.findByText("Couldn't draft a spec; it holds the report.")).toBeInTheDocument()
    expect(screen.getByLabelText('Spec')).toHaveValue('## From the investigation\n\n# R')
  })

  test('a blank title cannot be promoted', async () => {
    open()
    await userEvent.clear(await screen.findByLabelText('Title'))
    expect(screen.getByRole('button', { name: 'Promote' })).toBeDisabled()
  })

  test('a refusal on promote stays in the dialog', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'ticket.draftPromotion') return draft
      if (command === 'ticket.promote') throw new Error('#1 was already promoted to #2')
      return undefined
    })
    const onClose = open()
    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }))
    await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith('ticket.promote', 't1', expect.anything()))
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the Promote button and the links between the tickets', () => {
  function show(over: Parameters<typeof makeTicket>[0], state: Parameters<typeof makeTicket>[1], others: ReturnType<typeof makeTicket>[] = []) {
    const ticket = makeTicket({ title: 'Why is login slow', number: 1, ...over }, state)
    useMainbus.setState({ workspace, tickets: [ticket, ...others], currentTicketId: ticket.id })
    return ticket
  }
  const promoteButton = () => screen.queryByRole('button', { name: 'Promote' })

  test('is offered on an Investigate ticket with a report in Review or Done', async () => {
    show({ kind: 'investigate', report: '# R', manualColumn: 'done' }, { column: 'review', phase: 'ready_for_review' })
    renderWithMantine(<TicketView />)
    expect(await screen.findByRole('button', { name: 'Promote' })).toBeInTheDocument()
  })

  test('is offered in Done too', async () => {
    show({ kind: 'investigate', report: '# R', manualColumn: 'done' }, { column: 'done', phase: 'done' })
    renderWithMantine(<TicketView />)
    expect(await screen.findByRole('button', { name: 'Promote' })).toBeInTheDocument()
  })

  test.each([
    ['a Change ticket', { kind: 'change' as const, report: null }, { column: 'review' as const, phase: 'ready_for_review' as const }],
    ['no report', { kind: 'investigate' as const, report: null }, { column: 'review' as const, phase: 'ready_for_review' as const }],
    ['Backlog', { kind: 'investigate' as const, report: '# R' }, { column: 'backlog' as const, phase: 'not_started' as const }]
  ])('is not offered for %s', async (_name, over, state) => {
    show(over, state)
    renderWithMantine(<TicketView />)
    await screen.findByText('Why is login slow')
    expect(promoteButton()).not.toBeInTheDocument()
  })

  test('is not offered once the report was promoted, and links to the new ticket', async () => {
    const original = show({ kind: 'investigate', report: '# R', manualColumn: 'done' }, { column: 'done', phase: 'done' })
    const created = makeTicket({ title: 'Speed up login', number: 2, promotedFrom: original.id, report: '# R' })
    useMainbus.setState({ tickets: [original, created] })
    renderWithMantine(<TicketView />)
    expect(await screen.findByText('Promoted to')).toBeInTheDocument()
    expect(promoteButton()).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '#2 Speed up login' }))
    expect(useMainbus.getState().currentTicketId).toBe(created.id)
  })

  test('opens the dialog from the button', async () => {
    show({ kind: 'investigate', report: '# R', manualColumn: 'done' }, { column: 'review', phase: 'ready_for_review' })
    renderWithMantine(<TicketView />)
    await userEvent.click(await screen.findByRole('button', { name: 'Promote' }))
    const dialog = await screen.findByRole('dialog', { name: 'Promote to a Change ticket' })
    expect(await within(dialog).findByLabelText('Spec')).toHaveValue('Cache the lookup.')
  })

  test('the new Change ticket links back and shows the investigation report', async () => {
    const original = makeTicket({ title: 'Why is login slow', number: 1, kind: 'investigate', report: '# Findings\n\nIt is **X**.' })
    const created = makeTicket({ title: 'Speed up login', number: 2, promotedFrom: original.id, report: '# Findings\n\nIt is **X**.' })
    useMainbus.setState({ workspace, tickets: [original, created], currentTicketId: created.id })
    renderWithMantine(<ContextPane ticket={created} events={[]} decisions={[]} />)
    await userEvent.click(screen.getByRole('button', { name: '#1 Why is login slow' }))
    expect(useMainbus.getState().currentTicketId).toBe(original.id)
    expect(screen.getByText('Promoted from')).toBeInTheDocument()
    const report = screen.getByRole('region', { name: 'Investigation report' })
    expect(within(report).getByRole('heading', { name: 'Findings' })).toBeInTheDocument()
    expect(within(report).getByText('X').tagName).toBe('STRONG')
  })

  test('an ordinary ticket shows neither', () => {
    const t = makeTicket({ title: 'Plain' })
    useMainbus.setState({ workspace, tickets: [t] })
    renderWithMantine(<ContextPane ticket={t} events={[]} decisions={[]} />)
    expect(screen.queryByRole('region', { name: 'Promotion' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: 'Investigation report' })).not.toBeInTheDocument()
  })
})
