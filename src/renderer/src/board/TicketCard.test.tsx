import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expectNoAxeViolations, makeDecision, makeTicket, renderWithMantine } from '../test-utils'
import { TicketCard } from './TicketCard'

test('TicketCard shows number, title and phase chip only', () => {
  const ticket = makeTicket({ number: 7, title: 'Add the thing' }, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
  const { container } = renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  expect(screen.getByText('#7')).toBeInTheDocument()
  expect(screen.getByText('Add the thing')).toBeInTheDocument()
  expect(screen.getByText('Implementing')).toBeInTheDocument()
  expect(container.textContent).not.toMatch(/model|effort|token/i)
})

test('a ticket with saved run settings shows a Custom run chip; one without shows none', () => {
  const saved = { excludedRoleIds: ['p'], roles: {}, extraInstructions: null, roleNames: { p: 'Planner' } }
  const { unmount } = renderWithMantine(<TicketCard ticket={makeTicket({ runSettings: saved })} onOpen={() => {}} />)
  expect(screen.getByText('Custom run').closest('[data-run-settings-chip]')).not.toBeNull()
  unmount()
  renderWithMantine(<TicketCard ticket={makeTicket()} onOpen={() => {}} />)
  expect(screen.queryByText('Custom run')).not.toBeInTheDocument()
})

test('a card paused by the usage limit shows Paused and the reason', () => {
  const ticket = makeTicket(
    {},
    { column: 'in_progress', phase: 'implementing', agentStatus: 'paused', pausedByLimit: true, summary: 'Usage limit; resumes at 14:00' }
  )
  renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  expect(screen.getByText('Paused')).toBeInTheDocument()
  expect(screen.getByText('Usage limit; resumes at 14:00')).toBeInTheDocument()
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

test('a queued agent shows a Queued chip with its place beside the phase, in progress with the phase unchanged', () => {
  const queued = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'queued', queuePosition: 2 })
  const { unmount } = renderWithMantine(<TicketCard ticket={queued} onOpen={() => {}} />)
  expect(screen.getByText('Implementing')).toBeInTheDocument()
  expect(screen.getByText('Queued · 2nd')).toBeInTheDocument()
  unmount()
  const working = makeTicket({}, { column: 'in_progress', phase: 'implementing', agentStatus: 'working' })
  renderWithMantine(<TicketCard ticket={working} onOpen={() => {}} />)
  expect(screen.queryByText(/Queued/)).not.toBeInTheDocument()
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

test('the title button opens the ticket by click, Enter and Space, once each', async () => {
  const onOpen = vi.fn()
  const ticket = makeTicket({ title: 'Open me' })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={onOpen} />)
  const title = screen.getByRole('button', { name: 'Open me' })
  await userEvent.click(title)
  expect(onOpen).toHaveBeenCalledTimes(1)
  expect(onOpen).toHaveBeenCalledWith(ticket.id)
  title.focus()
  await userEvent.keyboard('{Enter}')
  expect(onOpen).toHaveBeenCalledTimes(2)
  await userEvent.keyboard(' ')
  expect(onOpen).toHaveBeenCalledTimes(3)
})

test('a click on the empty area of the card opens the ticket', async () => {
  const onOpen = vi.fn()
  const ticket = makeTicket({ number: 9, title: 'Open me' })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={onOpen} />)
  await userEvent.click(screen.getByText('#9'))
  expect(onOpen).toHaveBeenCalledWith(ticket.id)
})

test('the card is not itself a button: the title is the only tab stop, and no button contains another control', () => {
  const ticket = makeTicket(
    { title: 'Open me', pr: { url: 'https://github.com/o/r/pull/12', number: 12 }, pendingDecisions: [makeDecision()] },
    { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' }
  )
  renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
  const buttons = screen.getAllByRole('button')
  expect(buttons.map((b) => b.textContent)).toEqual(['Open me', 'Answer'])
  for (const b of buttons) expect(b.querySelector('button, a, [role="button"], [tabindex]')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open me' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'PR #12' })).toBeInTheDocument()
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

test('an Investigate ticket shows an Investigate badge, a Change ticket does not', () => {
  const { rerender } = renderWithMantine(<TicketCard ticket={makeTicket({ kind: 'investigate' })} onOpen={() => {}} />)
  expect(screen.getByText('Investigate')).toBeInTheDocument()
  rerender(<TicketCard ticket={makeTicket()} onOpen={() => {}} />)
  expect(screen.queryByText('Investigate')).not.toBeInTheDocument()
})

describe('the recently changed outline', () => {
  const ticket = (): ReturnType<typeof makeTicket> => makeTicket({}, { column: 'in_progress', phase: 'implementing' })
  const mockMotion = (reduce: boolean): void => {
    window.matchMedia = ((query: string) => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null
    })) as unknown as typeof window.matchMedia
  }
  const outlined = (): string | null =>
    screen.getByText('Implementing').closest('.mantine-Paper-root')?.getAttribute('data-recently-changed') ?? null

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a change fades out after about 4 seconds', () => {
    mockMotion(false)
    renderWithMantine(<TicketCard ticket={ticket()} changedAt={Date.now()} onOpen={() => {}} />)
    expect(outlined()).toBe('fade')
    act(() => void vi.advanceTimersByTime(3900))
    expect(outlined()).toBe('fade')
    act(() => void vi.advanceTimersByTime(200))
    expect(outlined()).toBeNull()
  })

  test('with reduced motion there is no fade, just a short outline', async () => {
    mockMotion(true)
    renderWithMantine(<TicketCard ticket={ticket()} changedAt={Date.now()} onOpen={() => {}} />)
    await vi.waitFor(() => expect(outlined()).toBe('still'))
    act(() => void vi.advanceTimersByTime(1300))
    expect(outlined()).toBeNull()
  })

  test('a card with no recent change has no outline, and an old one is not outlined', () => {
    mockMotion(false)
    const { rerender } = renderWithMantine(<TicketCard ticket={ticket()} onOpen={() => {}} />)
    expect(outlined()).toBeNull()
    rerender(<TicketCard ticket={ticket()} changedAt={Date.now() - 10_000} onOpen={() => {}} />)
    expect(outlined()).toBeNull()
  })
})

describe('accessibility', () => {
  test('a card with every chip has no axe violations', async () => {
    const ticket = makeTicket(
      {
        kind: 'investigate',
        hold: { id: 'h1', targetKind: 'ticket', targetId: 't', reason: 'Waiting on a design', until: null, createdAt: '2026-10-30T00:00:00.000Z' } as never,
        pr: { number: 12, url: 'https://github.com/o/r/pull/12' } as never,
        intent: [{ text: 'words', at: '2026-10-30T00:00:00.000Z', source: { kind: 'agent', agent: 'codex', cwd: '/home/me/tools' } }]
      },
      { column: 'in_progress', phase: 'implementing', agentStatus: 'queued', queuePosition: 2, pausedByUser: true }
    )
    renderWithMantine(<TicketCard ticket={ticket} cleaningUp onOpen={() => {}} handle={<button type="button">Move ticket #1</button>} />)
    await expectNoAxeViolations()
  })

  test('a Needs you card with its Answer control has no axe violations, closed or open', async () => {
    const ticket = makeTicket(
      { pendingDecisions: [makeDecision({ recommended: 1 })] },
      { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you', summary: 'Which database?' }
    )
    renderWithMantine(<TicketCard ticket={ticket} onOpen={() => {}} />)
    await expectNoAxeViolations()
    await userEvent.click(screen.getByRole('button', { name: 'Answer' }))
    await screen.findByRole('radio', { name: 'SQLite' })
    await expectNoAxeViolations()
  })
})

test.each([
  ['not_started', 'backlog', null, '– Not started'],
  ['implementing', 'in_progress', 'working', '• Implementing'],
  ['waiting_on_you', 'needs_you', 'waiting_on_you', '◆ Waiting on you'],
  ['ready_for_review', 'review', null, '○ Ready for review'],
  ['done', 'done', null, '✓ Done'],
  ['testing', 'needs_you', 'failed', '✕ Failed in Testing']
] as const)('the %s chip leads with a symbol: "%s %s" reads %s', (phase, column, agentStatus, text) => {
  const { container } = renderWithMantine(<TicketCard ticket={makeTicket({}, { phase, column, agentStatus })} onOpen={() => {}} />)
  expect(container.querySelector('.mantine-Badge-root')).toHaveTextContent(text)
})

test('a failed card has a dashed border and a Needs you card an orange one', () => {
  const failed = renderWithMantine(<TicketCard ticket={makeTicket({}, { column: 'needs_you', phase: 'testing', agentStatus: 'failed' })} onOpen={() => {}} />)
  expect(failed.container.querySelector<HTMLElement>('.mantine-Paper-root')!.style.border).toContain('dashed')
  failed.unmount()
  const needs = renderWithMantine(<TicketCard ticket={makeTicket({}, { column: 'needs_you', phase: 'waiting_on_you', agentStatus: 'waiting_on_you' })} onOpen={() => {}} />)
  expect(needs.container.querySelector<HTMLElement>('.mantine-Paper-root')!.style.border).toContain('needs-6')
})

test('the handle shares the number\'s row, and the title keeps a gutter clear of the handle\'s hit area', async () => {
  const onOpen = vi.fn()
  const ticket = makeTicket({ number: 61, title: 'A very long title '.repeat(12) })
  renderWithMantine(<TicketCard ticket={ticket} onOpen={onOpen} handle={<button aria-label="Move ticket #61">⠿</button>} />)
  const row = screen.getByText('#61').parentElement!
  expect(row).toContainElement(screen.getByRole('button', { name: 'Move ticket #61' }))
  const title = screen.getByText(/A very long title/).closest('button')!
  expect(row).not.toContainElement(title)
  // 22 px of hit area left of the handle's centre plus half its 18 px width.
  expect(parseInt(title.style.marginRight, 10)).toBeGreaterThanOrEqual(31)
  await userEvent.click(title)
  expect(onOpen).toHaveBeenCalledWith(ticket.id)
})
