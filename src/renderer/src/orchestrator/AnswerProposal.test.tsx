import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AnswerPayload, Proposal } from '../../../shared/proposals'
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

const PAYLOAD: AnswerPayload = {
  decisionId: 'd1',
  ticketId: 't3',
  number: 3,
  title: 'Add login',
  question: 'Which database?',
  decisionKind: 'question',
  options: ['SQLite', 'Postgres', 'MySQL'],
  allowAlways: false,
  choice: 1,
  note: null,
  judgement: null
}

const JUDGED: AnswerPayload = {
  ...PAYLOAD,
  choice: 0,
  judgement: {
    reason: 'widens_intent',
    requirement: 'Add a login form',
    proposed: 'Also add SSO and a user database',
    smallest_option: 'SQLite, nothing new to run',
    consequences: [
      { option: 'SQLite', consequence: 'Simple, one file' },
      { option: 'Postgres', consequence: 'A server to run' },
      { option: 'MySQL', consequence: 'A different server to run' }
    ],
    recommendation: 'SQLite keeps it within what you asked'
  }
}

function proposal(payload: AnswerPayload, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'answer',
    origin: 'orchestrator',
    payload,
    evidence: 'You said to use Postgres',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

describe('a plain recommendation', () => {
  test('shows the question, the recommended answer and the reasoning, with Confirm, Override and Reject', () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD)} />)
    const card = screen.getByRole('group', { name: 'Proposal: Answer #3: Which database?' })
    expect(within(card).getByText('Which database?')).toBeInTheDocument()
    expect(within(card).getByText('Recommended answer: Postgres')).toBeInTheDocument()
    expect(within(card).getByText('Why: You said to use Postgres')).toBeInTheDocument()
    for (const name of ['Confirm', 'Override', 'Reject']) expect(within(card).getByRole('button', { name })).toBeInTheDocument()
  })

  test('Confirm confirms with no override', async () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
  })

  test('Override picks another option and edits the note', async () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Override' }))
    expect(screen.getByRole('radio', { name: 'Postgres' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'MySQL' }))
    await userEvent.type(screen.getByLabelText('Note to the agent'), 'Ops runs MySQL')
    await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { choice: 2, note: 'Ops runs MySQL' })
  })

  test('Reject rejects', async () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.reject', 'p1')
  })

  test('a permission request is overridden with Allow once, Always allow or Deny', async () => {
    const permission: AnswerPayload = { ...PAYLOAD, decisionKind: 'permission', options: ['Allow once', 'Always allow', 'Deny'], allowAlways: true, choice: 'allow_once', question: 'Run npm install?' }
    renderWithMantine(<ProposalCard proposal={proposal(permission)} />)
    expect(screen.getByText('Recommended answer: Allow once')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Override' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Deny' }))
    await userEvent.click(screen.getByRole('button', { name: 'Confirm with changes' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { choice: 'deny', note: null })
  })
})

describe('a judgement card', () => {
  test('leads with the reason and lays out the requirement, proposal, smallest option, consequences and recommendation', () => {
    renderWithMantine(<ProposalCard proposal={proposal(JUDGED)} />)
    const card = screen.getByRole('group', { name: 'Proposal: Needs your judgement: this would widen your intent' })
    expect(within(card).getByText('Needs your judgement: this would widen your intent')).toBeInTheDocument()
    expect(within(card).getByText('Your requirement: Add a login form')).toBeInTheDocument()
    expect(within(card).getByText('Proposed: Also add SSO and a user database')).toBeInTheDocument()
    expect(within(card).getByText('Smallest option within your intent: SQLite, nothing new to run')).toBeInTheDocument()
    expect(within(card).getByText('SQLite: Simple, one file')).toBeInTheDocument()
    expect(within(card).getByText('Postgres: A server to run')).toBeInTheDocument()
    expect(within(card).getByText('Recommendation: SQLite keeps it within what you asked (SQLite)')).toBeInTheDocument()
  })

  test('its buttons are the options and Reject; there is no Confirm, Override or pre-selected option', () => {
    renderWithMantine(<ProposalCard proposal={proposal(JUDGED)} />)
    const card = screen.getByRole('group', { name: /Needs your judgement/ })
    expect(within(card).getAllByRole('button').map((b) => b.textContent)).toEqual(['SQLite', 'Postgres', 'MySQL', 'Reject'])
    expect(within(card).queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('button', { name: 'Override' })).not.toBeInTheDocument()
    expect(within(card).queryByRole('radio')).not.toBeInTheDocument()
    for (const b of within(card).getAllByRole('button')) expect(b).not.toHaveAttribute('aria-pressed', 'true')
  })

  test('with no recommended choice there is still nothing selected', () => {
    renderWithMantine(<ProposalCard proposal={proposal({ ...JUDGED, choice: null })} />)
    expect(screen.getByText('Recommendation: SQLite keeps it within what you asked')).toBeInTheDocument()
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['SQLite', 'Postgres', 'MySQL', 'Reject'])
  })

  test('choosing an option confirms with that option as the override', async () => {
    renderWithMantine(<ProposalCard proposal={proposal(JUDGED)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Postgres' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', { choice: 1, note: null })
  })

  test('Reject rejects', async () => {
    renderWithMantine(<ProposalCard proposal={proposal(JUDGED)} />)
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.reject', 'p1')
  })
})

describe('receipts', () => {
  test('an answered proposal is a one-line receipt', () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD, { status: 'confirmed', result: { decisionId: 'd1', ticketId: 't3', number: 3, title: 'Add login', question: 'Which database?', answer: 'Postgres', note: null } })} />)
    expect(screen.getByText(/Answered/)).toHaveTextContent('Answered #3 with "Postgres"')
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })

  test('one that failed because the decision was answered elsewhere shows why, not as a live card', () => {
    renderWithMantine(<ProposalCard proposal={proposal(PAYLOAD, { status: 'failed', result: { error: 'Already answered from the board' } })} />)
    expect(screen.getByText('Failed: Already answered from the board')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument()
  })
})
