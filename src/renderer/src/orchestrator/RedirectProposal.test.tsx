import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, RedirectPayload } from '../../../shared/proposals'
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

const PAYLOAD: RedirectPayload = {
  ticketId: 't3',
  number: 3,
  title: 'Add login',
  agentRunId: 'r1',
  episodeId: 'e1',
  role: 'Implementer',
  episodeEvidence: ['Bash failed 5 times in a row: npm test', 'Last error: timed out'],
  message: 'Timeouts are ruled out; check the shared fixtures instead.'
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'redirect',
    origin: 'orchestrator',
    payload: PAYLOAD,
    evidence: 'It is the same timeout every time',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

test('shows the episode evidence and the message, with Confirm, Override and Reject', () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Redirect the Implementer on #3 Add login' })
  expect(within(card).getByText('Bash failed 5 times in a row: npm test')).toBeInTheDocument()
  expect(within(card).getByText('Last error: timed out')).toBeInTheDocument()
  expect(within(card).getByText('Timeouts are ruled out; check the shared fixtures instead.')).toBeInTheDocument()
  expect(within(card).getByText('Why: It is the same timeout every time')).toBeInTheDocument()
  for (const name of ['Confirm', 'Override', 'Reject']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
})

test('Confirm confirms as proposed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test('Override edits the message', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  const box = screen.getByRole('textbox', { name: 'Message to the agent' })
  expect(box).toHaveValue(PAYLOAD.message)
  await userEvent.clear(box)
  // An empty message can't be confirmed.
  expect(screen.getByRole('button', { name: 'Confirm with changes' })).toBeDisabled()
  await userEvent.type(box, 'Look at test/shared.')
  await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { message: 'Look at test/shared.' })
})

test('Reject rejects', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.reject', 'p1')
})

test('a confirmed redirect is a receipt with the message', () => {
  const result = { ticketId: 't3', number: 3, title: 'Add login', role: 'Implementer', message: 'Check the fixtures.' }
  renderWithMantine(<ProposalCard proposal={proposal({ status: 'confirmed', result })} />)
  expect(screen.getByText(/Redirected the Implementer on/)).toHaveTextContent('Redirected the Implementer on #3: Check the fixtures.')
})

test('a stale redirect shows why it failed', () => {
  const result = { error: 'The Implementer on #3 is no longer stuck: that episode has closed. Nothing was interrupted.' }
  renderWithMantine(<ProposalCard proposal={proposal({ status: 'failed', result })} />)
  expect(screen.getByText(/no longer stuck/)).toHaveTextContent('Failed: ')
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
