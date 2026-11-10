import { screen, within } from '@testing-library/react'
import type { MergePayload, Proposal } from '../../../shared/proposals'
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

const PAYLOAD: MergePayload = {
  ticketId: 't3',
  number: 3,
  title: 'Add login',
  plan: { kind: 'pull_request', base: 'main', branch: 'feat', head: 'a', method: 'squash', pr: { url: 'https://github.com/o/r/pull/9', number: 9 } },
  moveToDone: true,
  deleteBranch: false
}

function proposal(payload: MergePayload = PAYLOAD, over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'merge',
    origin: 'orchestrator',
    payload,
    evidence: 'It is in Review with its checks passing',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

test('states the method and the move to Done, and only confirms or rejects', async () => {
  const { container } = renderWithMantine(<ProposalCard proposal={proposal()} />)
  const card = screen.getByRole('group', { name: 'Proposal: Merge #3 Add login' })
  expect(within(card).getByText(/Merges pull request #9 into main on GitHub by squashing it into one commit/)).toBeInTheDocument()
  expect(within(card).getByText('Then moves #3 to Done: its folder is removed and its branch is kept.')).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Merge' })).toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: /Override/ })).not.toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  await expectNoAxeViolations(container)
})

test('says what a local merge does to the checkout', () => {
  const local: MergePayload = {
    ...PAYLOAD,
    plan: { kind: 'local', base: 'main', branch: 'feat', head: 'a', how: 'fast_forward', commits: 1, checkout: '/repo', currentBranch: 'main', message: null }
  }
  renderWithMantine(<ProposalCard proposal={proposal(local)} />)
  expect(screen.getByText(/Fast-forwards main to feat \(1 commit\) in your checkout/)).toBeInTheDocument()
})

test('shows the receipt of a merged ticket', () => {
  renderWithMantine(
    <ProposalCard
      proposal={proposal(PAYLOAD, {
        status: 'confirmed',
        result: { ticketId: 't3', number: 3, title: 'Add login', plan: PAYLOAD.plan, commit: null, moved: 'moved' },
        decidedAt: '2026-11-01T10:05:00.000Z'
      })}
    />
  )
  expect(screen.getByText(/Merged/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '#3' })).toBeInTheDocument()
})
