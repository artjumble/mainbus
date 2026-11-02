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

test('a ticket whose only open decisions are deferred shows a grey Waiting on you · until chip', () => {
  const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const ticket = makeTicket({}, { column: 'in_progress', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', deferredUntil: until })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  expect(screen.getByText(/^Waiting on you · until /)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
})

test.each([
  ['not_started', 'Not started'],
  ['implementing', 'Implementing'],
  ['waiting_on_you', 'Waiting on you'],
  ['ready_for_review', 'Ready for review'],
  ['done', 'Done'],
  ['planning', 'Planning'],
  ['testing', 'Testing'],
  ['reviewing', 'Reviewing']
] as const)('the %s phase reads "%s"', (phase, label) => {
  renderWithMantine(<TicketCard ticket={makeTicket({}, { phase })} onOpen={() => {}} />)
  expect(screen.getByText(label)).toBeInTheDocument()
})

test('a Reviewer at work shows the blue working chip', () => {
  const working = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
  const reviewing = makeTicket({}, { column: 'in_progress', phase: 'reviewing', agentStatus: 'working' })
  const { unmount } = renderWithMantine(<TicketCard ticket={working} onOpen={() => {}} />)
  const workingColor = screen.getByText('Implementing').closest('.mantine-Badge-root')?.getAttribute('style')
  expect(workingColor).toMatch(/--badge-bg/)
  unmount()
  renderWithMantine(<TicketCard ticket={reviewing} onOpen={() => {}} />)
  expect(screen.getByText('Reviewing').closest('.mantine-Badge-root')?.getAttribute('style')).toBe(workingColor)
})

test('a role the user paused shows a Paused chip beside the phase; another pause does not', () => {
  const paused = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', pausedByUser: true })
  const limited = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', canContinue: true })
  const { unmount } = renderWithMantine(<TicketCard ticket={paused} onOpen={() => {}} />)
  expect(screen.getByText('Implementing')).toBeInTheDocument()
  expect(screen.getByText('Paused')).toBeInTheDocument()
  unmount()
  renderWithMantine(<TicketCard ticket={limited} onOpen={() => {}} />)
  expect(screen.queryByText('Paused')).not.toBeInTheDocument()
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

test('a ticket with a pull request links to it, and clicking the link does not open the ticket', async () => {
  const onOpen = vi.fn()
  const ticket = makeTicket({ pr: { url: 'https://github.com/o/r/pull/12', number: 12 } }, { column: 'review' })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={onOpen} />)
  const link = screen.getByRole('link', { name: 'PR #12' })
  expect(link).toHaveAttribute('href', 'https://github.com/o/r/pull/12')
  expect(link).toHaveAttribute('target', '_blank')
  link.addEventListener('click', (e) => e.preventDefault())
  await userEvent.click(link)
  expect(onOpen).not.toHaveBeenCalled()
})

test('a ticket with no pull request shows no PR link', () => {
  renderWithMantine(<TicketCard ticket={makeTicket()} onOpen={() => {}} />)
  expect(screen.queryByRole('link')).not.toBeInTheDocument()
})
