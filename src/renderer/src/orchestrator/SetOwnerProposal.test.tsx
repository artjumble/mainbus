import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, SetOwnerPayload } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'
import { expectCardAccessible } from './proposalTestUtils'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const PAYLOAD: SetOwnerPayload = { ticketId: 't3', number: 3, title: 'Check on a Mac', owner: 'human', reason: 'Only you can run it on a Mac' }

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'set_owner',
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

test('marking as yours: the ticket, the You badge, the reason and the effect, confirmed as it is', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Mark #3 Check on a Mac as yours' })
  expect(within(card).getByText('#3 Check on a Mac')).toBeInTheDocument()
  expect(card.querySelectorAll('[data-you-badge]')).toHaveLength(1)
  expect(within(card).getByText('Why: Only you can run it on a Mac')).toBeInTheDocument()
  expect(within(card).getByText(/No agent will start on it/)).toBeInTheDocument()
  await userEvent.click(within(card).getByRole('button', { name: 'Mark as yours' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test('handing to agents says what changes, with no badge', () => {
  renderWithMantine(<ProposalCard proposal={proposal({ payload: { ...PAYLOAD, owner: 'agent' } })} />)
  const card = screen.getByRole('group', { name: 'Proposal: Hand #3 Check on a Mac to agents' })
  expect(card.querySelectorAll('[data-you-badge]')).toHaveLength(0)
  expect(within(card).getByText(/Agents can then work on it/)).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Hand to agents' })).toBeInTheDocument()
})

test('the receipt says what happened, with a link to the ticket', () => {
  renderWithMantine(
    <ProposalCard
      proposal={proposal({ status: 'confirmed', result: { ticketId: 't3', number: 3, title: 'Check on a Mac', owner: 'human' }, decidedAt: '2026-11-01T10:01:00.000Z' })}
    />
  )
  expect(screen.getByRole('button', { name: '#3' })).toBeInTheDocument()
  expect(document.body.textContent).toContain('Marked #3 as yours')
})

test('the card has no axe violations', async () => {
  await expectCardAccessible(proposal(), { override: false })
})
