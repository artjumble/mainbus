import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, ReplacePayload } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, makeTicket, renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const PAYLOAD: ReplacePayload = {
  ticketId: 't3',
  number: 3,
  title: 'Add login',
  agentRunId: 'r1',
  role: 'Implementer',
  episodeId: 'e1',
  episodeEvidence: ['Bash failed 5 times in a row: npm test', 'Last error: timed out'],
  reason: 'A fresh agent will not repeat the dead end',
  model: 'opus',
  effort: 'high',
  extraInstructions: null
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'replace',
    origin: 'orchestrator',
    payload: PAYLOAD,
    evidence: 'The redirect did not help',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

const CARD = 'Proposal: Replace the Implementer on Add login'

test('shows the evidence lines and the three choices: Keep current, Override and Replace <role>', () => {
  useMainbus.setState({
    tickets: [
      makeTicket({ id: 't3', lineup: [
        { id: 'a', name: 'Planner', status: 'handed_off', active: false, replacements: 0 },
        { id: 'b', name: 'Implementer', status: 'working', active: true, replacements: 0 }
      ] })
    ]
  })
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: CARD })
  expect(within(card).getByRole('list', { name: 'Why it looks stuck' })).toBeInTheDocument()
  expect(within(card).getByText('PROPOSED ACTION', { exact: false })).toBeInTheDocument()
  expect(within(card).getByText("The new Implementer gets the plan, decisions so far, and a handoff of what was tried. The Planner's work is kept.")).toBeInTheDocument()
  // Keep current and Override come before the full-width Replace.
  expect(within(card).getAllByRole('button').slice(0, 3).map((b) => b.textContent)).toEqual(['Keep current', 'Override', 'Replace Implementer'])
  expect(within(card).getByText('Bash failed 5 times in a row: npm test')).toBeInTheDocument()
  expect(within(card).getByText('Last error: timed out')).toBeInTheDocument()
  expect(within(card).getByText('Why: The redirect did not help')).toBeInTheDocument()
  for (const name of ['Keep current', 'Override', 'Replace Implementer']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument()
})

test('the Replace… button’s card has no episode, so no evidence lines', () => {
  const payload = { ...PAYLOAD, episodeId: null, episodeEvidence: [] }
  renderWithMantine(<ProposalCard proposal={proposal({ origin: 'button', payload, evidence: 'You pressed Replace… on #3.' })} />)
  const card = screen.getByRole('group', { name: CARD })
  expect(within(card).queryByLabelText('Why it looks stuck')).not.toBeInTheDocument()
  for (const name of ['Keep current', 'Override', 'Replace Implementer']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
})

test('Replace <role> confirms as proposed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Replace Implementer' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

test('Keep current rejects it', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Keep current' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.reject', 'p1')
})

test('Override changes the new run’s model, effort and extra instructions', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  const model = screen.getByRole('combobox', { name: 'Model' })
  const effort = screen.getByRole('combobox', { name: 'Effort' })
  expect(model).toHaveValue('opus')
  expect(effort).toHaveValue('high')
  await userEvent.selectOptions(model, 'haiku')
  await userEvent.selectOptions(effort, 'low')
  await userEvent.type(screen.getByRole('textbox', { name: 'Extra instructions' }), 'Check the fixtures first')
  await userEvent.click(screen.getByRole('button', { name: 'Replace Implementer with changes' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { model: 'haiku', effort: 'low', extraInstructions: 'Check the fixtures first' })
})

test('Override can be cancelled, back to the card as it was', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(screen.getByRole('button', { name: 'Override' }))
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Replace Implementer' })).toBeInTheDocument()
  expect(mockInvoke).not.toHaveBeenCalled()
})

test('a confirmed replacement is a receipt with the model and effort', () => {
  const result = { ticketId: 't3', number: 3, title: 'Add login', role: 'Implementer', model: 'haiku', effort: 'low' }
  renderWithMantine(<ProposalCard proposal={proposal({ status: 'overridden', result })} />)
  expect(screen.getByText(/Replaced the Implementer on/)).toHaveTextContent('Replaced the Implementer on #3 (Haiku · Low)')
})

test('a stale replacement shows why it failed', () => {
  const result = { error: 'The Implementer on #3 is no longer stuck: that episode has closed. Nothing was replaced.' }
  renderWithMantine(<ProposalCard proposal={proposal({ status: 'failed', result })} />)
  expect(screen.getByText(/Nothing was replaced/)).toHaveTextContent('Failed: ')
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
