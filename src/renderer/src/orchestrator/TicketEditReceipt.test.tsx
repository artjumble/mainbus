import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { TicketEdit } from '../../../shared/domain'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { invoke } from '../api'
import { navigateTo } from '../navigation'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { Thread } from '../thread/Thread'
import { TicketEditReceipt } from './TicketEditReceipt'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
vi.mock('../navigation', () => ({ navigateTo: vi.fn(async () => {}) }))
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>
const mockNavigate = navigateTo as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
  mockInvoke.mockReset()
  mockNavigate.mockClear()
})

const EVENT: Extract<ThreadEvent, { kind: 'ticket_edited' }> = {
  kind: 'ticket_edited',
  editId: 'e1',
  workspaceId: 'ws1',
  workspace: 'mainbus',
  ticket: { id: 't71', number: 71, title: 'Run settings' }
}

const EDIT: TicketEdit = {
  id: 'e1',
  ticketId: 't71',
  workspaceId: 'ws1',
  number: 71,
  at: '2026-11-06T10:00:00.000Z',
  fields: ['spec', 'criteria'],
  before: {
    spec: 'Intro\nRun settings section\nTests',
    criteria: [
      { position: 0, text: 'one', checked: true },
      { position: 1, text: 'two', checked: false }
    ]
  },
  after: { spec: 'Intro\nTests', criteria: [{ position: 0, text: 'one', checked: true }] },
  intentAdded: [{ text: 'Remove the Run settings section', at: '2026-11-06T10:00:00.000Z' }],
  ticketUpdatedAt: '2026-11-06T10:00:00.000Z',
  undoneAt: null
}

const receipt = () => document.querySelector('[data-event="ticket_edited"]')!

test('says what changed, with a link to the ticket', async () => {
  const { container } = renderWithMantine(<TicketEditReceipt event={EVENT} edit={EDIT} />)
  expect(receipt().textContent).toContain('Updated #71: spec, criteria, your words (+1)')
  await userEvent.click(screen.getByRole('button', { name: '#71' }))
  expect(mockNavigate).toHaveBeenCalledWith({ to: 'ticket', workspaceId: 'ws1', ticketId: 't71' })
  await expectNoAxeViolations(container)
})

test('Show changes lists each field before and after, the spec as a line diff, and the words added', async () => {
  renderWithMantine(<TicketEditReceipt event={EVENT} edit={EDIT} />)
  expect(screen.queryByText(/Run settings section/)).not.toBeInTheDocument()
  const toggle = screen.getByRole('button', { name: 'Show changes' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const changes = await screen.findByTestId('edit-changes')
  const lines = Array.from(changes.querySelectorAll('p')).map((p) => p.textContent)
  expect(lines).toEqual([
    'Spec',
    '  Intro',
    '- Run settings section',
    '  Tests',
    'Criteria',
    'Before: [x] one\n[ ] two',
    'After: [x] one',
    'Your words (added)',
    '+ Remove the Run settings section'
  ])
})

test('Undo asks the engine to undo this edit', async () => {
  mockInvoke.mockResolvedValue({ ...EDIT, undoneAt: '2026-11-06T10:01:00.000Z' })
  renderWithMantine(<TicketEditReceipt event={EVENT} edit={EDIT} />)
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(mockInvoke).toHaveBeenCalledWith('ticket.undoEdit', 'e1')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test("a refused Undo shows the engine's reason on the receipt", async () => {
  mockInvoke.mockRejectedValue(
    new Error("Error invoking remote method 'engine:invoke': Error: Can't undo: #71 has changed since this edit, so it can't be undone")
  )
  renderWithMantine(<TicketEditReceipt event={EVENT} edit={EDIT} />)
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(await screen.findByRole('alert')).toHaveTextContent("Can't undo: #71 has changed since this edit, so it can't be undone")
  expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled()
})

test('once undone it says so and has no Undo', () => {
  renderWithMantine(<TicketEditReceipt event={EVENT} edit={{ ...EDIT, undoneAt: '2026-11-06T10:01:00.000Z' }} />)
  expect(receipt().textContent).toContain('Undone: #71 (was spec, criteria, your words (+1))')
  expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
})

test('the orchestrator thread shows the receipt where the ticket was edited', () => {
  const events: StoredEvent[] = [
    { runId: 'o1', seq: 1, at: '2026-11-06T10:00:00.000Z', event: { kind: 'user_message', text: 'Drop the Run settings part' } },
    { runId: 'o1', seq: 2, at: '2026-11-06T10:00:05.000Z', event: EVENT }
  ]
  renderWithMantine(<Thread events={events} decisions={[]} runs={{}} edits={{ e1: EDIT }} summariseTools />)
  expect(receipt().textContent).toContain('Updated #71: spec, criteria, your words (+1)')
})
