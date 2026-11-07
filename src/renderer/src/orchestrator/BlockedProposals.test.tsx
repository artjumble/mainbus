import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { CreateTicketsPayload, Proposal, StartLineupPayload } from '../../../shared/proposals'
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

function proposal(kind: Proposal['kind'], payload: unknown, origin: Proposal['origin'] = 'orchestrator'): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind,
    origin,
    payload,
    evidence: null,
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null
  } as Proposal
}

test('a start the user asked for while a blocker is not Done says so, and that confirming starts it anyway', () => {
  const payload: StartLineupPayload = {
    ticketId: 't12',
    number: 12,
    title: 'Rate-limit login',
    roles: [{ roleId: 'p', name: 'Planner', model: 'opus', effort: 'high', source: 'default' }],
    extraInstructions: null,
    blockedBy: [{ number: 9, title: 'Schema' }, { number: 10, title: 'Api' }]
  }
  const { container } = renderWithMantine(<ProposalCard proposal={proposal('start_lineup', payload, 'drag')} />)
  expect(container.querySelector('[data-blocked-note]')?.textContent).toBe("#9 and #10 aren't Done yet. Confirming starts it anyway.")
})

test('a start with no blockers has no blocked note', () => {
  const payload: StartLineupPayload = {
    ticketId: 't12',
    number: 12,
    title: 'Rate-limit login',
    roles: [{ roleId: 'p', name: 'Planner', model: 'opus', effort: 'high', source: 'default' }],
    extraInstructions: null
  }
  const { container } = renderWithMantine(<ProposalCard proposal={proposal('start_lineup', payload)} />)
  expect(container.querySelector('[data-blocked-note]')).toBeNull()
})

describe('create tickets with blockers', () => {
  const payload: CreateTicketsPayload = {
    intent: 'Do the series',
    column: 'backlog',
    tickets: [
      { title: 'Step one', spec: '', criteria: [], labels: [], blocked_by: [5] },
      { title: 'Step two', spec: '', criteria: [], labels: [], blocked_by: [{ draft: 0 }] },
      { title: 'Step three', spec: '', criteria: [], labels: [], blocked_by: [{ draft: 0 }, { draft: 1 }] }
    ]
  }

  test('each draft shows what blocks it', () => {
    const { container } = renderWithMantine(<ProposalCard proposal={proposal('create_tickets', payload)} />)
    expect([...container.querySelectorAll('[data-draft-blocked-by]')].map((n) => n.textContent)).toEqual([
      'Blocked by #5',
      'Blocked by ticket 1 above',
      'Blocked by ticket 1 above, ticket 2 above'
    ])
  })

  test('unticking a draft moves the others up and drops references to it', async () => {
    renderWithMantine(<ProposalCard proposal={proposal('create_tickets', payload)} />)
    await userEvent.click(screen.getByRole('checkbox', { name: /Step one|Include Step one/ }))
    await userEvent.click(screen.getByRole('button', { name: /^Create 2 tickets/ }))
    await vi.waitFor(() => expect(mockInvoke).toHaveBeenCalled())
    const call = mockInvoke.mock.calls.find(([cmd]) => cmd === 'proposal.confirm')!
    const override = call[2] as { tickets: { title: string; blocked_by?: unknown }[] }
    expect(override.tickets.map((t) => [t.title, t.blocked_by])).toEqual([
      ['Step two', undefined],
      ['Step three', [{ draft: 0 }]]
    ])
    expect(within(document.body).queryByText(/Step one/)).toBeTruthy()
  })
})
