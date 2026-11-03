import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, ProposalKindName, RoleControlPayload } from '../../../shared/proposals'
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

const PAYLOAD: RoleControlPayload = { ticketId: 't3', number: 3, title: 'Add login', agentRunId: 'r1', role: 'Reviewer', next: 'Implementer' }

function proposal(kind: ProposalKindName, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind,
    origin: 'orchestrator',
    payload: PAYLOAD,
    evidence: 'It has been looping for an hour',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

test.each([
  ['pause', 'Pause the Reviewer on #3 Add login', 'The Reviewer pauses; Resume continues it.'],
  ['stop', 'Stop #3 Add login', 'The run stops and the ticket goes back to Ready.'],
  ['skip', 'Skip the Reviewer on #3 Add login', "The Reviewer's work so far is summarised for the next role (the Implementer)."]
] as const)('%s shows the ticket, role, reason and consequence, and offers no Override', (kind, summary, consequence) => {
  renderWithMantine(<ProposalCard proposal={proposal(kind)} />)
  const card = screen.getByRole('group', { name: `Proposal: ${summary}` })
  expect(within(card).getByText('#3 Add login')).toBeInTheDocument()
  expect(within(card).getByText('Active role: Reviewer')).toBeInTheDocument()
  expect(within(card).getByText(consequence)).toBeInTheDocument()
  expect(within(card).getByText('Why: It has been looping for an hour')).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Confirm' })).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: 'Override' })).not.toBeInTheDocument()
  expect(card.closest('[data-proposal-id]') ?? card).toHaveAttribute('data-proposal-id', 'p1')
})

test('skipping the last role says the ticket goes to Review', () => {
  renderWithMantine(<ProposalCard proposal={proposal('skip', { payload: { ...PAYLOAD, next: null } })} />)
  expect(screen.getByText("The Reviewer's work so far is summarised and the ticket goes to Review.")).toBeInTheDocument()
})

test('Confirm confirms with no override', async () => {
  renderWithMantine(<ProposalCard proposal={proposal('pause')} />)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test.each([
  ['pause', 'Paused the Reviewer on #3'],
  ['stop', 'Stopped #3; back in Ready'],
  ['skip', 'Skipped the Reviewer on #3']
] as const)('%s receipt, with the ticket number opening the ticket', async (kind, text) => {
  const result = { ticketId: 't3', number: 3, title: 'Add login', role: 'Reviewer', next: null }
  renderWithMantine(<ProposalCard proposal={proposal(kind, { status: 'confirmed', result })} />)
  expect(document.querySelector('[data-proposal="receipt"]')?.textContent).toBe(text)
  await userEvent.click(screen.getByRole('button', { name: '#3' }))
  expect(useMainbus.getState().currentTicketId).toBe('t3')
})

test('a failed one shows why', () => {
  renderWithMantine(
    <ProposalCard proposal={proposal('skip', { status: 'failed', result: { error: '#3 has moved on since this was proposed' } })} />
  )
  expect(screen.getByText('Failed: #3 has moved on since this was proposed')).toBeInTheDocument()
})

test('the card and its Override editor have no axe violations', async () => {
  renderWithMantine(<ProposalCard proposal={proposal('pause')} />)
  await expectNoAxeViolations()
  const override = screen.queryByRole('button', { name: 'Override' })
  if (override) {
    await userEvent.click(override)
    await expectNoAxeViolations()
  }
})
