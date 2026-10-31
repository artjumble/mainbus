import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { makeTicket, renderWithMantine } from '../test-utils'
import { TicketCard } from './TicketCard'

test('TicketCard shows number, title and phase chip only', () => {
  const ticket = makeTicket({ number: 7, title: 'Add the thing' }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
  const { container } = renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  expect(screen.getByText('#7')).toBeInTheDocument()
  expect(screen.getByText('Add the thing')).toBeInTheDocument()
  expect(screen.getByText('Implementing')).toBeInTheDocument()
  expect(container.textContent).not.toMatch(/model|effort|token/i)
})

test.each([
  ['not_started', 'Not started'],
  ['implementing', 'Implementing'],
  ['waiting_on_you', 'Waiting on you'],
  ['ready_for_review', 'Ready for review'],
  ['done', 'Done'],
  ['planning', 'Planning'],
  ['testing', 'Testing']
] as const)('the %s phase reads "%s"', (phase, label) => {
  renderWithMantine(<TicketCard ticket={makeTicket({}, { phase })} onOpen={() => {}} />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

test('the summary shows only for a Needs you card', () => {
  const needsYou = makeTicket({}, { column: 'needs_you', phase: 'waiting_on_you', summary: 'Which database?' })
  const review = makeTicket({}, { column: 'review', phase: 'ready_for_review', summary: 'Should stay hidden' })
  const { unmount } = renderWithMantine(<TicketCard ticket={needsYou} onOpen={() => {}} />)
  expect(screen.getByText('Which database?')).toBeInTheDocument()
  unmount()
  renderWithMantine(<TicketCard ticket={review} onOpen={() => {}} />)
  expect(screen.queryByText('Should stay hidden')).not.toBeInTheDocument()
})

test('clicking or pressing Enter opens the ticket', async () => {
  const onOpen = vi.fn()
  const ticket = makeTicket({ title: 'Open me' })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={onOpen} />)
  const card = screen.getByRole('button', { name: /Open me/ })
  await userEvent.click(card)
  expect(onOpen).toHaveBeenCalledWith(ticket.id)
  card.focus()
  await userEvent.keyboard('{Enter}')
  expect(onOpen).toHaveBeenCalledTimes(2)
})

test('a ticket an agent filed shows "from <agent> (reported)" with the folder in a tooltip', async () => {
  const ticket = makeTicket({
    title: 'Filed by codex',
    intent: [{ text: 'words', at: '2026-10-30T00:00:00.000Z', source: { kind: 'agent', agent: 'codex', cwd: '/home/me/tools' } }]
  })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  const badge = screen.getByText('from codex (reported)')
  await userEvent.hover(badge)
  expect(await screen.findByText('Filed from /home/me/tools')).toBeInTheDocument()
})

test("the user's own tickets show no agent badge", () => {
  renderWithMantine(<TicketCard ticket={makeTicket({ title: 'Mine' })} onOpen={() => {}} />)
  expect(screen.queryByText(/\(reported\)/)).not.toBeInTheDocument()
})
