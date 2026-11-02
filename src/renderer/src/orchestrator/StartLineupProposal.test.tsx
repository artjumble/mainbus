import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, StartLineupPayload, StartLineupResult } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { optionLabels, renderWithMantine } from '../test-utils'
import { ProposalCard } from './ProposalCard'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const initial = useMainbus.getState()

beforeEach(() => {
  useMainbus.setState(initial, true)
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue(undefined)
})

const PAYLOAD: StartLineupPayload = {
  ticketId: 't12',
  number: 12,
  title: 'Rate-limit login',
  roles: [
    { roleId: 'p', name: 'Planner', model: 'opus', effort: 'high', source: 'default' },
    { roleId: 'i', name: 'Implementer', model: 'sonnet', effort: 'medium', source: 'orchestrator' },
    { roleId: 'r', name: 'Reviewer', model: 'opus', effort: 'max', source: 'role' }
  ],
  extraInstructions: 'Keep the diff small.'
}

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: 'p1',
    workspaceId: 'ws',
    orchestratorRunId: 'o1',
    kind: 'start_lineup',
    origin: 'orchestrator',
    payload: PAYLOAD,
    evidence: 'It is specced and nothing is running',
    status: 'pending',
    result: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    decidedAt: null,
    ...over
  }
}

const card = () => screen.getByRole('group', { name: 'Proposal: Start #12 Rate-limit login' })

test('shows the ticket, the roles in order with their model and effort, the extra instructions and the reason', () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  const roles = within(card()).getByRole('list', { name: 'Roles' })
  expect(within(roles).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Planner · Opus · High',
    'Implementer · Sonnet · Medium',
    'Reviewer · Opus · Max'
  ])
  expect(within(card()).getByText('Extra instructions: Keep the diff small.')).toBeInTheDocument()
  expect(within(card()).getByText('Why: It is specced and nothing is running')).toBeInTheDocument()
})

test('no extra instructions, no line for them', () => {
  renderWithMantine(<ProposalCard proposal={proposal({ payload: { ...PAYLOAD, extraInstructions: null } })} />)
  expect(screen.queryByText(/^Extra instructions:/)).not.toBeInTheDocument()
})

test('Confirm starts it as proposed', async () => {
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  await userEvent.click(within(card()).getByRole('button', { name: 'Confirm' }))
  expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1')
})

describe('override', () => {
  async function openEditor() {
    renderWithMantine(<ProposalCard proposal={proposal()} />)
    await userEvent.click(within(card()).getByRole('button', { name: 'Override' }))
    return within(within(card()).getByRole('group', { name: 'Models and effort per role' }))
  }

  test('has a box, a model and an effort per role, prefilled as proposed, and the extra instructions', async () => {
    const editor = await openEditor()
    for (const name of ['Planner', 'Implementer', 'Reviewer']) expect(editor.getByRole('checkbox', { name })).toBeChecked()
    expect(editor.getByRole('combobox', { name: 'Model for Planner' })).toHaveValue('opus')
    expect(editor.getByRole('combobox', { name: 'Effort for Implementer' })).toHaveValue('medium')
    // An effort outside the offered ones still shows as it is.
    expect(optionLabels(editor.getByRole('combobox', { name: 'Effort for Reviewer' }))).toEqual(['Low', 'Medium', 'High', 'Max'])
    expect(editor.getByRole('combobox', { name: 'Effort for Reviewer' })).toHaveValue('max')
    expect(within(card()).getByRole('textbox', { name: 'Extra instructions' })).toHaveValue('Keep the diff small.')
  })

  test('the last ticked role cannot be unticked', async () => {
    const editor = await openEditor()
    await userEvent.click(editor.getByRole('checkbox', { name: 'Planner' }))
    await userEvent.click(editor.getByRole('checkbox', { name: 'Reviewer' }))
    expect(editor.getByRole('checkbox', { name: 'Implementer' })).toBeChecked()
    expect(editor.getByRole('checkbox', { name: 'Implementer' })).toBeDisabled()
    expect(editor.getByRole('combobox', { name: 'Model for Planner' })).toBeDisabled()
    expect(within(card()).getByRole('button', { name: 'Confirm with changes' })).toBeEnabled()
  })

  test('confirms with exactly the roles kept, their models and effort, and the edited instructions', async () => {
    const editor = await openEditor()
    await userEvent.click(editor.getByRole('checkbox', { name: 'Planner' }))
    await userEvent.selectOptions(editor.getByRole('combobox', { name: 'Model for Implementer' }), 'Opus')
    await userEvent.selectOptions(editor.getByRole('combobox', { name: 'Effort for Reviewer' }), 'Low')
    const extra = within(card()).getByRole('textbox', { name: 'Extra instructions' })
    await userEvent.clear(extra)
    await userEvent.type(extra, 'Only the limiter.')
    await userEvent.click(within(card()).getByRole('button', { name: 'Confirm with changes' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', {
      roles: [
        { roleId: 'i', model: 'opus', effort: 'medium' },
        { roleId: 'r', model: 'opus', effort: 'low' }
      ],
      extraInstructions: 'Only the limiter.'
    })
  })
})

test('the receipt names the roles started, its number opening the ticket', async () => {
  const result: StartLineupResult = {
    ticketId: 't12',
    number: 12,
    title: 'Rate-limit login',
    roles: [
      { name: 'Implementer', model: 'opus', effort: 'medium' },
      { name: 'Reviewer', model: 'opus', effort: 'low' }
    ]
  }
  renderWithMantine(<ProposalCard proposal={proposal({ status: 'overridden', result })} />)
  expect(document.querySelector('[data-proposal="receipt"]')).toHaveTextContent('Started #12 with Implementer and Reviewer')
  await userEvent.click(screen.getByRole('button', { name: '#12' }))
  expect(useMainbus.getState().currentTicketId).toBe('t12')
})
