import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PromotePayload, Proposal } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const PAYLOAD: PromotePayload = {
  ticketId: 't1',
  number: 1,
  fromTitle: 'Why is login slow',
  title: 'Speed up login',
  spec: 'Cache the lookup.\nVerify with the benchmark.',
  specSource: 'summary'
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'promote',
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

test('shows the investigation, the new title and spec and where the spec came from, with Confirm, Override and Reject', () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Promote #1 Why is login slow to a Change ticket' })
  expect(within(card).getByText('From #1 Why is login slow')).toBeInTheDocument()
  expect(within(card).getByText('New Change ticket in Ready: Speed up login')).toBeInTheDocument()
  expect(within(card).getByText(/Cache the lookup\./)).toBeInTheDocument()
  expect(within(card).getByText(/^Spec drafted from the report\./)).toBeInTheDocument()
  for (const name of ['Confirm', 'Override', 'Reject']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
})

test('says when the spec is the report itself', () => {
  renderWithMantine(<ProposalCard proposal={proposal({ payload: { ...PAYLOAD, specSource: 'report' } })} />)
  expect(screen.getByText(/^Couldn't draft a spec; it holds the report\./)).toBeInTheDocument()
})

test('Confirm confirms as proposed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test('Override edits the title and spec', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  expect(screen.getByLabelText('Title')).toHaveValue('Speed up login')
  const title = screen.getByLabelText('Title')
  await userEvent.clear(title)
  await userEvent.type(title, 'Cache logins')
  const spec = screen.getByLabelText('Spec')
  await userEvent.clear(spec)
  await userEvent.type(spec, 'New spec')
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { title: 'Cache logins', spec: 'New spec' })
})

test('a blank title cannot be confirmed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  await userEvent.clear(screen.getByLabelText('Title'))
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
  expect(mockInvoke).not.toHaveBeenCalledWith('proposal.confirm', 'p1', expect.anything())
})

test('once confirmed it is a receipt that links to both tickets', async () => {
  renderWithMantine(
    <ProposalCard
      proposal={proposal({ status: 'confirmed', result: { ticketId: 't7', number: 7, title: 'Speed up login', fromTicketId: 't1', fromNumber: 1 } })}
    />
  )
  expect(screen.getByText(/^Promoted/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: '#7' }))
  expect(useMainbus.getState().currentTicketId).toBe('t7')
  await userEvent.click(screen.getByRole('button', { name: '#1' }))
  expect(useMainbus.getState().currentTicketId).toBe('t1')
})
