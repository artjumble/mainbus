import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'create_tickets',
    origin: 'orchestrator',
    payload: {
      intent: 'Please add login and logout',
      tickets: [
        { title: 'Login', spec: 'A form on /login', criteria: ['form renders', 'bad password refused'], labels: ['auth'] },
        { title: 'Logout', spec: '', criteria: [], labels: [] }
      ],
      column: 'backlog'
    },
    evidence: 'src/ has no auth module',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

describe('pending', () => {
  test('shows the heading, each draft and the evidence, with Create, Put in Ready instead and Reject', () => {
    useMainbus.setState({ workspace: { ...initial.workspace!, name: 'web-app' } })
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    const card = screen.getByRole('group', { name: 'Proposal: Create 2 tickets in Backlog' })
    expect(card).toHaveAttribute('data-proposal', 'pending')
    expect(within(card).getByText('Proposed action · create 2 tickets in web-app → Backlog')).toBeInTheDocument()
    expect(within(card).getByText('Login')).toBeInTheDocument()
    expect(within(card).getByText('A form on /login')).toBeInTheDocument()
    expect(within(card).getByText('2 acceptance criteria · labels: auth')).toBeInTheDocument()
    expect(within(card).getByText('Logout')).toBeInTheDocument()
    expect(within(card).getByText('Why: src/ has no auth module')).toBeInTheDocument()
    for (const name of ['Create 2 tickets', 'Put in Ready instead', 'Reject']) expect(within(card).getByRole('button', { name })).toBeEnabled()
    expect(within(card).queryByRole('button', { name: 'Override' })).not.toBeInTheDocument()
  })

  test('no evidence, no "Why"', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ evidence: null })} />)
    expect(screen.queryByText(/^Why:/)).not.toBeInTheDocument()
  })

  test('Create confirms the drafts as proposed', async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create 2 tickets' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', {
      tickets: [
        { title: 'Login', spec: 'A form on /login', criteria: ['form renders', 'bad password refused'], labels: ['auth'] },
        { title: 'Logout', spec: '', criteria: [], labels: [] }
      ],
      column: 'backlog'
    })
  })

  test('Put in Ready instead creates them in Ready', async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Put in Ready instead' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', expect.objectContaining({ column: 'ready' }))
  })

  test('Reject rejects it', async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.reject', 'p1')
  })

  test('a refused decision is shown, and the card stays as it is', async () => {
    mockInvoke.mockRejectedValue(new Error('Proposal p1 is rejected, not pending'))
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Create 2 tickets' }))
    expect(await screen.findByText('Proposal p1 is rejected, not pending')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create 2 tickets' })).toBeEnabled()
  })
})

describe('per-draft edit', () => {
  test("Edit opens that draft's fields in place, with the proposal as their defaults", async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    const first = screen.getByRole('group', { name: 'Draft 1' })
    expect(within(first).getByRole('checkbox', { name: 'Include Login' })).toBeChecked()
    expect(within(first).queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
    await userEvent.click(within(first).getByRole('button', { name: 'Edit Login' }))
    expect(within(first).getByRole('textbox', { name: 'Title' })).toHaveValue('Login')
    expect(within(first).getByRole('textbox', { name: 'Spec' })).toHaveValue('A form on /login')
    expect(within(first).getByRole('textbox', { name: 'Criteria (one per line)' })).toHaveValue('form renders\nbad password refused')
    expect(within(first).getByRole('textbox', { name: 'Labels (comma separated)' })).toHaveValue('auth')
    expect(within(screen.getByRole('group', { name: 'Draft 2' })).queryByRole('textbox', { name: 'Title' })).not.toBeInTheDocument()
  })

  test('edits a title, leaves a draft out and puts the rest in Ready', async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    const first = screen.getByRole('group', { name: 'Draft 1' })
    await userEvent.click(within(first).getByRole('button', { name: 'Edit Login' }))
    const title = within(first).getByRole('textbox', { name: 'Title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Sign in')
    await userEvent.type(within(first).getByRole('textbox', { name: 'Criteria (one per line)' }), '\n\n  locks after 5 tries  ')
    await userEvent.type(within(first).getByRole('textbox', { name: 'Labels (comma separated)' }), ', security,')
    await userEvent.click(within(screen.getByRole('group', { name: 'Draft 2' })).getByRole('checkbox', { name: 'Include Logout' }))
    expect(screen.getByRole('button', { name: 'Create 1 ticket' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Put in Ready instead' }))

    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', {
      tickets: [
        {
          title: 'Sign in',
          spec: 'A form on /login',
          criteria: ['form renders', 'bad password refused', 'locks after 5 tries'],
          labels: ['auth', 'security']
        }
      ],
      column: 'ready'
    })
  })

  test('with every draft left out there is nothing to create', async () => {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Login' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Include Logout' }))
    expect(screen.getByRole('button', { name: 'Create 0 tickets' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Put in Ready instead' })).toBeDisabled()
  })
})

describe('receipt', () => {
  const created = { tickets: [{ id: 't21', number: 21, title: 'Login' }, { id: 't22', number: 22, title: 'Logout' }], column: 'backlog' }

  test('created: one line, each number opening its ticket', async () => {
    renderWithMantine(<ProposalCard proposal={proposal({ status: 'confirmed', result: created })} />)
    const receipt = document.querySelector('[data-proposal="receipt"]')!
    expect(receipt).toHaveTextContent('Created #21 and #22 in Backlog')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(screen.queryByText('A form on /login')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '#22' }))
    expect(useMainbus.getState().currentTicketId).toBe('t22')
  })

  test('overridden reads the same', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ status: 'overridden', result: { tickets: [created.tickets[0]], column: 'ready' } })} />)
    expect(document.querySelector('[data-proposal="receipt"]')).toHaveTextContent('Created #21 in Ready')
  })

  test('rejected', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ status: 'rejected' })} />)
    expect(document.querySelector('[data-proposal="receipt"]')).toHaveTextContent(/^Rejected$/)
  })

  test('failed shows the error', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ status: 'failed', result: { error: 'FOREIGN KEY constraint failed' } })} />)
    expect(screen.getByText('Failed: FOREIGN KEY constraint failed')).toBeInTheDocument()
  })

  test('confirmed and still being carried out', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ status: 'confirmed', result: null })} />)
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })
})

test('the card and a draft being edited have no axe violations', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await expectNoAxeViolations()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Login' }))
  await expectNoAxeViolations()
})

test.each([
  ['accepted', { status: 'accepted', result: { tickets: [] } }],
  ['rejected', { status: 'rejected' }],
  ['failed', { status: 'failed', result: { error: 'Nope' } }],
  ['working', { status: 'accepted', result: null }]
] as const)('a %s receipt has no axe violations', async (_name, over) => {
  renderWithMantine(<ProposalCard proposal={proposal(over as never)} />)
  await expectNoAxeViolations()
})
