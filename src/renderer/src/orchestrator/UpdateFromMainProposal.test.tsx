import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, UpdateFromMainPayload } from '../../../shared/proposals'
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

const PAYLOAD: UpdateFromMainPayload = {
  ticketId: 't3',
  number: 3,
  title: 'Add login',
  base: 'main',
  behind: 2,
  conflicts: ['migrations/journal.txt'],
  agentRunId: null,
  role: null
}

function proposal(payload: UpdateFromMainPayload = PAYLOAD, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'update_from_main',
    origin: 'orchestrator',
    payload,
    evidence: 'It conflicts with main',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

test('shows how far behind the ticket is and the conflicting files, and only confirms or rejects', async () => {
  const { container } = renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Update #3 Add login from main' })
  expect(within(card).getByText('2 commits behind main, and merging it conflicts in migrations/journal.txt.')).toBeInTheDocument()
  expect(within(card).getByText('Why: It conflicts with main')).toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: 'Override' })).not.toBeInTheDocument()
  await userEvent.click(within(card).getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
  await expectNoAxeViolations(container)
})

test('says which open run the update ends', () => {
  renderWithMantine(<ProposalCard proposal={proposal({ ...PAYLOAD, agentRunId: 'r1', role: 'Reviewer', conflicts: [] })} />)
  expect(screen.getByText(/The Reviewer's run ends \(it counts as stopped\)\. The Implementer merges main/)).toBeInTheDocument()
})
