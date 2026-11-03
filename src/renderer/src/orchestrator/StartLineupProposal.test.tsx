import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Proposal, StartLineupPayload, StartLineupResult } from '../../../shared/proposals'
import { invoke } from '../api'
import { useMainbus } from '../store'
import { expectNoAxeViolations, optionLabels, renderWithMantine } from '../test-utils'
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

test('shows the ticket, the lineup in order, the extra instructions and the reason', () => {
  useMainbus.setState({ workspace: { ...initial.workspace!, name: 'web-app' } })
  renderWithMantine(<ProposalCard proposal={proposal()} />)
  expect(within(card()).getByText('PROPOSED ACTION', { exact: false })).toBeInTheDocument()
  expect(within(card()).getByLabelText('Roles')).toHaveTextContent('web-app lineup: Planner → Implementer → Reviewer')
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
    // The models and effort are in a section that starts collapsed.
    await userEvent.click(within(card()).getByRole('button', { name: /Models and effort per role/ }))
    await within(card()).findByRole('combobox', { name: 'Model for Planner' })
    return within(card())
  }

  test('has a box, a model and an effort per role, prefilled as proposed, and the extra instructions', async () => {
    const editor = await openEditor()
    for (const name of ['1. Planner', '2. Implementer', '3. Reviewer']) expect(editor.getByRole('checkbox', { name })).toBeChecked()
    expect(editor.getByText('Untick a role to skip it for this ticket only.')).toBeInTheDocument()
    expect(editor.getByRole('combobox', { name: 'Model for Planner' })).toHaveValue('opus')
    expect(editor.getByRole('combobox', { name: 'Effort for Implementer' })).toHaveValue('medium')
    // An effort outside the offered ones still shows as it is.
    expect(optionLabels(editor.getByRole('combobox', { name: 'Effort for Reviewer' }))).toEqual(['Low', 'Medium', 'High', 'Max'])
    expect(editor.getByRole('combobox', { name: 'Effort for Reviewer' })).toHaveValue('max')
    expect(within(card()).getByRole('textbox', { name: 'Extra instructions for this agent' })).toHaveValue('Keep the diff small.')
  })

  test('the Override form says whose lineup it is, and its buttons are Cancel and Start', async () => {
    useMainbus.setState({ workspace: { ...initial.workspace!, name: 'web-app' } })
    await openEditor()
    expect(within(card()).getByText('Lineup for this ticket (from web-app)')).toBeInTheDocument()
    expect(within(card()).getByRole('button', { name: 'Start' })).toBeEnabled()
    expect(within(card()).getByRole('button', { name: 'Cancel' })).toBeEnabled()
    expect(within(card()).queryByRole('button', { name: 'Confirm with changes' })).not.toBeInTheDocument()
  })

  test('the last ticked role cannot be unticked', async () => {
    const editor = await openEditor()
    await userEvent.click(editor.getByRole('checkbox', { name: '1. Planner' }))
    await userEvent.click(editor.getByRole('checkbox', { name: '3. Reviewer' }))
    expect(editor.getByRole('checkbox', { name: '2. Implementer' })).toBeChecked()
    expect(editor.getByRole('checkbox', { name: '2. Implementer' })).toBeDisabled()
    expect(editor.getByRole('combobox', { name: 'Model for Planner' })).toBeDisabled()
    expect(within(card()).getByRole('button', { name: 'Start' })).toBeEnabled()
  })

  test('confirms with exactly the roles kept, their models and effort, and the edited instructions', async () => {
    const editor = await openEditor()
    await userEvent.click(editor.getByRole('checkbox', { name: '1. Planner' }))
    await userEvent.selectOptions(editor.getByRole('combobox', { name: 'Model for Implementer' }), 'Opus')
    await userEvent.selectOptions(editor.getByRole('combobox', { name: 'Effort for Reviewer' }), 'Low')
    const extra = within(card()).getByRole('textbox', { name: 'Extra instructions for this agent' })
    await userEvent.clear(extra)
    await userEvent.type(extra, 'Only the limiter.')
    await userEvent.click(within(card()).getByRole('button', { name: 'Start' }))
    expect(mockInvoke).toHaveBeenCalledWith('proposal.confirm', 'p1', {
      roles: [
        { roleId: 'i', model: 'opus', effort: 'medium' },
        { roleId: 'r', model: 'opus', effort: 'low' }
      ],
      extraInstructions: 'Only the limiter.'
    })
  })
})

test('the receipt says where the ticket is and who is working, with an Open ticket link', async () => {
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
  // Before the board has the ticket, the receipt still says what started.
  expect(document.querySelector('[data-proposal="receipt"]')).toHaveTextContent('✓ Started Rate-limit login · Implementer working')
  await userEvent.click(screen.getByRole('button', { name: 'Open ticket' }))
  expect(useMainbus.getState().currentTicketId).toBe('t12')
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
