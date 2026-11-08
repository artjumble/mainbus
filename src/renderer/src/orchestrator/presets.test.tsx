import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TicketEdit } from '../../../shared/domain'
import type { CreateTicketsOverride, CreateTicketsPayload } from '../../../shared/proposals'
import { renderWithMantine } from '../test-utils'
import { createTicketsView } from './CreateTicketsProposal'
import { TicketEditReceipt } from './TicketEditReceipt'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
vi.mock('../navigation', () => ({ navigateTo: vi.fn(async () => {}) }))

const payload: CreateTicketsPayload = {
  intent: 'Document the API and fix the typo',
  column: 'backlog',
  tickets: [
    { title: 'Document the API', spec: '', criteria: [], labels: [], preset: 'Docs' },
    { title: 'Fix the typo', spec: '', criteria: [], labels: [] }
  ]
}

test('the drafts show their preset, on that draft only', () => {
  const Editor = createTicketsView.Editor!
  renderWithMantine(<Editor value={createTicketsView.initialEdit!(payload)} onChange={() => {}} payload={payload} />)
  expect(screen.getAllByText('Preset: Docs')).toHaveLength(1)
})

test('Edit keeps the preset of each draft', () => {
  const override = createTicketsView.toOverride!(createTicketsView.initialEdit!(payload))! as CreateTicketsOverride
  expect(override.tickets.map((t) => t.preset)).toEqual(['Docs', undefined])
  expect(override.tickets[1]).not.toHaveProperty('preset')
})

test('an edit receipt for run settings names the preset it set', async () => {
  const edit: TicketEdit = {
    id: 'e1',
    ticketId: 't71',
    workspaceId: 'ws1',
    number: 71,
    at: '2026-11-06T10:00:00.000Z',
    fields: ['runSettings'],
    before: { runSettings: null },
    after: { runSettings: { excludedRoleIds: ['p'], roles: {}, extraInstructions: null, roleNames: {} }, preset: 'Quick fix' },
    intentAdded: [],
    ticketUpdatedAt: '2026-11-06T10:00:00.000Z',
    undoneAt: null
  }
  renderWithMantine(
    <TicketEditReceipt event={{ kind: 'ticket_edited', editId: 'e1', workspaceId: 'ws1', workspace: 'mainbus', ticket: { id: 't71', number: 71, title: 'Run settings' } }} edit={edit} />
  )
  expect(screen.getByText(/run settings/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Show changes' }))
  const changes = await screen.findByTestId('edit-changes')
  expect(Array.from(changes.querySelectorAll('p')).map((p) => p.textContent)).toEqual(['Run settings', 'Before: Lineup defaults', 'After: Quick fix preset'])
})
