import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { HoldPayload, Proposal } from '../../../shared/proposals'
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

const UNTIL = new Date(2026, 10, 20)
const PAYLOAD: HoldPayload = { ticketId: 't3', number: 3, title: 'Add login', until: UNTIL.toISOString(), reason: 'The API lands on the 20th' }

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'hold',
    origin: 'orchestrator',
    payload: PAYLOAD,
    evidence: null,
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

test('shows the ticket, the date and the reason, with Confirm, Override and Reject', () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Hold #3 Add login' })
  expect(within(card).getByText('#3 Add login')).toBeInTheDocument()
  expect(within(card).getByText(/^Held until /)).toBeInTheDocument()
  expect(within(card).getByText('Why: The API lands on the 20th')).toBeInTheDocument()
  for (const name of ['Confirm', 'Override', 'Reject']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
})

test('a hold with no date says it is held until released', () => {
  renderWithMantine(<ProposalCard proposal={proposal({ payload: { ...PAYLOAD, until: null } })} />)
  expect(screen.getByText('Held until you release it')).toBeInTheDocument()
})

test('Confirm confirms as proposed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test('Override can change the date', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  const input = screen.getByLabelText('Hold until') as HTMLInputElement
  expect(input.value).toBe('2026-11-20')
  await userEvent.clear(input)
  await userEvent.type(input, '2026-12-01')
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { until: new Date(2026, 11, 1).toISOString() })
})

test('Override can clear the date', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  await userEvent.click(screen.getByLabelText('No date'))
  expect(screen.getByLabelText('Hold until')).toBeDisabled()
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { until: null })
})

test('once confirmed it is a receipt that links to the ticket', async () => {
  renderWithMantine(
    <ProposalCard
      proposal={proposal({ status: 'confirmed', result: { ticketId: 't3', number: 3, title: 'Add login', until: UNTIL.toISOString() } })}
    />
  )
  expect(screen.getByText(/^Held/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '#3' }))
  expect(useMainbus.getState().currentTicketId).toBe('t3')
})

test('the card and its Override editor have no axe violations', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await expectNoAxeViolations()
  const override = screen.queryByRole('button', { name: 'Override' })
  if (override) {
    await userEvent.click(override)
    await expectNoAxeViolations()
  }
})
