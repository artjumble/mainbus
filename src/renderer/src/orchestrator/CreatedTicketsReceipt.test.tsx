import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { StoredEvent, ThreadEvent } from '../../../shared/events'
import { navigateTo } from '../navigation'
import { expectNoAxeViolations, renderWithMantine } from '../test-utils'
import { Thread } from '../thread/Thread'
import { CreatedTicketsReceipt } from './CreatedTicketsReceipt'

vi.mock('../api', () => ({ invoke: vi.fn(), onEngineEvent: vi.fn(), isSetupRequired: () => false }))
vi.mock('../navigation', () => ({ navigateTo: vi.fn(async () => {}) }))
const mockNavigate = navigateTo as unknown as ReturnType<typeof vi.fn>

beforeEach(() => mockNavigate.mockClear())

const EVENT: Extract<ThreadEvent, { kind: 'tickets_created' }> = {
  kind: 'tickets_created',
  workspaceId: 'ws2',
  workspace: 'mainbus',
  tickets: [
    { id: 't51', number: 51, title: 'Add login' },
    { id: 't52', number: 52, title: 'Add logout' }
  ]
}

test("says what was created in which workspace's Backlog, with a link to each ticket and no buttons", () => {
  renderWithMantine(<CreatedTicketsReceipt event={EVENT} />)
  const receipt = document.querySelector('[data-event="tickets_created"]')!
  expect(receipt.textContent).toBe("Created #51 and #52 in mainbus's Backlog")
  const links = screen.getAllByRole('button')
  // The links are the only controls: anchors rendered as buttons, titled with the ticket.
  expect(links.map((l) => [l.textContent, l.getAttribute('title')])).toEqual([
    ['#51', 'Add login'],
    ['#52', 'Add logout']
  ])
  expect(screen.queryByRole('button', { name: /confirm|reject|override/i })).not.toBeInTheDocument()
})

test("a link opens the ticket in its own workspace", async () => {
  renderWithMantine(<CreatedTicketsReceipt event={EVENT} />)
  await userEvent.click(screen.getByRole('button', { name: '#52' }))
  expect(mockNavigate).toHaveBeenCalledWith({ to: 'ticket', workspaceId: 'ws2', ticketId: 't52' })
})

test('one ticket reads plainly', () => {
  renderWithMantine(<CreatedTicketsReceipt event={{ ...EVENT, tickets: [EVENT.tickets[0]!] }} />)
  expect(document.querySelector('[data-event="tickets_created"]')!.textContent).toBe("Created #51 in mainbus's Backlog")
})

test('says how many images were attached', () => {
  renderWithMantine(<CreatedTicketsReceipt event={{ ...EVENT, tickets: [EVENT.tickets[0]!], images: 1 }} />)
  expect(document.querySelector('[data-event="tickets_created"]')!.textContent).toBe("Created #51 in mainbus's Backlog, with 1 image attached")
})

test('the orchestrator thread shows the receipt where the tickets were created', () => {
  const events: StoredEvent[] = [
    { runId: 'o1', seq: 1, at: '2026-11-03T10:00:00.000Z', event: { kind: 'user_message', text: 'Add login and logout' } },
    { runId: 'o1', seq: 2, at: '2026-11-03T10:00:05.000Z', event: EVENT }
  ]
  renderWithMantine(<Thread events={events} decisions={[]} runs={{}} summariseTools />)
  expect(screen.getByRole('button', { name: '#51' })).toBeInTheDocument()
  expect(document.querySelector('[data-event="tickets_created"]')!.textContent).toBe("Created #51 and #52 in mainbus's Backlog")
})

test('has no axe violations', async () => {
  renderWithMantine(<CreatedTicketsReceipt event={EVENT} />)
  await expectNoAxeViolations()
})

test('says that a summary of the conversation was added, only when it was', () => {
  const { unmount } = renderWithMantine(<CreatedTicketsReceipt event={{ ...EVENT, context: true }} />)
  expect(document.querySelector('[data-event="tickets_created"]')!.textContent).toBe(
    "Created #51 and #52 in mainbus's Backlog, with a summary of the conversation under \"From an agent\""
  )
  unmount()
  renderWithMantine(<CreatedTicketsReceipt event={EVENT} />)
  expect(document.querySelector('[data-event="tickets_created"]')!.textContent).not.toContain('summary')
})
